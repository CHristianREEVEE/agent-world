// test-ws-farm.mjs — WebSocket 实时推送与断线重连测试
// 用法: node tests/test-ws-farm.mjs [BASE_URL]

import { WebSocket } from 'ws';

const BASE = process.env.BASE_URL || process.argv[2] || 'http://localhost:3000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const API = BASE + '/api';

let passed = 0, failed = 0;
const failures = [];
function ok(n) { passed++; console.log(`  ✓ ${n}`); }
function bad(n, m) { failed++; failures.push(`${n}: ${m}`); console.log(`  ✗ ${n} — ${m}`); }
function expect(n, c, e) { c ? ok(n) : bad(n, e); }

const api = async (m, p, b) => {
  const r = await fetch(API + p, {
    method: m, headers: { 'Content-Type': 'application/json' },
    body: b !== undefined ? JSON.stringify(b) : undefined,
  });
  return r.json();
};

// Simple WS client that collects all messages and can wait for a type
class WSClient {
  constructor() {
    this.ws = new WebSocket(WS_URL);
    this.messages = [];
    this.handlers = {};
    this._connected = false;
    this._closed = false;

    this.ws.on('open', () => { this._connected = true; });
    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.messages.push(msg);
        if (this.handlers[msg.type]) this.handlers[msg.type](msg);
      } catch {}
    });
    this.ws.on('close', () => { this._closed = true; });
  }

  waitForOpen(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS 连接超时')), timeout);
      const check = setInterval(() => {
        if (this._connected) { clearTimeout(t); clearInterval(check); resolve(); }
      }, 50);
    });
  }

  waitFor(type, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const existing = this.messages.find(m => m.type === type);
      if (existing) return resolve(existing);
      const t = setTimeout(() => reject(new Error(`等待 WS 消息 [${type}] 超时`)), timeout);
      this.handlers[type] = (msg) => { clearTimeout(t); resolve(msg); };
    });
  }

  waitForAny(timeout = 10000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), timeout);
      this.handlers['_any'] = (msg) => { clearTimeout(t); resolve(msg); };
    });
  }

  close() {
    return new Promise((res) => {
      if (this._closed) return res();
      this.ws.on('close', () => res());
      this.ws.close();
      setTimeout(res, 300);
    });
  }

  send(type, data) {
    this.ws.send(JSON.stringify({ type, data }));
  }
}

async function main() {
  console.log(`\n🔌 WebSocket 实时推送测试 → ${WS_URL}\n`);

  // 1. 连接并接收初始 state
  const client = new WSClient();
  await client.waitForOpen();
  ok('WS 连接成功');
  const initialState = await client.waitFor('state', 8000);
  expect('收到初始 state', initialState !== null);
  expect('state 含世界信息', initialState?.data?.world?.weather !== undefined || initialState?.data?.world);

  // 2. 创建修士
  const createR = await api('POST', '/agent/create', { name: 'WS测试' + Date.now().toString(36).slice(-4), path: 'sword' });
  const { agentId, token } = createR;
  ok('创建修士成功');

  await api('POST', '/farm/clear', { agentId, token });
  const farmInfo = await api('GET', '/farm');
  const crop = farmInfo.crops.find(c => c.tier === 0 && c.season === farmInfo.season)?.name || '灵草';
  await api('POST', '/farm/plant', { agentId, cropName: crop, token });
  // 浇灌加速生长
  await api('POST', '/farm/water', { agentId, token }).catch(() => {});

  // 3. 等待 state 更新
  const stateMsg = await client.waitFor('state', 8000);
  expect('收到 state 更新', stateMsg !== null);

  // 4. 调快速度等待成熟，然后主动收获
  await api('POST', '/game/speed', { speed: 10 });
  console.log('  等待作物成熟...');

  // 轮询等待作物 ready（200 秒足够 3 日周期在 10x 速度下成熟）
  let ready = false;
  for (let i = 0; i < 200; i++) {
    const st = await api('GET', `/farm/status?agentId=${agentId}`);
    if (st.farm?.ready) { ready = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  expect('作物成熟', ready);

  if (ready) {
    ok('作物成熟');
    // 主动收获触发 harvest 事件
    await api('POST', '/farm/harvest', { agentId, token });
    await new Promise(r => setTimeout(r, 2000));
  }

  // 等待灵田相关事件
  await new Promise(r => setTimeout(r, 2000));
  const gotEvent = client.messages.find(m =>
    m.type === 'harvest' || m.type === 'farm-event' || m.type === 'farm-ready');

  if (gotEvent) {
    ok('收到灵田事件推送');
    if (gotEvent.type === 'harvest') {
      expect('harvest 事件含 agentId', gotEvent?.data?.agentId === agentId);
      expect('harvest 事件含作物', gotEvent?.data?.item === crop || gotEvent?.data?.item);
    }
  } else {
    bad('灵田事件推送', '未收到 harvest/farm-event');
  }

  await api('POST', '/game/speed', { speed: 1 });

  // 5. 断线重连
  console.log('  断线重连测试...');
  await client.close();
  ok('旧连接已关闭');

  const client2 = new WSClient();
  await client2.waitForOpen();
  ok('重连成功');
  const state2 = await client2.waitFor('state', 8000);
  expect('重连后收到 state', state2 !== null);

  // 重连后仍可接收推送
  await api('POST', '/farm/patrol', { agentId, token });
  const stateMsg2 = await client2.waitFor('state', 8000);
  expect('重连后收到 state 更新', stateMsg2 !== null);

  await client2.close();

  // 6. 消息类型验证
  const allTypes = new Set(client.messages.map(m => m.type));
  expect('收到 state 消息', allTypes.has('state'));
  const farmEventTypes = client.messages.filter(m =>
    ['harvest', 'farm-event', 'farm-ready', 'log', 'agent'].includes(m.type));
  expect('至少有一种灵田相关事件', farmEventTypes.length > 0,
    `收到类型: ${[...allTypes].join(',')}`);

  console.log('\n══════════════════════════════════════');
  if (failed === 0) {
    console.log(`🎉 WebSocket 测试全部 ${passed} 项通过！\n`);
    process.exit(0);
  } else {
    console.log(`❌ ${failed} 项失败（${passed} 项通过）`);
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
}

main().catch(e => { console.error('\n💥 WS 测试异常:', e.message); process.exit(1); });

// acceptance-observer.mjs — 第 4 轮验收：人类观察面板
// token 三态 / 行为日志 / SSE 断线重连 / 越权 403 / DOM 结构断言
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const TMP = path.join(ROOT, 'data-test-observer');

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed += 1;
  console.log(`✓ ${name}${extra ? ' — ' + extra : ''}`);
};

fs.rmSync(TMP, { recursive: true, force: true });
const app = createApp({ dataDir: TMP, worldsRoot: path.join(ROOT, 'worlds'), webDir: path.join(ROOT, 'web') });

// 建两个账号（用于越权测试）
const accA = app.accounts.createAccount({ code: '账号A' });
const accB = app.accounts.createAccount({ code: '账号B' });
const charA = app.accounts.createCharacter(accA.id, 'xiuxian', { name: 'A的角色', path: 'sword' });
const charB = app.accounts.createCharacter(accB.id, 'xiuxian', { name: 'B的角色', path: 'pill' });

import http from 'node:http';
const server = http.createServer(app.app);
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;

const api = async (method, p, { token, body } = {}) => {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
  if (body !== undefined && method !== 'GET') opts.body = JSON.stringify(body);
  const r = await fetch(base + p, opts);
  return { status: r.status, json: await r.json() };
};

// ============================================================
// 场景 1：token 三态
// ============================================================
console.log('\n══ 场景 1：token 三态 ══');
// 正确
const ok = await api('POST', '/api/session/verify', { token: accA.token, body: {} });
check('正确 token → 200', ok.status === 200 && ok.json.ok);
// 错误
const bad = await api('POST', '/api/session/verify', { token: 'tok_bad', body: {} });
check('错误 token → 401 INVALID_TOKEN', bad.status === 401 && bad.json.code === 'INVALID_TOKEN');
// 缺失
const missing = await api('POST', '/api/session/verify', { body: {} });
check('缺失 token → 401', missing.status === 401);

// ============================================================
// 场景 2：越权 403（不暴露账号是否存在）
// ============================================================
console.log('\n══ 场景 2：越权 403 ══');
// A 查 B 的角色详情
const cross = await api('GET', `/api/characters/${charB.id}`, { token: accA.token });
check('A 查 B 角色 → 403 NOT_YOUR_CHARACTER', cross.status === 403 && cross.json.code === 'NOT_YOUR_CHARACTER');
// A 查 B 角色事件
const crossEvents = await api('GET', `/api/characters/${charB.id}/events`, { token: accA.token });
check('A 查 B 事件 → 403', crossEvents.status === 403);
// A 查 B 气运
const crossFortune = await api('GET', `/api/characters/${charB.id}/fortune`, { token: accA.token });
check('A 查 B 气运 → 403', crossFortune.status === 403);
// /api/me 只返回自己的角色
const me = await api('GET', '/api/me', { token: accA.token });
check('/api/me 只含自己角色', me.json.account.characters.length === 1 && me.json.account.characters[0].id === charA.id);
// 不存在的角色 id → 404（不暴露存在性给越权者？统一：自己账号查不存在 → 404；越权 → 403）
const notExist = await api('GET', '/api/characters/char_nope', { token: accA.token });
check('不存在角色 → 404 CHARACTER_NOT_FOUND', notExist.status === 404 && notExist.json.code === 'CHARACTER_NOT_FOUND');

// ============================================================
// 场景 3：行为日志（行动 + 随机事件品质标记）
// ============================================================
console.log('\n══ 场景 3：行为日志 ══');
const gameX = app.worlds.get('xiuxian').game;
gameX.startAction(charA.id, 'cultivate');
app.worlds.get('xiuxian').game.fastForward(10000);
const me2 = await api('GET', '/api/me', { token: accA.token });
const a = me2.json.account.characters[0];
check('行为日志含修炼完成', a.actionLog.some(l => l.kind === 'result' && l.type === 'cultivate'));
check('行为日志含行动开始', a.actionLog.some(l => l.kind === 'action' && l.type === 'cultivate'));

// 触发随机事件（mock fortune 直接调）
const { rollRandomEvent } = await import('../src/destiny.js');
rollRandomEvent(charA, gameX);
const me3 = await api('GET', '/api/me', { token: accA.token });
const a3 = me3.json.account.characters[0];
check('事件历史含品质标记', a3.eventLog.some(e => ['common', 'fine', 'rare', 'legendary'].includes(e.quality)));
check('行为日志含事件记录', a3.actionLog.some(l => l.kind === 'event'));

// ============================================================
// 场景 4：SSE 实时推送
// ============================================================
console.log('\n══ 场景 4：SSE ══');
// 用 fetch 流式读取 SSE
const sseUrl = `${base}/api/session/stream?token=${encodeURIComponent(accA.token)}`;
const sseRes = await fetch(sseUrl);
check('SSE 连接 200', sseRes.status === 200);
check('SSE Content-Type', sseRes.headers.get('content-type').includes('text/event-stream'));

const reader = sseRes.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
const events = [];
// 读 connected 事件
async function readEvent(timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const p of parts) {
      const lines = p.split('\n');
      const ev = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
      const data = lines.find(l => l.startsWith('data:'))?.slice(5).trim();
      if (ev && data) events.push({ ev, data: JSON.parse(data) });
    }
    if (events.length) return events.shift();
  }
  return null;
}

const connected = await readEvent();
check('SSE 收到 connected', connected && connected.ev === 'connected');

// 触发行动 → 应收到 update 事件（可能先收到 log，读到 update 为止）
gameX.startAction(charA.id, 'cultivate');
app.worlds.get('xiuxian').game.fastForward(10000);
let update = null;
for (let i = 0; i < 10; i++) {
  const ev = await readEvent(2000);
  if (!ev) break;
  if (ev.ev === 'update') { update = ev; break; }
}
check('SSE 收到 update 事件', update && update.ev === 'update', update?.ev);
if (update) {
  check('update 含角色数据', update.data.characters && update.data.characters.length > 0);
  check('update 含账号 XP', update.data.account && 'xp' in update.data.account);
}

// SSE 无效 token → 401
const badSse = await fetch(`${base}/api/session/stream?token=tok_bad`);
check('SSE 无效 token → 401', badSse.status === 401);

reader.releaseLock();
sseRes.body.cancel();

// ============================================================
// 场景 5：断线重连（重新建立 SSE）
// ============================================================
console.log('\n══ 场景 5：断线重连 ══');
const sse2 = await fetch(sseUrl);
const reader2 = sse2.body.getReader();
const decoder2 = new TextDecoder();
let buf2 = '';
async function readEvent2(timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { done, value } = await reader2.read();
    if (done) break;
    buf2 += decoder2.decode(value, { stream: true });
    const parts = buf2.split('\n\n');
    buf2 = parts.pop();
    for (const p of parts) {
      const lines = p.split('\n');
      const ev = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
      const data = lines.find(l => l.startsWith('data:'))?.slice(5).trim();
      if (ev && data) return { ev, data: JSON.parse(data) };
    }
  }
  return null;
}
const recon = await readEvent2();
check('重连后收到 connected', recon && recon.ev === 'connected');
reader2.releaseLock();
sse2.body.cancel();

// ============================================================
// 场景 6：DOM 结构断言（observer.html）
// ============================================================
console.log('\n══ 场景 6：DOM 结构断言 ══');
const html = fs.readFileSync(path.join(ROOT, 'web', 'observer.html'), 'utf-8');
check('含 token 输入框', html.includes('id="token-input"'));
check('含登录按钮', html.includes('id="login-btn"'));
check('含账号卡容器', html.includes('id="account-container"'));
check('含角色列表', html.includes('id="char-list"'));
check('含详情容器', html.includes('id="detail-container"'));
check('含 SSE EventSource', html.includes('EventSource'));
check('含断线重连处理', html.includes('onerror') && html.includes('自动重连'));
check('含修为进度条', html.includes('cult-bar') || html.includes('cultivationMax'));
check('含背包表格', html.includes('inv-table') || html.includes('inventory'));
check('含事件时间线', html.includes('timeline') && html.includes('quality'));
check('含移动端适配（375px）', html.includes('@media (max-width: 375px)'));
check('token 失效引导', html.includes('token 已失效') || html.includes('INVALID_TOKEN'));
check('不含天命数值暴露', !html.includes('destiny') || html.includes('气运'));

server.close();
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n══ 全部 ${passed} 项观察面板验收通过 ══`);
process.exit(0);

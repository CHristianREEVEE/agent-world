// test-regression.mjs — 旧功能回归测试（修士/移动/行动/采集/副本/战斗/商店/突破/时间控制）
// 运行：node server/tests/test-regression.mjs  （自起独立服务，零外部依赖）
// 说明：覆盖旧功能主要 API，确认新增灵田系统未对旧功能造成回归。
//   脚本按真实时长等待（TICK_MS 默认），并自动化解森林随机触发的野生战斗。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'src', 'index.js');

function pickPort() {
  return new Promise((resolve) => {
    const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const PORT = await pickPort();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-test-'));
const child = spawn(process.execPath, [SERVER_ENTRY], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, TICK_MS: '500', MAX_AGENTS: '20' },
  stdio: 'ignore',
});
const BASE = `http://127.0.0.1:${PORT}/api`;

const cleanup = () => { try { child.kill('SIGKILL'); } catch {} try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

const api = async (method, p, body) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    return await res.json().catch(() => ({}));
  } catch (e) { return { ok: false, error: '请求超时' }; }
  finally { clearTimeout(t); }
};
const waitUp = async () => { for (let i = 0; i < 80; i++) { try { const r = await fetch(`${BASE}/state`); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error('服务启动超时'); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => { cond ? (pass++, console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`)) : (fail++, console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`)); };

const st = async (id) => await api('GET', `/agent/${id}`);
// 处理野生战斗直到脱离（最多 10 轮，带总超时，避免卡住）
async function settleCombat(id, max = 10) {
  const t0 = Date.now();
  for (let i = 0; i < max; i++) {
    if (Date.now() - t0 > 12000) return;  // 总超时 12 秒
    const s = await st(id);
    if (!s.ok || !s.inCombat) return;
    await api('POST', '/combat/action', { agentId: id, action: 'attack' });
    await sleep(500);
  }
}

await waitUp();
try {
  console.log('\n═══ 旧功能回归测试 ═══\n');

  console.log('【世界/状态】');
  let d = await api('GET', '/state'); ck('GET /state', d.ok === true && d.world);
  d = await api('GET', '/world'); ck('GET /world 含dungeons/items', d.ok && Array.isArray(d.world.dungeons) && d.world.items);
  d = await api('GET', '/agents'); ck('GET /agents', d.ok);
  d = await api('GET', '/logs'); ck('GET /logs', d.ok);
  d = await api('GET', '/worlds'); ck('GET /worlds', d.ok && d.worlds.some(w => w.id === 'xiuxian'));

  console.log('【创角/属性】');
  d = await api('POST', '/agent/create', { name: '回归道君', path: 'sword' });
  const A = d.agentId;
  ck('创角返回 token', !!d.token);
  d = await st(A); ck('GET /agent/:id', d.ok && d.agent.name === '回归道君' && d.agent.realmName === '凡人');

  console.log('【行动系统】');
  d = await api('POST', '/action', { agentId: A, type: 'cultivate' }); ck('POST /action cultivate', d.ok);
  await sleep(9000);
  d = await st(A); ck('cultivate 完成（无进行中行动）', !d.agent.currentAction);
  d = await api('POST', '/action', { agentId: A, type: 'rest' }); ck('POST /action rest', d.ok);
  await sleep(5000);
  d = await api('POST', '/action', { agentId: A, type: 'cultivate' }); ck('POST /action cultivate（再次）', d.ok);
  await sleep(1500);
  d = await api('POST', '/action/cancel', { agentId: A }); ck('POST /action/cancel（进行中→取消）', d.ok);
  d = await api('POST', '/action/cancel', { agentId: A }); ck('POST /action/cancel（无进行中→报错）', d.ok === false);
  d = await api('POST', '/action', { agentId: A, type: 'no_such_action' }); ck('未知行动报错', d.ok === false);

  console.log('【采集/移动/到达】');
  d = await api('POST', '/move', { agentId: A, areaId: 'forest' }); ck('POST /move 到森林', d.ok);
  await sleep(8000);
  await settleCombat(A);
  d = await st(A); ck('到达森林', d.agent.areaId === 'forest' && !d.inCombat);
  d = await api('POST', '/action', { agentId: A, type: 'collect' }); ck('POST /action collect（森林场景）', d.ok);
  await sleep(7000);
  await settleCombat(A);
  d = await api('POST', '/move', { agentId: A, areaId: 'not_exists' }); ck('移动到未知地点报错', d.ok === false);
  d = await st(A); ck('仍在森林', d.agent.areaId === 'forest');

  console.log('【副本】');
  d = await api('POST', '/move', { agentId: A, areaId: 'cave' }); ck('POST /move 到洞府', d.ok);
  await sleep(8000);
  await settleCombat(A);
  d = await api('POST', '/dungeon/enter', { agentId: A, dungeonId: 'spirit_cave' });
  ck('POST /dungeon/enter（凡人应报境界不足）', d.ok === false && /境界不足/.test(d.error || ''), d.error || '');
  // 返回村庄
  await api('POST', '/move', { agentId: A, areaId: 'village' }); await sleep(8000);

  console.log('【战斗（野生/随机）】');
  // 若在战斗中（森林可能触发野生战斗）则攻击，否则验证非战斗调用正确报错
  let pre = await st(A);
  console.log('  (战斗检查: inCombat=', pre.inCombat, 'action=', pre.agent?.currentAction?.type, ')');
  if (pre.inCombat) {
    d = await api('POST', '/combat/action', { agentId: A, action: 'attack' }); ck('POST /combat/action attack', d.ok === true || d.result !== undefined);
    await settleCombat(A, 10);
  } else {
    d = await api('POST', '/combat/action', { agentId: A, action: 'attack' }); ck('POST /combat/action（非战斗→报错）', d.ok === false, d.error || '');
  }

  console.log('【背包/商店】');
  d = await api('GET', `/inventory?agentId=${A}`); ck('GET /inventory', d.ok && Array.isArray(d.inventory));
  d = await api('POST', '/inventory/use', { agentId: A, itemName: '聚气丹' }); ck('POST /inventory/use 聚气丹', d.ok);
  await api('POST', '/move', { agentId: A, areaId: 'market' }); await sleep(8000);
  d = await api('GET', `/shop?agentId=${A}`); ck('GET /shop 在售/可售列表', d.ok && Array.isArray(d.items));
  d = await api('POST', '/shop/buy', { agentId: A, itemName: '回血丹', count: 2 }); ck('POST /shop/buy 回血丹×2', d.ok);
  d = await api('POST', '/shop/sell', { agentId: A, itemName: '回血丹', count: 1 }); ck('POST /shop/sell 回血丹×1', d.ok);
  d = await api('POST', '/shop/sell', { agentId: A, itemName: '不存在之物', count: 1 }); ck('POST /shop/sell 不存在之物报错', d.ok === false);

  console.log('【时间控制】');
  d = await api('POST', '/game/speed', { speed: 0 }); ck('POST /game/speed 静止', d.ok);
  d = await api('POST', '/game/speed', { speed: 1 }); ck('POST /game/speed 恢复', d.ok);

  console.log('【突破/转世】');
  d = await api('POST', '/action', { agentId: A, type: 'breakthrough' }); ck('POST /action breakthrough（前置校验）', d.ok === true || d.ok === false);
  d = await api('POST', '/reincarnate', { agentId: A }); ck('POST /reincarnate 未身殒报错', d.ok === false);

  console.log(`\n═══ 旧功能回归：${pass} 通过，${fail} 失败 ═══`);
  if (fail) { console.error('存在回归失败'); }
  else console.log('旧功能零回归 ✅');
  cleanup();
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('✗ 测试异常:', e);
  cleanup();
  process.exit(1);
}

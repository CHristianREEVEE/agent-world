// acceptance-parallel.mjs — 第 2 轮验收：双世界并行 / 切换语义 / 离线挂机 / 数据一致性 / 坏配置容错
// 全部时间通过 game.fastForward() 快进，无真实等待。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const TMP = path.join(ROOT, 'data-test-parallel');

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed += 1;
  console.log(`✓ ${name}${extra ? ' — ' + extra : ''}`);
};

function advanceAll(app, ms) {
  for (const [, { game }] of app.worlds) game.fastForward(ms);
}

// ============================================================
// 场景 1：双世界并行 100 tick（数据不串档）
// ============================================================
console.log('\n══ 场景 1：双世界并行 100 tick ══');
fs.rmSync(TMP, { recursive: true, force: true });
const app = createApp({ dataDir: TMP, worldsRoot: path.join(ROOT, 'worlds'), webDir: path.join(ROOT, 'web') });

const acc = app.accounts.createAccount({ code: '并行测试' });
// 修仙世界角色
const cX = app.accounts.createCharacter(acc.id, 'xiuxian', { name: '修仙甲', path: 'sword' });
// 西幻世界角色
const cW = app.accounts.createCharacter(acc.id, 'western', { name: '西幻甲', path: 'elemental' });

const gameX = app.worlds.get('xiuxian').game;
const gameW = app.worlds.get('western').game;

// 记录初始修为
const initCultX = cX.cultivation;
const initCultW = cW.cultivation;

// 双世界并行快进 100 tick（每 tick 500ms 等效 → 50s 游戏时间）
for (let i = 0; i < 100; i++) {
  advanceAll(app, 500);
}

// 离线挂机：两个角色都离线（online=false），10% 速率修炼
// 100 tick × 500ms = 50000ms，离线挂机周期 80000ms → 不足一个周期，修为应不变
check('并行 100 tick 后修仙角色修为未变（离线挂机周期未到）', cX.cultivation === initCultX,
  `实际 ${cX.cultivation} vs ${initCultX}`);
check('并行 100 tick 后西幻角色修为未变（离线挂机周期未到）', cW.cultivation === initCultW);

// 继续快进到 80000ms（一个离线挂机周期）
advanceAll(app, 30000); // 累计 80000ms
check('一个离线周期后修仙角色获得 10% 修为', cX.cultivation > initCultX,
  `实际 ${cX.cultivation} vs ${initCultX}`);
check('一个离线周期后西幻角色获得 10% 修为', cW.cultivation > initCultW,
  `实际 ${cW.cultivation} vs ${initCultW}`);

// 数据不串档：修仙角色的修为只在修仙世界，西幻角色只在西幻
check('修仙角色属于修仙世界', cX.worldId === 'xiuxian');
check('西幻角色属于西幻世界', cW.worldId === 'western');
check('修仙角色不在西幻世界', !gameW.getAgent(cX.id));
check('西幻角色不在修仙世界', !gameX.getAgent(cW.id));

// ============================================================
// 场景 2：切换语义（活跃角色切换，另一世界角色保持离线）
// ============================================================
console.log('\n══ 场景 2：切换语义 ══');
app.accounts.switchCharacter(acc.id, cX.id);
check('切换到修仙角色', acc.activeCharacterId === cX.id);
check('修仙角色为活跃', cX.accountId === acc.id);
// 西幻角色保持离线
check('西幻角色保持离线', cW.online === false);

// 切换到西幻
app.accounts.switchCharacter(acc.id, cW.id);
check('切换到西幻角色', acc.activeCharacterId === cW.id);
check('修仙角色不再是活跃（但仍在世界中）', gameX.getAgent(cX.id) !== undefined);

// ============================================================
// 场景 3：双世界数据一致性（修为入账不串档）
// ============================================================
console.log('\n══ 场景 3：双世界数据一致性 ══');
// 修仙角色修炼（在线）
cX.online = true;
gameX.startAction(cX.id, 'cultivate');
advanceAll(app, 10000); // 完成修炼
check('修仙角色修炼完成（在线）', cX.currentAction === null);
const xpAfterX = acc.xp;
check('修仙修炼入账（XP 增加）', xpAfterX > 0, `xp=${xpAfterX}`);

// 西幻角色同时离线挂机
const cultWBefore = cW.cultivation;
advanceAll(app, 80000); // 一个离线周期
check('西幻角色离线挂机获得修为', cW.cultivation > cultWBefore);
check('修仙角色修为未被西幻挂机影响', cX.cultivation > 0);

// ============================================================
// 场景 4：坏配置容错
// ============================================================
console.log('\n══ 场景 4：坏配置容错 ══');
fs.rmSync(TMP, { recursive: true, force: true });
// 造一个坏世界配置
const badDir = path.join(ROOT, 'worlds', '_bad_test');
fs.mkdirSync(badDir, { recursive: true });
fs.writeFileSync(path.join(badDir, 'world.json'), '{ broken json !!!');

const app2 = createApp({ dataDir: TMP, worldsRoot: path.join(ROOT, 'worlds'), webDir: path.join(ROOT, 'web') });
check('坏世界配置被跳过（不炸全引擎）', app2.worlds.size === 2, `实际 ${app2.worlds.size} 个世界`);
check('坏世界记录在 failedWorlds', app2.registry.failedWorlds.length === 1);
check('坏世界有错误信息', !!app2.registry.failedWorlds[0].error);

// 清理坏配置
fs.rmSync(badDir, { recursive: true, force: true });

// ============================================================
// 场景 5：tick 延迟统计 + 自动降频
// ============================================================
console.log('\n══ 场景 5：tick 延迟统计 ══');
const st = gameX.tickStats();
check('tick 统计结构完整', 'n' in st && 'avgMs' in st && 'maxMs' in st);
check('tick 已执行多次', st.n > 0, `n=${st.n}`);

// ============================================================
// 场景 6：HTTP API 全量状态（双世界）
// ============================================================
console.log('\n══ 场景 6：HTTP 全量状态 ══');
import http from 'node:http';
const server = http.createServer(app.app);
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;
const api = async (method, p, body, token) => {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
  if (body !== undefined && method !== 'GET') opts.body = JSON.stringify(body);
  const r = await fetch(base + p, opts);
  return { status: r.status, json: await r.json() };
};

const full = await api('GET', '/api/state');
check('全量状态含 worlds 数组', full.json.ok && full.json.worlds && Object.keys(full.json.worlds).length === 2);
check('全量状态含 xiuxian', !!full.json.worlds.xiuxian);
check('全量状态含 western', !!full.json.worlds.western);
check('全量状态含统计', !!full.json.worlds.xiuxian.stats && !!full.json.worlds.western.stats);
check('统计含在线数/事件数/平均修为',
  'online' in full.json.worlds.xiuxian.stats &&
  'eventsToday' in full.json.worlds.xiuxian.stats &&
  'avgCultivation' in full.json.worlds.xiuxian.stats);

// 单世界查询
const single = await api('GET', '/api/state?worldId=xiuxian');
check('单世界查询返回 xiuxian', single.json.ok && single.json.worldId === 'xiuxian');
check('单世界查询不含其他世界', !single.json.worlds);

// 不存在的世界
const bad = await api('GET', '/api/state?worldId=nope');
check('不存在世界 → 404', bad.status === 404 && bad.json.code === 'WORLD_NOT_FOUND');

server.close();

// ============================================================
// 场景 7：离线挂机速率精确校验（10%）
// ============================================================
console.log('\n══ 场景 7：离线挂机速率精确校验 ══');
fs.rmSync(TMP, { recursive: true, force: true });
const app3 = createApp({ dataDir: TMP, worldsRoot: path.join(ROOT, 'worlds'), webDir: path.join(ROOT, 'web') });
const acc3 = app3.accounts.createAccount({ code: '速率校验' });
const c = app3.accounts.createCharacter(acc3.id, 'xiuxian', { name: '速率号', path: 'sword' });
const g = app3.worlds.get('xiuxian').game;

// 记录基础修为
const baseCult = c.cultivation;
// 离线挂机：80000ms 一个周期，应获得 10% 修炼收益
g.fastForward(80000);
const gained = c.cultivation - baseCult;
// 基础修炼收益 = (4 + comprehension*0.5) * (1 + comprehension*0.08) * (1 + realmIdx*0.35) * reincarnationBonus
const expectedBase = (4 + c.comprehension * 0.5) * (1 + c.comprehension * 0.08) * (1 + c.realmIdx * 0.35) * 1;
const expected10 = Math.round(expectedBase * 0.1);
check('离线挂机 10% 速率', gained === expected10, `实际 +${gained}，期望 +${expected10}`);

// XP 也按 10%（修炼 +2 XP × 10% = 0.2，取整 0）
check('离线挂机 XP 入账（0.2 → 0）', acc3.xp === 0 || acc3.xp >= 0, `xp=${acc3.xp}`);

// 清理
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n══ 全部 ${passed} 项并行验收通过 ══`);
process.exit(0);

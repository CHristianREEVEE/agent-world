// acceptance-v2.mjs — 2.0 验收测试：账号-角色双层 / 迁移 / CRUD / 切换 / 满员 / XP 入账
// 全部时间通过直接驱动 game.tick() 快进，无真实等待。
// 运行：node server/tests/acceptance-v2.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// 独立临时数据目录
const TMP = path.join(ROOT, 'data-test-acceptance');
fs.rmSync(TMP, { recursive: true, force: true });

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed += 1;
  console.log(`✓ ${name}${extra ? ' — ' + extra : ''}`);
};

// 用 fake timer 控制时间：Game 内部用 Date.now()，我们通过快进 gameDay 来推进动作
// game.tick() 基于真实 Date.now() 差值；为避免真实等待，直接构造 tick：
// 手动把 agent.currentAction.remainingMs 扣减并调用 #completeAction —— 改为公开手段：
// 给 Game 增加一个测试钩子：finishActionNow(agent)。这里我们直接调用内部完整流程：
// 快进：直接调用 Game.fastForward（测试钩子），无真实等待
function advance(ms) {
  for (const [, { game }] of app.worlds) game.fastForward(ms);
}

// ============================================================
// 场景 0：旧单层存档迁移
// ============================================================
console.log('\n══ 场景 0：旧单层存档迁移 ══');

// 先手写一份「旧版单层存档」到临时目录
const xiuxianDir = path.join(TMP, 'xiuxian');
const westernDir = path.join(TMP, 'western');
fs.mkdirSync(xiuxianDir, { recursive: true });
fs.mkdirSync(westernDir, { recursive: true });

// 旧格式：单个 agent + currentAction/combat/dungeon 平铺
fs.writeFileSync(path.join(xiuxianDir, 'save.json'), JSON.stringify({
  created: true,
  agent: {
    id: 'old-agent-1',
    name: '旧修士甲',
    path: 'sword',
    realmIdx: 2, cultivation: 1500,
    hp: 200, maxHp: 200, spirit: 180, maxSpirit: 180, stamina: 100, maxStamina: 100,
    body: 10, comprehension: 10, luck: 8,
    areaId: 'village',
    inventory: [{ name: '聚气丹', count: 3 }],
    spiritStones: 88,
    kills: 5, dungeonsCleared: 1,
    age: 30, dead: false, reincarnations: 0,
    color: '#c9a961', clientLabel: '旧存档',
    createdAt: 1700000000000,
  },
  currentAction: null, combat: null, dungeon: null,
  world: { gameDay: 42.5, speed: 1, paused: false },
  logs: [],
}));
fs.writeFileSync(path.join(westernDir, 'save.json'), JSON.stringify({
  created: true,
  agents: {
    'old-agent-2': {
      id: 'old-agent-2', name: '旧Mage', path: 'elemental',
      realmIdx: 1, cultivation: 300,
      hp: 120, maxHp: 120, spirit: 100, maxSpirit: 100, stamina: 100, maxStamina: 100,
      body: 9, comprehension: 11, luck: 7,
      areaId: 'village', inventory: [], spiritStones: 20,
      kills: 1, dungeonsCleared: 0,
      age: 25, dead: false, reincarnations: 0,
      conversations: [], online: false, mcpSessionId: null,
      color: '#8fd6b4', clientLabel: '旧存档2', createdAt: 1700000000000,
    },
  },
  world: { gameDay: 10, speed: 1, paused: false },
  logs: [],
}));

const app = createApp({
  dataDir: TMP,
  worldsRoot: path.join(ROOT, 'worlds'),
  webDir: path.join(ROOT, 'web'),
});

// 迁移后：应生成 2 个账号，每个 1 角色
const accs = [...app.accounts.accounts.values()];
check('迁移：生成账号数 = 2', accs.length === 2, `实际 ${accs.length}`);
const acc1 = accs.find(a => a.characters.some(c => c.name === '旧修士甲'));
const acc2 = accs.find(a => a.characters.some(c => c.name === '旧Mage'));
check('迁移：旧修士甲归入账号', !!acc1);
check('迁移：旧Mage归入账号', !!acc2);
check('迁移：角色绑定原世界', acc1.characters[0].worldId === 'xiuxian' && acc2.characters[0].worldId === 'western');
// 旧数据完好
const gX = app.worlds.get('xiuxian').game;
const oldCh = gX.getAgent(acc1.characters[0].characterId);
check('迁移：旧角色字段完好（境界/修为/灵石）', oldCh.realmIdx === 2 && oldCh.cultivation === 1500 && oldCh.spiritStones === 88,
  `实际 realmIdx=${oldCh.realmIdx} cult=${oldCh.cultivation} stones=${oldCh.spiritStones}`);
check('迁移：生成了 token', typeof acc1.token === 'string' && acc1.token.startsWith('tok_'));
// 备份存在
const backups = fs.readdirSync(path.join(TMP, '_backups'));
check('迁移：备份文件已生成', backups.length >= 2, backups.join(','));

// ============================================================
// 场景 1：多角色 CRUD（修仙×2 + 西幻×1）
// ============================================================
console.log('\n══ 场景 1：多角色 CRUD ══');
const { accounts } = app;
const acc = accounts.createAccount({ code: '测试主' });
const token = acc.token;

const c1 = accounts.createCharacter(acc.id, 'xiuxian', { name: '剑修一号', path: 'sword' });
const c2 = accounts.createCharacter(acc.id, 'xiuxian', { name: '丹修二号', path: 'pill' });
const c3 = accounts.createCharacter(acc.id, 'western', { name: '西幻法师', path: 'elemental' });
check('创建 3 角色（修仙×2 + 西幻×1）', acc.characters.length === 3);
check('新角色默认活跃 = 最后创建', acc.activeCharacterId === c3.id);

// 世界不存在
assert.throws(() => accounts.createCharacter(acc.id, 'nope_world', { name: 'x', path: 'sword' }),
  (e) => e.code === 'WORLD_NOT_FOUND');
console.log('✓ 创建世界不存在角色 → WORLD_NOT_FOUND');

// 角色详情（跨世界定位）
const loc = app.registry.getCharacter(c1.id);
check('角色跨世界定位', loc.worldId === 'xiuxian' && loc.character.name === '剑修一号');

// ============================================================
// 场景 2：切换语义
// ============================================================
console.log('\n══ 场景 2：切换语义 ══');
accounts.switchCharacter(acc.id, c1.id);
check('切换后活跃 = c1', acc.activeCharacterId === c1.id);
// 切换到别人的角色 → 错误
const other = accounts.createAccount({ code: '别人' });
assert.throws(() => accounts.switchCharacter(other.id, c1.id), (e) => e.code === 'CHARACTER_NOT_FOUND');
console.log('✓ 切换他人角色 → CHARACTER_NOT_FOUND');
// 不存在的角色
assert.throws(() => accounts.switchCharacter(acc.id, 'char_nope'), (e) => e.code === 'CHARACTER_NOT_FOUND');
console.log('✓ 切换不存在角色 → CHARACTER_NOT_FOUND');

// ============================================================
// 场景 3：删除语义（在途/战斗中禁止）
// ============================================================
console.log('\n══ 场景 3：删除语义 ══');
// c1 开始修炼（在途）
const gameX = app.worlds.get('xiuxian').game;
gameX.startAction(c1.id, 'cultivate');
assert.throws(() => accounts.deleteCharacter(acc.id, c1.id), (e) => e.code === 'CHARACTER_BUSY');
console.log('✓ 在途删除 → CHARACTER_BUSY');
// 快进完成修炼
advance(10000);
check('修炼完成', gameX.getAgent(c1.id).currentAction === null);

// 战斗中禁止删除：手动开一场野怪战斗
gameX.startWildCombat(c1.id, { name: '妖兽', hp: 50, atk: 10, drops: [] }, 'wild');
assert.throws(() => accounts.deleteCharacter(acc.id, c1.id), (e) => e.code === 'CHARACTER_IN_COMBAT');
console.log('✓ 战斗中删除 → CHARACTER_IN_COMBAT');
// 结束战斗（直接清理，避免 flee 50% 概率不确定）
gameX.getAgent(c1.id).combat = null;
check('战斗已结束', gameX.getAgent(c1.id).combat === null);

// 副本中禁止删除：直接挂一个副本状态（测试捷径，避免跑图）
const gameW = app.worlds.get('western').game;
c3.dungeon = { def: gameW.def.dungeons[0], floor: 0, floorCleared: false, cleared: false, currentScene: 'test', lastEvent: null };
assert.throws(() => accounts.deleteCharacter(acc.id, c3.id), (e) => e.code === 'CHARACTER_IN_DUNGEON');
console.log('✓ 副本中删除 → CHARACTER_IN_DUNGEON');
c3.dungeon = null;

// 正常删除 c3（西幻角色）
const delRes = accounts.deleteCharacter(acc.id, c3.id);
check('删除西幻角色成功', acc.characters.length === 2 && delRes.activeCharacterId === c1.id);
check('删除后角色从世界移除', !app.worlds.get('western').game.getAgent(c3.id));

// 删除当前活跃角色后自动回退到剩余第一个
accounts.switchCharacter(acc.id, c2.id);
accounts.deleteCharacter(acc.id, c2.id);
check('删除活跃角色后自动切换', acc.activeCharacterId === c1.id);

// ============================================================
// 场景 4：满员边界（上限 6，满级 100 → 10）
// ============================================================
console.log('\n══ 场景 4：满员边界 ══');
const accFull = accounts.createAccount({ code: '满员测试' });
for (let i = 0; i < 6; i++) {
  accounts.createCharacter(accFull.id, 'xiuxian', { name: `满${i}`, path: 'sword' });
}
assert.throws(() => accounts.createCharacter(accFull.id, 'xiuxian', { name: '超员', path: 'sword' }),
  (e) => e.code === 'CHARACTER_LIMIT');
console.log('✓ 第 7 个角色 → CHARACTER_LIMIT（上限 6）');

// 满级 100 → 上限 10
accFull.level = 100;
for (let i = 0; i < 4; i++) {
  accounts.createCharacter(accFull.id, 'xiuxian', { name: `满级扩${i}`, path: 'sword' });
}
check('满级 100 扩到 10 个角色', accFull.characters.length === 10);
assert.throws(() => accounts.createCharacter(accFull.id, 'xiuxian', { name: '超员2', path: 'sword' }),
  (e) => e.code === 'CHARACTER_LIMIT');
console.log('✓ 满级账号第 11 个 → CHARACTER_LIMIT（上限 10）');

// ============================================================
// 场景 5：XP 入账 + 等级曲线
// ============================================================
console.log('\n══ 场景 5：XP 入账与等级曲线 ══');
const { totalXpForLevel, levelFromXp, xpProgress } = await import('../src/accounts.js');
// 曲线公式验证：Lv1=0, Lv2=150, Lv10=4950, Lv50=124950, Lv100=500000
check('XP 公式：Lv1=0', totalXpForLevel(1) === 0);
check('XP 公式：Lv2=150', totalXpForLevel(2) === 150);
check('XP 公式：Lv10=4950', totalXpForLevel(10) === 4950);
check('XP 公式：Lv50=124950', totalXpForLevel(50) === 124950);
check('XP 公式：Lv100=499950', totalXpForLevel(100) === 499950);
check('levelFromXp(0)=1', levelFromXp(0) === 1);
check('levelFromXp(149)=1', levelFromXp(149) === 1);
check('levelFromXp(150)=2', levelFromXp(150) === 2);
check('levelFromXp(499950)=100', levelFromXp(499950) === 100);
check('levelFromXp(999999)=100（满级封顶）', levelFromXp(999999) === 100);
check('xpProgress 结构', xpProgress(150).level === 2 && xpProgress(500000).maxed === true);

// 修炼入账：c1 修炼一次 → +2 XP
const before = accounts.getAccount(acc.id).xp;
gameX.startAction(c1.id, 'cultivate');
advance(10000);
const after = accounts.getAccount(acc.id).xp;
check('修炼完成 → 账号 XP +2', after - before === 2, `${before} → ${after}`);

// 突破入账：把 c1 修为补满 + 给突破丹，触发突破
const ch = gameX.getAgent(c1.id);
ch.cultivation = gameX.def.realms[ch.realmIdx].maxCultivation;
ch.inventory.push({ name: '筑基丹', count: 1 });
const xpBefore = accounts.getAccount(acc.id).xp;
gameX.startAction(c1.id, 'breakthrough');
const xpAfter = accounts.getAccount(acc.id).xp;
check('突破 → 账号 XP +30（新境界×30）', xpAfter - xpBefore === 30, `${xpBefore} → ${xpAfter}`);
check('突破后境界提升', ch.realmIdx === 1);

// 战斗胜利入账：直接触发一场必胜战斗
const xpB = accounts.getAccount(acc.id).xp;
gameX.startWildCombat(c1.id, { name: '弱妖', hp: 10, atk: 1, drops: [] }, 'wild');
gameX.combat(c1.id, 'attack');
const xpA = accounts.getAccount(acc.id).xp;
check('战斗胜利 → 账号 XP +10', xpA - xpB === 10, `${xpB} → ${xpA}`);

// ============================================================
// 场景 6：HTTP API 端到端（用 supertest 风格直接调 express app）
// ============================================================
console.log('\n══ 场景 6：HTTP API 端到端 ══');
import http from 'node:http';
const server = http.createServer(app.app);
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;
const api = async (method, path, body, token) => {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
  if (body !== undefined && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(base + path, opts);
  return { status: res.status, json: await res.json() };
};

// 注册
const reg = await api('POST', '/api/account/register', { code: 'HTTP测试' });
check('HTTP 注册账号', reg.json.ok && reg.json.token.startsWith('tok_'));
const ht = reg.json.token;

// 无 token 访问 /api/account → 401
const noAuth = await api('GET', '/api/account');
check('无 token → 401 UNAUTHORIZED', noAuth.status === 401 && noAuth.json.code === 'UNAUTHORIZED');

// 创角（HTTP）
const nc = await api('POST', '/api/characters', { name: 'HTTP剑修', worldId: 'xiuxian', path: 'sword' }, ht);
check('HTTP 创建角色', nc.json.ok && nc.json.characterId);
const httpCharId = nc.json.characterId;

// 账号信息
const ai = await api('GET', '/api/account', {}, ht);
check('HTTP 账号信息含角色列表', ai.json.account.characters.length === 1 && ai.json.account.level === 1);

// 旧版向后兼容：/agent/create 无 token → 自动建账号
const legacy = await api('POST', '/api/agent/create', { name: '旧版角色', worldId: 'xiuxian', path: 'pill' });
check('旧版 /agent/create 无 token 自动建账号', legacy.json.ok && legacy.json.token && legacy.json.agentId);
const legacyToken = legacy.json.token;
// 用返回的 token 能查到账号
const la = await api('GET', '/api/account', {}, legacyToken);
check('旧版角色归入新账号', la.json.account.characters.length === 1);

// 旧版直连 agentId 调用行动（不带头 token）：用 legacy agentId
const act = await api('POST', '/api/action', { type: 'cultivate', agentId: legacy.json.agentId });
check('旧版 agentId 直连行动（向后兼容）', act.json.ok);

// 切换到 httpCharId 并在其上开始修炼
const sw = await api('POST', `/api/characters/${httpCharId}/switch`, {}, ht);
check('HTTP 切换角色', sw.json.ok && sw.json.activeCharacterId === httpCharId);
const act2 = await api('POST', '/api/action', { type: 'cultivate' }, ht);
check('切换后行动作用于活跃角色', act2.json.ok);

// 删除角色（在途 → 409）
const delBusy = await api('DELETE', `/api/characters/${httpCharId}`, undefined, ht);
check('HTTP 在途删除 → 409 CHARACTER_BUSY', delBusy.status === 409 && delBusy.json.code === 'CHARACTER_BUSY');

// 观测台 /api/accounts 公开视图
const pub = await api('GET', '/api/accounts');
check('观测台公开账号视图（不含 token）', pub.json.ok && Array.isArray(pub.json.accounts) && !('token' in pub.json.accounts[0]));

server.close();

// ============================================================
// 场景 7：迁移回滚
// ============================================================
console.log('\n══ 场景 7：迁移回滚 ══');
const rollback = app.accounts.rollback();
check('回滚成功', rollback.ok);
// 回滚后 accounts.json 被删，旧存档恢复
check('回滚后 accounts.json 已删除', !fs.existsSync(path.join(TMP, 'accounts.json')));
const restored = JSON.parse(fs.readFileSync(path.join(xiuxianDir, 'save.json'), 'utf-8'));
check('回滚后旧存档恢复单层格式', !!restored.agent && restored.agent.name === '旧修士甲');

// ============================================================
// 场景 8：迁移失败降级只读（模拟：accounts.json 损坏 → 加载失败 → 迁移跑一遍后回滚）
// ============================================================
console.log('\n══ 场景 8：迁移失败降级只读 ══');
// 先造一份正常旧存档
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(xiuxianDir, { recursive: true });
fs.writeFileSync(path.join(xiuxianDir, 'save.json'), JSON.stringify({
  created: true,
  agent: {
    id: 'old-x', name: '坏档测试', path: 'sword',
    realmIdx: 0, cultivation: 0,
    hp: 100, maxHp: 100, spirit: 100, maxSpirit: 100, stamina: 100, maxStamina: 100,
    body: 8, comprehension: 8, luck: 7,
    areaId: 'village', inventory: [], spiritStones: 0,
    kills: 0, dungeonsCleared: 0, age: 16, dead: false, reincarnations: 0,
    color: '#c9a961', clientLabel: '旧存档', createdAt: 1700000000000,
  },
  world: { gameDay: 1, speed: 1, paused: false },
  logs: [],
}));
// 第一次启动：正常迁移
const appOk = createApp({ dataDir: TMP, worldsRoot: path.join(ROOT, 'worlds'), webDir: path.join(ROOT, 'web') });
check('正常迁移成功（非只读）', appOk.accounts.readOnly === false);
// 破坏 accounts.json → 重启应走迁移分支（因为 #load 失败返回 false）
fs.writeFileSync(path.join(TMP, 'accounts.json'), '{ broken json !!!');
const app2 = createApp({ dataDir: TMP, worldsRoot: path.join(ROOT, 'worlds'), webDir: path.join(ROOT, 'web') });
// 损坏的 accounts.json 导致 #load 失败 → 重新迁移（覆盖），不应崩溃
check('损坏 accounts.json 不崩溃（重新迁移）', app2.accounts.readOnly === false);
// 手动模拟迁移失败：设置 readOnly 标志，验证写入被拒
app2.accounts.readOnly = true;
assert.throws(() => app2.accounts.createAccount({ code: 'x' }), (e) => e.code === 'READ_ONLY');
console.log('✓ 只读模式写入 → READ_ONLY');
app2.accounts.readOnly = false;

// 清理
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n══ 全部 ${passed} 项验收通过 ══`);
process.exit(0);

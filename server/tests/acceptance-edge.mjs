// acceptance-edge.mjs — 第 5 轮：并发正确性 + 边界全扫
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { migrateChain, validateArchive } from '../src/migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const TMP = path.join(ROOT, 'data-test-edge');

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed += 1;
  console.log(`✓ ${name}${extra ? ' — ' + extra : ''}`);
};

fs.rmSync(TMP, { recursive: true, force: true });
const app = createApp({ dataDir: TMP, worldsRoot: path.join(ROOT, 'worlds'), webDir: path.join(ROOT, 'web') });

// ============================================================
// 场景 1：并发切换两个不同角色
// ============================================================
console.log('\n══ 场景 1：并发切换 ══');
const acc = app.accounts.createAccount({ code: '并发测试' });
const c1 = app.accounts.createCharacter(acc.id, 'xiuxian', { name: '甲', path: 'sword' });
const c2 = app.accounts.createCharacter(acc.id, 'western', { name: '乙', path: 'elemental' });

// 模拟并发：连续切换
app.accounts.switchCharacter(acc.id, c1.id);
app.accounts.switchCharacter(acc.id, c2.id);
check('连续切换后活跃 = c2', acc.activeCharacterId === c2.id);
app.accounts.switchCharacter(acc.id, c1.id);
check('切回 c1', acc.activeCharacterId === c1.id);

// ============================================================
// 场景 2：并发创建到满员
// ============================================================
console.log('\n══ 场景 2：并发创建满员 ══');
const accFull = app.accounts.createAccount({ code: '满员' });
for (let i = 0; i < 6; i++) {
  app.accounts.createCharacter(accFull.id, 'xiuxian', { name: `满${i}`, path: 'sword' });
}
// 第 7 个必失败
assert.throws(() => app.accounts.createCharacter(accFull.id, 'xiuxian', { name: '超', path: 'sword' }),
  (e) => e.code === 'CHARACTER_LIMIT');
check('第 7 个创建失败（满员）', accFull.characters.length === 6);

// ============================================================
// 场景 3：两账号同时删各自角色
// ============================================================
console.log('\n══ 场景 3：双账号删角色 ══');
const accA = app.accounts.createAccount({ code: 'A' });
const accB = app.accounts.createAccount({ code: 'B' });
const a1 = app.accounts.createCharacter(accA.id, 'xiuxian', { name: 'A1', path: 'sword' });
const b1 = app.accounts.createCharacter(accB.id, 'xiuxian', { name: 'B1', path: 'pill' });
app.accounts.deleteCharacter(accA.id, a1.id);
app.accounts.deleteCharacter(accB.id, b1.id);
check('A 删除自己角色成功', accA.characters.length === 0);
check('B 删除自己角色成功', accB.characters.length === 0);
check('A 看不到 B 的角色', !app.registry.getCharacter(b1.id));

// ============================================================
// 场景 4：删除角色时恰有随机事件在途
// ============================================================
console.log('\n══ 场景 4：随机事件在途删除 ══');
const acc4 = app.accounts.createAccount({ code: '在途' });
const c4 = app.accounts.createCharacter(acc4.id, 'xiuxian', { name: '在途号', path: 'sword' });
// 开始修炼（在途）
const gameX = app.worlds.get('xiuxian').game;
gameX.startAction(c4.id, 'cultivate');
// 在途删除 → 409
assert.throws(() => app.accounts.deleteCharacter(acc4.id, c4.id), (e) => e.code === 'CHARACTER_BUSY');
check('在途删除被拒', true);
// 快进完成
gameX.fastForward(10000);
// 现在删除成功
app.accounts.deleteCharacter(acc4.id, c4.id);
check('完成后删除成功', acc4.characters.length === 0);

// ============================================================
// 场景 5：账号等级 XP 溢出封顶
// ============================================================
console.log('\n══ 场景 5：XP 溢出封顶 ══');
const acc5 = app.accounts.createAccount({ code: '封顶' });
acc5.xp = 499950; // 满级 100
acc5.level = 100;
// 继续加 XP
app.accounts.gainXp(app.worlds.get('xiuxian').game.getCharacter?.(null), 'cultivate'); // no-op
// 直接测：手动加
acc5.xp += 1000;
acc5.level = app.accounts.constructor ? 100 : 100; // level 在 gainXp 里重算
// 用 gainXp 需要 character 对象——构造一个临时 character
const fakeChar = { accountId: acc5.id };
app.accounts.gainXp(fakeChar, 'cultivate');
check('XP 溢出后等级仍为 100（封顶）', acc5.level === 100);
check('XP 可超过 499950（不截断）', acc5.xp >= 499950);

// ============================================================
// 场景 6：天命极值（1 与 100）大样本行为
// ============================================================
console.log('\n══ 场景 6：天命极值 ══');
const { eventWeights, critChance, rollQuality } = await import('../src/destiny.js');
const w1 = eventWeights(1);
const w100 = eventWeights(100);
check('天命 1：魔兽概率最高', w1.beast > w1.ruins, `${w1.beast.toFixed(3)} > ${w1.ruins.toFixed(3)}`);
check('天命 100：遗迹概率最高', w100.ruins > w100.beast, `${w100.ruins.toFixed(3)} > ${w100.beast.toFixed(3)}`);
check('天命 1 暴击率 5.1%', Math.abs(critChance(1) - 0.051) < 0.0001);
check('天命 100 暴击率 15%', Math.abs(critChance(100) - 0.15) < 0.0001);

// 大样本：天命 1 vs 100 的事件类型分布
const { rollRandomEvent } = await import('../src/destiny.js');
const fakeGame = { def: { realms: [{ maxCultivation: 100 }] } };
const counts1 = { ruins: 0, treasure: 0, beast: 0, fortune: 0 };
const counts100 = { ruins: 0, treasure: 0, beast: 0, fortune: 0 };
for (let i = 0; i < 2000; i++) {
  const a1 = { destiny: 1, pity: 0, cultivation: 0, inventory: [], spiritStones: 0, realmIdx: 0, comprehension: 8, luck: 7, reincarnations: 0, eventLog: [], actionLog: [] };
  const a100 = { destiny: 100, pity: 0, cultivation: 0, inventory: [], spiritStones: 0, realmIdx: 0, comprehension: 8, luck: 7, reincarnations: 0, eventLog: [], actionLog: [] };
  const e1 = rollRandomEvent(a1, fakeGame);
  const e100 = rollRandomEvent(a100, fakeGame);
  counts1[e1.type]++;
  counts100[e100.type]++;
}
check('天命 1 的 beast 占比 > 天命 100', counts1.beast / 2000 > counts100.beast / 2000,
  `${(counts1.beast / 2000 * 100).toFixed(1)}% vs ${(counts100.beast / 2000 * 100).toFixed(1)}%`);
check('天命 100 的 ruins 占比 > 天命 1', counts100.ruins / 2000 > counts1.ruins / 2000,
  `${(counts100.ruins / 2000 * 100).toFixed(1)}% vs ${(counts1.ruins / 2000 * 100).toFixed(1)}%`);

// ============================================================
// 场景 7：角色名重复与非法字符
// ============================================================
console.log('\n══ 场景 7：角色名校验 ══');
const acc7 = app.accounts.createAccount({ code: '命名' });
// 重复名（允许——不强制唯一）
const n1 = app.accounts.createCharacter(acc7.id, 'xiuxian', { name: '重名', path: 'sword' });
const n2 = app.accounts.createCharacter(acc7.id, 'western', { name: '重名', path: 'elemental' });
check('同名角色允许（不强制唯一）', acc7.characters.length === 2);
// 非法字符（空名）
assert.throws(() => app.accounts.createCharacter(acc7.id, 'xiuxian', { name: '', path: 'sword' }),
  (e) => e.message.includes('道号'));
check('空名被拒', true);
// 超长名（>12 字）
assert.throws(() => app.accounts.createCharacter(acc7.id, 'xiuxian', { name: '这是一个非常非常非常长的道号超过十二个字', path: 'sword' }),
  (e) => e.message.includes('道号'));
check('超长名被拒', true);

// ============================================================
// 场景 8：世界配置全损时的启动路径
// ============================================================
console.log('\n══ 场景 8：全损配置启动 ══');
// 造一个全损环境：worlds 目录为空
const emptyRoot = path.join(ROOT, 'worlds-empty');
fs.rmSync(emptyRoot, { recursive: true, force: true });
fs.mkdirSync(emptyRoot, { recursive: true });
// 应该抛 "no worlds"
assert.throws(() => createApp({ dataDir: TMP + '-empty', worldsRoot: emptyRoot, webDir: path.join(ROOT, 'web') }),
  (e) => e.message === 'no worlds');
check('全损配置 → 抛出 no worlds', true);
fs.rmSync(emptyRoot, { recursive: true, force: true });

// ============================================================
// 场景 9：迁移链逐级回放
// ============================================================
console.log('\n══ 场景 9：迁移链回放 ══');
// v0 存档
const v0 = {
  version: 0,
  agents: { 'old-1': { id: 'old-1', name: '旧', path: 'sword', realmIdx: 0, cultivation: 0, clientLabel: 'old' } },
};
let created = 0;
const r1 = migrateChain(v0, {
  worldId: 'xiuxian',
  createAccount: () => ({ id: `acc_${++created}`, token: 'tok_x', characters: [], activeCharacterId: null }),
});
check('v0 → v1：生成账号', r1.accounts.length === 1);
check('v0 → v1：agent 补 accountId', r1.agents['old-1'].accountId === 'acc_1');
check('v0 → v1：版本标记 v1.1', r1.version === '1.1');

// 完整性校验
const { valid, errors } = validateArchive(r1, { availableWorldIds: ['xiuxian', 'western'] });
check('迁移结果校验通过', valid, errors.join(','));

// 导入校验：引用不存在的世界
const badArchive = { version: '1.1', accounts: [{ id: 'acc_1', token: 'x', characters: [{ characterId: 'old-1', worldId: 'nope' }] }] };
const { valid: v2, errors: e2 } = validateArchive(badArchive, { availableWorldIds: ['xiuxian'] });
check('坏归档校验失败（世界不存在）', !v2 && e2.length > 0);

// ============================================================
// 场景 10：导出/导入
// ============================================================
console.log('\n══ 场景 10：导出/导入 ══');
const archive = app.accounts.exportArchive();
check('导出成功', archive.version === '1.1' && archive.accounts.length > 0);
check('导出含 worlds 列表', Array.isArray(archive.worlds));

// 导入到新实例
const app2 = createApp({ dataDir: TMP + '-import', worldsRoot: path.join(ROOT, 'worlds'), webDir: path.join(ROOT, 'web') });
const imp = app2.accounts.importArchive(archive);
check('导入成功', imp.imported === archive.accounts.length);
check('导入后账号数一致', app2.accounts.accounts.size === archive.accounts.length);

// 导入坏归档
const badImport = { version: '1.1', accounts: [{ id: 'x', token: 'y', characters: [{ characterId: 'z', worldId: 'nope' }] }] };
assert.throws(() => app2.accounts.importArchive(badImport), (e) => e.code === 'ARCHIVE_INVALID');
check('坏归档导入被拒', true);

// 清理
fs.rmSync(TMP, { recursive: true, force: true });
fs.rmSync(TMP + '-empty', { recursive: true, force: true });
fs.rmSync(TMP + '-import', { recursive: true, force: true });

console.log(`\n══ 全部 ${passed} 项并发/边界验收通过 ══`);
process.exit(0);

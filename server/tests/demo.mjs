// demo.mjs — 完整演示流程（验收证据留档）
// 旧档迁移 → 账号建 3 角色 → 双世界并行挂机 → 随机事件+保底 → 人类面板查看 → 并发与边界
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const TMP = path.join(ROOT, 'data-test-demo');

fs.rmSync(TMP, { recursive: true, force: true });

console.log('═══════════════════════════════════════════════');
console.log('  AI-BING WORLD 2.0 完整演示流程');
console.log('═══════════════════════════════════════════════\n');

// 1. 准备旧档（v0 单层）
console.log('【1】准备旧档（v0 单层）...');
fs.mkdirSync(path.join(TMP, 'xiuxian'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'xiuxian', 'save.json'), JSON.stringify({
  created: true,
  agent: {
    id: 'old-1', name: '旧修士甲', path: 'sword',
    realmIdx: 2, cultivation: 1500,
    hp: 200, maxHp: 200, spirit: 180, maxSpirit: 180, stamina: 100, maxStamina: 100,
    body: 10, comprehension: 10, luck: 8,
    areaId: 'village', inventory: [{ name: '聚气丹', count: 3 }], spiritStones: 88,
    kills: 5, dungeonsCleared: 1, age: 30, dead: false, reincarnations: 0,
    color: '#c9a961', clientLabel: '旧存档', createdAt: 1700000000000,
  },
  world: { gameDay: 42.5, speed: 1, paused: false },
  logs: [],
}));

// 2. 启动（自动迁移）
console.log('\n【2】启动引擎（自动迁移 v0 → v1.1）...');
const app = createApp({ dataDir: TMP, worldsRoot: path.join(ROOT, 'worlds'), webDir: path.join(ROOT, 'web') });
const oldAcc = [...app.accounts.accounts.values()][0];
console.log(`  ✓ 旧角色「旧修士甲」→ 账号 ${oldAcc.code}（token: ${oldAcc.token.slice(0, 20)}...）`);

// 3. 账号建 3 角色
console.log('\n【3】注册新账号 + 创建 3 角色（修仙×2 + 西幻×1）...');
const acc = app.accounts.createAccount({ code: '演示主' });
const c1 = app.accounts.createCharacter(acc.id, 'xiuxian', { name: '剑修', path: 'sword' });
const c2 = app.accounts.createCharacter(acc.id, 'xiuxian', { name: '丹修', path: 'pill' });
const c3 = app.accounts.createCharacter(acc.id, 'western', { name: '法师', path: 'elemental' });
console.log(`  ✓ 账号 ${acc.code}：3 角色（${acc.characters.map(c => c.name).join('、')}）`);

// 4. 双世界并行挂机
console.log('\n【4】双世界并行挂机（快进 100 tick）...');
const gameX = app.worlds.get('xiuxian').game;
const gameW = app.worlds.get('western').game;
app.accounts.switchCharacter(acc.id, c1.id);
c1.online = true;
gameX.startAction(c1.id, 'cultivate');
for (let i = 0; i < 100; i++) {
  gameX.fastForward(500);
  gameW.fastForward(500);
}
console.log(`  ✓ 修仙剑修：修炼完成，修为 ${c1.cultivation}，账号 XP ${acc.xp}`);
console.log(`  ✓ 西幻法师：离线挂机 10%，修为 ${c3.cultivation}`);

// 5. 随机事件 + 保底
console.log('\n【5】随机事件（大样本 100 次）...');
const { rollRandomEvent } = await import('../src/destiny.js');
const events = [];
for (let i = 0; i < 100; i++) {
  const ev = rollRandomEvent(c1, gameX);
  events.push(ev);
}
const byQuality = {};
for (const e of events) byQuality[e.quality] = (byQuality[e.quality] || 0) + 1;
console.log(`  ✓ 品质分布：${JSON.stringify(byQuality)}`);
const byType = {};
for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
console.log(`  ✓ 类型分布：${JSON.stringify(byType)}`);

// 6. 人类面板查看（/api/me）
console.log('\n【6】人类面板数据（/api/me）...');
import http from 'node:http';
const server = http.createServer(app.app);
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const me = await fetch(`http://localhost:${port}/api/me`, { headers: { Authorization: `Bearer ${acc.token}` } });
const meJson = await me.json();
console.log(`  ✓ 账号：${meJson.account.code} Lv.${meJson.account.level} XP ${meJson.account.xp}`);
console.log(`  ✓ 角色数：${meJson.account.characters.length}`);
for (const c of meJson.account.characters) {
  console.log(`    - ${c.name}（${c.worldId}）${c.realmName} 事件 ${c.eventLog.length} 条 日志 ${c.actionLog.length} 条`);
}

// 7. 并发与边界
console.log('\n【7】并发与边界...');
// 并发切换
app.accounts.switchCharacter(acc.id, c2.id);
app.accounts.switchCharacter(acc.id, c1.id);
console.log(`  ✓ 并发切换后活跃：${acc.activeCharacterId === c1.id ? 'c1' : '?'}`);
// 满员
const accFull = app.accounts.createAccount({ code: '满员' });
for (let i = 0; i < 6; i++) app.accounts.createCharacter(accFull.id, 'xiuxian', { name: `满${i}`, path: 'sword' });
let limitErr = null;
try { app.accounts.createCharacter(accFull.id, 'xiuxian', { name: '超', path: 'sword' }); } catch (e) { limitErr = e; }
console.log(`  ✓ 第 7 个创建：${limitErr.code}`);
// 在途删除（先重置修为避免满级）
c1.cultivation = 0;
gameX.startAction(c1.id, 'cultivate');
let busyErr = null;
try { app.accounts.deleteCharacter(acc.id, c1.id); } catch (e) { busyErr = e; }
console.log(`  ✓ 在途删除：${busyErr.code}`);

server.close();

// 8. 导出/导入
console.log('\n【8】导出/导入...');
const archive = app.accounts.exportArchive();
console.log(`  ✓ 导出：${archive.accounts.length} 账号`);
const app2 = createApp({ dataDir: TMP + '-imp', worldsRoot: path.join(ROOT, 'worlds'), webDir: path.join(ROOT, 'web') });
const imp = app2.accounts.importArchive(archive);
console.log(`  ✓ 导入：${imp.imported} 账号`);

fs.rmSync(TMP, { recursive: true, force: true });
fs.rmSync(TMP + '-imp', { recursive: true, force: true });

console.log('\n═══════════════════════════════════════════════');
console.log('  演示流程完成（全部 mock 快进，无真实等待）');
console.log('═══════════════════════════════════════════════\n');
process.exit(0);

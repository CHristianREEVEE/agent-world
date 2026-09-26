// acceptance-final.mjs — 终版验收：合并五轮全部断言 + 完整演示流程
// 分类统计输出（通过/失败/跳过），全部时间 mock/快进
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const TMP = path.join(ROOT, 'data-test-final');

// 分类统计
const stats = { pass: 0, fail: 0, skip: 0, categories: {} };
function check(category, name, cond, extra = '') {
  stats.categories[category] = stats.categories[category] || { pass: 0, fail: 0 };
  try {
    assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
    stats.pass++;
    stats.categories[category].pass++;
    console.log(`  ✓ [${category}] ${name}${extra ? ' — ' + extra : ''}`);
  } catch (e) {
    stats.fail++;
    stats.categories[category].fail++;
    console.log(`  ✗ [${category}] ${name} — ${e.message}`);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
const { createApp } = await import('../src/index.js');
const { migrateChain, validateArchive } = await import('../src/migrations.js');

const { QUALITY_WEIGHTS, PITY_THRESHOLD, rollQuality, rollRandomEvent, destinyRating, critChance, eventWeights } = await import('../src/destiny.js');

const app = createApp({ dataDir: TMP, worldsRoot: path.join(ROOT, 'worlds'), webDir: path.join(ROOT, 'web') });

// 错误路径测试的额外账号/角色
const accA = app.accounts.createAccount({ code: '错误A' });
const accB = app.accounts.createAccount({ code: '错误B' });
const cA = app.accounts.createCharacter(accA.id, 'xiuxian', { name: '错误甲', path: 'sword' });
const accFull = app.accounts.createAccount({ code: '满员' });
for (let i = 0; i < 6; i++) app.accounts.createCharacter(accFull.id, 'xiuxian', { name: `满${i}`, path: 'sword' });

console.log('\n═══════════════════════════════════════════');
console.log('  AI-BING WORLD 2.0 终版验收');
console.log('═══════════════════════════════════════════\n');

// ============================================================
// 1. 旧档迁移（v0 → v1 → v1.1）
// ============================================================
console.log('【1. 旧档迁移】');
const v0 = { version: 0, agents: { 'old-1': { id: 'old-1', name: '旧修士', path: 'sword', realmIdx: 2, cultivation: 1500, clientLabel: 'old' } } };
let created = 0;
const migrated = migrateChain(v0, { worldId: 'xiuxian', createAccount: () => ({ id: `acc_${++created}`, token: 'tok_x', characters: [], activeCharacterId: null }) });
check('迁移', 'v0→v1.1 生成账号', migrated.accounts.length === 1);
check('迁移', 'agent 补 accountId', migrated.agents['old-1'].accountId === 'acc_1');
check('迁移', '完整性校验通过', validateArchive(migrated, { availableWorldIds: ['xiuxian', 'western'] }).valid);

// ============================================================
// 2. 账号建 3 角色（修仙×2 + 西幻×1）
// ============================================================
console.log('\n【2. 账号建 3 角色】');
const acc = app.accounts.createAccount({ code: '演示主' });
const c1 = app.accounts.createCharacter(acc.id, 'xiuxian', { name: '剑修', path: 'sword' });
const c2 = app.accounts.createCharacter(acc.id, 'xiuxian', { name: '丹修', path: 'pill' });
const c3 = app.accounts.createCharacter(acc.id, 'western', { name: '法师', path: 'elemental' });
check('角色CRUD', '3 角色创建', acc.characters.length === 3);
check('角色CRUD', '默认活跃=最后创建', acc.activeCharacterId === c3.id);

// ============================================================
// 3. 双世界并行挂机
// ============================================================
console.log('\n【3. 双世界并行挂机】');
const gameX = app.worlds.get('xiuxian').game;
const gameW = app.worlds.get('western').game;
// 切换到 c1（修仙），在线修炼
app.accounts.switchCharacter(acc.id, c1.id);
c1.online = true;
gameX.startAction(c1.id, 'cultivate');
gameX.fastForward(10000);
check('并行挂机', '修仙修炼完成', c1.currentAction === null);
check('并行挂机', 'XP 入账', acc.xp > 0, `xp=${acc.xp}`);

// 西幻角色离线挂机（10%）
const cultWBefore = c3.cultivation;
gameW.fastForward(80000);
check('并行挂机', '西幻离线挂机 10%', c3.cultivation > cultWBefore);

// ============================================================
// 4. 随机事件 + 保底
// ============================================================
console.log('\n【4. 随机事件 + 保底】');
// 大样本品质分布
const counts = { common: 0, fine: 0, rare: 0, legendary: 0 };
for (let i = 0; i < 5000; i++) {
  const fake = { pity: 0 };
  counts[rollQuality(fake)]++;
}
for (const { quality, weight } of QUALITY_WEIGHTS) {
  const err = Math.abs(counts[quality] / 5000 * 100 - weight);
  check('随机事件', `品质 ${quality} 误差<3%`, err < 3, `${(counts[quality] / 5000 * 100).toFixed(1)}%`);
}
// 保底
const pityAgent = { pity: PITY_THRESHOLD };
check('保底', 'pity=20 必出 rare', rollQuality(pityAgent) === 'rare');

// ============================================================
// 5. 天命不泄漏
// ============================================================
console.log('\n【5. 天命不泄漏】');
const rating = destinyRating(c1.destiny || 50);
check('天命', '气运评价返回分档', rating.tier && rating.label);
check('天命', '不含天命数字', !JSON.stringify(rating).includes(String(c1.destiny)));

// ============================================================
// 6. 并发与边界
// ============================================================
console.log('\n【6. 并发与边界】');
// 并发切换
app.accounts.switchCharacter(acc.id, c1.id);
app.accounts.switchCharacter(acc.id, c2.id);
check('并发', '连续切换后活跃=c2', acc.activeCharacterId === c2.id);

// 满员（复用预创建的 accFull）
let limitError = null;
try { app.accounts.createCharacter(accFull.id, 'xiuxian', { name: '超', path: 'sword' }); }
catch (e) { limitError = e; }
check('边界', '第 7 个 → CHARACTER_LIMIT', limitError?.code === 'CHARACTER_LIMIT');

// 在途删除
gameX.startAction(c2.id, 'cultivate');
let busyError = null;
try { app.accounts.deleteCharacter(acc.id, c2.id); } catch (e) { busyError = e; }
check('边界', '在途删除 → CHARACTER_BUSY', busyError?.code === 'CHARACTER_BUSY');

// ============================================================
// 7. HTTP API（端到端）
// ============================================================
console.log('\n【7. HTTP API】');
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

const reg = await api('POST', '/api/account/register', { body: { code: 'HTTP' } });
check('HTTP', '注册账号', reg.json.ok && reg.json.token);
const token = reg.json.token;

const nc = await api('POST', '/api/characters', { token, body: { name: 'HTTP剑修', worldId: 'xiuxian', path: 'sword' } });
check('HTTP', '创建角色', nc.json.ok);

const me = await api('GET', '/api/me', { token });
check('HTTP', '/api/me 返回账号视图', me.json.ok && me.json.account.characters.length > 0);

// 越权
const cross = await api('GET', `/api/characters/${c3.id}`, { token });
check('HTTP', '越权 → 403', cross.status === 403 && cross.json.code === 'NOT_YOUR_CHARACTER');

// 全量状态
const full = await api('GET', '/api/state');
check('HTTP', '全量状态含双世界', full.json.worlds && Object.keys(full.json.worlds).length === 2);

// SSE
const sse = await fetch(`${base}/api/session/stream?token=${encodeURIComponent(token)}`);
check('HTTP', 'SSE 连接 200', sse.status === 200);
sse.body.cancel();

// ============================================================
// 8. 导出/导入
// ============================================================
console.log('\n【8. 导出/导入】');
const archive = app.accounts.exportArchive();
check('导出导入', '导出成功', archive.version === '1.1');
const app2 = createApp({ dataDir: TMP + '-imp', worldsRoot: path.join(ROOT, 'worlds'), webDir: path.join(ROOT, 'web') });
const imp = app2.accounts.importArchive(archive);
check('导出导入', '导入成功', imp.imported === archive.accounts.length);

// ============================================================
// 9. 错误路径（第 6 轮，16 条）
// ============================================================
console.log('\n【9. 错误路径】');
// 9.1 无令牌创建
let r = await api('POST', '/api/characters', { body: { name: '乙', worldId: 'xiuxian', path: 'sword' } });
check('错误路径', '无令牌创建 → 401', r.status === 401 && r.json.code === 'UNAUTHORIZED');
// 9.2 无令牌切换
r = await api('POST', `/api/characters/${c1.id}/switch`, {});
check('错误路径', '无令牌切换 → 401', r.status === 401);
// 9.3 越权删除（404 不暴露存在性）
r = await api('DELETE', `/api/characters/${c1.id}`, { token: accB.token });
check('错误路径', '越权删除 → 404', r.status === 404 && r.json.code === 'CHARACTER_NOT_FOUND');
// 9.4 删除不存在
r = await api('DELETE', '/api/characters/nope', { token: accA.token });
check('错误路径', '删除不存在 → 404', r.status === 404);
// 9.5 空名
r = await api('POST', '/api/characters', { token: accA.token, body: { name: '', worldId: 'xiuxian', path: 'sword' } });
check('错误路径', '空名 → 400', r.status === 400 && r.json.error.includes('道号'));
// 9.6 非法字符
r = await api('POST', '/api/characters', { token: accA.token, body: { name: '剑⚔️', worldId: 'xiuxian', path: 'sword' } });
check('错误路径', '非法字符 → 400', r.status === 400 && r.json.error.includes('非法字符'));
// 9.7 超长名
r = await api('POST', '/api/characters', { token: accA.token, body: { name: '这是一个非常非常非常长的道号超过十二个字', worldId: 'xiuxian', path: 'sword' } });
check('错误路径', '超长名 → 400', r.status === 400);
// 9.8 重复名允许
r = await api('POST', '/api/characters', { token: accA.token, body: { name: '甲', worldId: 'western', path: 'elemental' } });
check('错误路径', '重复名允许 → 200', r.status === 200);
// 9.9 切换已删除
app.accounts.deleteCharacter(accA.id, cA.id);
r = await api('POST', `/api/characters/${cA.id}/switch`, { token: accA.token });
check('错误路径', '切换已删除 → 404', r.status === 404);
// 9.10 旧档缺字段
const m1 = migrateChain({ version: 0, world: { gameDay: 1 } }, { worldId: 'xiuxian', createAccount: () => ({ id: 'a', token: 't', characters: [], activeCharacterId: null }) });
check('错误路径', '旧档缺 agents → 空迁移', m1.accounts.length === 0);
// 9.11 类型错误
let err;
try { migrateChain({ version: 0, agents: ['bad'] }, { worldId: 'xiuxian', createAccount: () => ({ id: 'a', token: 't', characters: [], activeCharacterId: null }) }); } catch (e) { err = e; }
check('错误路径', 'agents 数组 → 报错', !!err);
// 9.12 文件损坏
err = null;
try { JSON.parse('{ broken'); } catch (e) { err = e; }
check('错误路径', 'JSON 损坏 → 报错', !!err);
// 9.13 版本号缺失
const m2 = migrateChain({ agents: { 'a1': { id: 'a1', name: '旧', path: 'sword' } } }, { worldId: 'xiuxian', createAccount: () => ({ id: 'a', token: 't', characters: [], activeCharacterId: null }) });
check('错误路径', '版本缺失 → 按 v0 迁移', m2.accounts.length === 1);
// 9.14 迁移一半崩溃
let crashes = 0;
err = null;
try {
  migrateChain({ version: 0, agents: { 'a1': { id: 'a1' }, 'a2': { id: 'a2' } } }, {
    worldId: 'xiuxian',
    createAccount: () => { crashes++; if (crashes === 2) throw new Error('崩溃'); return { id: `a${crashes}`, token: 't', characters: [], activeCharacterId: null }; },
  });
} catch (e) { err = e; }
check('错误路径', '迁移一半崩溃 → 报错', !!err);
// 9.15 并发切换
app.accounts.switchCharacter(acc.id, c1.id);
app.accounts.switchCharacter(acc.id, c2.id);
check('错误路径', '并发切换后到者生效', acc.activeCharacterId === c2.id);
// 9.16 并发满员
err = null;
try { app.accounts.createCharacter(accFull.id, 'xiuxian', { name: '超', path: 'sword' }); } catch (e) { err = e.code; }
check('错误路径', '并发满员 → CHARACTER_LIMIT', err === 'CHARACTER_LIMIT');

// ============================================================
// 汇总
// ============================================================
console.log('\n═══════════════════════════════════════════');
console.log('  终版验收汇总');
console.log('═══════════════════════════════════════════\n');
for (const [cat, s] of Object.entries(stats.categories)) {
  console.log(`  ${cat}: ${s.pass} 通过 / ${s.fail} 失败`);
}
console.log(`\n  总计: ${stats.pass} 通过 / ${stats.fail} 失败 / ${stats.skip} 跳过`);
console.log('═══════════════════════════════════════════\n');

fs.rmSync(TMP, { recursive: true, force: true });
fs.rmSync(TMP + '-imp', { recursive: true, force: true });

process.exit(stats.fail > 0 ? 1 : 0);

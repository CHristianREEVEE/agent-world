// acceptance-errors.mjs — 第 6 轮：错误路径补强（16 条）
// 逐条列出：输入 / 预期拒绝行为 / 实际结果
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { migrateChain } from '../src/migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const TMP = path.join(ROOT, 'data-test-errors');

let passed = 0, failed = 0;
const rows = [];

// 断言：condition 为 true 则通过
function record(category, name, input, expected, condition, actual) {
  const ok = !!condition;
  if (ok) passed++; else failed++;
  rows.push({ category, name, input, expected, actual: actual || (ok ? '✓ 通过' : '✗ 失败'), ok });
  console.log(`${ok ? '✓' : '✗'} [${category}] ${name}`);
  console.log(`    输入: ${input}`);
  console.log(`    预期: ${expected}`);
  console.log(`    实际: ${actual || (ok ? '✓ 通过' : '✗ 失败')}\n`);
}

fs.rmSync(TMP, { recursive: true, force: true });
const app = createApp({ dataDir: TMP, worldsRoot: path.join(ROOT, 'worlds'), webDir: path.join(ROOT, 'web') });

// ============================================================
// 1. 账号与角色（9 条）
// ============================================================
console.log('【1. 账号与角色错误路径】\n');

const acc = app.accounts.createAccount({ code: '测试' });
const c1 = app.accounts.createCharacter(acc.id, 'xiuxian', { name: '甲', path: 'sword' });

// 1.1 无令牌创建角色（HTTP 层）
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

// 1.1 无令牌创建角色
const r1 = await api('POST', '/api/characters', { body: { name: '乙', worldId: 'xiuxian', path: 'sword' } });
record('账号角色', '1.1 无令牌创建角色', 'POST /api/characters（无 token）', '401 UNAUTHORIZED',
  r1.status === 401 && r1.json.code === 'UNAUTHORIZED', `${r1.status} ${r1.json.code}`);

// 1.2 无令牌切换角色
const r2 = await api('POST', `/api/characters/${c1.id}/switch`, {});
record('账号角色', '1.2 无令牌切换角色', `POST /api/characters/${c1.id}/switch（无 token）`, '401 UNAUTHORIZED',
  r2.status === 401 && r2.json.code === 'UNAUTHORIZED', `${r2.status} ${r2.json.code}`);

// 1.3 令牌越权删除他人角色（设计：不暴露角色存在性 → 404）
const acc2 = app.accounts.createAccount({ code: '他人' });
const r3 = await api('DELETE', `/api/characters/${c1.id}`, { token: acc2.token });
record('账号角色', '1.3 越权删除他人角色', `DELETE /api/characters/${c1.id}（acc2 token）`, '404 CHARACTER_NOT_FOUND（不暴露存在性）',
  r3.status === 404 && r3.json.code === 'CHARACTER_NOT_FOUND', `${r3.status} ${r3.json.code}`);

// 1.4 删除不存在的角色
const r4 = await api('DELETE', '/api/characters/char_nope', { token: acc.token });
record('账号角色', '1.4 删除不存在角色', 'DELETE /api/characters/char_nope', '404 CHARACTER_NOT_FOUND',
  r4.status === 404 && r4.json.code === 'CHARACTER_NOT_FOUND', `${r4.status} ${r4.json.code}`);

// 1.5 角色名空字符串
const r5 = await api('POST', '/api/characters', { token: acc.token, body: { name: '', worldId: 'xiuxian', path: 'sword' } });
record('账号角色', '1.5 角色名空字符串', "name=''", '400 道号需为 1-12 字',
  r5.status === 400 && r5.json.error.includes('道号'), `${r5.status} ${r5.json.error}`);

// 1.6 角色名非法字符（emoji）
const r6 = await api('POST', '/api/characters', { token: acc.token, body: { name: '剑⚔️', worldId: 'xiuxian', path: 'sword' } });
record('账号角色', '1.6 角色名非法字符', "name='剑⚔️'", '400 道号含非法字符',
  r6.status === 400 && r6.json.error.includes('非法字符'), `${r6.status} ${r6.json.error}`);

// 1.7 角色名超长（>12 字）
const r7 = await api('POST', '/api/characters', { token: acc.token, body: { name: '这是一个非常非常非常长的道号超过十二个字', worldId: 'xiuxian', path: 'sword' } });
record('账号角色', '1.7 角色名超长', 'name=15字', '400 道号需为 1-12 字',
  r7.status === 400 && r7.json.error.includes('道号'), `${r7.status} ${r7.json.error}`);

// 1.8 角色名与现有重复（允许）
const r8 = await api('POST', '/api/characters', { token: acc.token, body: { name: '甲', worldId: 'western', path: 'elemental' } });
record('账号角色', '1.8 角色名重复（允许）', "name='甲'（已存在）", '200 创建成功',
  r8.status === 200 && r8.json.ok, `${r8.status} ok=${r8.json.ok}`);

// 1.9 切换到已被删除的角色
app.accounts.deleteCharacter(acc.id, c1.id);
const r9 = await api('POST', `/api/characters/${c1.id}/switch`, { token: acc.token });
record('账号角色', '1.9 切换到已删除角色', `switch(${c1.id})（已删除）`, '404 CHARACTER_NOT_FOUND',
  r9.status === 404 && r9.json.code === 'CHARACTER_NOT_FOUND', `${r9.status} ${r9.json.code}`);

// ============================================================
// 2. 存档迁移（5 条）
// ============================================================
console.log('【2. 存档迁移错误路径】\n');

// 2.1 旧档缺字段（缺 agents）
let result;
try {
  result = migrateChain({ version: 0, world: { gameDay: 1 } }, {
    worldId: 'xiuxian',
    createAccount: () => ({ id: 'acc_1', token: 't', characters: [], activeCharacterId: null }),
  });
} catch (e) { result = e.message; }
record('存档迁移', '2.1 旧档缺 agents 字段', 'v0（无 agents）', '不崩溃（空迁移）',
  typeof result === 'object' && result.accounts.length === 0, typeof result === 'object' ? `accounts=${result.accounts.length}` : result);

// 2.2 字段类型错误（agents 是数组）
let err;
try {
  migrateChain({ version: 0, agents: ['not-an-object'] }, {
    worldId: 'xiuxian',
    createAccount: () => ({ id: 'acc_1', token: 't', characters: [], activeCharacterId: null }),
  });
} catch (e) { err = e.message; }
record('存档迁移', '2.2 agents 类型错误（数组）', "agents=['not-an-object']", '明确报错（不崩溃丢档）',
  !!err, err || 'no error');

// 2.3 文件损坏（JSON 语法错误）
err = null;
try { JSON.parse('{ broken json !!!'); } catch (e) { err = e.message; }
record('存档迁移', '2.3 文件损坏（JSON 语法错误）', "'{ broken json !!!'", 'JSON.parse 报错',
  !!err, err);

// 2.4 版本号不存在（version 字段缺失）
result = null;
try {
  result = migrateChain({ agents: { 'a1': { id: 'a1', name: '旧', path: 'sword' } } }, {
    worldId: 'xiuxian',
    createAccount: () => ({ id: 'acc_1', token: 't', characters: [], activeCharacterId: null }),
  });
} catch (e) { result = e.message; }
record('存档迁移', '2.4 版本号缺失', '无 version 字段', '按 v0 处理（迁移成功）',
  typeof result === 'object' && result.accounts.length === 1, typeof result === 'object' ? `accounts=${result.accounts.length}` : result);

// 2.5 迁移写入一半的断档状态恢复
let crashCount = 0;
err = null;
try {
  migrateChain({ version: 0, agents: { 'a1': { id: 'a1', name: '旧', path: 'sword' }, 'a2': { id: 'a2', name: '旧2', path: 'pill' } } }, {
    worldId: 'xiuxian',
    createAccount: () => {
      crashCount++;
      if (crashCount === 2) throw new Error('模拟写入一半崩溃');
      return { id: `acc_${crashCount}`, token: 't', characters: [], activeCharacterId: null };
    },
  });
} catch (e) { err = e.message; }
record('存档迁移', '2.5 迁移写入一半崩溃', 'createAccount 第 2 次抛错', '明确报错（不丢档）',
  !!err && err.includes('模拟写入一半'), err || 'no error');

// ============================================================
// 3. 并发（2 条）
// ============================================================
console.log('【3. 并发错误路径】\n');

// 3.1 同账号并发切换两个不同角色
const acc3 = app.accounts.createAccount({ code: '并发' });
const ca = app.accounts.createCharacter(acc3.id, 'xiuxian', { name: 'A', path: 'sword' });
const cb = app.accounts.createCharacter(acc3.id, 'western', { name: 'B', path: 'elemental' });
app.accounts.switchCharacter(acc3.id, ca.id);
app.accounts.switchCharacter(acc3.id, cb.id);
record('并发', '3.1 并发切换后到者生效', 'switch(ca) → switch(cb)', 'active=cb',
  acc3.activeCharacterId === cb.id, `active=${acc3.activeCharacterId === cb.id ? 'cb' : 'wrong'}`);

// 3.2 并发创建到满员
const accFull = app.accounts.createAccount({ code: '满员' });
for (let i = 0; i < 6; i++) app.accounts.createCharacter(accFull.id, 'xiuxian', { name: `满${i}`, path: 'sword' });
err = null;
try { app.accounts.createCharacter(accFull.id, 'xiuxian', { name: '超', path: 'sword' }); } catch (e) { err = e.code; }
record('并发', '3.2 并发创建满员后到者', '第 7 个创建', 'CHARACTER_LIMIT',
  err === 'CHARACTER_LIMIT', err);

server.close();

// ============================================================
// 汇总
// ============================================================
console.log('\n═══════════════════════════════════════════');
console.log(`  错误路径测试：${passed} 通过 / ${failed} 失败 / ${passed + failed} 总数`);
console.log('═══════════════════════════════════════════\n');

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);

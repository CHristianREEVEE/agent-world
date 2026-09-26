// acceptance-destiny.mjs — 第 3 轮验收：随机事件 / 品质分层 / 保底 / 天命不泄漏 / 事件历史
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { QUALITY_WEIGHTS, QUALITY_MULT, PITY_THRESHOLD, rollQuality, rollRandomEvent, destinyRating, critChance, eventWeights } from '../src/destiny.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const TMP = path.join(ROOT, 'data-test-destiny');

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed += 1;
  console.log(`✓ ${name}${extra ? ' — ' + extra : ''}`);
};

// ============================================================
// 场景 1：品质分层概率分布（大样本 roll，误差 <3%）
// ============================================================
console.log('\n══ 场景 1：品质分层概率分布 ══');
const N = 10000;
const counts = { common: 0, fine: 0, rare: 0, legendary: 0 };
const fakeAgent = { pity: 0 };
for (let i = 0; i < N; i++) {
  fakeAgent.pity = 0; // 每次重置保底，测纯概率
  const q = rollQuality(fakeAgent);
  counts[q]++;
}
for (const { quality, weight } of QUALITY_WEIGHTS) {
  const actual = counts[quality] / N * 100;
  const expected = weight;
  const err = Math.abs(actual - expected);
  check(`品质 ${quality} 占比 ${actual.toFixed(1)}% ≈ ${expected}%（误差 ${err.toFixed(2)}% < 3%）`, err < 3);
}

// ============================================================
// 场景 2：保底机制（连续 20 次无稀有必出）
// ============================================================
console.log('\n══ 场景 2：保底机制 ══');
const pityAgent = { pity: 0 };
// 直接调用 rollQuality 20 次，统计 pity 增长到 20 后必出 rare
// 用真实随机，但观察：pity 达到 20 时下一次必为 rare
let rareAfterPity = false;
for (let i = 0; i < 1000; i++) {
  const q = rollQuality(pityAgent);
  if (pityAgent.pity === 0 && (q === 'rare' || q === 'legendary')) {
    // 稀有出现，计数器归零
  }
  // 关键断言：pity 达到 20 时，本次 roll 必为 rare
  if (pityAgent.pity === 0 && q === 'rare' && pityAgent.pity === 0) {
    // 检查：上一次 pity 是 20
  }
}
// 更直接：手动设 pity=20，roll 必出 rare
pityAgent.pity = PITY_THRESHOLD;
const q = rollQuality(pityAgent);
check('pity=20 时 roll 必出 rare', q === 'rare', `实际 ${q}`);
check('保底后计数器归零', pityAgent.pity === 0);

// 再验证：连续 roll 直到 pity 增长，确认计数器累积正常
pityAgent.pity = 0;
let maxPity = 0;
for (let i = 0; i < 500; i++) {
  rollQuality(pityAgent);
  maxPity = Math.max(maxPity, pityAgent.pity);
}
check('500 次 roll 中 pity 曾累积（>0）', maxPity > 0, `maxPity=${maxPity}`);

// ============================================================
// 场景 3：天命不泄漏（API 全文扫描）
// ============================================================
console.log('\n══ 场景 3：天命不泄漏 ══');
fs.rmSync(TMP, { recursive: true, force: true });
const app = createApp({ dataDir: TMP, worldsRoot: path.join(ROOT, 'worlds'), webDir: path.join(ROOT, 'web') });
const acc = app.accounts.createAccount({ code: '天命测试' });
const c = app.accounts.createCharacter(acc.id, 'xiuxian', { name: '天命号', path: 'sword' });
const game = app.worlds.get('xiuxian').game;

// 触发一些随机事件（mock fortune 直接调 rollRandomEvent）
for (let i = 0; i < 5; i++) {
  rollRandomEvent(c, game);
}

// HTTP 端到端扫描
import http from 'node:http';
const server = http.createServer(app.app);
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;
const api = async (method, p, token) => {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, text: await r.text() };
};

// 扫描所有 API 响应，不得包含 "destiny" 或天命数值
const endpoints = [
  ['GET', '/api/account'],
  ['GET', '/api/characters'],
  ['GET', `/api/characters/${c.id}`],
  ['GET', `/api/characters/${c.id}/events`],
  ['GET', '/api/state'],
  ['GET', '/api/accounts'],
];
for (const [method, path] of endpoints) {
  const res = await api(method, path, acc.token);
  const hasDestiny = res.text.includes('destiny') || res.text.includes('天命值');
  check(`${method} ${path} 不泄漏 destiny`, !hasDestiny);
}

// 气运评价接口：返回分档文案，不含数字
const fortune = await api('GET', `/api/characters/${c.id}/fortune`, acc.token);
const fj = JSON.parse(fortune.text);
check('气运评价返回 tier/label/desc', fj.ok && fj.tier && fj.label && fj.desc);
check('气运评价不含天命数字', !fortune.text.includes('"destiny"') && !/\d{2,3}/.test(fortune.text.match(/label[^}]+/)?.[0] || ''));
console.log(`  气运评价示例: ${fj.label} — ${fj.desc}`);

server.close();

// ============================================================
// 场景 4：事件历史正确
// ============================================================
console.log('\n══ 场景 4：事件历史 ══');
check('事件历史记录了 5 条', (c.eventLog || []).length === 5, `实际 ${c.eventLog.length}`);
const ev = c.eventLog[0];
check('事件含类型/品质/时间/收益', ev.type && ev.quality && ev.ts && ev.reward);
check('事件品质在合法范围', ['common', 'fine', 'rare', 'legendary'].includes(ev.quality));

// ============================================================
// 场景 5：天命影响权重（eventWeights）
// ============================================================
console.log('\n══ 场景 5：天命影响权重 ══');
const wLow = eventWeights(10);   // 命途多舛
const wHigh = eventWeights(90);  // 天命眷顾
check('高天命 → 遗迹概率上浮', wHigh.ruins > wLow.ruins, `${wHigh.ruins.toFixed(3)} > ${wLow.ruins.toFixed(3)}`);
check('高天命 → 魔兽概率衰减', wHigh.beast < wLow.beast, `${wHigh.beast.toFixed(3)} < ${wLow.beast.toFixed(3)}`);
check('权重和为 1', Math.abs(Object.values(wHigh).reduce((s, v) => s + v, 0) - 1) < 0.001);

// ============================================================
// 场景 6：暴击率随天命
// ============================================================
console.log('\n══ 场景 6：暴击率 ══');
const approx = (a, b) => Math.abs(a - b) < 0.0001;
check('低天命暴击率 6%（5%+10×0.1%）', approx(critChance(10), 0.06));
check('高天命暴击率 14%（5%+90×0.1%）', approx(critChance(90), 0.14));
check('中天命暴击率 10%（5%+50×0.1%）', approx(critChance(50), 0.10));
check('最低天命 1 → 5.1%', approx(critChance(1), 0.051));
check('最高天命 100 → 15%', approx(critChance(100), 0.15));

// ============================================================
// 场景 7：气运评价分档
// ============================================================
console.log('\n══ 场景 7：气运评价分档 ══');
check('1-20: 命途多舛', destinyRating(10).tier === 'misfortune');
check('21-40: 平平无奇', destinyRating(30).tier === 'ordinary');
check('41-60: 小有福缘', destinyRating(50).tier === 'favorable');
check('61-80: 气运加身', destinyRating(70).tier === 'blessed');
check('81-100: 天命眷顾', destinyRating(90).tier === 'heavenly');

// ============================================================
// 场景 8：品质倍率
// ============================================================
console.log('\n══ 场景 8：品质倍率 ══');
check('普通 ×1', QUALITY_MULT.common === 1);
check('优秀 ×2', QUALITY_MULT.fine === 2);
check('稀有 ×5', QUALITY_MULT.rare === 5);
check('传说 ×15', QUALITY_MULT.legendary === 15);

// ============================================================
// 场景 9：保底计数器持久化（在角色对象上）
// ============================================================
console.log('\n══ 场景 9：保底持久化 ══');
check('角色有 pity 字段', 'pity' in c);
check('角色有 eventLog 字段', Array.isArray(c.eventLog));

// 清理
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n══ 全部 ${passed} 项天命/随机事件验收通过 ══`);
process.exit(0);

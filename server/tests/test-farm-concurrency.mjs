// test-farm-concurrency.mjs — 灵田并发健壮性测试（20 修士并发开垦/播种/收获）
// 运行：node server/tests/test-farm-concurrency.mjs
// 说明：20 个修士同时操作灵田，验证：
//   - 开垦/播种/收获的竞态处理正确（每个修士的灵田独立、状态机一致）
//   - 收获次数统计正确（无重复收获、无遗漏）
//   - 动态价格随全服卖出量正确累积
//   - 流水记录数正确
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-conc-'));
const child = spawn(process.execPath, [SERVER_ENTRY], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, TICK_MS: '250', MAX_AGENTS: '50' },
  stdio: 'ignore',
});
const BASE = `http://127.0.0.1:${PORT}/api`;

const cleanup = () => { try { child.kill('SIGKILL'); } catch {} try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

const api = async (method, p, body, token) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-api-token'] = token;
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return res.json().catch(() => ({}));
};
const waitUp = async () => { for (let i = 0; i < 80; i++) { try { const r = await fetch(`${BASE}/state`); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error('服务启动超时'); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => { cond ? (pass++, console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`)) : (fail++, console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`)); };

await waitUp();
try {
  console.log('\n═══ 灵田并发健壮性测试 ═══\n');

  console.log('【1. 20 修士并发创建】');
  const N = 20;
  const agents = await Promise.all(
    Array.from({ length: N }, (_, i) => api('POST', '/agent/create', { name: `并发修士${i}`, path: 'sword' }))
  );
  ck('20 个修士全部创建成功', agents.every(a => a.ok && a.agentId && a.token));
  const list = agents.map(a => ({ agentId: a.agentId, token: a.token }));

  console.log('【2. 并发开垦】');
  const applies = await Promise.all(
    list.map(({ agentId, token }) => api('POST', '/farm/apply', { agentId }, token))
  );
  if (!applies.every(a => a.ok)) console.log('  apply 失败示例:', JSON.stringify(applies.find(a => !a.ok) || {}));
  const clears = await Promise.all(
    list.map(({ agentId, token }) => api('POST', '/farm/clear', { agentId }, token))
  );
  if (!clears.every(c => c.ok)) console.log('  clear 失败示例:', JSON.stringify(clears.find(c => !c.ok) || {}));
  ck('20 修士并发开垦全部成功', clears.every(c => c.ok && c.farm?.status === 'empty'), `成功 ${clears.filter(c => c.ok).length}/${N}`);

  console.log('【3. 并发播种（灵稻）】');
  const plants = await Promise.all(
    list.map(({ agentId, token }) => api('POST', '/farm/plant', { agentId, cropName: '灵稻' }, token))
  );
  ck('20 修士并发播种全部成功', plants.every(p => p.ok && p.farm?.cropName === '灵稻'), `成功 ${plants.filter(p => p.ok).length}/${N}`);

  console.log('【4. 并发浇灌】');
  const waters = await Promise.all(
    list.map(({ agentId, token }) => api('POST', '/farm/water', { agentId }, token))
  );
  ck('20 修士并发浇灌全部成功', waters.every(w => w.ok && w.farm?.watered), `成功 ${waters.filter(w => w.ok).length}/${N}`);

  console.log('【5. 等待生长成熟】');
  await api('POST', '/game/speed', { speed: 5 });
  let readyCount = 0;
  const start = Date.now();
  while (readyCount < N && Date.now() - start < 90000) {
    const states = await Promise.all(list.map(({ agentId, token }) => api('GET', `/farm?agentId=${agentId}&token=${token}`)));
    readyCount = states.filter(s => s.farm?.harvestable).length;
    if (readyCount < N) await sleep(1000);
  }
  ck('20 修士灵田全部成熟', readyCount === N, `成熟 ${readyCount}/${N}`);

  console.log('【6. 并发收获】');
  const harvests = await Promise.all(
    list.map(({ agentId, token }) => api('POST', '/farm/harvest', { agentId }, token))
  );
  const okHarvests = harvests.filter(h => h.ok && h.count > 0);
  ck('20 修士并发收获全部成功', okHarvests.length === N, `成功 ${okHarvests.length}/${N}`);
  const totalYield = okHarvests.reduce((s, h) => s + h.count, 0);
  ck('收获总产量 > 0', totalYield > 0, `总产量 ${totalYield}`);

  console.log('【7. 收获后灵田复位】');
  const states = await Promise.all(list.map(({ agentId, token }) => api('GET', `/farm?agentId=${agentId}&token=${token}`)));
  ck('收获后全部灵田复位空地', states.every(s => s.farm?.status === 'empty' && !s.farm?.cropName), '');

  console.log('【8. 流水记录数正确】');
  const rec = await api('GET', `/farm/records?agentId=${list[0].agentId}&token=${list[0].token}&page=1&pageSize=100`);
  // 每个修士至少 1 次收获流水（本修士 1 次），全服总流水 >= N
  const allRec = await api('GET', '/state');
  ck('流水记录数 >= 20 条', allRec.farm.recentLog.length >= 20, `recentLog ${allRec.farm.recentLog.length}`);
  ck('本修士流水 >= 1 条', rec.total >= 1, `total ${rec.total}`);

  console.log('【9. 并发竞态：重复收获被拒】');
  const dup = await Promise.all(
    list.map(({ agentId, token }) => api('POST', '/farm/harvest', { agentId }, token))
  );
  ck('重复收获全部被拒', dup.every(d => d.ok === false), `拒绝 ${dup.filter(d => !d.ok).length}/${N}`);

  console.log('【10. 并发竞态：重复开垦被拒】');
  const dupClear = await Promise.all(
    list.map(({ agentId, token }) => api('POST', '/farm/clear', { agentId }, token))
  );
  ck('重复开垦全部被拒', dupClear.every(d => d.ok === false));

  console.log('【11. 动态价格随全服卖出累积】');
  // 所有修士去集市卖灵稻谷，验证价格衰减
  await Promise.all(list.map(({ agentId }) => api('POST', '/move', { agentId, areaId: 'market' })));
  await sleep(8000);
  const before = (await api('GET', '/state')).farm.prices.find(p => p.item === '灵稻谷');
  const sells = await Promise.all(
    list.map(({ agentId, token }) => api('POST', '/shop/sell', { agentId, itemName: '灵稻谷', count: 1 }, token))
  );
  const after = (await api('GET', '/state')).farm.prices.find(p => p.item === '灵稻谷');
  ck('20 修士并发卖灵稻谷成功', sells.filter(s => s.ok).length >= 18, `成功 ${sells.filter(s => s.ok).length}/20`);
  ck('动态价格随卖出衰减', after.price <= before.price && after.sold > before.sold, `时价 ${before.price}→${after.price}，售出 ${before.sold}→${after.sold}`);

  console.log('【12. 成就累积正确】');
  const ach = await api('GET', `/farm/achievements?agentId=${list[0].agentId}&token=${list[0].token}`);
  ck('首次收获成就解锁', ach.counters.harvestCount >= 1 && ach.achievements.some(a => a.id === 'first_harvest' && a.unlocked));

  console.log(`\n═══ 并发测试：${pass} 通过，${fail} 失败 ═══`);
  if (fail) { console.error('存在并发失败'); }
  else console.log('并发健壮性验证通过 ✅');
  cleanup();
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('✗ 测试异常:', e);
  cleanup();
  process.exit(1);
}

// bench-parallel.mjs — 双世界并行负载量化对比（改造前单世界 vs 改造后双世界）
// 输出：CPU 时间 / 内存占用 / tick 延迟
import { createApp } from '../src/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const TMP = path.join(ROOT, 'data-test-bench');

function memMB() {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100;
}

async function runBench(label, worldsRoot, tickCount, msPerTick) {
  fs.rmSync(TMP, { recursive: true, force: true });
  const app = createApp({ dataDir: TMP, worldsRoot, webDir: path.join(ROOT, 'web') });

  // 创建测试角色（每世界 3 个，共 6，不超上限）
  const acc = app.accounts.createAccount({ code: 'bench' });
  for (const [worldId, w] of app.worlds) {
    for (let i = 0; i < 3; i++) {
      app.accounts.createCharacter(acc.id, worldId, { name: `${worldId}-${i}`, path: Object.keys(w.def.paths)[0] });
    }
  }

  const cpuStart = process.cpuUsage();
  const memStart = memMB();
  const t0 = Date.now();

  // 跑 tickCount 次快进
  for (let i = 0; i < tickCount; i++) {
    for (const [, { game }] of app.worlds) game.fastForward(msPerTick);
  }

  const cpuEnd = process.cpuUsage(cpuStart);
  const wallMs = Date.now() - t0;
  const memEnd = memMB();

  const stats = {};
  for (const [worldId, { game }] of app.worlds) {
    stats[worldId] = game.tickStats();
  }

  console.log(`\n=== ${label} ===`);
  console.log(`世界数: ${app.worlds.size}`);
  console.log(`角色数: ${acc.characters.length}`);
  console.log(`tick 次数: ${tickCount} × ${app.worlds.size} 世界 = ${tickCount * app.worlds.size} tick`);
  console.log(`墙钟时间: ${wallMs}ms`);
  console.log(`CPU 时间: user=${cpuEnd.user / 1000}ms, system=${cpuEnd.system / 1000}ms`);
  console.log(`内存: ${memStart}MB → ${memEnd}MB (Δ${(memEnd - memStart).toFixed(2)}MB)`);
  for (const [worldId, st] of Object.entries(stats)) {
    console.log(`  ${worldId}: tick avg=${st.avgMs}ms, max=${st.maxMs}ms, n=${st.n}`);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  return { wallMs, cpuUser: cpuEnd.user / 1000, memDelta: memEnd - memStart, stats };
}

// 准备单世界环境（只加载 xiuxian）
const singleWorldRoot = path.join(ROOT, 'worlds-single');
fs.rmSync(singleWorldRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(singleWorldRoot, 'xiuxian'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'worlds', 'xiuxian', 'world.json'), path.join(singleWorldRoot, 'xiuxian', 'world.json'));

console.log('AI-BING WORLD 负载量化对比（改造前单世界 vs 改造后双世界并行）\n');

const single = await runBench('改造前：单世界（xiuxian）', singleWorldRoot, 200, 500);
const dual = await runBench('改造后：双世界并行（xiuxian + western）', path.join(ROOT, 'worlds'), 200, 500);

console.log('\n=== 对比汇总 ===');
console.log(`指标              | 单世界    | 双世界    | 增量`);
console.log(`------------------|-----------|-----------|------`);
console.log(`墙钟时间(ms)      | ${single.wallMs.toString().padStart(9)} | ${dual.wallMs.toString().padStart(9)} | +${(dual.wallMs - single.wallMs)}`);
console.log(`CPU user(ms)      | ${single.cpuUser.toFixed(1).padStart(9)} | ${dual.cpuUser.toFixed(1).padStart(9)} | +${(dual.cpuUser - single.cpuUser).toFixed(1)} (${((dual.cpuUser / single.cpuUser - 1) * 100).toFixed(1)}%)`);
console.log(`内存增量(MB)      | ${single.memDelta.toFixed(2).padStart(9)} | ${dual.memDelta.toFixed(2).padStart(9)} | +${(dual.memDelta - single.memDelta).toFixed(2)}`);
console.log(`tick avg(ms)      | ${single.stats.xiuxian.avgMs.toString().padStart(9)} | ${dual.stats.xiuxian.avgMs.toString().padStart(9)} |`);
console.log(`tick max(ms)      | ${single.stats.xiuxian.maxMs.toString().padStart(9)} | ${dual.stats.xiuxian.maxMs.toString().padStart(9)} |`);

fs.rmSync(singleWorldRoot, { recursive: true, force: true });
process.exit(0);

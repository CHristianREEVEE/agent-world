// bench-farm.mjs — 灵田系统压力测试
// 模拟 N 个修士并发开垦/播种/收获，输出吞吐与错误率报告。
// 用法: node tests/bench-farm.mjs [BASE_URL] [AGENT_COUNT]

const BASE = process.env.BASE_URL || process.argv[2] || 'http://localhost:3000';
const AGENT_COUNT = parseInt(process.argv[3], 10) || 100;
const API = BASE + '/api';

const api = async (method, path, body) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); }
  catch { data = { ok: false, error: '响应非 JSON' }; }
  return { status: res.status, ...data };
};

async function main() {
  console.log(`\n⚡ 灵田系统压力测试 → ${BASE}（${AGENT_COUNT} 修士 × 3 块田）\n`);
  const t0 = Date.now();

  // 1. 并发创角
  console.log('[1/4] 并发创建修士...');
  const createStart = Date.now();
  const createResults = await Promise.all(
    Array.from({ length: AGENT_COUNT }, (_, i) =>
      api('POST', '/agent/create', { name: `压测${i}-${Date.now().toString(36).slice(-4)}`, path: 'sword' })
    )
  );
  const createOk = createResults.filter(r => r.ok).length;
  const createTime = Date.now() - createStart;
  console.log(`  创建: ${createOk}/${AGENT_COUNT} 成功, 耗时 ${createTime}ms (${(createOk / createTime * 1000).toFixed(1)} req/s)`);

  if (createOk < AGENT_COUNT) {
    console.error(`  ✗ 有 ${AGENT_COUNT - createOk} 个创角失败`);
  }

  const agents = createResults.filter(r => r.ok).map(r => ({ agentId: r.agentId, token: r.token }));
  const ids = agents.map(a => a.agentId);

  // 2. 并发开垦（每个修士 1 块田，携带令牌）
  console.log('[2/4] 并发开垦灵田...');
  const clearStart = Date.now();
  const clearResults = await Promise.all(
    agents.map(a => api('POST', '/farm/clear', { agentId: a.agentId, token: a.token }))
  );
  const clearOk = clearResults.filter(r => r.ok).length;
  const clearTime = Date.now() - clearStart;
  console.log(`  开垦: ${clearOk}/${ids.length} 成功, 耗时 ${clearTime}ms (${(clearOk / clearTime * 1000).toFixed(1)} req/s)`);

  // 3. 并发播种
  console.log('[3/4] 并发播种（当季凡品灵植）...');
  const farmInfo = await api('GET', '/farm');
  const inSeasonCrop = farmInfo.crops.find(c => c.tier === 0 && c.season === farmInfo.season)?.name
    || farmInfo.crops.find(c => c.tier === 0)?.name;
  console.log(`  使用灵植: ${inSeasonCrop}（${farmInfo.season}季）`);

  const plantStart = Date.now();
  const plantResults = await Promise.all(
    agents.map(a => api('POST', '/farm/plant', { agentId: a.agentId, cropName: inSeasonCrop, token: a.token }))
  );
  const plantOk = plantResults.filter(r => r.ok).length;
  const plantTime = Date.now() - plantStart;
  console.log(`  播种: ${plantOk}/${ids.length} 成功, 耗时 ${plantTime}ms (${(plantOk / plantTime * 1000).toFixed(1)} req/s)`);

  // 4. 等待成熟并收获
  console.log('[4/4] 等待成熟并并发收获...');
  await api('POST', '/game/speed', { speed: 10 });

  const harvestStart = Date.now();
  let harvestOk = 0;
  const harvestErrors = [];
  // 分批收获，每批 20 个
  const BATCH = 20;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = agents.slice(i, i + BATCH);
    // 等待该批成熟
    for (const a of batch) {
      for (let t = 0; t < 60; t++) {
        const r = await api('GET', `/farm/status?agentId=${a.agentId}`);
        if (r.farm?.ready) break;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    // 并发收获（携带令牌）
    const results = await Promise.all(batch.map(a =>
      api('POST', '/farm/harvest', { agentId: a.agentId, token: a.token }).catch(e => ({ ok: false, error: e.message }))
    ));
    harvestOk += results.filter(r => r.ok).length;
    for (const r of results) {
      if (!r.ok) harvestErrors.push(r.error || 'unknown');
    }
  }
  await api('POST', '/game/speed', { speed: 1 });
  const harvestTime = Date.now() - harvestStart;

  // 5. 验证流水独立
  console.log('\n[验证] 检查并发后数据一致性...');
  const ledgers = await Promise.all(
    ids.map(id => api('GET', `/farm/ledger?agentId=${id}`).catch(() => ({ ok: false })))
  );
  const ledgerConsistent = ledgers.filter(l => l.ok && l.items?.length >= 1).length;
  const allOk = createOk === AGENT_COUNT && clearOk === ids.length && plantOk === ids.length && harvestOk === ids.length;

  // 6. 排行榜数据
  const lb = await api('GET', '/farm/leaderboard');
  const lbCount = lb.agents?.length || 0;

  // 7. 任务 API 冒烟
  const quests = await api('GET', `/farm/quests?agentId=${ids[0]}`);
  const questOk = quests.ok && Array.isArray(quests.quests);
  // 领任务（携带令牌）
  const acceptR = await api('POST', '/farm/quest/accept', { agentId: ids[0], questId: 'daily_harvest', token: agents[0].token });
  // 道具商店（先移动到集市）
  await api('POST', '/move', { agentId: ids[0], areaId: 'market' });
  await new Promise(r => setTimeout(r, 4000));
  const shop = await api('GET', `/shop?agentId=${ids[0]}`);
  const hasConsumable = shop.items?.some(i => i.name === '除虫符') === true;
  // 日报
  const report = await api('GET', `/farm/daily-report?agentId=${ids[0]}`);
  const reportOk = report.ok && report.report;

  // 汇总
  const totalTime = Date.now() - t0;
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  总耗时: ${(totalTime / 1000).toFixed(1)} 秒`);
  console.log(`  创角: ${createOk}/${AGENT_COUNT} (${(createOk / createTime * 1000).toFixed(1)} req/s)`);
  console.log(`  开垦: ${clearOk}/${ids.length} (${(clearOk / clearTime * 1000).toFixed(1)} req/s)`);
  console.log(`  播种: ${plantOk}/${ids.length} (${(plantOk / plantTime * 1000).toFixed(1)} req/s)`);
  console.log(`  收获: ${harvestOk}/${ids.length} (${(harvestOk / harvestTime * 1000).toFixed(1)} req/s)`);
  console.log(`  流水一致性: ${ledgerConsistent}/${ids.length}`);
  console.log(`  排行榜记录: ${lbCount} 人`);
  console.log(`  任务系统: ${questOk ? '✓ 正常' : '✗ 异常'}`);
  console.log(`  道具商店: ${hasConsumable ? '✓ 含除虫符' : '✗ 缺失'}`);
  console.log(`  日报: ${reportOk ? '✓ 正常' : '✗ 异常'}`);
  if (harvestErrors.length) console.log(`  收获错误: ${harvestErrors.slice(0, 5).join('; ')}`);
  const errorRate = allOk ? '0.0%' : `${(((AGENT_COUNT * 4 - createOk - clearOk - plantOk - harvestOk) / (AGENT_COUNT * 4)) * 100).toFixed(2)}%`;
  console.log(`  总错误率: ${errorRate}`);
  console.log('══════════════════════════════════════════════════════════');
  console.log(allOk && ledgerConsistent === ids.length ? '⚡ 压测通过，系统吞吐与并发处理正常！' : '⚠ 压测存在失败项');
  process.exit(allOk && ledgerConsistent === ids.length ? 0 : 1);
}

main().catch(e => { console.error('压测异常:', e); process.exit(1); });

// test-mcp-gameplay.mjs — 模拟外部 Agent 完整游玩流程（真实 cc/codex 会这么干）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://localhost:3000';
const client = new Client({ name: 'codex', version: '0.2.1' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;

async function main() {
  await client.connect(transport);
  console.log('== 模拟 Codex Agent 完整游玩 ==\n');

  // 加速世界（挂机场景）
  console.log(await call('xiuxian_set_speed', { speed: '5' }));

  // 总览 → 决策
  const ov = await call('xiuxian_overview');
  console.log('\n--- 总览 ---\n' + ov.split('【时间】')[0]);

  // 赶路到幽冥洞府（如果不在）
  if (ov.includes('幽冥洞府') && ov.includes('秘境入口')) {
    console.log('\n--- 已在秘境入口，直接进 ---');
  } else {
    const m = ov.match(/【可前往】(.*)/);
    console.log('\n可前往:', m?.[1]?.slice(0, 120));
  }

  // 进副本 → 探索（若触发战斗则打）
  try {
    const enter = await call('xiuxian_dungeon', { action: 'enter', dungeonId: 'spirit_cave' });
    console.log('\n--- 入副本 ---\n' + enter.split('\n\n')[0]);
  } catch (e) { console.log('入副本失败（可能已在其中或不在入口）:', e.message); }

  // 探索最多6轮，遇敌则战
  for (let i = 0; i < 6; i++) {
    const st = await (await fetch(`${BASE}/api/state`)).json();
    if (!st.inDungeon) { console.log('已不在副本中，结束'); break; }
    if (st.inCombat) {
      const c = await call('xiuxian_combat', { action: 'attack' });
      const first = c.split('\n')[0];
      console.log(`战斗: ${first}`);
      if (c.includes('战斗胜利')) console.log('  ⚔ 胜利');
      if (c.includes('身殒') || c.includes('已身殒')) { console.log('  ☠ 身殒'); break; }
      continue;
    }
    const exp = await call('xiuxian_dungeon', { action: 'explore' });
    const first = exp.split('\n')[0];
    console.log(`探索: ${first}`);
    if (exp.includes('身殒')) break;
  }

  // 状态检查
  const st = await (await fetch(`${BASE}/api/state`)).json();
  console.log(`\n--- 结果: 生命 ${st.agent.hp}/${st.agent.maxHp} · 灵石 ${st.agent.spiritStones} · 秘境清数 ${st.agent.dungeonsCleared} ---`);

  // 断开 → 验证离场记录（规范客户端会发 DELETE 终止会话）
  await transport.terminateSession();
  await client.close();
  await new Promise(r => setTimeout(r, 600));
  const info = await (await fetch(`${BASE}/api/mcp/info`)).json();
  console.log('断开后连接数:', info.clients.length, info.clients.length === 0 ? '（已正确清理）' : '（✗ 未清理）');
  const st2 = await (await fetch(`${BASE}/api/agent/status`)).json();
  const ext = (st2.decisions || []).filter(d => d.external);
  console.log(`道心流外部操作: ${ext.length} 条（provider=${ext[ext.length-1]?.provider}）`);
  console.log('\n== 流程测试结束 ==');
  process.exit(0);
}

main().catch(e => { console.error('✗', e.message); process.exit(1); });

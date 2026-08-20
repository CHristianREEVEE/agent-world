// test-mcp-client.mjs — 模拟 Claude Code / Codex 通过 MCP 接入修仙世界
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://localhost:3000';
const client = new Client({ name: 'claude-code', version: '1.0.45' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));

const ok = (name, cond, extra = '') => console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
let failed = 0;
const check = (name, cond, extra) => { if (!cond) failed++; ok(name, cond, extra); };

async function main() {
  await client.connect(transport);
  console.log('== MCP 握手成功 ==\n');

  // 1. 工具列表
  const { tools } = await client.listTools();
  check('工具列表（11个）', tools.length === 11, `共 ${tools.length} 个: ${tools.map(t => t.name).join(', ')}`);

  // 2. 总览
  const ov = await client.callTool({ name: 'xiuxian_overview', arguments: {} });
  const ovText = ov.content[0].text;
  check('修士总览', ovText.includes('【修士】') && ovText.includes('云隐子'), ovText.split('\n')[0]);

  // 3. 修炼（等待完成）
  const t0 = Date.now();
  const act = await client.callTool({ name: 'xiuxian_act', arguments: { type: 'rest' } });
  const actText = act.content[0].text;
  check('行动+自动等待', actText.includes('【修士】'), `${Math.round((Date.now() - t0) / 100) / 10}s 完成`);

  // 4. 纪事
  const logs = await client.callTool({ name: 'xiuxian_logs', arguments: { count: 5 } });
  check('翻阅纪事', logs.content[0].text.length > 10);

  // 5. 决策流记录（外部操作应在 /api/agent/status 里）
  const st = await (await fetch(`${BASE}/api/agent/status`)).json();
  const extDecisions = (st.decisions || []).filter(d => d.external);
  check('外部操作入道心流', extDecisions.length >= 3, `已记录 ${extDecisions.length} 条，provider=${extDecisions[0]?.provider}`);

  // 6. MCP 连接状态
  const info = await (await fetch(`${BASE}/api/mcp/info`)).json();
  check('连接状态跟踪', info.clients.length === 1 && info.clients[0].name === 'Claude Code', JSON.stringify(info.clients));
  console.log('\n接入命令：', info.commands.claude);

  // 规范断开（模拟 Claude Code 退出时发送 DELETE）
  await transport.terminateSession();
  await client.close();
  await new Promise(r => setTimeout(r, 500));
  const info2 = await (await fetch(`${BASE}/api/mcp/info`)).json();
  check('断开会话清理', info2.clients.length === 0, `剩余 ${info2.clients.length} 个连接`);

  console.log(failed ? `\n✗ ${failed} 项失败` : '\n== 全部通过 ==');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('✗ 测试异常:', e.message); process.exit(1); });

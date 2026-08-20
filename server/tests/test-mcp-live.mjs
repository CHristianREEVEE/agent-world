// test-mcp-live.mjs — 保持连接并操作，用于验证前端实时联动
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://localhost:3000';
const client = new Client({ name: 'claude-code', version: '1.0.45' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;

await client.connect(transport);
console.log('已连接，开始操作……');
console.log((await call('xiuxian_overview')).split('\n').slice(0, 3).join('\n'));
console.log((await call('xiuxian_dungeon', { action: 'exit' })).split('\n')[0]);
await call('xiuxian_act', { type: 'cultivate' });
console.log('修炼完成一轮');
// 保持连接 12 秒供前端观察
await new Promise(r => setTimeout(r, 12000));
await transport.terminateSession();
await client.close();
console.log('已断开');
process.exit(0);

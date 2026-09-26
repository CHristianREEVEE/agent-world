// mcp/http.js — Streamable HTTP 传输：把 MCP 服务器挂到 /mcp 端点
// 每个 MCP 会话绑定一个独立 agentId + 连接时的世界实例
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './server.js';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

function prettyClientName(raw) {
  if (!raw) return '未知 Agent';
  const n = String(raw).toLowerCase();
  if (n.includes('claude')) return 'Claude Code';
  if (n.includes('codex')) return 'Codex';
  if (n.includes('cursor')) return 'Cursor';
  if (n.includes('cline') || n.includes('vscode')) return 'IDE Agent';
  if (n.includes('mcp') && n.includes('inspector')) return 'MCP Inspector';
  return raw;
}

export function mountMcp(app, { getActive, switchWorld, registry }) {
  // sessionId -> { transport, agentId, accountId, lastActive, clientLabel, game, runner }
  const transports = new Map();

  function cleanup(sessionId, reason = '') {
    const entry = transports.get(sessionId);
    if (!entry) return;
    transports.delete(sessionId);
    try { entry.transport.close(); } catch {}
    // 用存档的 game/runner 引用（连接时的世界），而非当前的活跃世界
    const agentId = entry.session?.agentId;
    if (agentId && entry.game) {
      entry.game.setAgentOffline(agentId);
      entry.game.emit('update');
    }
    entry.runner?.mcpDisconnect(sessionId, reason);
  }

  const handlePost = async (req, res) => {
    const sessionIdHeader = req.headers['mcp-session-id'];
    let entry = sessionIdHeader ? transports.get(sessionIdHeader) : undefined;

    if (entry) entry.lastActive = Date.now();

    // 新连接
    if (!entry) {
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Missing session id. Send initialize first.' }, id: null });
        return;
      }
      const clientName = prettyClientName(req.body?.params?.clientInfo?.name);
      // 连接时锁定当前活跃世界的 game/runner
      const { game, runner } = getActive();
      const session = { accountId: null };  // 懒建账号：首次创角时创建
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
      });
      const server = createMcpServer({ game, runner, clientLabel: clientName, session, accounts: registry?.accounts });
      transport.onclose = () => {
        if (transport.sessionId) cleanup(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      if (transport.sessionId) {
        transports.set(transport.sessionId, {
          transport, session, lastActive: Date.now(), clientLabel: clientName,
          game, runner,  // 存档引用，cleanup 时用
        });
        runner?.mcpConnect(transport.sessionId, clientName, null);
      }
      return;
    }

    // 已有 session
    try {
      await entry.transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp] handleRequest:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  };

  app.post('/mcp', (req, res, next) => { handlePost(req, res).catch(next); });

  app.get('/mcp', (req, res) => {
    res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null }));
  });

  app.delete('/mcp', (req, res) => {
    const sid = req.headers['mcp-session-id'];
    if (sid && transports.has(sid)) {
      cleanup(sid);
      res.status(200).json({ ok: true });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // 空闲回收
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [sid, e] of transports) {
      if (now - e.lastActive > IDLE_TIMEOUT_MS) {
        console.log(`[mcp] 回收空闲会话 ${sid.slice(0, 8)}（agent ${e.session?.agentId?.slice(0, 8) || '未创角'}）`);
        cleanup(sid, '（久无音讯，元神自行离场）');
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  return {
    status() {
      return {
        endpoint: '/mcp', sessions: transports.size,
        details: [...transports.entries()].map(([sid, e]) => ({
          sessionId: sid.slice(0, 8), agentId: e.session?.agentId?.slice(0, 8) || null,
          clientLabel: e.clientLabel, lastActive: e.lastActive,
        })),
      };
    },
  };
}

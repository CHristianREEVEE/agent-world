// index.js — AI-BING WORLD 服务入口
// 多世界引擎：同时加载所有世界，前端可丝滑切换
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';

import { Game } from './game.js';
import { Store } from './store.js';
import { AgentRunner } from './agent/runner.js';
import { buildApi } from './api.js';
import { mountMcp } from './mcp/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const PORT = Number(process.env.PORT || 3000);
const WORLDS_ROOT = process.env.WORLDS_ROOT || path.join(ROOT, 'worlds');
const WEB_DIR = process.env.WEB_DIR || path.join(ROOT, 'web');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const MAX_AGENTS = Number(process.env.MAX_AGENTS || 500);
const TICK_MS = Number(process.env.TICK_MS || 500);
const BROADCAST_MS = Number(process.env.BROADCAST_MS || 500);

// ---------- 扫描并加载所有世界 ----------
const worldDirs = fs.existsSync(WORLDS_ROOT)
  ? fs.readdirSync(WORLDS_ROOT).filter(d => fs.existsSync(path.join(WORLDS_ROOT, d, 'world.json')))
  : [];

// worlds: { worldId -> { game, runner, store, def, info } }
const worlds = new Map();
let activeWorldId = null;

for (const dir of worldDirs) {
  try {
    const wf = path.join(WORLDS_ROOT, dir, 'world.json');
    const def = JSON.parse(fs.readFileSync(wf, 'utf-8'));
    const store = new Store(path.join(DATA_DIR, dir));
    const game = new Game(def, store);
    game.maxAgents = MAX_AGENTS;
    const runner = new AgentRunner(game, store);
    worlds.set(dir, { game, runner, store, def, info: { id: dir, name: def.name, desc: def.desc || '', areas: def.areas.length, dungeons: def.dungeons.length } });
    console.log(`[boot] 世界「${def.name}」(${dir}) 加载完成：${def.areas.length} 地点 / ${def.dungeons.length} 副本`);
    if (!activeWorldId) activeWorldId = dir;
  } catch (e) {
    console.error(`[boot] 世界 ${dir} 加载失败:`, e.message);
  }
}

// 默认活跃世界优先级：xiuxian > 第一个
if (worlds.has('xiuxian')) activeWorldId = 'xiuxian';

if (!activeWorldId) {
  console.error('[boot] 没有可用世界，退出');
  process.exit(1);
}

const availableWorlds = [...worlds.values()].map(w => w.info);

// 获取活跃世界
function getActive() { return worlds.get(activeWorldId); }

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const apiRouter = buildApi({ getActive, availableWorlds, switchWorld });
app.use('/api', apiRouter);

// MCP：外部 Agent 接入（用活跃世界）
const mcpLayer = mountMcp(app, { getActive, switchWorld });
apiRouter._setMcpLayer?.(mcpLayer);

app.use(express.static(WEB_DIR));

const server = http.createServer(app);
server.requestTimeout = 0;
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });
const clients = new Set();

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(msg); } catch { clients.delete(ws); }
    }
  }
}

// 状态广播节流
let stateTimer = null;
let lastBroadcastSig = '';
function broadcastStateSoon() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    const { game } = getActive();
    const st = game.publicState();
    const sig = JSON.stringify({ w: activeWorldId, n: st.agents?.length || 0, d: Math.floor(Date.now() / 1000) });
    if (sig !== lastBroadcastSig) {
      lastBroadcastSig = sig;
      broadcast('state', { ...st, activeWorldId });
    }
  }, BROADCAST_MS);
}

// 所有世界的事件都触发广播
for (const [, { game, runner }] of worlds) {
  game.on('update', broadcastStateSoon);
  game.on('log', (entry) => broadcast('log', entry));
  game.on('agent-chat', (ev) => broadcast('agent-chat', ev));
  runner.on('agent', (ev) => broadcast('agent', ev));
}

function switchWorld(worldId) {
  if (!worlds.has(worldId)) throw new Error('世界不存在');
  const old = activeWorldId;
  activeWorldId = worldId;
  lastBroadcastSig = '';  // 强制广播
  const { game } = getActive();
  game.emit('update');
  console.log(`[world] 切换：${old} -> ${worldId}`);
  return { ok: true, worldId, ...game.publicState() };
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  const { game, runner } = getActive();
  ws.send(JSON.stringify({ type: 'state', data: { ...game.publicState(), activeWorldId } }));
  ws.send(JSON.stringify({ type: 'agent', kind: 'status', data: runner.status(), t: Date.now() }));
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (buf) => {
    try {
      const { type } = JSON.parse(buf.toString());
      if (type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch {}
  });
});

// WebSocket 心跳
const wsHeartbeat = setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) { clients.delete(ws); try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);
wsHeartbeat.unref?.();

// ---------- 所有世界的心跳 ----------
const gameTick = setInterval(() => {
  for (const [, { game }] of worlds) {
    try { game.tick(); } catch (e) { console.error('[tick]', e); }
  }
}, TICK_MS);
gameTick.unref?.();

// ---------- 优雅退出 ----------
process.on('SIGINT', () => {
  console.log('\n[boot] 正在保存并退出……');
  for (const [, { store, game }] of worlds) store.save(game.state);
  process.exit(0);
});
process.on('SIGTERM', () => {
  for (const [, { store, game }] of worlds) store.save(game.state);
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`[boot] AI-BING WORLD 服务已启动（多世界模式）`);
  console.log(`[boot] 界面:  http://localhost:${PORT}`);
  console.log(`[boot] API:   http://localhost:${PORT}/api/state`);
  console.log(`[boot] WS:    ws://localhost:${PORT}/ws`);
  console.log(`[boot] MCP:   http://localhost:${PORT}/mcp`);
  console.log(`[boot]        claude mcp add ai-bing --transport http http://localhost:${PORT}/mcp`);
  console.log(`[boot] 配置:  最大 ${MAX_AGENTS} Agent | 心跳 ${TICK_MS}ms | 广播 ${BROADCAST_MS}ms`);
  console.log(`[boot] 可用世界：${availableWorlds.map(w => `${w.id}(${w.name})`).join('、')}`);
  console.log(`[boot] 当前活跃：${activeWorldId}`);
  for (const [id, { game }] of worlds) {
    const agents = game.allAgents();
    if (agents.length) {
      console.log(`[boot] [${id}] 续接存档：${agents.length} 位修士`);
      for (const a of agents) {
        console.log(`[boot]   - ${a.name}（${game.realmName(a.realmIdx)}）${a.dead ? ' ☠' : a.online ? ' ●在线' : ' ○离线'}`);
      }
    }
  }
});

// index.js — AI-BING WORLD 服务入口（2.0：账号-角色双层 + 多世界）
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
import { AccountManager } from './accounts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// ---------- 装配：加载世界 + 账号体系 ----------
export function createApp({
  dataDir = path.join(ROOT, 'data'),
  worldsRoot = path.join(ROOT, 'worlds'),
  webDir = path.join(ROOT, 'web'),
  maxAgents = 500,
} = {}) {
  // worlds: { worldId -> { game, runner, store, def, info } }
  const worlds = new Map();

  const worldDirs = fs.existsSync(worldsRoot)
    ? fs.readdirSync(worldsRoot).filter(d => fs.existsSync(path.join(worldsRoot, d, 'world.json')))
    : [];

  const failedWorlds = [];
  for (const dir of worldDirs) {
    try {
      const wf = path.join(worldsRoot, dir, 'world.json');
      const raw = fs.readFileSync(wf, 'utf-8');
      const def = JSON.parse(raw);
      // 基本完整性校验
      if (!def.id || !def.name || !Array.isArray(def.areas) || !Array.isArray(def.realms)) {
        throw new Error('world.json 缺少必要字段（id/name/areas/realms）');
      }
      const store = new Store(path.join(dataDir, dir));
      const game = new Game(def, store);
      game.maxAgents = maxAgents;
      const runner = new AgentRunner(game, store);
      worlds.set(dir, { game, runner, store, def, info: { id: dir, name: def.name, desc: def.desc || '', areas: def.areas.length, dungeons: def.dungeons.length } });
      console.log(`[boot] 世界「${def.name}」(${dir}) 加载完成：${def.areas.length} 地点 / ${def.dungeons.length} 副本`);
    } catch (e) {
      console.error(`[boot] ⚠ 世界 ${dir} 加载失败，已跳过:`, e.message);
      failedWorlds.push({ id: dir, error: e.message });
    }
  }

  let activeWorldId = worlds.has('xiuxian') ? 'xiuxian' : worlds.keys().next().value;
  if (!activeWorldId) {
    console.error('[boot] 没有可用世界');
    throw new Error('no worlds');
  }

  // ---------- 账号体系（含旧存档迁移） ----------
  const accounts = new AccountManager({ dataDir, worlds });
  accounts.boot();

  // 成长事件 → 账号 XP 入账
  for (const [, { game }] of worlds) {
    game.on('growth', ({ agent, kind, amount }) => accounts.gainXp(agent, kind, amount));
  }

  const availableWorlds = [...worlds.values()].map(w => w.info);
  const getActive = () => worlds.get(activeWorldId);

  const registry = {
    worlds,
    accounts,
    failedWorlds,
    getWorld: (id) => worlds.get(id),
    getCharacter: (characterId) => {
      for (const [worldId, w] of worlds) {
        const agent = w.game.getAgent(characterId);
        if (agent) return { character: agent, game: w.game, worldId };
      }
      return null;
    },
  };

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

  function switchWorld(worldId) {
    if (!worlds.has(worldId)) throw new Error('世界不存在');
    const old = activeWorldId;
    activeWorldId = worldId;
    const { game } = getActive();
    game.emit('update');
    console.log(`[world] 切换：${old} -> ${worldId}`);
    return { ok: true, worldId, ...game.publicState() };
  }

  const apiRouter = buildApi({ getActive, availableWorlds, switchWorld, registry });
  app.use('/api', apiRouter);

  // MCP：外部 Agent 接入
  const mcpLayer = mountMcp(app, { getActive, switchWorld, registry });
  apiRouter._setMcpLayer?.(mcpLayer);

  app.use(express.static(webDir));

  return { app, registry, worlds, getActive, switchWorld, accounts };
}

// ---------- 启动（含 WS + 心跳） ----------
export function startServer(opts = {}) {
  const PORT = Number(process.env.PORT || opts.port || 3000);
  const TICK_MS = Number(process.env.TICK_MS || 500);
  const BROADCAST_MS = Number(process.env.BROADCAST_MS || 500);

  const { app, worlds, getActive, switchWorld, registry } = createApp(opts);

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

  // 全量世界状态（双世界并行）
  function allWorldsState() {
    const worldsState = {};
    for (const [id, w] of worlds) {
      worldsState[id] = { ...w.game.publicState(), stats: w.game.worldStats() };
    }
    return {
      activeWorldId: getActive().def.id,
      worlds: worldsState,
      accounts: registry.accounts.publicAccounts(),
      failedWorlds: registry.failedWorlds,
    };
  }

  let stateTimer = null;
  let lastBroadcastSig = '';
  function broadcastStateSoon() {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      const data = allWorldsState();
      const sig = JSON.stringify(Object.fromEntries(Object.entries(data.worlds).map(([k, v]) => [k, { n: v.agents?.length || 0, d: Math.floor(Date.now() / 1000) }])));
      if (sig !== lastBroadcastSig) {
        lastBroadcastSig = sig;
        broadcast('state', data);
      }
    }, BROADCAST_MS);
  }

  for (const [, { game, runner }] of worlds) {
    game.on('update', broadcastStateSoon);
    game.on('log', (entry) => broadcast('log', entry));
    game.on('agent-chat', (ev) => broadcast('agent-chat', ev));
    runner.on('agent', (ev) => broadcast('agent', ev));
    // 灵田实时事件（世界 2.0 整合自灵田合并 ac6e2e8）
    game.on('harvest', (ev) => broadcast('harvest', ev));
    game.on('farmEvent', (ev) => broadcast('farm-event', ev));
    game.on('farmReady', (ev) => broadcast('farm-ready', ev));
    game.on('farmUpgrade', (ev) => broadcast('farm-upgrade', ev));
    game.on('worldEvent', (ev) => broadcast('world-event', ev));
    game.on('achievement', (ev) => broadcast('achievement', ev));
  }

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.isAlive = true;
    ws.send(JSON.stringify({ type: 'state', data: allWorldsState() }));
    const { runner } = getActive();
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

  const wsHeartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) { clients.delete(ws); try { ws.terminate(); } catch {} continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 30000);
  wsHeartbeat.unref?.();

  // ---------- 每世界独立 tick 循环（并行，互不冻结） ----------
  // tick 延迟超阈值自动降频：单世界 tick 平均 > 阈值时，该世界频率减半
  const TICK_SLOW_THRESHOLD_MS = Number(process.env.TICK_SLOW_THRESHOLD_MS || 20);
  const worldTimers = new Map();
  for (const [worldId, { game }] of worlds) {
    let interval = TICK_MS;
    const timer = setInterval(() => {
      try {
        game.tick();
        // 负载管理：每 100 tick 评估一次
        const st = game.tickStats();
        if (st.n > 0 && st.n % 100 === 0 && st.avgMs > TICK_SLOW_THRESHOLD_MS) {
          const newInterval = Math.min(interval * 2, 4000);
          if (newInterval !== interval) {
            console.warn(`[tick] ⚠ 世界 ${worldId} tick 平均 ${st.avgMs}ms > ${TICK_SLOW_THRESHOLD_MS}ms，自动降频 ${interval}ms → ${newInterval}ms`);
            interval = newInterval;
            clearInterval(timer);
            worldTimers.set(worldId, setInterval(() => { try { game.tick(); } catch (e) { console.error('[tick]', e); } }, interval));
          }
        }
      } catch (e) { console.error('[tick]', e); }
    }, interval);
    worldTimers.set(worldId, timer);
    timer.unref?.();
  }

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
    console.log(`[boot] AI-BING WORLD 服务已启动（多世界模式 · 2.0 账号体系）`);
    console.log(`[boot] 界面:  http://localhost:${PORT}`);
    console.log(`[boot] API:   http://localhost:${PORT}/api/state`);
    console.log(`[boot] WS:    ws://localhost:${PORT}/ws`);
    console.log(`[boot] MCP:   http://localhost:${PORT}/mcp`);
    console.log(`[boot] 可用世界：${[...worlds.values()].map(w => `${w.info.id}(${w.info.name})`).join('、')}`);
    console.log(`[boot] 当前活跃：${getActive().def.id}`);
    if (registry.accounts.readOnly) console.error('[boot] ⚠ 账号系统处于只读降级模式！');
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

  return { server, registry, worlds };
}

// 直接运行时启动；被 import 时不自动启动（测试用）
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer({
    dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
    worldsRoot: process.env.WORLDS_ROOT || path.join(ROOT, 'worlds'),
    webDir: process.env.WEB_DIR || path.join(ROOT, 'web'),
    maxAgents: Number(process.env.MAX_AGENTS || 500),
  });
}

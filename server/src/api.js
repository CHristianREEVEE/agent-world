// api.js — RESTful API 路由（多世界版本）
// 所有路由通过 getActive() 动态获取当前活跃世界的 game/runner
import { Router } from 'express';
import { randomUUID } from 'node:crypto';

export function buildApi({ getActive, availableWorlds, switchWorld }) {
  const r = Router();

  const wrap = (fn) => (req, res) => {
    try { const out = fn(req, res); if (out !== undefined) res.json(out); }
    catch (e) { res.status(400).json({ ok: false, error: e.message || String(e) }); }
  };
  const wrapAsync = (fn) => (req, res) => {
    Promise.resolve(fn(req, res))
      .then((out) => { if (out !== undefined) res.json(out); })
      .catch((e) => res.status(400).json({ ok: false, error: e.message || String(e) }));
  };

  const getAgentId = (req) => req.body?.agentId || req.query.agentId || null;

  let mcpLayer = null;

  // ---------- 世界切换 ----------
  r.post('/world/switch', wrap((req) => {
    const worldId = req.body?.worldId || req.query.worldId;
    if (!worldId) throw new Error('需提供 worldId');
    return switchWorld(worldId);
  }));

  // ---------- 上帝视角 ----------
  r.get('/state', wrap(() => {
    const { game } = getActive();
    return { ok: true, ...game.publicState(), activeWorldId: getActive().def.id };
  }));

  r.get('/world', wrap(() => {
    const { game } = getActive();
    const d = game.def;
    return {
      ok: true,
      world: {
        id: d.id, name: d.name, desc: d.desc, spawn: d.spawn,
        map: d.map, areas: d.areas, realms: d.realms.map(x => ({
          name: x.name, maxCultivation: x.maxCultivation, maxLifespan: x.maxLifespan,
          breakItem: x.breakItem || null,
        })),
        paths: Object.fromEntries(Object.entries(d.paths).map(([k, v]) => [k, { name: v.name, desc: v.desc, skills: v.skills }])),
        dungeons: d.dungeons.map(x => ({ id: x.id, name: x.name, areaId: x.areaId, floors: x.floors, minRealm: x.minRealm, minRealmName: d.realms[x.minRealm].name })),
        items: d.items,
      },
    };
  }));

  r.get('/logs', wrap((req) => {
    const { game } = getActive();
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 60);
    return { ok: true, logs: game.state.logs.slice(-limit) };
  }));

  r.get('/agents', wrap(() => {
    const { game } = getActive();
    const ps = game.publicState();
    return { ok: true, agents: ps.agents || [], areaPop: ps.areaPop || {} };
  }));

  r.get('/worlds', wrap(() => ({ ok: true, worlds: availableWorlds || [] })));

  r.get('/agent/:agentId', wrap((req) => {
    const { game } = getActive();
    const st = game.agentPublicState(req.params.agentId);
    if (!st) return { ok: false, error: 'Agent 不存在' };
    return { ok: true, ...st };
  }));

  // ---------- 角色与游戏控制 ----------
  r.post('/agent/create', wrapAsync(async (req) => {
    const { game, runner } = getActive();
    const { name, path, body, comprehension, luck, agentId } = req.body || {};
    const id = agentId || randomUUID();
    game.createAgent(id, { name, path, body, comprehension, luck, clientLabel: 'Web' });
    if (runner) { runner.agentId = id; runner.updateConfig({ persona: name }); }
    return { ok: true, agentId: id, state: game.agentPublicState(id) };
  }));

  r.post('/reincarnate', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    game.reincarnateAgent(agentId);
    return { ok: true, state: game.agentPublicState(agentId) };
  }));

  r.post('/game/speed', wrap((req) => {
    const { game } = getActive();
    const speed = Number(req.body?.speed);
    if (![0, 1, 2, 5].includes(speed)) throw new Error('速度仅支持 0/1/2/5');
    game.state.world.speed = speed;
    game.state.world.paused = speed === 0;
    game.addLog(speed === 0 ? '时间静止了。' : `时间流速调整为 ${speed} 倍。`, 'system');
    game.emit('update');
    game.markDirty();
    return { ok: true, speed };
  }));

  // ---------- 行动 ----------
  r.get('/actions', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return { ok: true, actions: game.availableActions(agentId) };
  }));

  r.post('/action', wrapAsync(async (req) => {
    const { game } = getActive();
    const { type, itemName } = req.body || {};
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const res = game.startAction(agentId, type, { itemName });
    return { ok: true, ...res, actionId: `act_${Date.now()}` };
  }));

  r.post('/action/cancel', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return { ok: true, ...game.cancelAction(agentId) };
  }));

  r.post('/move', wrapAsync(async (req) => {
    const { game } = getActive();
    const { areaId } = req.body || {};
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return { ok: true, ...game.moveTo(agentId, areaId), actionId: `move_${Date.now()}` };
  }));

  // ---------- 副本 ----------
  r.post('/dungeon/enter', wrapAsync(async (req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return { ok: true, ...game.enterDungeonById(agentId, req.body?.dungeonId) };
  }));

  r.post('/dungeon/action', wrapAsync(async (req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return { ok: true, ...game.dungeon(agentId, req.body?.action) };
  }));

  // ---------- 战斗 ----------
  r.post('/combat/action', wrapAsync(async (req) => {
    const { game } = getActive();
    const { action, skillIdx } = req.body || {};
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return game.combat(agentId, action, skillIdx);
  }));

  // ---------- 背包与商店 ----------
  r.get('/inventory', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const agent = game.getAgent(agentId);
    if (!agent) throw new Error('Agent 不存在');
    return { ok: true, inventory: agent.inventory, spiritStones: agent.spiritStones };
  }));

  r.post('/inventory/use', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return { ok: true, ...game.useItem(agentId, req.body?.itemName) };
  }));

  r.get('/shop', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return { ok: true, ...game.shopList(agentId) };
  }));

  r.post('/shop/buy', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return { ok: true, ...game.buy(agentId, req.body?.itemName, req.body?.count) };
  }));

  r.post('/shop/sell', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return { ok: true, ...game.sell(agentId, req.body?.itemName, req.body?.count) };
  }));

  // ---------- Agent Runner ----------
  const { runner } = getActive();
  if (runner) {
    r.get('/agent/config', wrap(() => { const { runner } = getActive(); return { ok: true, config: runner.publicConfig() }; }));
    r.post('/agent/config', wrap((req) => { const { runner } = getActive(); return { ok: true, config: runner.updateConfig(req.body || {}) }; }));
    r.post('/agent/start', wrap(() => { const { runner } = getActive(); return { ok: true, ...runner.start() }; }));
    r.post('/agent/stop', wrap(() => { const { runner } = getActive(); return { ok: true, ...runner.stop() }; }));
    r.get('/agent/status', wrap(() => { const { runner } = getActive(); return { ok: true, ...runner.status() }; }));
    r.post('/agent/tick', wrapAsync(async () => { const { runner } = getActive(); await runner.tick(); return { ok: true }; }));
    r.post('/agent/chat', wrapAsync(async (req) => { const { runner } = getActive(); return { ok: true, ...(await runner.chat(req.body?.message)) }; }));
    r.get('/mcp/info', wrap((req) => ({
      ok: true,
      endpoint: `${req.protocol}://${req.get('host')}/mcp`,
      sessions: mcpLayer?.status() || { sessions: 0 },
      commands: {
        claude: `claude mcp add ai-bing --transport http ${req.protocol}://${req.get('host')}/mcp`,
        codex: `[mcp_servers.ai-bing]\nurl = "${req.protocol}://${req.get('host')}/mcp"`,
      },
    })));
  }

  r._setMcpLayer = (layer) => { mcpLayer = layer; };

  return r;
}

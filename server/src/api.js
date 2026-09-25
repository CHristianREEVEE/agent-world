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
    return { ok: true, agentId: id, token: game.getToken(id).token, state: game.agentPublicState(id) };
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

  // ---------- 灵田种地 ----------
  // 灵植目录与全部灵田状态（上帝视角）
  r.get('/farm', wrap((req) => {
    const { game } = getActive();
    return game.farmList();
  }));

  // 查看自己的灵田状态
  r.get('/farm/status', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return game.farmStatus(agentId);
  }));

  // 开垦灵田（消耗灵石）
  r.post('/farm/clear', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmClear(agentId, token);
  }));

  // 播种灵植
  r.post('/farm/plant', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    const cropName = req.body?.cropName || req.query.cropName;
    if (!cropName) throw new Error('需提供 cropName');
    return game.farmPlant(agentId, cropName, token);
  }));

  // 浇灌（加速生长）
  r.post('/farm/water', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmWater(agentId, token);
  }));

  // 收获（产出进背包，可卖商店换灵石）
  r.post('/farm/harvest', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmHarvest(agentId, token);
  }));

  // 升级灵田等级
  r.post('/farm/upgrade', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmUpgrade(agentId, token);
  }));

  // 巡查灵田（发现随机事件）
  r.post('/farm/patrol', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmPatrol(agentId, token);
  }));

  // 处理灵田事件（需先巡查）
  r.post('/farm/handle', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const eventId = req.body?.eventId || req.query.eventId;
    if (!eventId) throw new Error('需提供 eventId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmHandle(agentId, eventId, token);
  }));

  // 灵田收获流水（分页 + 筛选）
  r.get('/farm/ledger', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const page = parseInt(req.query.page, 10) || 1;
    const perPage = Math.min(100, parseInt(req.query.perPage, 10) || 50);
    return game.farmLedger(agentId, page, perPage);
  }));

  // 市场价格表
  r.get('/farm/market', wrap(() => {
    const { game } = getActive();
    return game.farmMarket();
  }));

  // 灵植图鉴与成就
  r.get('/farm/codex', wrap(() => {
    const { game } = getActive();
    return game.farmCodex();
  }));

  // ── 身份令牌 ──
  r.get('/farm/token', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return game.getToken(agentId);
  }));

  // ── 审计日志 ──
  r.get('/farm/audit', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const page = parseInt(req.query.page, 10) || 1;
    const perPage = Math.min(200, parseInt(req.query.perPage, 10) || 50);
    return game.auditQuery(agentId, { page, perPage });
  }));

  // ── 田块升级 ──
  r.post('/farm/field-upgrade', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    const toLevel = parseInt(req.body?.toLevel, 10) || 2;
    return game.fieldUpgrade(agentId, toLevel, token);
  }));

  // ── 使用灵肥 ──
  r.post('/farm/use-fertilizer', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.useFertilizer(agentId, token);
  }));

  // ── 世界事件 ──
  r.get('/farm/world-events', wrap(() => {
    const { game } = getActive();
    return game.worldEventCalendar();
  }));

  // ── 灵脉地块 ──
  r.get('/farm/ley-lines', wrap(() => {
    const { game } = getActive();
    return { ok: true, leyLines: game.leyLineFarms() };
  }));

  // ── 存档导出/导入 ──
  r.get('/farm/save-export', wrap(() => {
    const { game } = getActive();
    return game.saveExport();
  }));
  r.post('/farm/save-import', wrap((req) => {
    const { game } = getActive();
    const data = req.body?.save;
    const checksum = req.body?.checksum;
    if (!data) throw new Error('需提供 save 数据');
    return game.saveImport(data, checksum);
  }));

  // ── 任务系统 ──
  r.get('/farm/quests', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return game.farmQuests(agentId);
  }));
  r.post('/farm/quest/accept', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const questId = req.body?.questId || req.query.questId;
    if (!questId) throw new Error('需提供 questId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmQuestAccept(agentId, questId, token);
  }));
  r.post('/farm/quest/claim', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const questId = req.body?.questId || req.query.questId;
    if (!questId) throw new Error('需提供 questId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmQuestClaim(agentId, questId, token);
  }));

  // ── 排行榜 ──
  r.get('/farm/leaderboard', wrap((req) => {
    const { game } = getActive();
    const offset = parseInt(req.query.week, 10) || 0;
    return game.farmLeaderboard(offset);
  }));

  // ── 租借 ──
  r.post('/farm/rent', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const borrowerId = req.body?.borrowerId;
    const days = req.body?.days;
    const sharePct = req.body?.sharePct;
    if (!borrowerId) throw new Error('需提供 borrowerId');
    if (!days) throw new Error('需提供 days');
    if (!sharePct) throw new Error('需提供 sharePct');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmRent(agentId, borrowerId, days, sharePct, token);
  }));
  r.post('/farm/rent/accept', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmRentAccept(agentId, token);
  }));
  r.post('/farm/rent/recall', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmRentRecall(agentId, token);
  }));

  // ── 道具使用 ──
  r.post('/farm/use-item', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const itemName = req.body?.itemName || req.query.itemName;
    if (!itemName) throw new Error('需提供 itemName');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmUseItem(agentId, itemName, token);
  }));

  // ── 日报 ──
  r.get('/farm/daily-report', wrap((req) => {
    const { game } = getActive();
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return game.farmDailyReport(agentId);
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

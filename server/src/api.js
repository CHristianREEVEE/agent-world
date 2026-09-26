// api.js — RESTful API 路由（2.0：账号-角色双层）
// 鉴权：Authorization: Bearer <token>（新体系）；兼容旧版直传 agentId（= 原主人密钥）
// 行动端点作用于「当前活跃角色」；角色固定绑定世界，路由自动定位到角色所在世界的 game
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError } from './accounts.js';
import { destinyRating } from './destiny.js';

export function buildApi({ getActive, availableWorlds, switchWorld, registry }) {
  const r = Router();

  const wrap = (fn) => (req, res) => {
    try {
      const out = fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (e) {
      if (e instanceof ApiError) res.status(e.status).json({ ok: false, error: e.message, code: e.code });
      else res.status(400).json({ ok: false, error: e.message || String(e), code: 'INTERNAL' });
    }
  };
  const wrapAsync = (fn) => (req, res) => {
    Promise.resolve(fn(req, res))
      .then((out) => { if (out !== undefined) res.json(out); })
      .catch((e) => {
        if (e instanceof ApiError) res.status(e.status).json({ ok: false, error: e.message, code: e.code });
        else res.status(400).json({ ok: false, error: e.message || String(e), code: 'INTERNAL' });
      });
  };

  const getAgentId = (req) => req.body?.agentId || req.query.agentId || null;

  // token → 账号（Authorization: Bearer / body.token / query.token）
  const authenticate = (req) => {
    const header = req.headers.authorization || '';
    const token = header.replace(/^Bearer\s+/i, '') || req.body?.token || req.query.token || null;
    if (!token) throw new ApiError('UNAUTHORIZED', '需提供 token（Authorization: Bearer <token>）', 401);
    const acc = registry.accounts.authenticate(token);
    if (!acc) throw new ApiError('INVALID_TOKEN', 'token 无效或已注销', 401);
    return acc;
  };

  // 解析行动目标：优先 token → 账号活跃角色；否则回退旧版 agentId 直连
  const resolveActor = (req) => {
    const header = req.headers.authorization || '';
    const token = header.replace(/^Bearer\s+/i, '') || req.body?.token || req.query.token || null;
    const agentId = getAgentId(req);

    if (token) {
      const account = registry.accounts.authenticate(token);
      if (!account) throw new ApiError('INVALID_TOKEN', 'token 无效或已注销', 401);
      const charId = agentId || account.activeCharacterId;
      if (!charId) throw new ApiError('NO_ACTIVE_CHARACTER', '暂无活跃角色，请先创建角色或切换角色', 400);
      const loc = registry.getCharacter(charId);
      if (!loc) throw new ApiError('CHARACTER_NOT_FOUND', '角色不存在', 404);
      if (loc.character.accountId && loc.character.accountId !== account.id) {
        throw new ApiError('NOT_YOUR_CHARACTER', '该角色不属于当前账号', 403);
      }
      return { account, character: loc.character, game: loc.game, worldId: loc.worldId };
    }
    if (agentId) {
      const loc = registry.getCharacter(agentId);
      if (!loc) throw new ApiError('CHARACTER_NOT_FOUND', '角色不存在', 404);
      return { account: null, character: loc.character, game: loc.game, worldId: loc.worldId };
    }
    throw new ApiError('UNAUTHORIZED', '需提供 token（Authorization: Bearer <token>）或 agentId', 401);
  };

  let mcpLayer = null;

  // ---------- 世界切换（上帝视角） ----------
  r.post('/world/switch', wrap((req) => {
    const worldId = req.body?.worldId || req.query.worldId;
    if (!worldId) throw new ApiError('WORLD_REQUIRED', '需提供 worldId', 400);
    if (!registry.worlds.has(worldId)) throw new ApiError('WORLD_NOT_FOUND', `世界不存在：${worldId}`, 404);
    return switchWorld(worldId);
  }));

  // ---------- 上帝视角 ----------
  r.get('/state', wrap((req) => {
    const worldId = req.query.worldId;
    // 单世界查询
    if (worldId) {
      const w = registry.worlds.get(worldId);
      if (!w) throw new ApiError('WORLD_NOT_FOUND', `世界不存在：${worldId}`, 404);
      return {
        ok: true, ...w.game.publicState(),
        worldId,
        stats: w.game.worldStats(),
        accounts: registry.accounts.publicAccounts(),
      };
    }
    // 全量：所有世界 + 统计
    const worlds = {};
    for (const [id, w] of registry.worlds) {
      worlds[id] = { ...w.game.publicState(), stats: w.game.worldStats() };
    }
    return {
      ok: true,
      activeWorldId: getActive().def.id,
      worlds,
      accounts: registry.accounts.publicAccounts(),
      failedWorlds: registry.failedWorlds || [],
    };
  }));

  r.get('/world', wrap((req) => {
    const worldId = req.query.worldId;
    const w = worldId ? registry.worlds.get(worldId) : getActive();
    if (!w) throw new ApiError('WORLD_NOT_FOUND', `世界不存在：${worldId}`, 404);
    const { game } = w;
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

  // 观测台：全部账号公开视图（不含 token）
  r.get('/accounts', wrap(() => ({ ok: true, accounts: registry.accounts.publicAccounts() })));

  r.get('/agent/:agentId', wrap((req) => {
    const { game } = getActive();
    const st = game.agentPublicState(req.params.agentId);
    if (!st) throw new ApiError('CHARACTER_NOT_FOUND', 'Agent 不存在', 404);
    return { ok: true, ...st };
  }));

  // ========== 账号体系（2.0） ==========

  // 注册账号 → 返回 token（主人密钥）
  r.post('/account/register', wrap((req) => {
    const code = req.body?.code || '';
    const acc = registry.accounts.createAccount({ code });
    return { ok: true, token: acc.token, account: registry.accounts.accountView(acc) };
  }));

  // 账号信息（等级/XP/角色列表）
  r.get('/account', wrap((req) => {
    const account = authenticate(req);
    return { ok: true, account: registry.accounts.accountView(account) };
  }));

  // 创建角色（绑定世界）
  r.post('/characters', wrap((req) => {
    const account = authenticate(req);
    const { name, worldId, path, body, comprehension, luck } = req.body || {};
    if (!worldId) throw new ApiError('WORLD_REQUIRED', '需提供 worldId（角色固定绑定一个世界）', 400);
    if (!registry.worlds.has(worldId)) throw new ApiError('WORLD_NOT_FOUND', `世界不存在：${worldId}`, 404);
    const agent = registry.accounts.createCharacter(account.id, worldId, {
      name, path, body, comprehension, luck, clientLabel: account.code,
    });
    const loc = registry.getCharacter(agent.id);
    return { ok: true, characterId: agent.id, activeCharacterId: account.activeCharacterId, state: loc.game.agentPublicState(agent.id) };
  }));

  // 角色列表
  r.get('/characters', wrap((req) => {
    const account = authenticate(req);
    return { ok: true, characters: registry.accounts.accountView(account).characters };
  }));

  // 角色详情
  r.get('/characters/:id', wrap((req) => {
    const account = authenticate(req);
    const loc = registry.getCharacter(req.params.id);
    if (!loc) throw new ApiError('CHARACTER_NOT_FOUND', '角色不存在', 404);
    if (loc.character.accountId !== account.id) throw new ApiError('NOT_YOUR_CHARACTER', '该角色不属于当前账号', 403);
    return { ok: true, ...loc.game.agentPublicState(req.params.id) };
  }));

  // 气运评价（不暴露天命数值）
  r.get('/characters/:id/fortune', wrap((req) => {
    const account = authenticate(req);
    const loc = registry.getCharacter(req.params.id);
    if (!loc) throw new ApiError('CHARACTER_NOT_FOUND', '角色不存在', 404);
    if (loc.character.accountId !== account.id) throw new ApiError('NOT_YOUR_CHARACTER', '该角色不属于当前账号', 403);
    const rating = destinyRating(loc.character.destiny || 50);
    return { ok: true, ...rating };
  }));

  // 角色随机事件历史
  r.get('/characters/:id/events', wrap((req) => {
    const account = authenticate(req);
    const loc = registry.getCharacter(req.params.id);
    if (!loc) throw new ApiError('CHARACTER_NOT_FOUND', '角色不存在', 404);
    if (loc.character.accountId !== account.id) throw new ApiError('NOT_YOUR_CHARACTER', '该角色不属于当前账号', 403);
    const events = (loc.character.eventLog || []).slice(-50).reverse();
    return { ok: true, events };
  }));

  // 切换活跃角色
  r.post('/characters/:id/switch', wrap((req) => {
    const account = authenticate(req);
    const res = registry.accounts.switchCharacter(account.id, req.params.id);
    return { ok: true, activeCharacterId: account.activeCharacterId, state: res.game.agentPublicState(res.character.id) };
  }));

  // 删除角色（在途/战斗/副本中禁止）
  r.delete('/characters/:id', wrap((req) => {
    const account = authenticate(req);
    const res = registry.accounts.deleteCharacter(account.id, req.params.id);
    return { ok: true, ...res };
  }));

  // ---------- 人类观察面板（2.2） ----------
  // token 验证
  r.post('/session/verify', wrap((req) => {
    const account = authenticate(req);
    return { ok: true, account: registry.accounts.accountView(account) };
  }));

  // 我的账号视图（含角色详情 + 行为日志）
  r.get('/me', wrap((req) => {
    const account = authenticate(req);
    const view = registry.accounts.accountView(account);
    // 附加每角色的完整快照 + 行为日志
    view.characters = view.characters.map(ref => {
      const loc = registry.getCharacter(ref.id);
      const game = loc?.game;
      const agent = loc?.character;
      if (!agent) return { ...ref, missing: true };
      return {
        ...ref,
        // 完整角色快照（与 agentPublicState.agent 一致，但不含 destiny/pity）
        cultivationMax: game.def.realms[agent.realmIdx].maxCultivation,
        hp: Math.floor(agent.hp), maxHp: agent.maxHp,
        spirit: Math.floor(agent.spirit), maxSpirit: agent.maxSpirit,
        stamina: Math.floor(agent.stamina), maxStamina: agent.maxStamina,
        body: agent.body, comprehension: agent.comprehension, luck: agent.luck,
        age: agent.age, lifespan: game.def.realms[agent.realmIdx].maxLifespan,
        inventory: agent.inventory,
        spiritStones: agent.spiritStones,
        kills: agent.kills, dungeonsCleared: agent.dungeonsCleared,
        currentAction: agent.currentAction ? { label: agent.currentAction.label, progress: agent.currentAction.progress } : null,
        actionLog: (agent.actionLog || []).slice(-50).reverse(),
        eventLog: (agent.eventLog || []).slice(-20).reverse(),
        fortune: destinyRating(agent.destiny || 50),
      };
    });
    return { ok: true, account: view };
  }));

  // SSE 实时推送（断线自动重连由 EventSource 原生处理）
  r.get('/session/stream', (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.token;
    const account = registry.accounts.authenticate(token);
    if (!account) {
      res.status(401).json({ ok: false, error: 'token 无效或已注销', code: 'INVALID_TOKEN' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('event: connected\ndata: {"ok":true}\n\n');

    const send = (type, data) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // 订阅所有世界的 update/log 事件
    const listeners = [];
    for (const [worldId, w] of registry.worlds) {
      const onUpdate = () => {
        // 只推送该账号相关角色的更新
        const chars = account.characters.filter(c => c.worldId === worldId);
        if (!chars.length) return;
        const agentUpdates = chars.map(ref => {
          const agent = w.game.getAgent(ref.characterId);
          if (!agent) return null;
          return {
            characterId: ref.characterId,
            realmIdx: agent.realmIdx,
            cultivation: Math.floor(agent.cultivation),
            areaName: w.game.agentArea(agent)?.name || '?',
            status: w.game.agentStatus(agent),
            actionLog: (agent.actionLog || []).slice(-10).reverse(),
            eventLog: (agent.eventLog || []).slice(-5).reverse(),
          };
        }).filter(Boolean);
        if (agentUpdates.length) send('update', { worldId, characters: agentUpdates, account: registry.accounts.accountView(account) });
      };
      const onLog = (entry) => {
        // 只推送与该账号角色相关的日志
        const related = account.characters.some(c => {
          const agent = w.game.getAgent(c.characterId);
          return agent && entry.text.includes(agent.name);
        });
        if (related) send('log', entry);
      };
      w.game.on('update', onUpdate);
      w.game.on('log', onLog);
      listeners.push([w.game, 'update', onUpdate], [w.game, 'log', onLog]);
    }

    // 心跳
    const heartbeat = setInterval(() => send('heartbeat', { t: Date.now() }), 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      for (const [game, ev, fn] of listeners) game.off(ev, fn);
    });
  });

  // ---------- 导出 / 导入（完整性校验） ----------
  // 导出全量账号档案（含完整性校验）
  r.get('/admin/export', wrap(() => {
    return { ok: true, archive: registry.accounts.exportArchive() };
  }));

  // 导入账号档案（校验：角色引用世界存在、账号引用角色存在）
  r.post('/admin/import', wrap((req) => {
    const archive = req.body?.archive;
    if (!archive) throw new ApiError('ARCHIVE_INVALID', '缺少 archive 字段', 400);
    return registry.accounts.importArchive(archive);
  }));

  // 运维：迁移回滚（测试/灾备用）
  r.post('/admin/migrate/rollback', wrap(() => registry.accounts.rollback()));

  // ---------- 旧版创角（向后兼容：无 token 时自动建账号并返回 token；有 token 时在账号下创角） ----------
  r.post('/agent/create', wrapAsync(async (req) => {
    const { name, path, body, comprehension, luck, agentId, worldId } = req.body || {};
    // 可选 token：有则挂到账号下，无则自动建账号
    let account = null;
    const header = req.headers.authorization || '';
    const tokenRaw = header.replace(/^Bearer\s+/i, '') || req.body?.token || req.query.token || null;
    if (tokenRaw) {
      account = registry.accounts.authenticate(tokenRaw);
      if (!account) throw new ApiError('INVALID_TOKEN', 'token 无效或已注销', 401);
    }
    const wid = worldId || getActive().def.id;
    if (!registry.worlds.has(wid)) throw new ApiError('WORLD_NOT_FOUND', `世界不存在：${wid}`, 404);
    const game = registry.getWorld(wid).game;

    let characterId, token;
    if (account) {
      const agent = registry.accounts.createCharacter(account.id, wid, {
        name, path, body, comprehension, luck, clientLabel: account.code,
      });
      characterId = agent.id;
    } else {
      characterId = agentId || randomUUID();
      game.createAgent(characterId, { name, path, body, comprehension, luck, clientLabel: 'Web' });
      const acc = registry.accounts.attachLegacyAgent(characterId, wid, name);
      token = acc.token;
    }
    const { runner } = registry.getWorld(wid);
    if (runner && !account) { runner.agentId = characterId; runner.updateConfig({ persona: name }); }
    // token = 角色身份令牌（灵田签名体系）；accountToken = 旧版匿名创角时自动建账号的令牌
    return { ok: true, agentId: characterId, token: game.getToken(characterId).token, ...(token ? { accountToken: token } : {}), state: game.agentPublicState(characterId) };
  }));

  r.post('/reincarnate', wrap((req) => {
    const { character, game } = resolveActor(req);
    game.reincarnateAgent(character.id);
    return { ok: true, state: game.agentPublicState(character.id) };
  }));

  r.post('/game/speed', wrap((req) => {
    const { game } = getActive();
    const speed = Number(req.body?.speed);
    if (![0, 1, 2, 5].includes(speed)) throw new ApiError('INVALID_SPEED', '速度仅支持 0/1/2/5', 400);
    game.state.world.speed = speed;
    game.state.world.paused = speed === 0;
    game.addLog(speed === 0 ? '时间静止了。' : `时间流速调整为 ${speed} 倍。`, 'system');
    game.emit('update');
    game.markDirty();
    return { ok: true, speed };
  }));

  // ---------- 行动（作用于当前活跃角色） ----------
  r.get('/actions', wrap((req) => {
    const { character, game } = resolveActor(req);
    return { ok: true, actions: game.availableActions(character.id) };
  }));

  r.post('/action', wrapAsync(async (req) => {
    const { type, itemName } = req.body || {};
    const { character, game } = resolveActor(req);
    const res = game.startAction(character.id, type, { itemName });
    return { ok: true, ...res, actionId: `act_${Date.now()}` };
  }));

  r.post('/action/cancel', wrap((req) => {
    const { character, game } = resolveActor(req);
    return { ok: true, ...game.cancelAction(character.id) };
  }));

  r.post('/move', wrapAsync(async (req) => {
    const { areaId } = req.body || {};
    const { character, game } = resolveActor(req);
    return { ok: true, ...game.moveTo(character.id, areaId), actionId: `move_${Date.now()}` };
  }));

  // ---------- 副本 ----------
  r.post('/dungeon/enter', wrapAsync(async (req) => {
    const { character, game } = resolveActor(req);
    return { ok: true, ...game.enterDungeonById(character.id, req.body?.dungeonId) };
  }));

  r.post('/dungeon/action', wrapAsync(async (req) => {
    const { character, game } = resolveActor(req);
    return { ok: true, ...game.dungeon(character.id, req.body?.action) };
  }));

  // ---------- 灵田种地（世界 2.0 整合：agentId 定位角色所在世界，未传时用活跃世界） ----------
  const farmGame = (req) => {
    const agentId = getAgentId(req);
    if (agentId) {
      const loc = registry.getCharacter(agentId);
      if (loc) return loc.game;
    }
    return getActive().game;
  };

  // ---------- 灵田种地 ----------
  // 灵植目录与全部灵田状态（上帝视角）
  r.get('/farm', wrap((req) => {
    const game = farmGame(req);
    return game.farmList();
  }));

  // 查看自己的灵田状态
  r.get('/farm/status', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return game.farmStatus(agentId);
  }));

  // 开垦灵田（消耗灵石）
  r.post('/farm/clear', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmClear(agentId, token);
  }));

  // 播种灵植
  r.post('/farm/plant', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    const cropName = req.body?.cropName || req.query.cropName;
    if (!cropName) throw new Error('需提供 cropName');
    return game.farmPlant(agentId, cropName, token);
  }));

  // 浇灌（加速生长）
  r.post('/farm/water', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmWater(agentId, token);
  }));

  // 收获（产出进背包，可卖商店换灵石）
  r.post('/farm/harvest', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmHarvest(agentId, token);
  }));

  // 升级灵田等级
  r.post('/farm/upgrade', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmUpgrade(agentId, token);
  }));

  // 巡查灵田（发现随机事件）
  r.post('/farm/patrol', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmPatrol(agentId, token);
  }));

  // 处理灵田事件（需先巡查）
  r.post('/farm/handle', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const eventId = req.body?.eventId || req.query.eventId;
    if (!eventId) throw new Error('需提供 eventId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmHandle(agentId, eventId, token);
  }));

  // 灵田收获流水（分页 + 筛选）
  r.get('/farm/ledger', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const page = parseInt(req.query.page, 10) || 1;
    const perPage = Math.min(100, parseInt(req.query.perPage, 10) || 50);
    return game.farmLedger(agentId, page, perPage);
  }));

  // 市场价格表
  r.get('/farm/market', wrap((req) => {
    const game = farmGame(req);
    return game.farmMarket();
  }));

  // 灵植图鉴与成就
  r.get('/farm/codex', wrap((req) => {
    const game = farmGame(req);
    return game.farmCodex();
  }));

  // ── 身份令牌 ──
  r.get('/farm/token', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return game.getToken(agentId);
  }));

  // ── 审计日志 ──
  r.get('/farm/audit', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const page = parseInt(req.query.page, 10) || 1;
    const perPage = Math.min(200, parseInt(req.query.perPage, 10) || 50);
    return game.auditQuery(agentId, { page, perPage });
  }));

  // ── 田块升级 ──
  r.post('/farm/field-upgrade', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    const toLevel = parseInt(req.body?.toLevel, 10) || 2;
    return game.fieldUpgrade(agentId, toLevel, token);
  }));

  // ── 使用灵肥 ──
  r.post('/farm/use-fertilizer', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.useFertilizer(agentId, token);
  }));

  // ── 世界事件 ──
  r.get('/farm/world-events', wrap((req) => {
    const game = farmGame(req);
    return game.worldEventCalendar();
  }));

  // ── 灵脉地块 ──
  r.get('/farm/ley-lines', wrap((req) => {
    const game = farmGame(req);
    return { ok: true, leyLines: game.leyLineFarms() };
  }));

  // ── 存档导出/导入 ──
  r.get('/farm/save-export', wrap((req) => {
    const game = farmGame(req);
    return game.saveExport();
  }));
  r.post('/farm/save-import', wrap((req) => {
    const game = farmGame(req);
    const data = req.body?.save;
    const checksum = req.body?.checksum;
    if (!data) throw new Error('需提供 save 数据');
    return game.saveImport(data, checksum);
  }));

  // ── 任务系统 ──
  r.get('/farm/quests', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return game.farmQuests(agentId);
  }));
  r.post('/farm/quest/accept', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const questId = req.body?.questId || req.query.questId;
    if (!questId) throw new Error('需提供 questId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmQuestAccept(agentId, questId, token);
  }));
  r.post('/farm/quest/claim', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const questId = req.body?.questId || req.query.questId;
    if (!questId) throw new Error('需提供 questId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmQuestClaim(agentId, questId, token);
  }));

  // ── 排行榜 ──
  r.get('/farm/leaderboard', wrap((req) => {
    const game = farmGame(req);
    const offset = parseInt(req.query.week, 10) || 0;
    return game.farmLeaderboard(offset);
  }));

  // ── 租借 ──
  r.post('/farm/rent', wrap((req) => {
    const game = farmGame(req);
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
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmRentAccept(agentId, token);
  }));
  r.post('/farm/rent/recall', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmRentRecall(agentId, token);
  }));

  // ── 道具使用 ──
  r.post('/farm/use-item', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    const itemName = req.body?.itemName || req.query.itemName;
    if (!itemName) throw new Error('需提供 itemName');
    const token = req.body?.token || req.headers['x-auth-token'];
    return game.farmUseItem(agentId, itemName, token);
  }));

  // ── 日报 ──
  r.get('/farm/daily-report', wrap((req) => {
    const game = farmGame(req);
    const agentId = getAgentId(req);
    if (!agentId) throw new Error('需提供 agentId');
    return game.farmDailyReport(agentId);
  }));

  // ---------- 战斗 ----------
  r.post('/combat/action', wrapAsync(async (req) => {
    const { action, skillIdx } = req.body || {};
    const { character, game } = resolveActor(req);
    return game.combat(character.id, action, skillIdx);
  }));

  // ---------- 背包与商店 ----------
  r.get('/inventory', wrap((req) => {
    const { character, game } = resolveActor(req);
    return { ok: true, inventory: character.inventory, spiritStones: character.spiritStones };
  }));

  r.post('/inventory/use', wrap((req) => {
    const { character, game } = resolveActor(req);
    return { ok: true, ...game.useItem(character.id, req.body?.itemName) };
  }));

  r.get('/shop', wrap((req) => {
    const { character, game } = resolveActor(req);
    return { ok: true, ...game.shopList(character.id) };
  }));

  r.post('/shop/buy', wrap((req) => {
    const { character, game } = resolveActor(req);
    return { ok: true, ...game.buy(character.id, req.body?.itemName, req.body?.count) };
  }));

  r.post('/shop/sell', wrap((req) => {
    const { character, game } = resolveActor(req);
    return { ok: true, ...game.sell(character.id, req.body?.itemName, req.body?.count) };
  }));

  // ---------- Agent Runner（内置灵智，上帝视角调试用） ----------
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

// modules/farm.js — 灵田种地 mixin（Game.prototype 挂载）
// 来源：主仓库灵田合并（ac6e2e8）的 game.js 灵田段，适配 slab 世界 2.0 的 mixin 架构。
// 灵田核心逻辑在 engine/farm.js；本文件只做挂载层：方法群 + 每日结算钩子 + 状态补齐。
import {
  newFarm, newMarket, newCodex, newLeaderboard, newAuditLog, newWorldEvents,
  evalFarm, rollDailyEvent, rollWeather, marketDailyTick, checkAchievements,
  clearFarm, plantCrop, waterFarm, harvestFarm, upgradeFarm, patrolFarm, handleFarm,
  publicFarmState, publicCodex, listQuests, acceptQuest, claimQuest, refreshQuests,
  checkQuestEvents, recordLeaderboard, settleWeekLeaderboard, getLeaderboard,
  createRental, acceptRental, recallRental, settleRental,
  usePestCharm, useGuardCharm, generateDailyReport, cooperativeWaterOwner,
  generateToken, validateToken, auditLog, queryAuditLog,
  checkFertility, consumeFertility, tickFertility, useFertilizer,
  startFieldUpgrade, tickFieldUpgrade, generateLeyLines,
  rollWorldEvents, getWorldEvent, getEventCalendar, migrateState, saveChecksum, verifySave,
  SCHEMA_VERSION, CROPS, FARM, FARM_LEVELS, WEATHERS, CONSUMABLES,
} from '../engine/farm.js';

export { publicFarmState, SCHEMA_VERSION };

// 供外部（game.js 视图层）直接使用的公开灵田状态
export function farmPublic(game, agent, agentId) {
  return publicFarmState(game, agent, game.state.farms[agentId]);
}

// 状态补齐：为旧存档/新世界补灵田全局字段（幂等）
export function ensureFarmState(game) {
  const s = game.state;
  if (!s.farms) s.farms = {};
  if (!s.market) s.market = newMarket();
  if (!s.codex) s.codex = newCodex();
  if (!s.leaderboard) s.leaderboard = newLeaderboard();
  if (!s.audit) s.audit = newAuditLog();
  if (!s.worldEvents) s.worldEvents = newWorldEvents();
  if (!s.schemaVersion) s.schemaVersion = SCHEMA_VERSION;   // 灵田子系统版本（与账号迁移链 version 独立共存）
  if (s.world.weather === undefined) s.world.weather = 'sunny';
  for (const a of Object.values(s.agents || {})) {
    if (!a.token) a.token = generateToken(a.id);
    if (!s.farms[a.id]) s.farms[a.id] = newFarm();
  }
}

export function applyFarmMixin(Game) {

  // requireFarmAgent（原 #private 方法，mixin 版普通函数）
  function requireFarmAgent(game, agentId, token, requireAuth = false) {
    const agent = game.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    if (requireAuth) {
      // 校验签名
      const v = validateToken(token, agentId);
      if (!v.ok) throw new Error(v.error);
    }
    const farm = game.state.farms[agentId];
    if (!farm) game.state.farms[agentId] = newFarm();
    const f = game.state.farms[agentId];
    if (f.level === undefined) f.level = 1;
    if (!Array.isArray(f.events)) f.events = [];
    if (f.lastEventDay === undefined) f.lastEventDay = -1;
    if (f.rainBoost === undefined) f.rainBoost = 0;
    if (f.beastActive === undefined) f.beastActive = false;
    if (f.fertility === undefined) f.fertility = 50;
    if (f.fieldLevel === undefined) f.fieldLevel = 1;
    if (!f.upgrading) f.upgrading = null;
    if (f.isLeyLine === undefined) f.isLeyLine = false;
    return { agent, farm: f };
  }

  // ---------- 每日结算（tick 每 tick 调，内部按 gameDay 幂等） ----------
  Game.prototype.farmDailyTick = function () {
    const w = this.state.world;
    // 天气与市场每日结算
    const prevWeather = w.weather || 'sunny';
    w.weather = rollWeather(prevWeather, this.season());
    if (w.weather !== prevWeather) {
      this.addLog(`天地之间风云变幻，今日天色转为【${WEATHERS[w.weather]?.cn || w.weather}】。`, 'system');
    }
    marketDailyTick(this, this.state.market, w.gameDay);
    settleWeekLeaderboard(this, this.state.leaderboard);

    // 世界事件
    const worldEvent = rollWorldEvents(this, this.state.worldEvents, w.gameDay);
    if (worldEvent && worldEvent.startDay === Math.floor(w.gameDay)) {
      this.addLog(`【世界事件】${worldEvent.name}降临！${worldEvent.desc}`, 'breakthrough');
      this.emit('worldEvent', worldEvent);
    }

    // 每个 Agent 独立处理
    for (const agent of this.allAgents()) {
      if (agent.dead) continue;
      const farm = this.state.farms[agent.id];
      if (!farm) continue;
      // 任务刷新
      refreshQuests(this, agent, farm);
      // 租借到期结算
      settleRental(this, farm);
      // 守护符过期
      if (farm.guardUntil > 0 && Math.floor(w.gameDay) >= farm.guardUntil) farm.guardUntil = 0;
      // 田块升级推进
      if (farm.upgrading) {
        const up = tickFieldUpgrade(this, agent, farm, w.gameDay);
        if (up?.completed) this.emit('farmUpgrade', { agentId: agent.id, fieldLevel: up.fieldLevel });
      }
      // 肥力恢复
      tickFertility(farm, w.gameDay);
      // 日报生成
      generateDailyReport(this, agent, farm);
      // 灵田生长推进
      if (farm.stage === 'growing') {
        const season = this.season();
        // 守护符免疫虫害/灵兽
        const guardActive = farm.guardUntil > 0 && Math.floor(w.gameDay) < farm.guardUntil;
        evalFarm(farm, w.gameDay, season, w.weather);
        if (!guardActive) {
          const evt = rollDailyEvent(this, agent, farm, w.gameDay, season, w.weather);
          if (evt) this.emit('farmEvent', { agentId: agent.id, event: evt });
        } else if (Math.random() < FARM.eventRate * 0.1) {
          rollDailyEvent(this, agent, farm, w.gameDay, season, w.weather);
        }
        if (farm.ready) {
          this.addLog(`${agent.name} 灵田中的【${farm.crop}】已然成熟。`, 'event-good');
          this.emit('farmReady', { agentId: agent.id, crop: farm.crop });
        }
      }
    }
  };

  // ---------- 灵田方法群 ----------
  Game.prototype.farmCrops = function () { return CROPS; };
  Game.prototype.farmConfig = function () { return FARM; };
  Game.prototype.farmLevels = function () { return FARM_LEVELS; };

  Game.prototype.farmStatus = function (agentId) {
    const { agent, farm } = requireFarmAgent(this, agentId);
    return { ok: true, farm: publicFarmState(this, agent, farm) };
  };

  Game.prototype.farmList = function () {
    const season = this.season();
    return {
      ok: true,
      season,
      seasonCrops: Object.values(CROPS).filter(c => c.season === season).map(c => c.name),
      crops: Object.values(CROPS).map(c => ({
        ...c, tierName: ['凡品', '灵品', '仙品'][c.tier],
        inSeason: c.season === season,
        profitPerDay: Math.round(((c.yieldMin + c.yieldMax) / 2 * c.sell - c.cost) / c.periodDays),
      })),
      levels: FARM_LEVELS,
      farm: FARM,
      farms: Object.entries(this.state.agents).map(([id, agent]) => ({
        agentId: id,
        name: agent.name,
        realmName: this.realmName(agent.realmIdx),
        areaName: this.areaDef(agent.areaId)?.name || '未知',
        farm: publicFarmState(this, agent, this.state.farms[id]),
      })),
    };
  };

  Game.prototype.farmClear = function (agentId, token) {
    const { agent, farm } = requireFarmAgent(this, agentId, token, true);
    clearFarm(this, agent, farm);
    auditLog(this, agentId, agent.name, 'farm_clear', '灵田', '成功', -10);
    this.emit('update'); this.markDirty();
    return { ok: true, farm: publicFarmState(this, agent, farm) };
  };

  Game.prototype.farmPlant = function (agentId, cropName, token) {
    const { agent, farm } = requireFarmAgent(this, agentId, token, true);
    // 肥力校验
    const fertChk = checkFertility(farm.fertility);
    if (!fertChk.ok) throw new Error(fertChk.error);
    const r = plantCrop(this, agent, farm, cropName);
    consumeFertility(farm, cropName);
    auditLog(this, agentId, agent.name, 'farm_plant', cropName, '成功', -(CROPS[cropName]?.cost || 0));
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  };

  Game.prototype.farmWater = function (agentId, token) {
    const { agent, farm } = requireFarmAgent(this, agentId, token, true);
    waterFarm(this, agent, farm);
    checkQuestEvents(this, agent, farm, 'water', 1);
    if (farm.rental?.active && farm.rental.borrowerId === agentId) {
      const ownerFarm = this.state.farms[farm.rental.ownerId];
      const owner = this.state.agents[farm.rental.ownerId];
      if (ownerFarm && owner) {
        cooperativeWaterOwner(ownerFarm);
        this.addLog(`${owner.name} 亦因协作浇灌记入任务进度。`, 'system');
      }
    }
    auditLog(this, agentId, agent.name, 'farm_water', '灵田', '成功', 0);
    this.emit('update'); this.markDirty();
    return { ok: true, farm: publicFarmState(this, agent, farm) };
  };

  Game.prototype.farmHarvest = function (agentId, token) {
    const { agent, farm } = requireFarmAgent(this, agentId, token, true);
    const r = harvestFarm(this, agent, farm, this.state.market);
    checkAchievements(this, agent, farm, this.state.codex);
    checkQuestEvents(this, agent, farm, 'harvest', r.count);
    recordLeaderboard(this, this.state.leaderboard, agentId, r.count, r.revenue);
    auditLog(this, agentId, agent.name, 'farm_harvest', r.item, `收获×${r.count}`, 0);
    this.emit('update'); this.markDirty();
    this.emit('harvest', { agentId: agentId, item: r.item, count: r.count, revenue: r.revenue });
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  };

  Game.prototype.farmLedger = function (agentId, page = 1, perPage = 50) {
    const { agent, farm } = requireFarmAgent(this, agentId);
    const ledger = farm.ledger || [];
    const total = ledger.length;
    const start = (page - 1) * perPage;
    const items = ledger.slice(start, start + perPage);
    // 近 30 天产量趋势（按天聚合）
    const trendMap = {};
    for (const e of ledger) {
      const d = e.day;
      if (!trendMap[d]) trendMap[d] = { day: d, count: 0, revenue: 0, crops: {} };
      trendMap[d].count += e.count;
      trendMap[d].revenue += e.revenue;
      trendMap[d].crops[e.crop] = (trendMap[d].crops[e.crop] || 0) + e.count;
    }
    const trend = Object.values(trendMap).sort((a, b) => a.day - b.day).slice(-30);
    return { ok: true, items, total, page, perPage, trend, totalRevenue: farm.totalRevenue };
  };

  Game.prototype.farmMarket = function () {
    const market = this.state.market;
    return {
      ok: true,
      items: Object.entries(CROPS).map(([name, c]) => {
        const m = market.items[name];
        return {
          name, tier: c.tier, tierCN: c.tierCN, season: c.season,
          baseSell: c.sell, currentPrice: m.currentPrice, soldToday: m.soldToday,
          priceDelta: Math.round((m.currentPrice - c.sell) / c.sell * 1000) / 10,
        };
      }),
    };
  };

  Game.prototype.farmCodex = function () {
    return { ok: true, ...publicCodex(this.state.codex) };
  };

  // ── 任务系统 ──
  Game.prototype.farmQuests = function (agentId) {
    const { agent, farm } = requireFarmAgent(this, agentId);
    return { ok: true, quests: listQuests(this, agent, farm), questCodexPoints: farm.questCodexPoints };
  };

  Game.prototype.farmQuestAccept = function (agentId, questId, token) {
    const { agent, farm } = requireFarmAgent(this, agentId, token, true);
    const r = acceptQuest(this, agent, farm, questId);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  };

  Game.prototype.farmQuestClaim = function (agentId, questId, token) {
    const { agent, farm } = requireFarmAgent(this, agentId, token, true);
    const r = claimQuest(this, agent, farm, questId);
    checkQuestEvents(this, agent, farm, 'harvest', 0);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  };

  // ── 排行榜 ──
  Game.prototype.farmLeaderboard = function (weekOffset = 0) {
    return { ok: true, ...getLeaderboard(this, this.state.leaderboard, weekOffset) };
  };

  // ── 租借 ──
  Game.prototype.farmRent = function (agentId, borrowerId, days, sharePct, token) {
    const { agent, farm } = requireFarmAgent(this, agentId, token, true);
    const borrower = this.state.agents[borrowerId];
    if (!borrower) throw new Error('对方修士不存在');
    if (agentId === borrowerId) throw new Error('不能租给自己');
    const r = createRental(this, agent, farm, borrowerId, borrower.name, days, sharePct);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  };

  Game.prototype.farmRentAccept = function (agentId, token) {
    const { agent, farm: borrowerFarm } = requireFarmAgent(this, agentId, token, true);
    // 查找待接受的租借（租借记录在田主的灵田上）
    let rentalFarm = null;
    for (const [fid, f] of Object.entries(this.state.farms)) {
      if (f.rental && f.rental.active && f.rental.borrowerId === agentId && !f.rental.accepted) {
        rentalFarm = f;
        break;
      }
    }
    if (!rentalFarm) throw new Error('无待接受的租借');
    const r = acceptRental(this, agent, rentalFarm);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, borrowerFarm) };
  };

  Game.prototype.farmRentRecall = function (agentId, token) {
    const { agent, farm } = requireFarmAgent(this, agentId, token, true);
    if (farm.rental?.ownerId !== agentId) throw new Error('只有田主可收回灵田');
    const r = recallRental(this, agent, farm);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  };

  // ── 道具 ──
  Game.prototype.farmUseItem = function (agentId, itemName, token) {
    const { agent, farm } = requireFarmAgent(this, agentId, token, true);
    const item = agent.inventory.find(i => i.name === itemName);
    if (!item || item.count < 1) throw new Error(`背包无【${itemName}】`);
    const def = CONSUMABLES[itemName];
    if (!def) throw new Error(`【${itemName}】不是可使用的道具`);
    item.count -= 1;
    if (item.count <= 0) {
      const idx = agent.inventory.indexOf(item);
      agent.inventory.splice(idx, 1);
    }
    if (def.effect === 'clearPest') usePestCharm(this, agent, farm);
    else if (def.effect === 'guard') useGuardCharm(this, agent, farm);
    this.emit('update'); this.markDirty();
    return { ok: true, item: itemName, farm: publicFarmState(this, agent, farm) };
  };

  // ── 日报 ──
  Game.prototype.farmDailyReport = function (agentId) {
    const { agent, farm } = requireFarmAgent(this, agentId);
    const report = generateDailyReport(this, agent, farm);
    if (!report) {
      const lastDay = Math.floor(this.state.world.gameDay);
      return { ok: true, report: { day: lastDay, note: '今日尚无收获事件', income: 0, harvestCount: 0, crops: [], events: [], suggestions: ['播种并收获作物以生成日报'] } };
    }
    return { ok: true, report };
  };

  Game.prototype.farmUpgrade = function (agentId, token) {
    const { agent, farm } = requireFarmAgent(this, agentId, token, true);
    const r = upgradeFarm(this, agent, farm);
    auditLog(this, agentId, agent.name, 'farm_upgrade', '灵田等级', '成功', -(FARM_LEVELS[farm.level - 1]?.upgrade?.stones || 0));
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  };

  Game.prototype.farmPatrol = function (agentId, token) {
    const { agent, farm } = requireFarmAgent(this, agentId, token, true);
    const r = patrolFarm(this, agent, farm);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  };

  Game.prototype.farmHandle = function (agentId, eventId, token) {
    const { agent, farm } = requireFarmAgent(this, agentId, token, true);
    const r = handleFarm(this, agent, farm, eventId);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  };

  // ── 身份令牌 / 审计 / 田块 / 世界事件 / 存档导出导入 ──
  Game.prototype.saveExport = function () {
    const data = JSON.parse(JSON.stringify(this.state));
    const checksum = saveChecksum(data);
    return { ok: true, save: data, checksum, schemaVersion: SCHEMA_VERSION };
  };

  Game.prototype.saveImport = function (data, checksum) {
    if (checksum && !verifySave(data, checksum)) {
      throw new Error('存档校验和不匹配，数据可能被篡改');
    }
    if (!data || typeof data !== 'object' || !data.created) {
      throw new Error('存档数据无效');
    }
    const result = migrateState(data);
    this.state = Object.assign(this.initialState(), result.saved);
    ensureFarmState(this);
    for (const a of Object.values(this.state.agents)) {
      if (!a.token) a.token = generateToken(a.id);
    }
    this._colorIdx = Object.keys(this.state.agents).length % (this.constructor.AGENT_COLORS?.length || 8);
    this.store?.save(this.state);
    this.emit('update'); this.markDirty();
    return { ok: true, migrated: result.migrations.length > 0, migrations: result.migrations, schemaVersion: result.version };
  };

  Game.prototype.verifyToken = function (agentId, token) {
    const agent = this.state.agents[agentId];
    if (!agent) return { ok: false, error: 'Agent 不存在' };
    if (!token) return { ok: false, error: '缺少身份令牌' };
    const parts = String(token).split('.');
    if (parts.length !== 3) return { ok: false, error: '令牌格式无效' };
    if (parts[0] !== agentId) return { ok: false, error: '令牌与修士身份不匹配' };
    if (agent.token !== token) {
      const v = validateToken(token, agentId);
      if (!v.ok) return { ok: false, error: v.error };
    }
    return { ok: true, agent };
  };

  Game.prototype.getToken = function (agentId) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    if (!agent.token) agent.token = generateToken(agentId);
    return { token: agent.token };
  };

  Game.prototype.auditQuery = function (agentId, { page = 1, perPage = 50 } = {}) {
    if (agentId && !this.state.agents[agentId]) throw new Error('Agent 不存在');
    return { ok: true, ...queryAuditLog(this.state.audit, { agentId, page, perPage }) };
  };

  Game.prototype.fieldUpgrade = function (agentId, toLevel, token) {
    const { agent, farm } = requireFarmAgent(this, agentId, token, true);
    if (farm.upgrading) throw new Error('田块正在升级中，请等待完成');
    startFieldUpgrade(this, agent, farm, toLevel);
    this.emit('update'); this.markDirty();
    return { ok: true, upgrading: farm.upgrading, farm: publicFarmState(this, agent, farm) };
  };

  Game.prototype.useFertilizer = function (agentId, token) {
    const { agent, farm } = requireFarmAgent(this, agentId, token, true);
    const item = agent.inventory.find(i => i.name === '灵肥');
    if (!item || item.count < 1) throw new Error('背包无【灵肥】，需在集市购买');
    const r = useFertilizer(agent, farm, 1);
    auditLog(this, agentId, agent.name, 'consume_item', '灵肥', '成功', 0);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  };

  Game.prototype.worldEventCalendar = function () {
    return { ok: true, ...getEventCalendar(this, this.state.worldEvents) };
  };

  Game.prototype.currentWorldEvent = function () {
    return { ok: true, event: getWorldEvent(this, this.state.worldEvents, this.state.world.gameDay) };
  };

  Game.prototype.leyLineFarms = function () {
    return Object.entries(this.state.farms)
      .filter(([, f]) => f.isLeyLine)
      .map(([id, f]) => ({
        agentId: id,
        agentName: this.state.agents[id]?.name || '未知',
        leyLineId: f.leyLineId,
        fertility: f.fertility,
        stage: f.stage,
      }));
  };

  // 新修士开田（createAgent 钩子）+ 身份令牌补发（灵田签名体系）
  Game.prototype.farmInitFor = function (agentId) {
    const agent = this.state.agents[agentId];
    if (agent && !agent.token) agent.token = generateToken(agentId);
    this.state.farms[agentId] = newFarm();
    generateLeyLines(this, this.state.farms);
  };
}

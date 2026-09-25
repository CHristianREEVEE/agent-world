// game.js — 世界引擎核心：多Agent状态机 / 时间 / 行动 / 成长 / 神识感知
import { randInt, clamp, weightedPick, SEASONS, SHICHEN } from './engine/util.js';
import { combatAct, startCombat, isCombatActive } from './engine/combat.js';
import { enterDungeon, dungeonAct, afterDungeonVictory } from './engine/dungeon.js';
import { newFarm, newMarket, newCodex, newLeaderboard, newAuditLog, newWorldEvents, evalFarm, rollDailyEvent, rollWeather, marketDailyTick, marketSell, checkAchievements, clearFarm, plantCrop, waterFarm, harvestFarm, upgradeFarm, patrolFarm, handleFarm, publicFarmState, publicCodex, listQuests, acceptQuest, claimQuest, refreshQuests, checkQuestEvents, recordLeaderboard, settleWeekLeaderboard, getLeaderboard, createRental, acceptRental, recallRental, settleRental, snapshotFarmForReincarnation, inheritFarm, usePestCharm, useGuardCharm, generateDailyReport, cooperativeWater, cooperativeWaterOwner, questWeekOf, generateToken, validateToken, auditLog, queryAuditLog, checkFertility, consumeFertility, tickFertility, useFertilizer, startFieldUpgrade, tickFieldUpgrade, generateLeyLines, rollWorldEvents, getWorldEvent, getEventCalendar, migrateState, saveChecksum, verifySave, SCHEMA_VERSION, CROPS, FARM, FARM_LEVELS, WEATHERS, ACHIEVEMENTS, QUEST_DEFS, CONSUMABLES, WORLD_EVENTS } from './engine/farm.js';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const ACTION_DEFS = {
  cultivate: { label: '修炼', icon: '修', duration: 8000, cost: { spirit: 5 }, desc: '吐纳灵气，提升修为' },
  rest: { label: '休息', icon: '息', duration: 4000, cost: {}, desc: '恢复体力与灵力' },
  collect: { label: '采集', icon: '采', duration: 5000, cost: { stamina: 3 }, desc: '采集灵草（森林）' },
  mine: { label: '挖矿', icon: '掘', duration: 6000, cost: { stamina: 5 }, desc: '开采玄铁（矿脉）' },
  fish: { label: '赶海', icon: '渔', duration: 5000, cost: { stamina: 3 }, desc: '捕捉鱼获（江河海滩）' },
  ask: { label: '请教', icon: '问', duration: 4000, cost: { spiritStones: 10 }, desc: '聆听讲道（宗门/山脉）' },
  fortune: { label: '探缘', icon: '缘', duration: 4000, cost: { stamina: 2 }, desc: '探索此地机缘' },
  shop: { label: '坊市', icon: '购', duration: 0, cost: {}, desc: '买卖物品（集市）' },
};

// 神识感知范围（地图距离单位，地图 1000×700）
const SENSE_RANGES = [0, 80, 150, 250, 400, 550, 700, 9999];

// Agent 标记颜色
const AGENT_COLORS = [
  '#c9a961', '#8fd6b4', '#a78bfa', '#ef7b6d',
  '#5b9fd6', '#e8a87c', '#85c1a8', '#d4a5d5',
];

export class Game extends EventEmitter {
  constructor(worldDef, store) {
    super();
    this.def = worldDef;
    this.store = store;
    this.state = this.#initialState();
    this._lastTick = Date.now();
    this._saveTimer = null;
    this._dirty = false;
    this._colorIdx = 0;
    this.maxAgents = 500;  // 可被外部覆盖
    this.#load();  // #load 可能在存在存档时重设 _colorIdx
  }

  #initialState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      created: false,
      agents: {},           // agentId -> agent object
      farms: {},            // agentId -> farm object（灵田，每个修士一块）
      market: newMarket(),  // 市场动态定价
      codex: newCodex(),    // 图鉴与成就
      leaderboard: newLeaderboard(), // 排行榜
      audit: newAuditLog(),        // 审计日志
      worldEvents: newWorldEvents(), // 限时世界事件
      world: { gameDay: 0.0, speed: 1, paused: false, weather: 'sunny' },
      logs: [],
    };
  }

  #load() {
    const saved = this.store?.load();
    if (!saved) return;
    // 迁移旧版单 Agent 存档
    if (saved.agent && !saved.agents) {
      const oldAgent = saved.agent;
      const agentId = randomUUID();
      saved.agents = {
        [agentId]: {
          id: agentId,
          ...oldAgent,
          currentAction: saved.currentAction || null,
          combat: saved.combat || null,
          dungeon: saved.dungeon || null,
          age: saved.world?.age || 16,
          dead: saved.world?.dead || false,
          deathReason: saved.world?.deathReason || '',
          reincarnations: saved.world?.reincarnations || 0,
          conversations: [],
          online: false,
          mcpSessionId: null,
          color: AGENT_COLORS[0],
          clientLabel: '旧存档',
          createdAt: Date.now(),
        },
      };
      saved.world = { gameDay: saved.world?.gameDay || 0, speed: saved.world?.speed || 1, paused: saved.world?.paused || false };
      delete saved.agent;
      delete saved.currentAction;
      delete saved.combat;
      delete saved.dungeon;
    }
    if (saved.created || (saved.agents && Object.keys(saved.agents).length)) {
      // 统一 schema 版本迁移（含 farms/market/codex/leaderboard/audit/事件/灵脉等全部字段）
      const result = migrateState(saved);
      this.state = Object.assign(this.#initialState(), result.saved);
      // 确保所有 agent 有 conversations 字段和令牌
      for (const a of Object.values(this.state.agents)) {
        if (!a.conversations) a.conversations = [];
        if (a.online) { a.online = false; a.mcpSessionId = null; }
        if (!a.token) a.token = generateToken(a.id);
        if (!this.state.farms[a.id]) this.state.farms[a.id] = newFarm();
      }
      this._colorIdx = Object.keys(this.state.agents).length % AGENT_COLORS.length;
      if (result.migrations.length) {
        console.log(`[boot] 存档迁移完成: ${result.migrations.join('; ')}`);
      }
    }
  }

  markDirty() {
    this._dirty = true;
    if (!this._saveTimer) {
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        if (this._dirty) { this._dirty = false; this.store?.save(this.state); }
      }, 3000);
    }
  }

  // ---------- 基础查询 ----------
  areaDef(id) { return this.def.areas.find(a => a.id === id) || null; }
  realmName(idx) { return this.def.realms[clamp(idx, 0, this.def.realms.length - 1)].name; }
  pathDef(agent) { return this.def.paths[agent.path]; }
  realmDef(agent) { return this.def.realms[agent.realmIdx]; }
  agentArea(agent) { return this.areaDef(agent.areaId); }

  getAgent(agentId) { return this.state.agents[agentId]; }
  allAgents() { return Object.values(this.state.agents); }
  onlineAgents() { return this.allAgents().filter(a => !a.dead && a.online); }

  agentStatus(agent) {
    if (!agent) return 'uncreated';
    if (agent.dead) return 'dead';
    if (isCombatActive(agent)) return 'combat';
    if (agent.dungeon) return 'dungeon';
    if (agent.currentAction) return agent.currentAction.type === 'move' ? 'moving' : 'busy';
    return 'idle';
  }

  addLog(text, type = 'system') {
    const entry = { t: Date.now(), day: Math.floor(this.state.world.gameDay), text, type };
    this.state.logs.push(entry);
    if (this.state.logs.length > 400) this.state.logs.splice(0, this.state.logs.length - 400);
    this.emit('log', entry);
    this.markDirty();
  }

  // ---------- Agent 创建 / 转世 ----------
  createAgent(agentId, { name, path, body, comprehension, luck, clientLabel }) {
    if (!agentId) agentId = randomUUID();
    if (this.state.agents[agentId]) throw new Error('该 Agent 已存在');
    if (!name || typeof name !== 'string' || name.length > 12) throw new Error('道号需为 1-12 字');
    if (!this.def.paths[path]) throw new Error('无效的修炼方向');
    const count = Object.keys(this.state.agents).length;
    if (this.maxAgents && count >= this.maxAgents) throw new Error(`世界已满（上限 ${this.maxAgents} 位修士）`);
    body = clamp(Number(body) || 8, 5, 14);
    comprehension = clamp(Number(comprehension) || 8, 5, 14);
    luck = clamp(Number(luck) || 7, 4, 13);
    const color = AGENT_COLORS[this._colorIdx++ % AGENT_COLORS.length];
    const agent = {
      id: agentId,
      name: name.trim(), path,
      realmIdx: 0, cultivation: 0,
      hp: 0, maxHp: 0, spirit: 0, maxSpirit: 0, stamina: 100, maxStamina: 100,
      body, comprehension, luck,
      areaId: this.def.spawn,
      inventory: [{ name: '聚气丹', count: 3 }],
      spiritStones: 50,
      kills: 0, dungeonsCleared: 0,
      currentAction: null, combat: null, dungeon: null,
      age: 16, dead: false, deathReason: '', reincarnations: 0,
      conversations: [],
      online: false, mcpSessionId: null, connectedAt: null,
      color, clientLabel: clientLabel || name,
      createdAt: Date.now(),
      token: generateToken(agentId),
    };
    this.state.agents[agentId] = agent;
    this.state.farms[agentId] = newFarm();
    generateLeyLines(this, this.state.farms);
    this.state.created = true;
    this.#recalcStats(agent, true);
    this.addLog(`${name} 踏入修行之路，于青石村开始求道生涯。`, 'breakthrough');
    this.emit('update');
    this.markDirty();
    return agent;
  }

  setAgentOnline(agentId, sessionId, clientLabel) {
    const agent = this.state.agents[agentId];
    if (!agent) return;
    agent.online = true;
    agent.mcpSessionId = sessionId;
    agent.connectedAt = Date.now();
    if (clientLabel) agent.clientLabel = clientLabel;
    this.markDirty();
  }

  setAgentOffline(agentId) {
    const agent = this.state.agents[agentId];
    if (!agent) return;
    agent.online = false;
    agent.mcpSessionId = null;
    this.markDirty();
  }

  reincarnateAgent(agentId) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    if (!agent.dead) throw new Error('尚未身殒');
    const keepStones = Math.floor(agent.spiritStones * 0.5);
    agent.realmIdx = 0; agent.cultivation = 0;
    agent.spiritStones = keepStones;
    agent.areaId = this.def.spawn;
    agent.stamina = agent.maxStamina = 100;
    agent.dead = false; agent.deathReason = '';
    agent.reincarnations += 1;
    agent.age = 16;
    agent.combat = null; agent.dungeon = null; agent.currentAction = null;
    this.#recalcStats(agent, true);
    this.addLog(`天道有轮回。${agent.name} 携道痕转世重修（第 ${agent.reincarnations} 世），修炼速度提升 ${agent.reincarnations * 20}%。`, 'breakthrough');
    this.emit('update');
    this.markDirty();
  }

  removeAgent(agentId) {
    const agent = this.state.agents[agentId];
    if (!agent) return;
    delete this.state.agents[agentId];
    this.addLog(`${agent.name} 离开了这个世界。`, 'system');
    this.emit('update');
    this.markDirty();
  }

  reset() {
    this.state = this.#initialState();
    this._colorIdx = 0;
    this.store?.save(this.state);
    this.emit('update');
  }

  #recalcStats(agent, full = false) {
    const r = agent.realmIdx;
    agent.maxHp = Math.floor(60 + agent.body * 4 + r * 35);
    agent.maxSpirit = Math.floor(50 + agent.comprehension * 5 + r * 30);
    agent.maxStamina = 100 + r * 10;
    if (full) { agent.hp = agent.maxHp; agent.spirit = agent.maxSpirit; agent.stamina = agent.maxStamina; }
    agent.hp = clamp(agent.hp, 0, agent.maxHp);
    agent.spirit = clamp(agent.spirit, 0, agent.maxSpirit);
    agent.stamina = clamp(agent.stamina, 0, agent.maxStamina);
  }

  reincarnationBonus(agent) { return 1 + agent.reincarnations * 0.2; }

  // ---------- 神识感知系统 ----------
  senseRange(agent) {
    return SENSE_RANGES[clamp(agent.realmIdx, 0, SENSE_RANGES.length - 1)];
  }

  // 两点地图距离
  areaDistance(a1, a2) {
    const d1 = this.areaDef(a1.areaId);
    const d2 = this.areaDef(a2.areaId);
    if (!d1 || !d2) return Infinity;
    if (a1.areaId === a2.areaId) return 0;
    return Math.sqrt((d1.x - d2.x) ** 2 + (d1.y - d2.y) ** 2);
  }

  // 返回感知范围内的其他 Agent
  senseNearby(agentId) {
    const me = this.state.agents[agentId];
    if (!me || me.dead) return [];
    const range = this.senseRange(me);
    const result = [];
    for (const other of this.allAgents()) {
      if (other.id === agentId) continue;
      if (other.dead) continue;
      const dist = this.areaDistance(me, other);
      if (dist <= range) {
        result.push({
          id: other.id,
          name: other.name,
          realmName: this.realmName(other.realmIdx),
          realmIdx: other.realmIdx,
          pathName: this.pathDef(other)?.name || other.path,
          areaId: other.areaId,
          areaName: this.areaDef(other.areaId)?.name || '未知',
          distance: Math.round(dist),
          online: other.online,
          clientLabel: other.clientLabel,
          sameArea: dist === 0,
        });
      }
    }
    return result.sort((a, b) => a.distance - b.distance);
  }

  // ---------- Agent 对话系统 ----------
  converse(fromAgentId, toAgentId, text) {
    const from = this.state.agents[fromAgentId];
    const to = this.state.agents[toAgentId];
    if (!from) throw new Error('发送者不存在');
    if (!to) throw new Error('目标不存在');
    if (from.dead) throw new Error('已身殒，无法传音');
    if (to.dead) throw new Error('对方已身殒');
    // 必须在感知范围内
    const nearby = this.senseNearby(fromAgentId);
    const canReach = nearby.some(a => a.id === toAgentId);
    if (!canReach) throw new Error('对方不在神识范围内，无法传音');
    const msg = {
      id: randomUUID(),
      fromId: fromAgentId,
      fromName: from.name,
      fromRealm: this.realmName(from.realmIdx),
      text: String(text).slice(0, 200),
      t: Date.now(),
      read: false,
    };
    to.conversations.push(msg);
    if (to.conversations.length > 50) to.conversations.shift();
    this.addLog(`【${from.name}】向【${to.name}】传音。`, 'agent');
    this.emit('agent-chat', { from: from.name, to: to.name, text: msg.text, t: msg.t });
    this.markDirty();
    return msg;
  }

  getConversations(agentId) {
    const agent = this.state.agents[agentId];
    if (!agent) return [];
    return agent.conversations;
  }

  markConversationsRead(agentId) {
    const agent = this.state.agents[agentId];
    if (!agent) return;
    for (const m of agent.conversations) m.read = true;
    this.markDirty();
  }

  // ---------- 时间系统 ----------
  tick() {
    const nowTs = Date.now();
    const dt = nowTs - this._lastTick;
    this._lastTick = nowTs;
    const w = this.state.world;
    if (w.paused || !this.state.created) return;

    const eff = dt * w.speed;
    w.gameDay += (eff / this.def.time.tickMs) * this.def.time.dayPerTick;

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
      // 寿元检查
      const realm = this.def.realms[agent.realmIdx];
      if (agent.age > realm.maxLifespan) {
        agent.dead = true;
        agent.deathReason = `寿元耗尽，坐化于 ${this.areaDef(agent.areaId)?.name || '荒野'}，享年 ${agent.age} 岁。`;
        agent.combat = null; agent.dungeon = null; agent.currentAction = null;
        if (farm) farm.stage = 'fallow';
        this.addLog(agent.deathReason, 'event-bad');
        continue;
      }
      // 推进行动
      const act = agent.currentAction;
      if (act) {
        act.remainingMs -= eff;
        act.progress = clamp(1 - act.remainingMs / act.durationMs, 0, 1);
        if (act.remainingMs <= 0) {
          agent.currentAction = null;
          this.#completeAction(agent, act);
        }
      }
    }
    this.markDirty();
  }

  season() { return SEASONS[Math.floor((this.state.world.gameDay % this.def.time.daysPerYear) / 90)] || '春'; }
  dayOfYear() { return Math.floor(this.state.world.gameDay % this.def.time.daysPerYear) + 1; }
  shichen() {
    const frac = this.state.world.gameDay % 1;
    return SHICHEN[Math.floor(frac * 12) % 12] + '时';
  }

  // ---------- 行动系统 ----------
  availableActions(agentId) {
    const agent = this.state.agents[agentId];
    if (!agent) return [];
    const list = [];
    const st = this.agentStatus(agent);

    if (st === 'combat') {
      const skills = this.pathDef(agent).skills.map((s, i) => ({
        type: 'skill', label: s.name, icon: '技', skillIdx: i, enabled: agent.spirit >= s.spirit,
        cost: { spirit: s.spirit }, duration: 0, description: s.desc,
      }));
      return [
        { type: 'attack', label: '攻击', icon: '击', enabled: true, cost: {}, duration: 0, description: '普通攻击' },
        { type: 'defend', label: '防御', icon: '守', enabled: true, cost: {}, duration: 0, description: '减免伤害并回复少量生命' },
        ...skills,
        { type: 'flee', label: '逃跑', icon: '遁', enabled: true, cost: {}, duration: 0, description: '五成把握逃离战斗' },
      ];
    }
    if (st === 'dungeon') {
      const d = agent.dungeon;
      const acts = [];
      if (!d.floorCleared) acts.push({ type: 'explore', label: '探索', icon: '探', enabled: true, cost: { stamina: 2 }, duration: 0, description: '探索本层' });
      else if (d.floor < d.def.floors - 1) acts.push({ type: 'advance', label: '深入', icon: '前', enabled: true, cost: { stamina: 1 }, duration: 0, description: '前往下一层' });
      acts.push({ type: 'exit_dungeon', label: '退出', icon: '出', enabled: true, cost: {}, duration: 0, description: '离开副本' });
      return acts;
    }
    if (st !== 'idle') return list;

    const area = this.agentArea(agent);
    const t = area.type;
    const push = (type, extra = {}) => {
      const def = ACTION_DEFS[type];
      const enabled = this.#canAfford(agent, def.cost);
      list.push({ type, label: def.label, icon: def.icon, duration: def.duration / 1000, cost: def.cost, description: def.desc, enabled, ...extra });
    };

    const realm = this.def.realms[agent.realmIdx];
    const full = agent.cultivation >= realm.maxCultivation && agent.realmIdx < this.def.realms.length - 1;
    if (full) {
      const item = realm.breakItem;
      const has = !item || this.#countItem(agent, item) > 0;
      list.push({ type: 'breakthrough', label: `突破·${this.realmName(agent.realmIdx + 1)}`, icon: '破', duration: 0, cost: item ? { item } : {}, description: has ? '冲击下一境界' : `需要 ${item}`, enabled: true });
    } else {
      push('cultivate');
    }
    push('rest');

    if (t === 'forest') push('collect');
    if (t === 'mine') push('mine');
    if (t === 'river' || t === 'beach') push('fish');
    if (t === 'market') list.push({ type: 'shop', label: '坊市', icon: '购', duration: 0, cost: {}, description: '散修集市，买卖物品', enabled: true });
    if (t === 'sect' || t === 'mountain') {
      const cost = this.def.ask[t === 'sect' ? 'sect' : 'mountain'].cost;
      push('ask', { cost: { spiritStones: cost } });
    }
    if (t === 'event') push('fortune');
    if (t === 'dungeon_entrance') {
      const dg = this.def.dungeons.find(d => d.id === area.dungeonId);
      const ok = agent.realmIdx >= dg.minRealm;
      list.push({
        type: `enter_dungeon:${dg.id}`, label: `进入·${dg.name}`, icon: '阵', duration: 0,
        dungeonId: dg.id, description: `${dg.name}（${dg.floors}层，需${this.realmName(dg.minRealm)}）`,
        enabled: ok, cost: {},
      });
    }
    return list;
  }

  #canAfford(agent, cost) {
    if (!cost) return true;
    if (cost.spirit && agent.spirit < cost.spirit) return false;
    if (cost.stamina && agent.stamina < cost.stamina) return false;
    if (cost.spiritStones && agent.spiritStones < cost.spiritStones) return false;
    return true;
  }

  #payCost(agent, cost) {
    if (cost.spirit) agent.spirit = Math.max(0, agent.spirit - cost.spirit);
    if (cost.stamina) agent.stamina = Math.max(0, agent.stamina - cost.stamina);
    if (cost.spiritStones) agent.spiritStones = Math.max(0, agent.spiritStones - cost.spiritStones);
  }

  startAction(agentId, type, payload = {}) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    if (agent.dead) throw new Error('已身殒，需转世重修');
    if (isCombatActive(agent)) throw new Error('战斗中');
    if (agent.dungeon) throw new Error('副本中，请先探索或退出');
    if (agent.currentAction) throw new Error(`正在进行：${agent.currentAction.label}`);

    if (type === 'breakthrough') return this.#doBreakthrough(agent);
    if (type === 'use_pill') return this.useItem(agentId, payload.itemName);
    if (type === 'shop') return this.shopList(agentId);

    const def = ACTION_DEFS[type];
    if (!def) throw new Error(`未知行动: ${type}`);
    const area = this.agentArea(agent);
    const t = area.type;
    const sceneOk = {
      collect: t === 'forest', mine: t === 'mine', fish: t === 'river' || t === 'beach',
      ask: t === 'sect' || t === 'mountain', fortune: t === 'event', shop: t === 'market',
    }[type];
    if (sceneOk === false) throw new Error('此地不可进行该行动');
    if (type === 'cultivate' && agent.cultivation >= this.def.realms[agent.realmIdx].maxCultivation && agent.realmIdx < this.def.realms.length - 1)
      throw new Error('修为已满，需突破境界');

    const cost = type === 'ask' ? { spiritStones: this.def.ask[area.type === 'sect' ? 'sect' : 'mountain'].cost } : def.cost;
    if (!this.#canAfford(agent, cost)) {
      const name = cost.spirit ? '灵力' : cost.stamina ? '体力' : '灵石';
      throw new Error(`${name}不足`);
    }
    this.#payCost(agent, cost);
    const durationMs = def.duration * (1 - Math.min(agent.comprehension, 14) * 0.02);
    agent.currentAction = {
      type, label: def.label, startedAt: Date.now(), durationMs,
      remainingMs: durationMs, progress: 0, payload,
    };
    if (type === 'cultivate') this.addLog(`${agent.name} 盘膝入定，吐纳灵气……`, 'system');
    this.emit('update');
    this.markDirty();
    return { ok: true, action: agent.currentAction, message: `开始${def.label}` };
  }

  cancelAction(agentId) {
    const agent = this.state.agents[agentId];
    if (!agent?.currentAction) throw new Error('当前无进行中的行动');
    const label = agent.currentAction.label;
    agent.currentAction = null;
    this.addLog(`${agent.name} 中断了${label}。`, 'system');
    this.emit('update');
    this.markDirty();
    return { ok: true };
  }

  #completeAction(agent, act) {
    const gainCult = (base) => {
      const g = Math.round(base * (1 + agent.comprehension * 0.08) * (1 + agent.realmIdx * 0.35) * this.reincarnationBonus(agent));
      agent.cultivation = Math.min(agent.cultivation + g, this.def.realms[agent.realmIdx].maxCultivation);
      return g;
    };
    switch (act.type) {
      case 'cultivate': {
        const g = gainCult(4 + agent.comprehension * 0.5);
        this.addLog(`${agent.name} 修炼完毕，修为 +${g}。`, 'event-good');
        break;
      }
      case 'rest':
        agent.stamina = Math.min(agent.maxStamina, agent.stamina + 55);
        agent.spirit = Math.min(agent.maxSpirit, agent.spirit + Math.ceil(agent.maxSpirit * 0.35));
        agent.hp = Math.min(agent.maxHp, agent.hp + Math.ceil(agent.maxHp * 0.2));
        this.addLog(`${agent.name} 稍作歇息，体力灵力尽复几分。`, 'event-good');
        break;
      case 'collect': this.#gather(agent, 'collect', '灵兽森林'); break;
      case 'mine': this.#gather(agent, 'mine', '玄铁矿脉'); break;
      case 'fish': this.#gather(agent, 'fish', this.agentArea(agent).type === 'river' ? '碧水江' : '海滩'); break;
      case 'ask': {
        const cfg = this.def.ask[this.agentArea(agent).type === 'sect' ? 'sect' : 'mountain'];
        const g = gainCult(cfg.cultivationBase + agent.comprehension);
        this.addLog(`${agent.name} ${cfg.text}，修为 +${g}。`, 'event-good');
        if (Math.random() < cfg.comprehensionChance + agent.luck * 0.004) {
          agent.comprehension += 1; this.addLog(`${agent.name} 灵光乍现，悟性 +1！`, 'breakthrough');
        }
        break;
      }
      case 'fortune': this.#fortune(agent, this.agentArea(agent).id); break;
      case 'move': {
        const target = act.payload.to;
        agent.areaId = target;
        this.addLog(`${agent.name} 抵达 ${this.areaDef(target).name}。${this.areaDef(target).desc}`, 'system');
        break;
      }
    }
    this.#recalcStats(agent);
    this.emit('update');
    this.markDirty();
  }

  #gather(agent, kind, where) {
    const roll = weightedPick(this.def.gather[kind]);
    if (roll.item === 'spiritStones') {
      const n = randInt(roll.min, roll.max) + (Math.random() < agent.luck * 0.02 ? 3 : 0);
      agent.spiritStones += n;
      this.addLog(`${agent.name} 在${where}收获灵石 +${n}。`, 'event-good');
    } else {
      let n = 1;
      if (Math.random() < agent.luck * 0.03) n += 1;
      this.#addItem(agent, roll.item, n);
      this.addLog(`${agent.name} 在${where}采得【${roll.item}】×${n}。`, 'event-good');
    }
  }

  #fortune(agent, areaId) {
    const table = this.def.fortuneEvents[areaId];
    if (!table) { this.addLog(`${agent.name} 此地并无机缘。`, 'system'); return; }
    const luckBoost = 1 + agent.luck * 0.03;
    const adjusted = table.map(e => ({ ...e, weight: ['hp', 'none'].includes(e.type) ? e.weight / luckBoost : e.weight * luckBoost }));
    const ev = weightedPick(adjusted);
    switch (ev.type) {
      case 'cultivation': {
        const g = Math.round(randInt(ev.min, ev.max) * (1 + agent.realmIdx * 0.3));
        agent.cultivation = Math.min(agent.cultivation + g, this.def.realms[agent.realmIdx].maxCultivation);
        this.addLog(`${agent.name} ${ev.text}（修为 +${g}）`, 'event-good'); break;
      }
      case 'spiritStones': { const n = randInt(ev.min, ev.max); agent.spiritStones += n; this.addLog(`${agent.name} ${ev.text}（灵石 +${n}）`, 'event-good'); break; }
      case 'hp': { const d = randInt(-ev.min, -ev.max); agent.hp = Math.max(1, agent.hp + d); this.addLog(`${agent.name} ${ev.text}（生命 ${d}）`, 'event-bad'); break; }
      case 'comprehension': agent.comprehension += 1; this.addLog(`${agent.name} ${ev.text}`, 'breakthrough'); break;
      case 'body': agent.body += 1; this.#recalcStats(agent); this.addLog(`${agent.name} ${ev.text}`, 'breakthrough'); break;
      case 'item': this.#addItem(agent, ev.item, 1); this.addLog(`${agent.name} ${ev.text}`, 'event-good'); break;
      default: this.addLog(`${agent.name} ${ev.text}`, 'system');
    }
  }

  #doBreakthrough(agent) {
    if (agent.realmIdx >= this.def.realms.length - 1) throw new Error('已至大乘，只待飞升');
    const realm = this.def.realms[agent.realmIdx];
    if (agent.cultivation < realm.maxCultivation) throw new Error('修为未至圆满');
    const next = this.def.realms[agent.realmIdx + 1];
    const item = realm.breakItem;
    if (item && this.#countItem(agent, item) < 1) throw new Error(`突破需要【${item}】`);
    if (item) this.#removeItem(agent, item, 1);
    agent.realmIdx += 1;
    agent.cultivation = 0;
    this.#recalcStats(agent, true);
    this.addLog(`天降异象，灵气如潮！${agent.name} 成功突破至【${next.name}】之境！寿元上限提升至 ${next.maxLifespan} 岁。`, 'breakthrough');
    this.emit('update');
    this.markDirty();
    return { ok: true, message: `突破成功：${next.name}`, realm: next.name };
  }

  // ---------- 移动 ----------
  availableAreas(agentId) {
    const agent = this.state.agents[agentId];
    if (!agent || agent.dead || isCombatActive(agent) || agent.dungeon) return [];
    const results = [];
    const visited = new Map([[agent.areaId, 0]]);
    const queue = [agent.areaId];
    while (queue.length) {
      const cur = queue.shift();
      const dist = visited.get(cur);
      if (dist >= 3) continue;
      for (const nb of (this.areaDef(cur)?.adjacent || [])) {
        if (visited.has(nb)) continue;
        const def = this.areaDef(nb);
        const unlocked = agent.realmIdx >= def.minRealm;
        visited.set(nb, dist + 1);
        if (unlocked) queue.push(nb);
        results.push({
          id: nb, name: def.name, continent: def.continent, type: def.type, x: def.x, y: def.y,
          distance: dist + 1, unlocked, needRealm: def.realmLabel || this.realmName(def.minRealm),
          dungeonId: def.dungeonId || null, desc: def.desc,
        });
      }
    }
    return results.sort((x, y) => x.distance - y.distance || x.name.localeCompare(y.name));
  }

  moveTo(agentId, areaId) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    if (agent.dead) throw new Error('已身殒');
    if (isCombatActive(agent)) throw new Error('战斗中无法移动');
    if (agent.dungeon) throw new Error('副本中无法移动');
    if (agent.currentAction) throw new Error(`正在进行：${agent.currentAction.label}`);
    const areas = this.availableAreas(agentId).filter(x => x.unlocked);
    const target = areas.find(x => x.id === areaId);
    if (!target) throw new Error('无法抵达该地点（未解锁或不相邻）');
    const durationMs = target.distance * 4000;
    agent.currentAction = {
      type: 'move', label: `前往${target.name}`, startedAt: Date.now(),
      durationMs, remainingMs: durationMs, progress: 0, payload: { to: areaId },
    };
    this.addLog(`${agent.name} 动身前往 ${target.name}，约需 ${(durationMs / 1000).toFixed(0)} 秒。`, 'system');
    this.emit('update');
    this.markDirty();
    return { ok: true, duration: durationMs / 1000, from: agent.areaId, to: areaId };
  }

  // ---------- 灵田种地 ----------
  farmCrops() { return CROPS; }
  farmConfig() { return FARM; }
  farmLevels() { return FARM_LEVELS; }
  #requireFarmAgent(agentId, token, requireAuth = false) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    // 写操作令牌鉴权（强制要求）
    if (requireAuth) {
      if (!token) throw new Error('缺少身份令牌');
      const parts = String(token).split('.');
      if (parts.length !== 3) throw new Error('令牌格式无效');
      if (parts[0] !== agentId) throw new Error('令牌与修士身份不匹配');
      // 校验签名
      const v = validateToken(token, agentId);
      if (!v.ok) throw new Error(v.error);
    }
    const farm = this.state.farms[agentId];
    if (!farm) this.state.farms[agentId] = newFarm();
    const f = this.state.farms[agentId];
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
  farmStatus(agentId) {
    const { agent, farm } = this.#requireFarmAgent(agentId);
    return { ok: true, farm: publicFarmState(this, agent, farm) };
  }
  farmList() {
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
  }
  farmClear(agentId, token) {
    const { agent, farm } = this.#requireFarmAgent(agentId, token, true);
    clearFarm(this, agent, farm);
    auditLog(this, agentId, agent.name, 'farm_clear', '灵田', '成功', -10);
    this.emit('update'); this.markDirty();
    return { ok: true, farm: publicFarmState(this, agent, farm) };
  }
  farmPlant(agentId, cropName, token) {
    const { agent, farm } = this.#requireFarmAgent(agentId, token, true);
    // 肥力校验
    const fertChk = checkFertility(farm.fertility);
    if (!fertChk.ok) throw new Error(fertChk.error);
    const r = plantCrop(this, agent, farm, cropName);
    consumeFertility(farm, cropName);
    auditLog(this, agentId, agent.name, 'farm_plant', cropName, '成功', -CROPS[cropName]?.cost || 0);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  }
  farmWater(agentId, token) {
    const { agent, farm } = this.#requireFarmAgent(agentId, token, true);
    waterFarm(this, agent, farm);
    checkQuestEvents(this, agent, farm, 'water', 1);
    if (farm.rental?.active && farm.rental.borrowerId === agentId) {
      const ownerFarm = this.state.farms[farm.rental.ownerId];
      const owner = this.state.agents[farm.rental.ownerId];
      if (ownerFarm && owner) {
        cooperativeWaterOwner(this, ownerFarm);
        this.addLog(`${owner.name} 亦因协作浇灌记入任务进度。`, 'system');
      }
    }
    auditLog(this, agentId, agent.name, 'farm_water', '灵田', '成功', 0);
    this.emit('update'); this.markDirty();
    return { ok: true, farm: publicFarmState(this, agent, farm) };
  }
  farmHarvest(agentId, token) {
    const { agent, farm } = this.#requireFarmAgent(agentId, token, true);
    const r = harvestFarm(this, agent, farm, this.state.market);
    checkAchievements(this, agent, farm, this.state.codex);
    checkQuestEvents(this, agent, farm, 'harvest', r.count);
    recordLeaderboard(this, this.state.leaderboard, agentId, r.count, r.revenue);
    auditLog(this, agentId, agent.name, 'farm_harvest', r.item, `收获×${r.count}`, 0);
    this.emit('update'); this.markDirty();
    this.emit('harvest', { agentId: agentId, item: r.item, count: r.count, revenue: r.revenue });
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  }
  farmLedger(agentId, page = 1, perPage = 50) {
    const { agent, farm } = this.#requireFarmAgent(agentId);
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
  }
  farmMarket() {
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
  }
  farmCodex() {
    return { ok: true, ...publicCodex(this.state.codex) };
  }
  // ── 任务系统 ──
  farmQuests(agentId) {
    const { agent, farm } = this.#requireFarmAgent(agentId);
    return { ok: true, quests: listQuests(this, agent, farm), questCodexPoints: farm.questCodexPoints };
  }
  farmQuestAccept(agentId, questId, token) {
    const { agent, farm } = this.#requireFarmAgent(agentId, token, true);
    const r = acceptQuest(this, agent, farm, questId);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  }
  farmQuestClaim(agentId, questId, token) {
    const { agent, farm } = this.#requireFarmAgent(agentId, token, true);
    const r = claimQuest(this, agent, farm, questId);
    checkQuestEvents(this, agent, farm, 'harvest', 0);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  }
  // ── 排行榜 ──
  farmLeaderboard(weekOffset = 0) {
    return { ok: true, ...getLeaderboard(this, this.state.leaderboard, weekOffset) };
  }
  // ── 租借 ──
  farmRent(agentId, borrowerId, days, sharePct, token) {
    const { agent, farm } = this.#requireFarmAgent(agentId, token, true);
    const borrower = this.state.agents[borrowerId];
    if (!borrower) throw new Error('对方修士不存在');
    if (agentId === borrowerId) throw new Error('不能租给自己');
    const r = createRental(this, agent, farm, borrowerId, borrower.name, days, sharePct);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  }
  farmRentAccept(agentId, token) {
    const { agent, farm: borrowerFarm } = this.#requireFarmAgent(agentId, token, true);
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
  }
  farmRentRecall(agentId, token) {
    const { agent, farm } = this.#requireFarmAgent(agentId, token, true);
    if (farm.rental?.ownerId !== agentId) throw new Error('只有田主可收回灵田');
    const r = recallRental(this, agent, farm);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  }
  // ── 道具 ──
  farmUseItem(agentId, itemName, token) {
    const { agent, farm } = this.#requireFarmAgent(agentId, token, true);
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
  }
  // ── 日报 ──
  farmDailyReport(agentId) {
    const { agent, farm } = this.#requireFarmAgent(agentId);
    const report = generateDailyReport(this, agent, farm);
    if (!report) {
      // 返回最近一次
      const lastDay = Math.floor(this.state.world.gameDay);
      return { ok: true, report: { day: lastDay, note: '今日尚无收获事件', income: 0, harvestCount: 0, crops: [], events: [], suggestions: ['播种并收获作物以生成日报'] } };
    }
    return { ok: true, report };
  }
  farmUpgrade(agentId, token) {
    const { agent, farm } = this.#requireFarmAgent(agentId, token, true);
    const r = upgradeFarm(this, agent, farm);
    auditLog(this, agentId, agent.name, 'farm_upgrade', '灵田等级', '成功', -(FARM_LEVELS[farm.level - 1]?.upgrade?.stones || 0));
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  }
  // ── 第四轮新方法 ──
  // 身份令牌验证（供 API 层调用）
  verifyToken(agentId, token) {
    const agent = this.state.agents[agentId];
    if (!agent) return { ok: false, error: 'Agent 不存在' };
    if (!token) return { ok: false, error: '缺少身份令牌' };
    const parts = String(token).split('.');
    if (parts.length !== 3) return { ok: false, error: '令牌格式无效' };
    if (parts[0] !== agentId) return { ok: false, error: '令牌与修士身份不匹配' };
    // 令牌必须与存档中的令牌一致（支持重新签发后旧令牌失效）
    if (agent.token !== token) {
      const v = validateToken(token, agentId);
      if (!v.ok) return { ok: false, error: v.error };
    }
    return { ok: true, agent };
  }
  // 获取令牌
  getToken(agentId) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    if (!agent.token) agent.token = generateToken(agentId);
    return { token: agent.token };
  }
  // 审计日志查询
  auditQuery(agentId, { page = 1, perPage = 50 } = {}) {
    if (agentId && !this.state.agents[agentId]) throw new Error('Agent 不存在');
    return { ok: true, ...queryAuditLog(this.state.audit, { agentId, page, perPage }) };
  }
  // 田块升级
  fieldUpgrade(agentId, toLevel, token) {
    const { agent, farm } = this.#requireFarmAgent(agentId, token, true);
    if (farm.upgrading) throw new Error('田块正在升级中，请等待完成');
    startFieldUpgrade(this, agent, farm, toLevel);
    this.emit('update'); this.markDirty();
    return { ok: true, upgrading: farm.upgrading, farm: publicFarmState(this, agent, farm) };
  }
  // 使用灵肥
  useFertilizer(agentId, token) {
    const { agent, farm } = this.#requireFarmAgent(agentId, token, true);
    const item = agent.inventory.find(i => i.name === '灵肥');
    if (!item || item.count < 1) throw new Error('背包无【灵肥】，需在集市购买');
    const r = useFertilizer(agent, farm, 1);
    auditLog(this, agentId, agent.name, 'consume_item', '灵肥', '成功', 0);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  }
  // 世界事件日历
  worldEventCalendar() {
    return { ok: true, ...getEventCalendar(this, this.state.worldEvents) };
  }
  // 当前世界事件
  currentWorldEvent() {
    return { ok: true, event: getWorldEvent(this, this.state.worldEvents, this.state.world.gameDay) };
  }
  // 存档导出
  saveExport() {
    const data = JSON.parse(JSON.stringify(this.state));
    const checksum = saveChecksum(data);
    return { ok: true, save: data, checksum, schemaVersion: SCHEMA_VERSION };
  }
  // 存档导入
  saveImport(data, checksum) {
    if (checksum && !verifySave(data, checksum)) {
      throw new Error('存档校验和不匹配，数据可能被篡改');
    }
    // 验证 data 是对象
    if (!data || typeof data !== 'object' || !data.created) {
      throw new Error('存档数据无效');
    }
    const result = migrateState(data);
    this.state = Object.assign(this.#initialState(), result.saved);
    // 确保所有 agent 有令牌
    for (const a of Object.values(this.state.agents)) {
      if (!a.token) a.token = generateToken(a.id);
    }
    this._colorIdx = Object.keys(this.state.agents).length % AGENT_COLORS.length;
    this.store?.save(this.state);
    this.emit('update'); this.markDirty();
    return { ok: true, migrated: result.migrations.length > 0, migrations: result.migrations, schemaVersion: result.version };
  }
  // 灵脉地块列表
  leyLineFarms() {
    return Object.entries(this.state.farms)
      .filter(([, f]) => f.isLeyLine)
      .map(([id, f]) => ({
        agentId: id,
        agentName: this.state.agents[id]?.name || '未知',
        leyLineId: f.leyLineId,
        fertility: f.fertility,
        stage: f.stage,
      }));
  }
  farmPatrol(agentId, token) {
    const { agent, farm } = this.#requireFarmAgent(agentId, token, true);
    const r = patrolFarm(this, agent, farm);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  }
  farmHandle(agentId, eventId, token) {
    const { agent, farm } = this.#requireFarmAgent(agentId, token, true);
    const r = handleFarm(this, agent, farm, eventId);
    this.emit('update'); this.markDirty();
    return { ok: true, ...r, farm: publicFarmState(this, agent, farm) };
  }

  // ---------- 物品 / 商店 ----------
  #countItem(agent, name) { return agent.inventory.find(i => i.name === name)?.count || 0; }
  #addItem(agent, name, count) {
    const e = agent.inventory.find(i => i.name === name);
    if (e) e.count += count; else agent.inventory.push({ name, count });
  }
  #removeItem(agent, name, count) {
    const e = agent.inventory.find(i => i.name === name);
    if (!e || e.count < count) return false;
    e.count -= count;
    if (e.count <= 0) agent.inventory.splice(agent.inventory.indexOf(e), 1);
    return true;
  }

  useItem(agentId, itemName) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    const item = this.def.items[itemName];
    if (!item || this.#countItem(agent, itemName) < 1) throw new Error('没有该物品');
    if (item.type !== 'pill') throw new Error('该物品无法直接使用');
    if (!this.#removeItem(agent, itemName, 1)) throw new Error('物品不足');
    let msg = '';
    if (item.hp) { const h = Math.min(item.hp, agent.maxHp - agent.hp); agent.hp += h; msg += `生命 +${h} `; }
    if (item.spirit) { const s = Math.min(item.spirit, agent.maxSpirit - agent.spirit); agent.spirit += s; msg += `灵力 +${s}`; }
    this.addLog(`${agent.name} 服下【${itemName}】，${msg}。`, 'event-good');
    this.emit('update');
    this.markDirty();
    return { ok: true, message: `服用 ${itemName}` };
  }

  shopList(agentId) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    if (this.agentArea(agent)?.type !== 'market') throw new Error('需在散修集市');
    return {
      items: this.def.shop.map(name => ({ name, ...this.def.items[name] })),
      sellable: agent.inventory
        .filter(i => (this.def.items[i.name]?.sell || 0) > 0)
        .map(i => ({ name: i.name, count: i.count, sell: this.def.items[i.name].sell, desc: this.def.items[i.name].desc })),
    };
  }

  buy(agentId, itemName, count = 1) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    if (this.agentArea(agent)?.type !== 'market') throw new Error('需在散修集市');
    const item = this.def.items[itemName];
    if (!item || !this.def.shop.includes(itemName) || !item.price) throw new Error('坊市无此货物');
    count = clamp(Math.floor(count), 1, 99);
    const cost = item.price * count;
    if (agent.spiritStones < cost) throw new Error('灵石不足');
    agent.spiritStones -= cost;
    this.#addItem(agent, itemName, count);
    this.addLog(`${agent.name} 购入【${itemName}】×${count}，灵石 -${cost}。`, 'event-good');
    this.emit('update'); this.markDirty();
    return { ok: true, message: `购入 ${itemName}×${count}` };
  }

  sell(agentId, itemName, count = 1) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    if (this.agentArea(agent)?.type !== 'market') throw new Error('需在散修集市');
    const item = this.def.items[itemName];
    if (!item?.sell) throw new Error('此物无人收购');
    count = clamp(Math.floor(count), 1, this.#countItem(agent, itemName));
    if (!this.#removeItem(agent, itemName, count)) throw new Error('物品不足');
    // 灵植使用市场动态价格
    const mkt = this.state.market?.items[itemName];
    const price = mkt ? mkt.currentPrice : item.sell;
    const gain = Math.round(price * count);
    agent.spiritStones += gain;
    if (mkt) marketSell(this, this.state.market, itemName, count);
    // 更新图鉴统计
    const cd = this.state.codex.codex[itemName];
    if (cd) {
      cd.totalSold += count;
      cd.totalRevenue += gain;
    }
    this.addLog(`${agent.name} 售出【${itemName}】×${count}，灵石 +${gain}（市价 ${price}/枚）。`, 'event-good');
    this.emit('update'); this.markDirty();
    return { ok: true, message: `售出 ${itemName}×${count}`, price, gain };
  }

  // ---------- 战斗 / 副本代理 ----------
  combat(agentId, action, skillIdx) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    const res = combatAct(this, agent, action, skillIdx);
    if (res?.result?.dungeonContinue && agent.dungeon) {
      res.dungeonResult = afterDungeonVictory(this, agent);
    }
    return res;
  }
  enterDungeonById(agentId, dungeonId) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    return enterDungeon(this, agent, dungeonId);
  }
  dungeon(agentId, action) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    return dungeonAct(this, agent, action);
  }
  startWildCombat(agentId, enemy, source) {
    const agent = this.state.agents[agentId];
    if (!agent) throw new Error('Agent 不存在');
    return startCombat(this, agent, enemy, source);
  }

  // ---------- 对外状态（上帝视角：全部 Agent） ----------
  publicState() {
    const s = this.state;
    // 即使没有 agent，也返回世界时间信息，方便上帝视角展示
    if (!s.created || Object.keys(s.agents).length === 0) return {
      created: false, status: 'uncreated', agents: [],
      world: {
        gameDay: Math.floor(s.world.gameDay),
        gameYear: Math.floor(s.world.gameDay / this.def.time.daysPerYear) + 1,
        dayOfYear: this.dayOfYear(), season: this.season(), weather: s.world.weather, weatherCN: WEATHERS[s.world.weather]?.cn || '晴', shichen: this.shichen(),
        speed: s.world.speed, paused: s.world.paused,
        worldEvent: getWorldEvent(this, s.worldEvents, s.world.gameDay),
      },
      market: this.farmMarket(),
      worldEvents: getEventCalendar(this, s.worldEvents),
      auditCount: s.audit?.entries?.length || 0,
      recentLogs: s.logs.slice(-40),
    };

    const agents = this.allAgents().map(a => {
      const realm = this.def.realms[a.realmIdx];
      const area = this.areaDef(a.areaId);
      return {
        id: a.id,
        name: a.name,
        color: a.color,
        online: a.online,
        clientLabel: a.clientLabel,
        path: a.path,
        pathName: this.def.paths[a.path]?.name || a.path,
        realmIdx: a.realmIdx,
        realmName: realm.name,
        nextRealmName: this.realmName(a.realmIdx + 1),
        cultivation: Math.floor(a.cultivation),
        cultivationMax: realm.maxCultivation,
        hp: Math.floor(a.hp), maxHp: a.maxHp,
        spirit: Math.floor(a.spirit), maxSpirit: a.maxSpirit,
        stamina: Math.floor(a.stamina), maxStamina: a.maxStamina,
        spiritStones: a.spiritStones,
        inventory: a.inventory,
        age: a.age, lifespan: realm.maxLifespan,
        dead: a.dead, deathReason: a.deathReason,
        areaId: a.areaId,
        areaName: area?.name || '未知',
        areaType: area?.type || '',
        areaX: area?.x || 0,
        areaY: area?.y || 0,
        status: this.agentStatus(a),
        kills: a.kills,
        dungeonsCleared: a.dungeonsCleared,
        senseRange: this.senseRange(a),
        unreadMessages: (a.conversations || []).filter(m => !m.read).length,
        currentAction: a.currentAction ? {
          type: a.currentAction.type, label: a.currentAction.label,
          progress: a.currentAction.progress,
          remainingMs: Math.max(0, a.currentAction.remainingMs),
        } : null,
        inCombat: isCombatActive(a),
        inDungeon: !!a.dungeon,
        farm: publicFarmState(this, a, this.state.farms[a.id]),
      };
    });

    // 区域人口统计
    const areaPop = {};
    for (const a of agents) {
      if (a.dead) continue;
      areaPop[a.areaId] = (areaPop[a.areaId] || 0) + 1;
    }

    return {
      created: true,
      agents,
      areaPop,
      world: {
        gameDay: Math.floor(s.world.gameDay),
        gameYear: Math.floor(s.world.gameDay / this.def.time.daysPerYear) + 1,
        dayOfYear: this.dayOfYear(), season: this.season(), weather: s.world.weather, weatherCN: WEATHERS[s.world.weather]?.cn || '晴', shichen: this.shichen(),
        speed: s.world.speed, paused: s.world.paused,
      },
      market: this.farmMarket(),
      recentLogs: s.logs.slice(-40),
    };
  }

  // 单个 Agent 的完整状态（给 MCP 工具用）
  agentPublicState(agentId) {
    const agent = this.state.agents[agentId];
    if (!agent) return null;
    const realm = this.def.realms[agent.realmIdx];
    const area = this.areaDef(agent.areaId);
    const act = agent.currentAction;
    const statusCN = { idle: '闲适', busy: '行事中', moving: '赶路', combat: '战斗中', dungeon: '秘境中', dead: '已身殒', uncreated: '未创建' };
    return {
      created: true,
      status: this.agentStatus(agent),
      statusCN: statusCN[this.agentStatus(agent)] || this.agentStatus(agent),
      currentAction: act ? { type: act.type, label: act.label, progress: act.progress, remainingMs: Math.max(0, act.remainingMs), durationMs: act.durationMs, to: act.payload?.to || null } : null,
      inCombat: isCombatActive(agent), inDungeon: !!agent.dungeon,
      agent: {
        id: agent.id,
        name: agent.name, path: agent.path, pathName: this.def.paths[agent.path]?.name || agent.path,
        realmIdx: agent.realmIdx, realmName: realm.name, nextRealmName: this.realmName(agent.realmIdx + 1),
        cultivation: Math.floor(agent.cultivation), cultivationMax: realm.maxCultivation,
        hp: Math.floor(agent.hp), maxHp: agent.maxHp,
        spirit: Math.floor(agent.spirit), maxSpirit: agent.maxSpirit,
        stamina: Math.floor(agent.stamina), maxStamina: agent.maxStamina,
        body: agent.body, luck: agent.luck, comprehension: agent.comprehension,
        age: agent.age, lifespan: realm.maxLifespan,
        areaId: agent.areaId, areaName: area?.name || '未知', areaType: area?.type || '', areaDesc: area?.desc || '',
        inventory: agent.inventory, spiritStones: agent.spiritStones,
        kills: agent.kills, dungeonsCleared: agent.dungeonsCleared,
        reincarnations: agent.reincarnations,
        senseRange: this.senseRange(agent),
        unreadMessages: (agent.conversations || []).filter(m => !m.read).length,
      },
      world: {
        gameDay: Math.floor(this.state.world.gameDay),
        gameYear: Math.floor(this.state.world.gameDay / this.def.time.daysPerYear) + 1,
        dayOfYear: this.dayOfYear(), season: this.season(), weather: this.state.world.weather, weatherCN: WEATHERS[this.state.world.weather]?.cn || '晴', shichen: this.shichen(),
        speed: this.state.world.speed, paused: this.state.world.paused,
        dead: agent.dead, deathReason: agent.deathReason,
      },
      combat: agent.combat,
      dungeon: agent.dungeon ? {
        id: agent.dungeon.def.id, name: agent.dungeon.def.name, floor: agent.dungeon.floor, floors: agent.dungeon.def.floors,
        floorCleared: agent.dungeon.floorCleared, cleared: agent.dungeon.cleared,
        scene: agent.dungeon.currentScene, lastEvent: agent.dungeon.lastEvent || null,
      } : null,
      availableAreas: this.availableAreas(agentId),
      nearbyAgents: this.senseNearby(agentId),
      conversations: (agent.conversations || []).slice(-10),
      farm: publicFarmState(this, agent, this.state.farms[agentId]),
    };
  }
}

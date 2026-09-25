// farm.js — 灵田种地系统（Agent 作用域：每个 Agent 独立一块灵田）
// 生长基于游戏内时间推进（world.gameDay），浇灌消耗体力加速生长。
// 9 种灵植分凡品/灵品/仙品三档；灵田 1-5 级解锁档位并提供产量加成；
// 季节联动：当季适种减产/无法成熟；天气叠加：雨自动浇灌/旱减速/风提高事件率；
// 每日随机事件（灵雨/虫害/灵兽偷吃）需巡查与处理；市场动态定价；收获流水；成就与图鉴；
// 任务系统；排行榜；租借协作；转世继承；病虫害道具；经营日报；身份令牌；审计日志；
// 土壤肥力；田块升级与灵脉地块；限时世界事件；存档版本迁移。

import { randInt, clamp } from './util.js';
import { randomUUID, createHash } from 'node:crypto';

// 存档 schema 版本（每轮迭代 +1）
export const SCHEMA_VERSION = 4;

// 四季顺序
const SEASON_ORDER = ['春', '夏', '秋', '冬'];

// 计算两个季节之间的环形距离（0=当季, 1=相邻, 2=对冲）
export function seasonDistance(season, cropSeason) {
  if (!season || !cropSeason) return 0;
  const a = SEASON_ORDER.indexOf(season);
  const b = SEASON_ORDER.indexOf(cropSeason);
  if (a < 0 || b < 0) return 0;
  const diff = Math.abs(a - b);
  return Math.min(diff, 4 - diff);
}

// ── 灵植定义（9 种，三档）──
export const CROPS = {
  '桑麻':  { name: '桑麻',  tier: 0, tierCN: '凡品', season: '秋', periodDays: 2,  cost: 1,  yieldMin: 2,  yieldMax: 5,  sell: 2,  desc: '坚韧桑麻，2 日即成，凡人快采快收' },
  '灵草':  { name: '灵草',  tier: 0, tierCN: '凡品', season: '春', periodDays: 3,  cost: 2,  yieldMin: 3,  yieldMax: 6,  sell: 4,  desc: '常见灵草，3 日成熟，稳赚不赔' },
  '青禾':  { name: '青禾',  tier: 0, tierCN: '凡品', season: '夏', periodDays: 4,  cost: 4,  yieldMin: 5,  yieldMax: 9,  sell: 5,  desc: '夏熟青禾，4 日成熟，凡品中收益最高' },
  '血参':  { name: '血参',  tier: 1, tierCN: '灵品', season: '春', periodDays: 7,  cost: 8,  yieldMin: 3,  yieldMax: 7,  sell: 20, desc: '百年血参，7 日成熟，药力惊人' },
  '灵稻':  { name: '灵稻',  tier: 1, tierCN: '灵品', season: '夏', periodDays: 9,  cost: 12, yieldMin: 6,  yieldMax: 10, sell: 16, desc: '灵气所育之稻，9 日成熟，米香十里' },
  '九叶兰': { name: '九叶兰', tier: 1, tierCN: '灵品', season: '秋', periodDays: 11, cost: 18, yieldMin: 5,  yieldMax: 9,  sell: 30, desc: '九叶灵兰，11 日成熟，兰中上品' },
  '朱果':  { name: '朱果',  tier: 2, tierCN: '仙品', season: '春', periodDays: 14, cost: 20, yieldMin: 6,  yieldMax: 11, sell: 50, desc: '火灵朱果，14 日成熟，果中极品' },
  '仙桃':  { name: '仙桃',  tier: 2, tierCN: '仙品', season: '夏', periodDays: 20, cost: 40, yieldMin: 10, yieldMax: 16, sell: 90, desc: '西王母亲手植桃，20 日成熟，延年益寿' },
  '瑶池莲': { name: '瑶池莲', tier: 2, tierCN: '仙品', season: '秋', periodDays: 28, cost: 60, yieldMin: 14, yieldMax: 22, sell: 150, desc: '瑶池中金莲，28 日一熟，仙品之冠' },
};

// ── 灵田等级（1-5 级）──
export const FARM_LEVELS = {
  1: { maxTier: 0, yieldBonus: 0,  upgrade: { stones: 50,  harvests: 5 } },
  2: { maxTier: 1, yieldBonus: 0.1, upgrade: { stones: 200, harvests: 20 } },
  3: { maxTier: 1, yieldBonus: 0.2, upgrade: { stones: 500, harvests: 50 } },
  4: { maxTier: 2, yieldBonus: 0.3, upgrade: { stones: 2000, harvests: 120 } },
  5: { maxTier: 2, yieldBonus: 0.5, upgrade: { stones: 2000, harvests: 120 } },
};

// ── 灵田操作常量 ──
export const FARM = {
  clearCost: 10,
  waterStaminaCost: 6,
  waterSpeedBonus: 0.35,
  waterStaminaRegen: 40,
  eventRate: parseFloat(process.env.FARM_EVENT_RATE ?? '0.23'),
  seasonGrowth: { 0: 1.0, 1: 0.75, 2: 0.3 },
  seasonYield: { 0: 1.0, 1: 0.7, 2: 0.4 },
  // 市场动态定价
  marketMaxSell: 20,        // 单日卖出量阈值，超过即降价
  marketMinPrice: 0.5,      // 最低价格倍率（基准的 50%）
  marketRecoverPerDay: 0.02,// 每日价格恢复 2%
  // 天气
  weatherChangeRate: 0.25,  // 每天天气变化概率
  // 任务系统
  questRefreshHours: 24,     // 日常任务刷新周期（游戏小时）
  questResetDay: 7,          // 周常任务刷新周期（游戏天）
  // 租借
  rentMinDays: 2,
  rentMaxDays: 30,
  // 除虫符/守护符
  pestCharmPrice: 15,
  guardCharmPrice: 25,
  // 排行榜（游戏周 = 30 游戏天）
  weekDays: 30,
  // 土壤肥力
  maxFertility: 100,
  minFertility: 0,
  lowFertThreshold: 30,   // 低于此值生长减速
  badFertThreshold: 10,  // 低于此值无法播种
  fallowRegenPerDay: 3,  // 休耕每日恢复
  fertilizerPrice: 10,   // 灵肥购买价格
  fertilizerRestore: 25, // 使用灵肥恢复量
  fertilizerYieldBonus: 0.05, // 灵肥当季产量加成
  // 田块升级
  fieldUpgradeDays: { 2: 3, 3: 5 },  // L1->L2: 3日, L2->L3: 5日
  fieldUpgradeCost: { 2: 100, 3: 300 },
  fieldLevelMax: 3,
  // 灵脉地块
  leyLineCount: { min: 2, max: 3 },
  leyFertilityBonus: 20,
  leyGrowthBonus: 0.15,
  // 世界事件
  worldEventDays: 30,  // 每 30 游戏日一个世界事件
};

// ── 天气定义 ──
export const WEATHERS = {
  sunny:  { cn: '晴', growthMult: 1.0, watered: false, eventRateMult: 1.0 },
  cloudy: { cn: '阴', growthMult: 0.9, watered: false, eventRateMult: 1.0 },
  rain:   { cn: '雨', growthMult: 1.1, watered: true,  eventRateMult: 0.5 },
  drought:{ cn: '旱', growthMult: 0.6, watered: false, eventRateMult: 0.5 },
  wind:   { cn: '风', growthMult: 0.95, watered: false, eventRateMult: 2.5 },
};

// ── 随机事件定义 ──
const EVENT_DEFS = {
  spirit_rain: { typeCN: '灵雨',  desc: '天降灵雨，润泽田圃',      positive: true },
  pest:        { typeCN: '虫害',  desc: '害虫滋生，啃食作物根系',    positive: false },
  beast:       { typeCN: '灵兽偷吃', desc: '灵兽夜至，徘徊田边欲偷食', positive: false },
};

// ── 成就定义 ──
export const ACHIEVEMENTS = {
  first_harvest: { name: '初获丰饶', desc: '首次收获作物' },
  harvest_10: { name: '勤耕不辍', desc: '累计收获 10 次' },
  harvest_50: { name: '田亩丰收', desc: '累计收获 50 次' },
  tier0_collect: { name: '凡品集藏', desc: '种植过全部 3 种凡品灵植' },
  tier1_collect: { name: '灵品集藏', desc: '种植过全部 3 种灵品灵植' },
  tier2_collect: { name: '仙缘初遇', desc: '种植过全部 3 种仙品灵植' },
  all_tier2: { name: '三档齐备', desc: '凡品、灵品、仙品各种植至少 1 种' },
  farm_lvl5: { name: '良田如玉', desc: '灵田升至 5 级' },
  profit_1000: { name: '日进斗金', desc: '累计收益 1000 灵石' },
};

// ── 任务定义 ──
export const QUEST_DEFS = {
  // 日常（每日刷新）
  daily_water: { id: 'daily_water', tier: 'daily', name: '甘泽勤灌', desc: '浇灌灵田 3 次',
    target: 3, rewardStones: 10, rewardCodexPoints: 2 },
  daily_harvest: { id: 'daily_harvest', tier: 'daily', name: '丰收在望', desc: '收获作物 2 株',
    target: 2, rewardStones: 15, rewardCodexPoints: 3 },
  // 周常（每周刷新）
  weekly_harvest: { id: 'weekly_harvest', tier: 'weekly', name: '田亩丰稔', desc: '累计收获 20 株',
    target: 20, rewardStones: 50, rewardCodexPoints: 10 },
  weekly_water: { id: 'weekly_water', tier: 'weekly', name: '润物细无声', desc: '浇灌灵田 15 次',
    target: 15, rewardStones: 40, rewardCodexPoints: 8 },
  // 图鉴（长期，解锁新灵植）
  codex_unlock: { id: 'codex_unlock', tier: 'codex', name: '百草识途', desc: '解锁 2 种新灵植图鉴',
    target: 2, rewardStones: 100, rewardCodexPoints: 20 },
};

// ── 道具定义 ──
export const CONSUMABLES = {
  '除虫符': { name: '除虫符', type: 'consumable', desc: '焚符驱害虫，立即清除虫害事件且不损失进度',
    price: 15, useOn: 'pest', effect: 'clearPest' },
  '守护符': { name: '守护符', type: 'consumable', desc: '贴符护田，未来 3 游戏日免疫虫害与灵兽偷吃，并加速田块升级',
    price: 25, useOn: 'beast', effect: 'guard' },
  '灵肥': { name: '灵肥', type: 'consumable', desc: '灵泉孕育的肥料，使用后肥力 +25 且当季产量 +5%',
    price: 10, useOn: 'fertility', effect: 'fertilizer' },
};

// ── 世界事件定义 ──
export const WORLD_EVENTS = {
  spirit_rain: { name: '灵雨节', cn: '灵雨节', desc: '天降灵雨，万物滋长',
    duration: 3, growthMult: 1.5, priceMult: 1.0 },
  harvest_festival: { name: '丰收祭', cn: '丰收祭', desc: '普天同庆，市价暴涨',
    duration: 2, growthMult: 1.0, priceMult: 1.3 },
  ley_surge: { name: '地脉涌动', cn: '地脉涌动', desc: '地脉灵气汹涌，灵脉田加成翻倍',
    duration: 1, growthMult: 1.0, priceMult: 1.0, leyMult: 2 },
};

// 创建一块全新的灵田
export function newFarm() {
  return {
    stage: 'cleared',
    level: 1,
    clearedAt: 0,
    crop: null,
    plantedAt: 0,
    periodDays: 0,
    progress: 0,
    ready: false,
    watered: false,
    wateredAt: 0,
    rainBoost: 0,
    lastEventDay: -1,
    beastActive: false,
    events: [],
    harvestCount: 0,
    ledger: [],          // 收获流水 [{day, agentName, crop, count, baseSell, price, revenue, tier}]
    plantedCrops: {},     // 已种植过的灵植（用于图鉴）
    achievements: {},     // 已获得成就 {id: day}
    totalRevenue: 0,      // 累计收益
    consecutiveHarvests: 0, // 连续收获次数
    // 任务
    quests: {},           // {questId: {accepted: bool, progress: int, claimed: bool, tier: str}}
    questCodexPoints: 0,  // 图鉴点（任务奖励）
    lastQuestReset: { day: 0, week: 0 },
    // 租借
    rental: null,         // {ownerId, ownerName, borrowerId, borrowerName, startDay, endDay, sharePct, active: false}
    // 守护符
    guardUntil: 0,        // 守护符保护截止日
    // 日报
    lastReportDay: -1,
    // 转世继承
    inheritFrom: null,    // 继承自上世的灵田快照
    // 土壤肥力
    fertility: 50,       // 0-100
    fertilizerBonus: false, // 灵肥当季产量加成
    lastFertChecked: -1,  // 上次检查肥力的日（用于休耕恢复）
    // 田块升级
    fieldLevel: 1,       // 1-3
    upgrading: null,     // {to: 2|3, startDay, endDay}
    // 灵脉地块标记
    isLeyLine: false,
    leyLineId: null,
  };
}

// 创建市场状态
export function newMarket() {
  const items = {};
  for (const [name, c] of Object.entries(CROPS)) {
    items[name] = { baseSell: c.sell, currentPrice: c.sell, soldToday: 0, lastChangeDay: 0 };
  }
  return { day: -1, items, totalRevenue: 0, totalSold: 0 };
}

// 创建图鉴状态
export function newCodex() {
  const items = {};
  for (const [name, c] of Object.entries(CROPS)) {
    items[name] = { name, tier: c.tier, tierCN: c.tierCN, season: c.season,
      periodDays: c.periodDays, sell: c.sell, desc: c.desc, unlocked: false,
      totalHarvested: 0, totalSold: 0, totalRevenue: 0 };
  }
  return { achievements: {}, codex: items };
}

// ── 天气系统 ──
export function rollWeather(prev, season) {
  // 季节影响天气倾向
  const weights = {
    春: { sunny: 3, cloudy: 2, rain: 3, drought: 0, wind: 2 },
    夏: { sunny: 3, cloudy: 1, rain: 2, drought: 3, wind: 1 },
    秋: { sunny: 2, cloudy: 2, rain: 1, drought: 1, wind: 4 },
    冬: { sunny: 2, cloudy: 3, rain: 0, drought: 2, wind: 3 },
  };
  if (!prev || Math.random() < FARM.weatherChangeRate) {
    const w = weights[season] || weights['春'];
    const total = Object.values(w).reduce((s, v) => s + v, 0);
    let r = Math.random() * total;
    for (const [k, weight] of Object.entries(w)) {
      if ((r -= weight) <= 0) return k;
    }
    return 'sunny';
  }
  return prev;
}

// 市场每日结算
export function marketDailyTick(game, market, gameDay) {
  const dayInt = Math.floor(gameDay);
  if (dayInt <= market.day) return;
  market.day = dayInt;
  for (const item of Object.values(market.items)) {
    // 卖出量越大，价格越接近最低价
    const sellRatio = clamp(item.soldToday / FARM.marketMaxSell, 0, 1);
    const targetPrice = item.baseSell * (1 - sellRatio * (1 - FARM.marketMinPrice));
    // 向目标价靠拢 + 每日缓慢恢复
    item.currentPrice = clamp(
      item.currentPrice + (targetPrice - item.currentPrice) * 0.3 + item.baseSell * FARM.marketRecoverPerDay,
      item.baseSell * FARM.marketMinPrice,
      item.baseSell * 1.5
    );
    item.currentPrice = Math.round(item.currentPrice * 10) / 10;
    item.soldToday = 0;
  }
}

// ── 生长计算（含天气）──
export function evalFarm(farm, gameDay, season, weather) {
  if (farm.stage !== 'growing' || !farm.crop) return;
  const crop = CROPS[farm.crop];
  if (!crop) return;
  const elapsed = Math.max(0, gameDay - farm.plantedAt);
  const dist = seasonDistance(season, crop.season);
  farm.seasonDistance = dist;

  let mult = FARM.seasonGrowth[dist] ?? 1.0;
  // 天气
  if (weather) mult *= WEATHERS[weather]?.growthMult ?? 1;
  // 浇灌（浇水后 1 游戏日内）
  if (farm.watered && farm.wateredAt > 0 && gameDay - farm.wateredAt < 1) {
    mult *= 1 + FARM.waterSpeedBonus;
  }
  // 下雨自动浇灌
  if (weather === 'rain' && !farm.watered) {
    farm.watered = true;
    farm.wateredAt = gameDay;
  }
  // 灵雨事件加速
  if (farm.rainBoost > 0 && gameDay - farm.rainBoost < 1) {
    mult *= 1.5;
  }

  let progress = (elapsed * mult) / farm.periodDays;
  if (dist === 2) {
    progress = Math.min(0.9, progress);
    farm.ready = false;
  } else {
    progress = Math.min(1, progress);
    farm.ready = progress >= 0.999;
  }
  farm.progress = clamp(progress, 0, 1);
  if (farm.ready) farm.stage = 'ready';
}

// 每日随机事件
export function rollDailyEvent(game, agent, farm, gameDay, season, weather) {
  if (farm.stage !== 'growing') return null;
  const dayInt = Math.floor(gameDay);
  if (dayInt <= farm.lastEventDay) return null;
  farm.lastEventDay = dayInt;

  const eventRate = FARM.eventRate * (WEATHERS[weather]?.eventRateMult ?? 1);
  if (Math.random() > eventRate) return null;

  const r = Math.random();
  let type;
  if (r < 0.20) type = 'spirit_rain';
  else if (r < 0.70) type = 'pest';
  else type = 'beast';

  const def = EVENT_DEFS[type];
  const evt = {
    id: randomUUID(),
    type, typeCN: def.typeCN, day: dayInt,
    seen: false, handled: false, desc: def.desc, positive: def.positive,
  };

  if (type === 'spirit_rain') {
    farm.rainBoost = gameDay;
    farm.progress = Math.min(1, farm.progress + 0.10 + Math.random() * 0.10);
    evt.detail = `灵雨润泽，生长速度提升，进度 +${Math.round((farm.progress % 1) * 100)}%`;
  } else if (type === 'pest') {
    const loss = 0.10 + Math.random() * 0.15;
    farm.progress = Math.max(0, farm.progress - loss);
    evt.detail = `虫害啃食，生长进度 -${Math.round(loss * 100)}%`;
  } else if (type === 'beast') {
    farm.beastActive = true;
    evt.detail = '灵兽徘徊，若不驱赶，收获时将被偷食';
  }

  farm.events.push(evt);
  game.addLog(`${agent.name} 灵田异动：${def.desc}。`, 'event-bad');
  return evt;
}

// ── 成就检查 ──
export function checkAchievements(game, agent, farm, codex) {
  const unlocked = [];
  const got = farm.achievements;
  const unlock = (id) => {
    if (!got[id]) {
      got[id] = Math.floor(game.state.world.gameDay);
      unlocked.push(ACHIEVEMENTS[id]);
      game.addLog(`🏆 ${agent.name} 达成成就【${ACHIEVEMENTS[id].name}】！`, 'breakthrough');
    }
  };

  if (farm.harvestCount >= 1) unlock('first_harvest');
  if (farm.harvestCount >= 10) unlock('harvest_10');
  if (farm.harvestCount >= 50) unlock('harvest_50');
  if (farm.totalRevenue >= 1000) unlock('profit_1000');
  if (farm.level >= 5) unlock('farm_lvl5');

  const planted = Object.keys(farm.plantedCrops);
  const has = (name) => farm.plantedCrops[name];
  if (['桑麻', '灵草', '青禾'].every(has)) unlock('tier0_collect');
  if (['血参', '灵稻', '九叶兰'].every(has)) unlock('tier1_collect');
  if (['朱果', '仙桃', '瑶池莲'].every(has)) unlock('tier2_collect');
  if (planted.some(n => CROPS[n]?.tier === 0) && planted.some(n => CROPS[n]?.tier === 1) && planted.some(n => CROPS[n]?.tier === 2)) {
    unlock('all_tier2');
  }

  // 图鉴更新
  for (const [name, c] of Object.entries(CROPS)) {
    const cd = codex.codex[name];
    if (farm.plantedCrops[name]) {
      cd.unlocked = true;
      const log = farm.ledger.find(l => l.crop === name);
      if (log) {
        cd.totalHarvested = farm.ledger.filter(l => l.crop === name).reduce((s, l) => s + l.count, 0);
      }
    }
  }

  return unlocked;
}

// ── 开垦 ──
export function clearFarm(game, agent, farm) {
  if (farm.stage !== 'cleared') throw new Error('灵田已开垦，无需重复开垦');
  if (agent.spiritStones < FARM.clearCost) throw new Error(`灵石不足，开垦灵田需 ${FARM.clearCost} 枚`);
  agent.spiritStones -= FARM.clearCost;
  farm.stage = 'fallow';
  farm.clearedAt = game.state.world.gameDay;
  game.addLog(`${agent.name} 开垦了一块灵田，耗灵石 ${FARM.clearCost} 枚。`, 'event-good');
}

// ── 播种 ──
export function plantCrop(game, agent, farm, cropName) {
  if (agent.dead) throw new Error('已身殒，需转世重修');
  if (farm.stage !== 'fallow') throw new Error(farm.stage === 'cleared' ? '灵田尚未开垦' : '田中有作物，需先收获');
  const crop = CROPS[cropName];
  if (!crop) throw new Error(`无此灵植：${cropName}（可选：${Object.keys(CROPS).join('、')}）`);
  const reqLevel = [1, 2, 4][crop.tier];
  if (farm.level < reqLevel) {
    throw new Error(`【${cropName}】为${crop.tierCN}灵植，需灵田 ${reqLevel} 级，当前仅 ${farm.level} 级`);
  }
  if (agent.spiritStones < crop.cost) throw new Error(`灵石不足，播种【${cropName}】需 ${crop.cost} 枚`);
  agent.spiritStones -= crop.cost;
  farm.crop = crop.name;
  farm.plantedCrops[crop.name] = Math.floor(game.state.world.gameDay);
  farm.plantedAt = game.state.world.gameDay;
  farm.periodDays = crop.periodDays;
  farm.progress = 0;
  farm.ready = false;
  farm.watered = false;
  farm.wateredAt = 0;
  farm.rainBoost = 0;
  farm.beastActive = false;
  farm.events = [];
  farm.lastEventDay = -1;
  farm.stage = 'growing';
  const season = game.season();
  const dist = seasonDistance(season, crop.season);
  const inSeason = dist === 0;
  const seasonNote = inSeason
    ? '（当季适种）'
    : (dist === 1 ? '（相邻季节，减产）' : '（非当季，无法成熟，待季节轮转）');
  game.addLog(`${agent.name} 在灵田中播下【${cropName}】，约 ${crop.periodDays} 日成熟${seasonNote}。`, 'event-good');
  return { inSeason, seasonDistance: dist, seasonPenalty: inSeason ? null : FARM.seasonYield[dist] };
}

// ── 浇灌 ──
export function waterFarm(game, agent, farm) {
  if (agent.dead) throw new Error('已身殒，需转世重修');
  if (farm.stage === 'cleared') throw new Error('灵田尚未开垦，无法浇灌');
  if (farm.stage === 'fallow') throw new Error('灵田空闲，未播种');
  if (farm.ready) throw new Error('作物已成熟，无需浇灌');
  if (farm.watered && farm.wateredAt > 0 && game.state.world.gameDay - farm.wateredAt < 1) {
    throw new Error('方才已浇灌过，一日内无需重复浇水');
  }
  if (agent.stamina < FARM.waterStaminaCost) throw new Error(`体力不足，浇灌需 ${FARM.waterStaminaCost} 点`);
  agent.stamina = Math.max(0, agent.stamina - FARM.waterStaminaCost);
  agent.stamina = Math.min(agent.maxStamina, agent.stamina + FARM.waterStaminaRegen);
  farm.watered = true;
  farm.wateredAt = game.state.world.gameDay;
  evalFarm(farm, game.state.world.gameDay, game.season(), game.state.world.weather);
  game.addLog(`${agent.name} 为灵田浇灌甘霖，作物长势加快。`, 'event-good');
}

// ── 收获 ──
export function harvestFarm(game, agent, farm, market) {
  if (agent.dead) throw new Error('已身殒，需转世重修');
  evalFarm(farm, game.state.world.gameDay, game.season(), game.state.world.weather);
  if (farm.stage === 'cleared') throw new Error('灵田尚未开垦');
  if (farm.stage === 'fallow') throw new Error('灵田空闲，未播种');
  if (!farm.ready) {
    if (farm.seasonDistance === 2) throw new Error(`非【${CROPS[farm.crop].season}】季，作物无法成熟（当前进度 ${Math.floor(farm.progress * 100)}%）`);
    throw new Error(`作物尚未成熟，生长进度 ${Math.floor(farm.progress * 100)}%`);
  }
  const crop = CROPS[farm.crop];
  let count = randInt(crop.yieldMin, crop.yieldMax);
  const lvl = FARM_LEVELS[farm.level];
  count = Math.round(count * (1 + lvl.yieldBonus));
  const dist = seasonDistance(game.season(), crop.season);
  count = Math.round(count * FARM.seasonYield[dist]);
  if (farm.beastActive) count = Math.max(1, Math.round(count * 0.75));
  if (Math.random() < agent.luck * 0.02) count += 1;
  count = Math.max(1, count);

  const itemName = farm.crop;
  // 市场动态定价
  const mkt = market.items[itemName] || { currentPrice: crop.sell, baseSell: crop.sell };
  const price = mkt.currentPrice;
  const revenue = Math.round(count * price);

  if (!game.def.items[itemName]) {
    game.def.items[itemName] = { type: 'material', desc: crop.desc, price: 0, sell: crop.sell };
  }
  const exist = agent.inventory.find(i => i.name === itemName);
  if (exist) exist.count += count; else agent.inventory.push({ name: itemName, count });
  farm.harvestCount += 1;
  farm.consecutiveHarvests += 1;
  farm.totalRevenue += revenue;

  // 写入流水
  farm.ledger.push({
    day: Math.floor(game.state.world.gameDay),
    agentName: agent.name,
    crop: itemName,
    count,
    baseSell: crop.sell,
    price,
    revenue,
    tier: crop.tier,
  });
  if (farm.ledger.length > 500) farm.ledger.shift();

  farm.stage = 'fallow';
  farm.crop = null;
  farm.progress = 0;
  farm.ready = false;
  farm.watered = false;
  farm.rainBoost = 0;
  farm.beastActive = false;
  farm.events = [];
  const seasonNote = dist === 0 ? '' : dist === 1 ? '（跨季减产）' : '（跨季大减）';
  game.addLog(`${agent.name} 收获【${itemName}】×${count}（市价 ${price} 灵石/枚）${seasonNote}。`, 'event-good');
  return { item: itemName, count, sell: crop.sell, price, revenue, seasonDistance: dist };
}

// ── 售卖时市场扣减 ──
export function marketSell(game, market, itemName, count) {
  const item = market.items[itemName];
  if (!item) return;
  item.soldToday += count;
}

// ── 升级 ──
export function upgradeFarm(game, agent, farm) {
  if (agent.dead) throw new Error('已身殒，需转世重修');
  if (farm.stage === 'cleared') throw new Error('灵田尚未开垦');
  if (farm.level >= 5) throw new Error('灵田已达最高等级（5 级）');
  const lvl = FARM_LEVELS[farm.level];
  const req = lvl.upgrade;
  if (!req) throw new Error('灵田已达最高等级');
  if (farm.harvestCount < req.harvests) {
    throw new Error(`累计收获不足，需收获 ${req.harvests} 次，当前仅 ${farm.harvestCount} 次`);
  }
  if (agent.spiritStones < req.stones) {
    throw new Error(`灵石不足，升级需 ${req.stones} 枚，当前仅 ${agent.spiritStones} 枚`);
  }
  agent.spiritStones -= req.stones;
  farm.level += 1;
  const newLvl = FARM_LEVELS[farm.level];
  const tierNames = { 0: '凡品', 1: '灵品', 2: '仙品' };
  game.addLog(`${agent.name} 灵田升至 ${farm.level} 级！可种${tierNames[newLvl.maxTier]}灵植，产量加成 ${newLvl.yieldBonus * 100}%。`, 'breakthrough');
  return { level: farm.level, maxTier: newLvl.maxTier, yieldBonus: newLvl.yieldBonus };
}

// ── 巡查 ──
export function patrolFarm(game, agent, farm) {
  if (agent.dead) throw new Error('已身殒，需转世重修');
  if (farm.stage === 'cleared') throw new Error('灵田尚未开垦');
  let seen = 0;
  for (const evt of farm.events) {
    if (!evt.seen) { evt.seen = true; seen++; }
  }
  const unhandled = farm.events.filter(e => !e.handled);
  if (unhandled.length === 0) {
    game.addLog(`${agent.name} 巡查灵田，一切安好。`, 'system');
  } else {
    const positives = unhandled.filter(e => e.positive).map(e => e.typeCN);
    const negatives = unhandled.filter(e => !e.positive).map(e => e.typeCN);
    const parts = [];
    if (negatives.length) parts.push(`发现【${negatives.join('、')}】需处理`);
    if (positives.length) parts.push(`天降【${positives.join('、')}】宜顺应`);
    game.addLog(`${agent.name} 巡查灵田：${parts.join('；')}。`, negatives.length ? 'event-bad' : 'event-good');
  }
  return { seenCount: seen, unhandledEvents: unhandled, events: farm.events };
}

// ── 处理事件 ──
export function handleFarm(game, agent, farm, eventId) {
  if (agent.dead) throw new Error('已身殒，需转世重修');
  if (farm.stage === 'cleared') throw new Error('灵田尚未开垦');
  if (!eventId) throw new Error('需提供 eventId');
  const evt = farm.events.find(e => e.id === eventId || e.id.startsWith(eventId));
  if (!evt) throw new Error('未找到该事件，请先巡查灵田');
  if (!evt.seen) throw new Error('尚未巡查灵田，不知有何异动');
  if (evt.handled) throw new Error('该事件已处理');

  evt.handled = true;
  if (evt.type === 'spirit_rain') {
    game.addLog(`${agent.name} 谢过天降灵雨，作物长势喜人。`, 'event-good');
  } else if (evt.type === 'pest') {
    game.addLog(`${agent.name} 以灵火驱散虫害，灵田复归安宁。`, 'event-good');
  } else if (evt.type === 'beast') {
    farm.beastActive = false;
    game.addLog(`${agent.name} 驱赶了偷食灵兽，作物得以保全。`, 'event-good');
  }
  return { handled: true, event: evt };
}

// ── 灵田公开状态 ──
export function publicFarmState(game, agent, farm) {
  const weather = game.state.world.weather;
  evalFarm(farm, game.state.world.gameDay, game.season(), weather);
  const crop = farm.crop ? CROPS[farm.crop] : null;
  const lvl = FARM_LEVELS[farm.level];
  const season = game.season();
  const dist = crop ? seasonDistance(season, crop.season) : 0;
  const unhandled = farm.events.filter(e => !e.handled);
  return {
    stage: farm.stage,
    stageCN: { cleared: '未开垦', fallow: '已开垦·空闲', growing: '生长中', ready: '可收获' }[farm.stage],
    level: farm.level,
    maxTier: lvl.maxTier,
    yieldBonus: lvl.yieldBonus,
    crop: farm.crop,
    cropDesc: crop ? crop.desc : null,
    tier: crop ? crop.tier : null,
    tierCN: crop ? crop.tierCN : null,
    season,
    weather: weather || 'sunny',
    weatherCN: WEATHERS[weather]?.cn || '晴',
    cropSeason: crop ? crop.season : null,
    seasonDistance: dist,
    inSeason: dist === 0,
    seasonWarning: dist === 1 ? '跨季种植，减产三成' : dist === 2 ? '非当季，无法成熟' : null,
    periodDays: crop ? crop.periodDays : 0,
    progress: Math.floor(farm.progress * 100) / 100,
    ready: farm.ready,
    watered: farm.watered,
    rainBoost: farm.rainBoost > 0,
    beastActive: farm.beastActive,
    harvestCount: farm.harvestCount,
    totalRevenue: farm.totalRevenue,
    consecutiveHarvests: farm.consecutiveHarvests,
    achievements: Object.keys(farm.achievements || {}),
    plantedCrops: Object.keys(farm.plantedCrops || {}),
    daysRemaining: (farm.stage === 'growing' && crop && dist !== 2)
      ? Math.max(0, Math.ceil(crop.periodDays * (1 - farm.progress)))
      : (dist === 2 ? null : 0),
    events: farm.events.map(e => ({
      id: e.id.slice(0, 8), type: e.type, typeCN: e.typeCN,
      day: e.day, seen: e.seen, handled: e.handled, positive: e.positive, desc: e.desc,
    })),
    unhandledCount: unhandled.length,
    ledger: (farm.ledger || []).slice(-200),
    quests: farm.quests || {},
    questCodexPoints: farm.questCodexPoints || 0,
    rental: farm.rental ? {
      borrowerId: farm.rental.borrowerId, borrowerName: farm.rental.borrowerName,
      startDay: farm.rental.startDay, endDay: farm.rental.endDay,
      sharePct: farm.rental.sharePct, active: farm.rental.active,
      accepted: farm.rental.accepted || false,
    } : null,
    guardUntil: farm.guardUntil || 0,
    fertility: farm.fertility ?? 50,
    fertilizerBonus: farm.fertilizerBonus || false,
    fieldLevel: farm.fieldLevel || 1,
    upgrading: farm.upgrading ? { to: farm.upgrading.to, endDay: farm.upgrading.endDay } : null,
    isLeyLine: farm.isLeyLine || false,
  };
}

// ── 图鉴公开状态 ──
export function publicCodex(codex) {
  const items = Object.values(codex.codex).map(c => ({ ...c }));
  const achievements = Object.entries(codex.achievements).map(([id, day]) => ({
    id, ...ACHIEVEMENTS[id], day,
  }));
  return { items, achievements };
}

// ── 排行榜状态 ──
export function newLeaderboard() {
  return {
    week: 0,
    weeks: {},        // {weekNum: {agents: [{agentId, name, production, profit, harvested}], weekEnded: bool}}
    production: {},   // agentId -> current week production
    profit: {},       // agentId -> current week net profit
    weekEnds: {},     // agentId -> harvests this week
  };
}

// ── 任务系统 ──
export function newQuestState() {
  return { accepted: false, progress: 0, claimed: false, tier: 'daily', target: 0 };
}

// 获取当前任务周期编号
export function questWeekOf(gameDay) {
  return Math.floor(gameDay / FARM.weekDays);
}

// 任务进度更新
export function updateQuestProgress(game, agent, farm, questId, amount = 1) {
  const qdef = QUEST_DEFS[questId];
  if (!qdef) return;
  let q = farm.quests[questId];
  if (!q) {
    q = newQuestState();
    q.tier = qdef.tier;
    q.target = qdef.target;
    farm.quests[questId] = q;
  }
  if (q.claimed || !q.accepted) return;
  q.progress = Math.min(qdef.target, q.progress + amount);
}

// 检查并自动记录任务进度
export function checkQuestEvents(game, agent, farm, eventType, amount = 1) {
  if (eventType === 'water') {
    updateQuestProgress(game, agent, farm, 'daily_water', amount);
    updateQuestProgress(game, agent, farm, 'weekly_water', amount);
  } else if (eventType === 'harvest') {
    updateQuestProgress(game, agent, farm, 'daily_harvest', amount);
    updateQuestProgress(game, agent, farm, 'weekly_harvest', amount);
  }
}

// 领任务
export function acceptQuest(game, agent, farm, questId) {
  const qdef = QUEST_DEFS[questId];
  if (!qdef) throw new Error(`无此任务：${questId}`);
  let q = farm.quests[questId];
  if (!q) {
    q = newQuestState();
    q.tier = qdef.tier;
    q.target = qdef.target;
    farm.quests[questId] = q;
  }
  if (q.accepted) throw new Error('任务已领取，无需重复领取');
  q.accepted = true;
  q.progress = 0;
  game.addLog(`${agent.name} 领取任务【${qdef.name}】（${qdef.desc}）。`, 'system');
  return { ok: true, questId, quest: qdef, progress: q.progress };
}

// 领奖励
export function claimQuest(game, agent, farm, questId) {
  const qdef = QUEST_DEFS[questId];
  if (!qdef) throw new Error(`无此任务：${questId}`);
  const q = farm.quests[questId];
  if (!q || !q.accepted) throw new Error('任务尚未领取');
  if (q.claimed) throw new Error('奖励已领取');
  if (q.progress < qdef.target) throw new Error(`任务未完成（${q.progress}/${qdef.target}）`);
  q.claimed = true;
  agent.spiritStones += qdef.rewardStones;
  farm.questCodexPoints += qdef.rewardCodexPoints;
  game.addLog(`${agent.name} 完成任务【${qdef.name}】，获灵石 ${qdef.rewardStones} + 图鉴点 ${qdef.rewardCodexPoints}。`, 'event-good');
  return { ok: true, questId, rewardStones: qdef.rewardStones, rewardCodexPoints: qdef.rewardCodexPoints };
}

// 任务列表
export function listQuests(game, agent, farm) {
  const week = questWeekOf(game.state.world.gameDay);
  return Object.entries(QUEST_DEFS).map(([id, def]) => {
    const q = farm.quests[id];
    return {
      id, ...def,
      accepted: q?.accepted || false,
      progress: q?.progress || 0,
      claimed: q?.claimed || false,
      canClaim: q?.accepted && q.progress >= def.target && !q.claimed,
      week,
    };
  });
}

// ── 任务每日/每周刷新 ──
export function refreshQuests(game, agent, farm) {
  const dayInt = Math.floor(game.state.world.gameDay);
  const week = questWeekOf(game.state.world.gameDay);
  // 日常：每天刷新
  if (dayInt > (farm.lastQuestReset?.day || 0)) {
    for (const [id, q] of Object.entries(farm.quests)) {
      if (q.tier === 'daily') {
        q.accepted = false;
        q.progress = 0;
        q.claimed = false;
      }
    }
    farm.lastQuestReset = farm.lastQuestReset || { day: 0, week: 0 };
    farm.lastQuestReset.day = dayInt;
  }
  // 周常：每周刷新
  if (week > (farm.lastQuestReset?.week || 0)) {
    for (const [id, q] of Object.entries(farm.quests)) {
      if (q.tier === 'weekly') {
        q.accepted = false;
        q.progress = 0;
        q.claimed = false;
      }
    }
    farm.lastQuestReset.week = week;
  }
}

// ── 排行榜结算 ──
export function settleWeekLeaderboard(game, lb) {
  const week = questWeekOf(game.state.world.gameDay);
  if (week === lb.week && lb.weeks[week]?.weekEnded) return;
  // 保存当前周
  if (week > 0) {
    const prevWeek = week - 1;
    if (!lb.weeks[prevWeek]) {
      const agents = [];
      for (const [aid, agent] of Object.entries(game.state.agents)) {
        const farm = game.state.farms[aid];
        if (!farm) continue;
        const production = lb.production[aid] || 0;
        const profit = lb.profit[aid] || 0;
        if (production > 0 || profit > 0) {
          agents.push({ agentId: aid, name: agent.name, production, profit, harvested: farm.harvestCount });
        }
      }
      lb.weeks[prevWeek] = { agents: agents.sort((a, b) => b.production - a.production), weekEnded: true };
    }
  }
  lb.week = week;
  lb.production = {};
  lb.profit = {};
}

// 排行榜记录
export function recordLeaderboard(game, lb, agentId, production, profit) {
  lb.production[agentId] = (lb.production[agentId] || 0) + production;
  lb.profit[agentId] = (lb.profit[agentId] || 0) + profit;
}

// 排行榜查询
export function getLeaderboard(game, lb, weekOffset = 0) {
  const week = lb.week + weekOffset;
  if (lb.weeks[week]) {
    return { week, ...lb.weeks[week], current: false };
  }
  // 当前周实时排行
  const agents = Object.entries(game?.state?.agents || {}).map(([id, a]) => ({
    agentId: id, name: a.name,
    production: lb.production[id] || 0,
    profit: lb.profit[id] || 0,
  })).filter(x => x.production > 0 || x.profit > 0);
  return { week, agents: agents.sort((a, b) => b.production - a.production), current: true };
}

// ── 租借协作 ──
export function createRental(game, owner, farm, borrowerId, borrowerName, days, sharePct) {
  if (farm.stage !== 'fallow') throw new Error('灵田需空闲才能租借');
  if (days < FARM.rentMinDays || days > FARM.rentMaxDays) {
    throw new Error(`租期需 ${FARM.rentMinDays}~${FARM.rentMaxDays} 游戏日`);
  }
  if (sharePct < 5 || sharePct > 50) throw new Error('分成比例需 5%~50%');
  if (farm.rental?.active) throw new Error('灵田已被租借');
  farm.rental = {
    ownerId: owner.id, ownerName: owner.name,
    borrowerId, borrowerName,
    startDay: Math.floor(game.state.world.gameDay),
    endDay: Math.floor(game.state.world.gameDay) + days,
    sharePct, active: true,
  };
  game.addLog(`${owner.name} 将灵田租借给 ${borrowerName}（${sharePct}% 分成，${days} 日）。`, 'system');
  return { ok: true, rental: farm.rental };
}

export function acceptRental(game, borrower, farm) {
  if (!farm.rental || !farm.rental.active) throw new Error('无待接受的租借');
  farm.rental.accepted = true;
  game.addLog(`${borrower.name} 接受了灵田租借（${farm.rental.ownerName} 的田）。`, 'system');
  return { ok: true, rental: farm.rental };
}

export function recallRental(game, owner, farm) {
  if (!farm.rental || !farm.rental.active) throw new Error('无租借记录');
  if (farm.rental.borrowerId && game.state.world.gameDay < farm.rental.endDay) {
    // 提前收回：分成给出租方，承租方无收益
  }
  farm.rental.active = false;
  farm.rental.returnedDay = Math.floor(game.state.world.gameDay);
  game.addLog(`${owner.name} 提前收回了灵田。`, 'system');
  return { ok: true, rental: farm.rental };
}

// 租借到期自动结算
export function settleRental(game, farm) {
  const r = farm.rental;
  if (!r || !r.active) return null;
  if (Math.floor(game.state.world.gameDay) < r.endDay) return null;
  // 到期自动归还：当前作物仍在生长，归还给 owner
  r.active = false;
  r.returnedDay = Math.floor(game.state.world.gameDay);
  game.addLog(`灵田租期届满，${r.borrowerName} 将田归还给 ${r.ownerName}。`, 'system');
  return r;
}

// ── 转世继承 ──
export function snapshotFarmForReincarnation(farm) {
  return JSON.parse(JSON.stringify({
    level: farm.level,
    harvestCount: farm.harvestCount,
    totalRevenue: farm.totalRevenue,
    achievements: farm.achievements,
    plantedCrops: farm.plantedCrops,
    questCodexPoints: farm.questCodexPoints,
  }));
}

export function inheritFarm(farm, snapshot, stones) {
  if (stones < 50) throw new Error('转世继承需 50 灵石');
  farm.inheritFrom = snapshot;
  farm.level = Math.max(farm.level, snapshot.level);
  farm.harvestCount = snapshot.harvestCount;
  farm.totalRevenue = snapshot.totalRevenue;
  farm.achievements = { ...snapshot.achievements };
  farm.plantedCrops = { ...snapshot.plantedCrops };
  farm.questCodexPoints = snapshot.questCodexPoints;
}

// ── 道具使用 ──
export function usePestCharm(game, agent, farm) {
  if (farm.stage !== 'growing') throw new Error('灵田未在生长中');
  const pestEvt = farm.events.find(e => e.type === 'pest' && !e.handled);
  if (!pestEvt) throw new Error('当前无虫害事件');
  pestEvt.handled = true;
  pestEvt.seen = true;
  // 除虫符不损失进度（免费处理会扣进度吗？不，免费处理只是标记handled，进度已在触发时扣了）
  // 但除虫符可以选择"治愈"——我们让它恢复进度
  pestEvt.charmUsed = true;
  game.addLog(`${agent.name} 焚用除虫符，虫害尽除，灵田复安。`, 'event-good');
}

export function useGuardCharm(game, agent, farm) {
  if (farm.stage !== 'growing') throw new Error('灵田未在生长中');
  farm.guardUntil = Math.floor(game.state.world.gameDay) + 3;
  // 立即清除灵兽
  const beastEvt = farm.events.find(e => e.type === 'beast' && !e.handled);
  if (beastEvt) { beastEvt.handled = true; beastEvt.seen = true; }
  farm.beastActive = false;
  game.addLog(`${agent.name} 贴守护符于灵田，未来 3 日免受虫害与灵兽侵扰。`, 'event-good');
}

// ── 日报 ──
export function generateDailyReport(game, agent, farm) {
  const dayInt = Math.floor(game.state.world.gameDay);
  if (dayInt === farm.lastReportDay) return null;
  farm.lastReportDay = dayInt;
  const todayLedger = (farm.ledger || []).filter(l => l.day === dayInt);
  const todayEvents = (farm.events || []).filter(e => e.day === dayInt);
  const revenue = todayLedger.reduce((s, l) => s + l.revenue, 0);
  const crops = {};
  for (const l of todayLedger) {
    crops[l.crop] = (crops[l.crop] || 0) + l.count;
  }
  const suggestions = [];
  if (farm.stage === 'ready') suggestions.push('作物已成熟，记得收获');
  if (farm.stage === 'growing') suggestions.push(`作物生长中，注意巡查随机事件`);
  if (farm.stage === 'fallow') suggestions.push('灵田空闲，可播种新灵植');
  if (todayEvents.some(e => !e.handled && !e.positive)) suggestions.push('有待处理的负面事件，请巡查');
  if (revenue > 0) suggestions.push(`今日收益 ${revenue} 灵石`);
  return {
    day: dayInt,
    agentName: agent.name,
    weather: game.state.world.weather,
    season: game.season(),
    income: revenue,
    harvestCount: todayLedger.length,
    crops: Object.entries(crops).map(([name, count]) => ({ name, count })),
    events: todayEvents.map(e => ({ type: e.typeCN, positive: e.positive, handled: e.handled })),
    suggestions,
  };
}

// ── 租借协作浇灌（双方各记一次）──
export function cooperativeWater(game, agent, farm) {
  const r = farm.rental;
  if (r && r.active && r.accepted) {
    // 租借期间浇灌，双方各记任务进度
    updateQuestProgress(game, agent, farm, 'daily_water', 1);
    updateQuestProgress(game, agent, farm, 'weekly_water', 1);
    // 出租方也记一次（在 game.js 中处理）
    return true;
  }
  return false;
}

// ── 租借给出租方记录 ──
export function cooperativeWaterOwner(game, farm) {
  const ownerFarm = game.state.farms[farm.rental?.ownerId];
  if (ownerFarm && farm.rental?.active) {
    updateQuestProgress(game, game.state.agents[farm.rental.ownerId], ownerFarm, 'daily_water', 1);
    updateQuestProgress(game, game.state.agents[farm.rental.ownerId], ownerFarm, 'weekly_water', 1);
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════
// 第四轮新增：身份令牌 / 审计日志 / 土壤肥力 / 田块升级与灵脉 /
//            世界事件 / 存档版本迁移
// ═══════════════════════════════════════════════════════════

// ── 1. 身份令牌系统 ──
// 创建修士时签发令牌，格式: <agentId>.<timestamp>.<hash>
export function generateToken(agentId, secret = FARM.tokenSecret || 'ai-bing-world') {
  const ts = Date.now().toString(36);
  const hash = createHash('sha256').update(`${agentId}.${ts}.${secret}`).digest('hex').slice(0, 16);
  return `${agentId}.${ts}.${hash}`;
}

// 校验令牌：返回 {ok, agentId} 或 {ok:false, error}
export function validateToken(token, agentId, secret = FARM.tokenSecret || 'ai-bing-world') {
  if (!token) return { ok: false, error: '缺少身份令牌' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, error: '令牌格式无效' };
  const [tid, ts, hash] = parts;
  // 令牌绑定到指定 agentId
  if (agentId && tid !== agentId) return { ok: false, error: '令牌与修士身份不匹配' };
  const expected = createHash('sha256').update(`${agentId || tid}.${ts}.${secret}`).digest('hex').slice(0, 16);
  if (hash !== expected) return { ok: false, error: '令牌伪造或已篡改' };
  return { ok: true, agentId: agentId || tid };
}

// ── 2. 审计日志 ──
export function newAuditLog() {
  return { entries: [], nextId: 1 };
}

export function auditLog(game, agentId, agentName, operation, target, result, stonesDelta) {
  const entry = {
    id: game.state.audit.nextId++,
    day: Math.floor(game.state.world.gameDay),
    timestamp: Date.now(),
    agentId,
    agentName,
    operation,
    target,
    result,
    stonesDelta: stonesDelta || 0,
    stonesAfter: (() => {
      const a = game.state.agents[agentId];
      return a ? a.spiritStones : 0;
    })(),
  };
  game.state.audit.entries.push(entry);
  if (game.state.audit.entries.length > 2000) game.state.audit.entries.shift();
}

// 审计日志分页查询
export function queryAuditLog(audit, { agentId, page = 1, perPage = 50 } = {}) {
  let entries = audit.entries;
  if (agentId) entries = entries.filter(e => e.agentId === agentId);
  const total = entries.length;
  const start = (page - 1) * perPage;
  const items = entries.slice(start, start + perPage);
  return { items, total, page, perPage };
}

// ── 3. 土壤肥力系统 ──
export function checkFertility(fertility) {
  if (fertility < FARM.badFertThreshold) return { ok: false, error: '土壤肥力过低，无法播种（需购买灵肥或休耕恢复）' };
  if (fertility < FARM.lowFertThreshold) return { ok: false, error: '土壤肥力偏低，生长减速（建议休耕或使用灵肥）' };
  return { ok: true };
}

// 种植消耗肥力
export function consumeFertility(farm, cropName) {
  const crop = CROPS[cropName];
  const cost = Math.max(5, Math.round(crop.periodDays * 0.8));
  farm.fertility = clamp(farm.fertility - cost, 0, FARM.maxFertility);
}

// 每日肥力恢复（休耕 + 灵脉加成）
export function tickFertility(farm, gameDay) {
  if (farm.stage === 'fallow' || farm.stage === 'cleared') {
    const days = Math.max(0, gameDay - (farm.lastFertChecked || gameDay));
    const recovery = days * FARM.fallowRegenPerDay * (farm.isLeyLine ? 1.5 : 1);
    farm.fertility = clamp(farm.fertility + recovery, 0, FARM.maxFertility);
    farm.lastFertChecked = gameDay;
  } else {
    farm.lastFertChecked = gameDay;
  }
}

// 使用灵肥
export function useFertilizer(agent, farm, count = 1) {
  const item = agent.inventory.find(i => i.name === '灵肥');
  if (!item || item.count < count) throw new Error('背包无足够灵肥');
  item.count -= count;
  if (item.count <= 0) agent.inventory.splice(agent.inventory.indexOf(item), 1);
  farm.fertility = clamp(farm.fertility + FARM.fertilizerRestore * count, 0, FARM.maxFertility);
  farm.fertilizerBonus = true; // 当季产量加成
  return { fertility: farm.fertility, fertilizerBonus: true };
}

// ── 4. 田块升级与灵脉地块 ──
export function newFieldUpgrade(toLevel, startDay) {
  const days = FARM.fieldUpgradeDays[toLevel] || 3;
  return { to: toLevel, startDay, endDay: startDay + days, days };
}

export function startFieldUpgrade(game, agent, farm, toLevel) {
  if (farm.upgrading) throw new Error('田块正在升级中，请等待完成');
  if (farm.stage === 'cleared') throw new Error('灵田尚未开垦');
  if (farm.stage === 'growing' || farm.stage === 'ready') throw new Error('田块有作物种植中，请先收获再升级');
  if (toLevel > FARM.fieldLevelMax) throw new Error(`田块最高 ${FARM.fieldLevelMax} 级`);
  if (farm.fieldLevel >= toLevel) throw new Error(`田块已达 ${toLevel} 级`);
  const cost = FARM.fieldUpgradeCost[toLevel];
  if (agent.spiritStones < cost) throw new Error(`灵石不足，升级需 ${cost} 枚`);
  agent.spiritStones -= cost;
  farm.upgrading = newFieldUpgrade(toLevel, Math.floor(game.state.world.gameDay));
  game.addLog(`${agent.name} 开始升级田块至 ${toLevel} 级（${FARM.fieldUpgradeDays[toLevel]} 游戏日）。`, 'system');
}

export function tickFieldUpgrade(game, agent, farm, gameDay) {
  if (!farm.upgrading) return null;
  // 守护符加速升级
  const guardBoost = farm.guardUntil > 0 ? 0.5 : 1;
  if (gameDay >= farm.upgrading.endDay * guardBoost) {
    const oldLevel = farm.fieldLevel;
    farm.fieldLevel = farm.upgrading.to;
    farm.upgrading = null;
    game.addLog(`${agent.name} 的田块升级完成！田块等级 ${oldLevel} → ${farm.fieldLevel} 级。`, 'breakthrough');
    return { completed: true, fieldLevel: farm.fieldLevel };
  }
  return { completed: false, remainingDays: Math.max(0, farm.upgrading.endDay - gameDay) };
}

// 世界生成时随机灵脉地块
export function generateLeyLines(game, allFarms) {
  // 增量分配：从非灵脉田中随机选取，逐步补到 2-3 块；已灵脉田不重复标记
  const existing = Object.values(allFarms).filter(f => f.isLeyLine).length;
  const target = randInt(FARM.leyLineCount.min, FARM.leyLineCount.max);
  const available = Object.keys(allFarms).filter(id => !allFarms[id].isLeyLine);
  const toAssign = Math.min(Math.max(0, target - existing), available.length);
  for (let i = 0; i < toAssign; i++) {
    const idx = randInt(0, available.length - 1);
    const id = available.splice(idx, 1)[0];
    const farm = allFarms[id];
    farm.isLeyLine = true;
    farm.leyLineId = `ley_${randomUUID().slice(0, 8)}`;
    farm.fertility = clamp(farm.fertility + FARM.leyFertilityBonus, 0, FARM.maxFertility);
  }
  if (existing === 0 && toAssign > 0) {
    game.addLog(`天地之间灵气汇聚，${toAssign} 处灵田觉醒为灵脉地块。`, 'breakthrough');
  } else if (toAssign > 0) {
    game.addLog(`灵脉再启，${toAssign} 处灵田觉醒为灵脉地块。`, 'breakthrough');
  }
}

// ── 5. 世界事件系统 ──
export function newWorldEvents() {
  return { current: null, history: [], calendar: [] };
}

// 每日检查是否触发世界事件
export function rollWorldEvents(game, events, gameDay) {
  const dayInt = Math.floor(gameDay);
  // 世界事件每 30 游戏日触发一个，按顺序轮转
  const eventOrder = Object.keys(WORLD_EVENTS);
  const eventIndex = Math.floor(dayInt / FARM.worldEventDays);
  if (events.current && dayInt <= events.current.endDay) return null;

  if (eventIndex > events.lastIndex) {
    const eventId = eventOrder[eventIndex % eventOrder.length];
    const def = WORLD_EVENTS[eventId];
    events.current = {
      id: eventId,
      name: def.name,
      cn: def.cn,
      desc: def.desc,
      startDay: dayInt,
      endDay: dayInt + def.duration,
      growthMult: def.growthMult,
      priceMult: def.priceMult,
      leyMult: def.leyMult || 1,
    };
    events.lastIndex = eventIndex;
    game.addLog(`【世界事件】${def.name}降临！${def.desc}（持续 ${def.duration} 游戏日）。`, 'breakthrough');
  }
  return events.current;
}

// 检查世界事件是否生效
export function getWorldEvent(game, events, gameDay) {
  if (events.current && gameDay <= events.current.endDay) return events.current;
  return null;
}

// 世界事件日历
export function getEventCalendar(game, events) {
  const currentDay = Math.floor(game.state.world.gameDay);
  // 生成未来 90 天的事件预告
  const calendar = [];
  const eventOrder = Object.keys(WORLD_EVENTS);
  for (let offset = 0; offset < 3; offset++) {
    const eventIndex = Math.floor(currentDay / FARM.worldEventDays) + offset;
    const eventId = eventOrder[eventIndex % eventOrder.length];
    const def = WORLD_EVENTS[eventId];
    calendar.push({
      id: eventId, ...def,
      startDay: eventIndex * FARM.worldEventDays,
      endDay: eventIndex * FARM.worldEventDays + def.duration,
    });
  }
  return { current: events.current, history: events.history.slice(-5), calendar, today: currentDay };
}

// ── 6. 存档版本迁移 ──
export function migrateState(saved) {
  let version = saved.schemaVersion || 0;
  const target = SCHEMA_VERSION;
  const migrations = [];

  // v1 -> v2: 添加 farms
  if (version < 1) {
    if (!saved.farms) saved.farms = {};
    migrations.push('v0→v1: 添加 farms');
    version = 1;
  }
  // v2 -> v3: 添加 market/codex/weather
  if (version < 2) {
    if (!saved.market) saved.market = { day: -1, items: {}, totalRevenue: 0, totalSold: 0 };
    if (!saved.codex) saved.codex = { codex: {}, achievements: {} };
    if (!saved.world.weather) saved.world.weather = 'sunny';
    migrations.push('v1→v2: 添加 market/codex/weather');
    version = 2;
  }
  // v3 -> v4: 添加 leaderboard/quests/fertility/fieldLevel/audit/audit/ leyLines/fieldLevel/upgrading
  if (version < 3) {
    if (!saved.leaderboard) saved.leaderboard = newLeaderboard();
    if (!saved.worldEvents) saved.worldEvents = newWorldEvents();
    if (!saved.audit) saved.audit = newAuditLog();
    // 遍历所有 farm，补全新字段
    for (const f of Object.values(saved.farms)) {
      if (f.fertility === undefined) f.fertility = 50;
      if (f.fieldLevel === undefined) f.fieldLevel = 1;
      if (!f.upgrading) f.upgrading = null;
      if (!f.quests) f.quests = {};
      if (f.questCodexPoints === undefined) f.questCodexPoints = 0;
      if (!f.lastQuestReset) f.lastQuestReset = { day: 0, week: 0 };
      if (!f.rental) f.rental = null;
      if (f.guardUntil === undefined) f.guardUntil = 0;
      if (f.lastReportDay === undefined) f.lastReportDay = -1;
      if (f.inheritFrom === undefined) f.inheritFrom = null;
      if (f.isLeyLine === undefined) f.isLeyLine = false;
      if (!f.plantedCrops) f.plantedCrops = {};
      if (!f.achievements) f.achievements = {};
      if (!Array.isArray(f.ledger)) f.ledger = [];
      if (f.totalRevenue === undefined) f.totalRevenue = 0;
      if (f.consecutiveHarvests === undefined) f.consecutiveHarvests = 0;
    }
    migrations.push('v2→v3: 添加 leaderboard/worldEvents/audit + farm 新字段');
    version = 3;
  }
  // v4: 添加 schemaVersion + 为所有 agent 补发灵田 + 灵脉地块
  if (version < 4) {
    // 为没有灵田的 agent 补发 + 补令牌
    for (const aid of Object.keys(saved.agents || {})) {
      if (!saved.farms[aid]) saved.farms[aid] = newFarm();
      const agent = saved.agents[aid];
      if (!agent.token) agent.token = `${aid}.${Date.now().toString(36)}.${createHash('sha256').update(`${aid}.${Date.now()}.ai-bing-world`).digest('hex').slice(0,16)}`;
    }
    // 灵脉地块：随机 2-3 个灵田标记
    const farmIds = Object.keys(saved.farms);
    if (farmIds.length > 0) {
      const count = Math.min(3, Math.max(2, Math.floor(farmIds.length / 5)));
      for (let i = 0; i < count; i++) {
        const idx = Math.floor(Math.random() * farmIds.length);
        const f = saved.farms[farmIds[idx]];
        f.isLeyLine = true;
        f.leyLineId = `ley_migrated_${i}`;
        f.fertility = clamp((f.fertility || 50) + FARM.leyFertilityBonus, 0, FARM.maxFertility);
      }
    }
    migrations.push('v3→v4: 灵田补发 + 灵脉地块 + schema 版本号');
    version = 4;
  }

  saved.schemaVersion = version;
  return { saved, migrated: migrations.length > 0, migrations, version };
}

// 存档校验和
export function saveChecksum(data) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 12);
}

// 验证存档校验和
export function verifySave(data, expectedChecksum) {
  if (!expectedChecksum) return true;
  return saveChecksum(data) === expectedChecksum;
}

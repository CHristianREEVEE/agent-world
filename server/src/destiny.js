// destiny.js — 随机遭遇 + 天命气运系统（2.1 第 3 轮）
// 设计要点：
// - 天命（destiny）是隐藏值：出生分配 1-100，API/观测台均不直接暴露，只通过统计结果模糊感知
// - 品质分层：普通 70% / 优秀 25% / 稀有 4% / 传说 1%
// - 保底：连续 20 次无稀有（rare+）必出稀有，计数器持久化在角色上
import { randInt, weightedPick } from './engine/util.js';

// ---------- 品质分层 ----------
export const QUALITY_WEIGHTS = [
  { quality: 'common', weight: 70, label: '普通' },
  { quality: 'fine', weight: 25, label: '优秀' },
  { quality: 'rare', weight: 4, label: '稀有' },
  { quality: 'legendary', weight: 1, label: '传说' },
];

export const QUALITY_MULT = { common: 1, fine: 2, rare: 5, legendary: 15 };
export const QUALITY_LABEL = { common: '普通', fine: '优秀', rare: '稀有', legendary: '传说' };
export const RARITY_ORDER = ['common', 'fine', 'rare', 'legendary'];

// ---------- 保底机制 ----------
export const PITY_THRESHOLD = 20; // 连续 20 次无稀有必出稀有

// ---------- 事件类型 ----------
// ruins: 遗迹（探索收益加成）/ treasure: 宝箱（灵石/丹药）/ beast: 魔兽袭击（强制战斗）/ fortune: 机缘（大额收益）
export const EVENT_TYPES = ['ruins', 'treasure', 'beast', 'fortune'];
export const EVENT_LABEL = { ruins: '遗迹', treasure: '宝箱', beast: '魔兽袭击', fortune: '机缘' };

// ---------- 天命 ----------
// 出生分配 1-100。影响：
// - 事件权重：遗迹/宝箱/机缘 随天命上浮，魔兽袭击随天命衰减
// - 战斗暴击率：5% ~ 15%（线性）
export function rollDestiny() {
  return randInt(1, 100);
}

// 气运评价分档文案（不暴露具体数字）
export function destinyRating(destiny) {
  if (destiny <= 20) return { tier: 'misfortune', label: '命途多舛', desc: '前路多蹇，需以勤勉补天时。' };
  if (destiny <= 40) return { tier: 'ordinary', label: '平平无奇', desc: '命途寻常，步步皆在人为。' };
  if (destiny <= 60) return { tier: 'favorable', label: '小有福缘', desc: '时有机缘相伴，行事半功倍。' };
  if (destiny <= 80) return { tier: 'blessed', label: '气运加身', desc: '机缘常至，逢凶化吉。' };
  return { tier: 'heavenly', label: '天命眷顾', desc: '天选之人，奇遇连连，大敌亦有一线生机。' };
}

// 暴击率：5% + (destiny/100)*10% → 5%~15%
export function critChance(destiny) {
  return 0.05 + (destiny / 100) * 0.10;
}

// ---------- 事件权重（受天命影响） ----------
// 基础权重：ruins 0.25 / treasure 0.25 / beast 0.30 / fortune 0.20
// luckFactor = destiny/100
// ruins/treasure/fortune × (0.5 + luckFactor)；beast × (1.5 - luckFactor)
export function eventWeights(destiny) {
  const lf = destiny / 100;
  const raw = {
    ruins: 0.25 * (0.5 + lf),
    treasure: 0.25 * (0.5 + lf),
    beast: 0.30 * (1.5 - lf),
    fortune: 0.20 * (0.5 + lf),
  };
  const total = Object.values(raw).reduce((s, v) => s + v, 0);
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v / total]));
}

// ---------- 品质 roll（含保底） ----------
// agent.pity: 连续无稀有计数（持久化）
export function rollQuality(agent) {
  agent.pity = agent.pity || 0;
  // 保底：连续 20 次无稀有 → 强制稀有
  if (agent.pity >= PITY_THRESHOLD) {
    agent.pity = 0;
    return 'rare';
  }
  const roll = weightedPick(QUALITY_WEIGHTS, 'weight');
  const quality = roll.quality;
  if (quality === 'rare' || quality === 'legendary') {
    agent.pity = 0;
  } else {
    agent.pity += 1;
  }
  return quality;
}

// ---------- 随机事件触发 ----------
// 返回 { type, quality, reward, text }；beast 类型由调用方触发战斗
export function rollRandomEvent(agent, game) {
  const destiny = agent.destiny || 50;
  const weights = eventWeights(destiny);
  const type = weightedPick(EVENT_TYPES.map(t => ({ type: t, weight: weights[t] })), 'weight').type;
  const quality = rollQuality(agent);
  const mult = QUALITY_MULT[quality];

  let reward = {};
  let text = '';

  switch (type) {
    case 'ruins': {
      // 遗迹：修为加成
      const base = Math.round((20 + agent.comprehension * 2) * (1 + agent.realmIdx * 0.5));
      const cult = base * mult;
      agent.cultivation = Math.min(agent.cultivation + cult, game.def.realms[agent.realmIdx].maxCultivation);
      reward = { cultivation: cult };
      text = `发现一处古代修士遗迹！参悟石壁铭文，修为 +${cult}（${QUALITY_LABEL[quality]}）。`;
      break;
    }
    case 'treasure': {
      // 宝箱：灵石 + 概率丹药
      const stones = Math.round((30 + agent.realmIdx * 20) * mult);
      agent.spiritStones += stones;
      reward = { spiritStones: stones };
      if (quality === 'rare' || quality === 'legendary') {
        const item = quality === 'legendary' ? '筑基丹' : '聚气丹';
        agent.inventory.push({ name: item, count: quality === 'legendary' ? 3 : 1 });
        reward.item = item;
        reward.itemCount = quality === 'legendary' ? 3 : 1;
        text = `开启宝箱！灵石 +${stones}，拾获【${item}】×${reward.itemCount}（${QUALITY_LABEL[quality]}）。`;
      } else {
        text = `开启宝箱！灵石 +${stones}（${QUALITY_LABEL[quality]}）。`;
      }
      break;
    }
    case 'beast': {
      // 魔兽袭击：强制战斗（强度随境界分层）
      const tier = agent.realmIdx;
      const enemy = {
        name: `${QUALITY_LABEL[quality]}魔兽`,
        hp: Math.round((30 + tier * 25) * mult),
        atk: Math.round((8 + tier * 6) * mult),
        drops: ['妖丹'],
      };
      reward = { enemy };
      text = `一头【${QUALITY_LABEL[quality]}】魔兽骤然袭来！（HP ${enemy.hp} / ATK ${enemy.atk}）`;
      break;
    }
    case 'fortune': {
      // 机缘：一次性大额收益（修为+灵石）
      const cult = Math.round((50 + agent.realmIdx * 40) * mult);
      const stones = Math.round((20 + agent.realmIdx * 15) * mult);
      agent.cultivation = Math.min(agent.cultivation + cult, game.def.realms[agent.realmIdx].maxCultivation);
      agent.spiritStones += stones;
      reward = { cultivation: cult, spiritStones: stones };
      text = `天降机缘！修为 +${cult}，灵石 +${stones}（${QUALITY_LABEL[quality]}）。`;
      break;
    }
  }

  // 记录事件历史
  agent.eventLog = agent.eventLog || [];
  agent.eventLog.push({
    type, quality, ts: Date.now(), reward, text,
  });
  if (agent.eventLog.length > 100) agent.eventLog.shift();

  // 行为日志（人类观察面板）
  game.logAction?.(agent, { kind: 'event', eventType: type, quality, text });

  return { type, quality, reward, text };
}

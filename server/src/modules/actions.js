// actions.js — 行动完成 / 采集 / 机缘 / 突破（Game mixin）
import { randInt, weightedPick, clamp } from '../engine/util.js';
import { startCombat } from '../engine/combat.js';
import { rollRandomEvent } from '../destiny.js';

export function applyActionsMixin(Game) {
  Game.prototype.completeAction = function(agent, act) {
    const gainCult = (base) => {
      const g = Math.round(base * (1 + agent.comprehension * 0.08) * (1 + agent.realmIdx * 0.35) * this.reincarnationBonus(agent));
      agent.cultivation = Math.min(agent.cultivation + g, this.def.realms[agent.realmIdx].maxCultivation);
      return g;
    };
    switch (act.type) {
      case 'cultivate': {
        const g = gainCult(4 + agent.comprehension * 0.5);
        this.addLog(`${agent.name} 修炼完毕，修为 +${g}。`, 'event-good');
        this.gainXp(agent, 'cultivate');
        break;
      }
      case 'rest':
        agent.stamina = Math.min(agent.maxStamina, agent.stamina + 55);
        agent.spirit = Math.min(agent.maxSpirit, agent.spirit + Math.ceil(agent.maxSpirit * 0.35));
        agent.hp = Math.min(agent.maxHp, agent.hp + Math.ceil(agent.maxHp * 0.2));
        this.addLog(`${agent.name} 稍作歇息，体力灵力尽复几分。`, 'event-good');
        break;
      case 'collect': this.gather(agent, 'collect', '灵兽森林'); this.gainXp(agent, 'gather'); break;
      case 'mine': this.gather(agent, 'mine', '玄铁矿脉'); this.gainXp(agent, 'gather'); break;
      case 'fish': this.gather(agent, 'fish', this.agentArea(agent).type === 'river' ? '碧水江' : '海滩'); this.gainXp(agent, 'gather'); break;
      case 'ask': {
        const cfg = this.def.ask[this.agentArea(agent).type === 'sect' ? 'sect' : 'mountain'];
        const g = gainCult(cfg.cultivationBase + agent.comprehension);
        this.addLog(`${agent.name} ${cfg.text}，修为 +${g}。`, 'event-good');
        this.gainXp(agent, 'ask');
        if (Math.random() < cfg.comprehensionChance + agent.luck * 0.004) {
          agent.comprehension += 1; this.addLog(`${agent.name} 灵光乍现，悟性 +1！`, 'breakthrough');
        }
        break;
      }
      case 'fortune': {
        const ev = rollRandomEvent(agent, this);
        this.addLog(`${agent.name} ${ev.text}`, ev.quality === 'legendary' ? 'breakthrough' : 'event-good');
        if (ev.type === 'beast') startCombat(this, agent, ev.reward.enemy, 'wild');
        this.gainXp(agent, 'fortune');
        break;
      }
      case 'move': {
        const target = act.payload.to;
        agent.areaId = target;
        this.addLog(`${agent.name} 抵达 ${this.areaDef(target).name}。${this.areaDef(target).desc}`, 'system');
        break;
      }
    }
    this.recalcStats(agent);
    this.logAction(agent, { kind: 'result', type: act.type, label: act.label });
    this.emit('update');
    this.markDirty();
  };

  Game.prototype.gather = function(agent, kind, where) {
    if (Math.random() < 0.15) {
      const ev = rollRandomEvent(agent, this);
      this.addLog(`${agent.name} ${ev.text}`, ev.quality === 'legendary' ? 'breakthrough' : 'event-good');
      if (ev.type === 'beast') startCombat(this, agent, ev.reward.enemy, 'wild');
      return;
    }
    const roll = weightedPick(this.def.gather[kind]);
    if (roll.item === 'spiritStones') {
      const n = randInt(roll.min, roll.max) + (Math.random() < agent.luck * 0.02 ? 3 : 0);
      agent.spiritStones += n;
      this.addLog(`${agent.name} 在${where}收获灵石 +${n}。`, 'event-good');
    } else {
      let n = 1;
      if (Math.random() < agent.luck * 0.03) n += 1;
      this.addItem(agent, roll.item, n);
      this.addLog(`${agent.name} 在${where}采得【${roll.item}】×${n}。`, 'event-good');
    }
  };

  Game.prototype.fortune = function(agent, areaId) {
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
      case 'body': agent.body += 1; this.recalcStats(agent); this.addLog(`${agent.name} ${ev.text}`, 'breakthrough'); break;
      case 'item': this.addItem(agent, ev.item, 1); this.addLog(`${agent.name} ${ev.text}`, 'event-good'); break;
      default: this.addLog(`${agent.name} ${ev.text}`, 'system');
    }
  };

  Game.prototype.doBreakthrough = function(agent) {
    if (agent.realmIdx >= this.def.realms.length - 1) throw new Error('已至大乘，只待飞升');
    const realm = this.def.realms[agent.realmIdx];
    if (agent.cultivation < realm.maxCultivation) throw new Error('修为未至圆满');
    const next = this.def.realms[agent.realmIdx + 1];
    const item = realm.breakItem;
    if (item && this.countItem(agent, item) < 1) throw new Error(`突破需要【${item}】`);
    if (item) this.removeItem(agent, item, 1);
    agent.realmIdx += 1;
    agent.cultivation = 0;
    this.recalcStats(agent, true);
    this.addLog(`天降异象，灵气如潮！${agent.name} 成功突破至【${next.name}】之境！寿元上限提升至 ${next.maxLifespan} 岁。`, 'breakthrough');
    this.gainXp(agent, 'breakthrough', 30 * agent.realmIdx);
    this.logAction(agent, { kind: 'breakthrough', realm: next.name });
    this.emit('update');
    this.markDirty();
    return { ok: true, message: `突破成功：${next.name}`, realm: next.name };
  };
}

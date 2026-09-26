// tick.js — 时间推进 / 离线挂机 / 统计（Game mixin）
import { isCombatActive } from '../engine/combat.js';
import { clamp } from '../engine/util.js';

export function applyTickMixin(Game) {
  Game.prototype.tick = function() {
    const nowTs = Date.now();
    const dt = nowTs - this._lastTick;
    this._lastTick = nowTs;
    const w = this.state.world;
    if (w.paused || !this.state.created) return;

    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    const eff = dt * w.speed;
    this.advance(eff);
    const cost = (typeof performance !== 'undefined') ? performance.now() - t0 : 0;
    this._tickStats.n += 1;
    this._tickStats.sumMs += cost;
    this._tickStats.maxMs = Math.max(this._tickStats.maxMs, cost);
  };

  Game.prototype.advance = function(eff) {
    const w = this.state.world;
    w.gameDay += (eff / this.def.time.tickMs) * this.def.time.dayPerTick;

    for (const agent of this.allAgents()) {
      if (agent.dead) continue;
      const realm = this.def.realms[agent.realmIdx];
      if (agent.age > realm.maxLifespan) {
        agent.dead = true;
        agent.deathReason = `寿元耗尽，坐化于 ${this.areaDef(agent.areaId)?.name || '荒野'}，享年 ${agent.age} 岁。`;
        agent.combat = null; agent.dungeon = null; agent.currentAction = null;
        this.addLog(agent.deathReason, 'event-bad');
        continue;
      }
      const act = agent.currentAction;
      if (act) {
        act.remainingMs -= eff;
        act.progress = clamp(1 - act.remainingMs / act.durationMs, 0, 1);
        if (act.remainingMs <= 0) {
          agent.currentAction = null;
          this.completeAction(agent, act);
        }
      } else if (!agent.online && !isCombatActive(agent) && !agent.dungeon) {
        this.offlineIdle(agent, eff);
      }
    }
    this.markDirty();
  };

  Game.prototype.offlineIdle = function(agent, eff) {
    agent.idleMs = (agent.idleMs || 0) + eff;
    const cycle = Game.OFFLINE_IDLE_CYCLE_MS;
    while (agent.idleMs >= cycle) {
      agent.idleMs -= cycle;
      const g = Math.round((4 + agent.comprehension * 0.5) * (1 + agent.comprehension * 0.08) * (1 + agent.realmIdx * 0.35) * this.reincarnationBonus(agent) * Game.OFFLINE_IDLE_RATE);
      agent.cultivation = Math.min(agent.cultivation + g, this.def.realms[agent.realmIdx].maxCultivation);
      this.gainXp(agent, 'cultivate', 0.2);
    }
  };

  Game.prototype.tickStats = function() {
    return {
      ...this._tickStats,
      avgMs: this._tickStats.n ? Math.round(this._tickStats.sumMs / this._tickStats.n * 100) / 100 : 0,
    };
  };

  Game.prototype.worldStats = function() {
    const agents = this.allAgents();
    const alive = agents.filter(a => !a.dead);
    const today = Math.floor(this.state.world.gameDay);
    const eventsToday = (this.state.logs || []).filter(l => l.day === today).length;
    const avgCultivation = alive.length
      ? Math.round(alive.reduce((s, a) => s + a.cultivation, 0) / alive.length)
      : 0;
    return {
      online: agents.filter(a => a.online).length,
      alive: alive.length,
      total: agents.length,
      eventsToday,
      avgCultivation,
      tick: this.tickStats(),
    };
  };

  Game.prototype.fastForward = function(ms) {
    const w = this.state.world;
    if (w.paused || !this.state.created) return;
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    const eff = ms * w.speed;
    this.advance(eff);
    const cost = (typeof performance !== 'undefined') ? performance.now() - t0 : 0;
    this._tickStats.n += 1;
    this._tickStats.sumMs += cost;
    this._tickStats.maxMs = Math.max(this._tickStats.maxMs, cost);
  };
}

// accounts.js — 账号-角色双层模型（2.0）
// Account（账号）：代号 / token / 跨世界等级(1-100) / XP / 角色列表 / 活跃角色指针
// Character（角色）：沿用原 agent 实体，固定绑定一个世界，存于各世界 save.json 的 agents 表
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateChain, validateArchive } from './migrations.js';

// ---------- XP 曲线（公式写入文档 docs/api-v2.md） ----------
// 达到等级 L 所需的【累计】XP：
//   totalXp(L) = 50*(L-1)^2 + 100*(L-1)
//   Lv1=0, Lv2=150, Lv10=4950, Lv50=124950, Lv100=500000
// 升到下一级所需 XP（当前等级内）：
//   need(L) = totalXp(L+1) - totalXp(L) = 100*L + 50
export function totalXpForLevel(level) {
  const x = Math.max(0, level - 1);
  return 50 * x * x + 100 * x;
}

export function levelFromXp(xp) {
  xp = Math.max(0, Math.floor(xp || 0));
  // 解 50x^2 + 100x <= xp  →  x = floor((-100 + sqrt(10000 + 200*xp)) / 100)
  let x = Math.floor((-100 + Math.sqrt(10000 + 200 * xp)) / 100);
  x = Math.max(0, Math.min(99, x));
  return x + 1;
}

export function xpProgress(xp) {
  const level = levelFromXp(xp);
  const base = totalXpForLevel(level);
  const next = level >= 100 ? null : totalXpForLevel(level + 1);
  const need = next === null ? 0 : next - base;
  return {
    level,
    xp: Math.floor(xp),
    base,
    next,
    into: Math.floor(xp - base),
    need,
    pct: next === null ? 100 : Math.floor(((xp - base) / need) * 100),
    maxed: level >= 100,
  };
}

// 角色成长 → 账号 XP 入账表（kind -> 基础 XP）
export const XP_SOURCES = {
  cultivate: 2,          // 修炼完成
  gather: 1,            // 采集/挖矿/赶海
  ask: 3,               // 宗门请教
  fortune: 5,           // 机缘事件
  breakthrough: null,   // 特殊：30 * 新境界序号（由 game 传入 amount）
  combat_win: 10,       // 战斗胜利
  dungeon_loot: 5,      // 副本探索收获（宝箱/参悟）
  dungeon_boss: 100,    // 副本通关 Boss
};

export const BASE_CHARACTER_LIMIT = 6;
export const MAX_CHARACTER_LIMIT = 10;
export const MAX_LEVEL = 100;

export function characterLimitForLevel(level) {
  return level >= MAX_LEVEL ? MAX_CHARACTER_LIMIT : BASE_CHARACTER_LIMIT;
}

// 业务错误（带错误码），API 层据此返回 code + message
export class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class AccountManager {
  constructor({ dataDir, worlds }) {
    this.dataDir = dataDir;
    this.worlds = worlds; // Map<worldId, { game, def, store, runner, info }>
    this.accountsFile = path.join(dataDir, 'accounts.json');
    this.backupDir = path.join(dataDir, '_backups');
    this.accounts = new Map(); // accountId -> account
    this.readOnly = false;    // 迁移失败降级：只读
    this.migration = null;    // 迁移记录（用于回滚）
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // ---------- 持久化 ----------
  #save() {
    const data = {
      version: 2,
      migratedAt: this.migration?.migratedAt || null,
      accounts: [...this.accounts.values()],
    };
    const tmp = this.accountsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, this.accountsFile);
  }

  #load() {
    if (!fs.existsSync(this.accountsFile)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(this.accountsFile, 'utf-8'));
      if (!data || !Array.isArray(data.accounts)) return false;
      for (const acc of data.accounts) this.accounts.set(acc.id, acc);
      this.migration = data.migratedAt ? { migratedAt: data.migratedAt } : null;
      return true;
    } catch (e) {
      console.error('[accounts] 读取 accounts.json 失败:', e.message);
      return false;
    }
  }

  // ---------- 启动入口：加载或迁移 ----------
  boot() {
    if (this.#load()) {
      console.log(`[accounts] 账号表加载完成：${this.accounts.size} 个账号`);
      return;
    }
    this.#migrate();
  }

  // ---------- 存档迁移：单层 agentId → 账号 + 首角色 ----------
  #migrate() {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backups = [];
    try {
      // 1. 快照所有世界存档
      for (const [worldId, w] of this.worlds) {
        const saveFile = w.store.saveFile;
        if (fs.existsSync(saveFile)) {
          const dest = path.join(this.backupDir, `save-${worldId}-${ts}.bak`);
          fs.copyFileSync(saveFile, dest);
          backups.push({ worldId, saveFile, backup: dest });
        }
      }

      // 2. 通过迁移链：v0 → v1 → v1.1
      let created = 0;
      for (const [worldId, w] of this.worlds) {
        const saved = { version: 0, agents: w.game.state.agents || {} };
        const result = migrateChain(saved, {
          worldId,
          createAccount: (opts) => {
            const acc = this.createAccount(opts);
            created += 1;
            return acc;
          },
        });
        // 把迁移结果写回 game state
        for (const [key, agent] of Object.entries(result.agents)) {
          w.game.state.agents[key] = agent;
        }
        w.store.save(w.game.state);
      }

      this.migration = { migratedAt: ts, backups, accountsCreated: created };
      this.#save();
      console.log(`[accounts] 迁移完成：${created} 个旧角色已归入账号，备份位于 ${this.backupDir}`);
    } catch (e) {
      // 失败降级：回滚备份 → 只读模式 + 告警
      console.error('[accounts] ✗✗✗ 迁移失败，正在回滚存档:', e.message);
      for (const b of backups) {
        try { fs.copyFileSync(b.backup, b.saveFile); } catch (e2) {
          console.error('[accounts] 回滚失败:', e2.message);
        }
      }
      this.accounts.clear();
      this.readOnly = true;
      console.error('[accounts] ✗✗✗ 系统已降级为只读模式，旧存档未被改动，请检查数据后重启');
    }
  }

  // ---------- 导出 / 导入（完整性校验） ----------
  exportArchive() {
    const availableWorldIds = [...this.worlds.keys()];
    const archive = {
      version: '1.1',
      accounts: [...this.accounts.values()],
      worlds: availableWorldIds,
    };
    const { valid, errors } = validateArchive(archive, { availableWorldIds });
    if (!valid) throw new ApiError('ARCHIVE_INVALID', `导出校验失败：${errors.join(', ')}`, 500);
    return archive;
  }

  importArchive(archive) {
    this.#assertWritable();
    const availableWorldIds = [...this.worlds.keys()];
    const { valid, errors } = validateArchive(archive, { availableWorldIds });
    if (!valid) throw new ApiError('ARCHIVE_INVALID', `导入校验失败：${errors.join(', ')}`, 400);
    // 合并：覆盖同 id 账号，新增缺失
    for (const acc of archive.accounts) {
      this.accounts.set(acc.id, acc);
    }
    this.#save();
    return { ok: true, imported: archive.accounts.length };
  }

  // 回滚：恢复迁移前备份，清空账号表（测试 / 运维用）
  rollback() {
    if (!this.migration?.backups?.length) throw new ApiError('NO_MIGRATION', '无迁移记录，无需回滚', 404);
    for (const b of this.migration.backups) {
      if (fs.existsSync(b.backup)) fs.copyFileSync(b.backup, b.saveFile);
    }
    if (fs.existsSync(this.accountsFile)) fs.unlinkSync(this.accountsFile);
    this.accounts.clear();
    this.readOnly = false;
    console.log('[accounts] 已回滚到迁移前存档');
    return { ok: true, restored: this.migration.backups.length };
  }

  #assertWritable() {
    if (this.readOnly) throw new ApiError('READ_ONLY', '系统处于只读降级模式（迁移失败），暂不可写入', 503);
  }

  // ---------- 账号 ----------
  createAccount({ code = '', migrated = false } = {}) {
    this.#assertWritable();
    const acc = {
      id: 'acc_' + randomUUID(),
      code: String(code || '').slice(0, 24) || `道友${randomUUID().slice(0, 4)}`,
      token: 'tok_' + randomUUID(),
      level: 1,
      xp: 0,
      characters: [],
      activeCharacterId: null,
      createdAt: Date.now(),
      migrated: !!migrated,
    };
    this.accounts.set(acc.id, acc);
    this.#save();
    return acc;
  }

  authenticate(token) {
    if (!token) return null;
    for (const acc of this.accounts.values()) {
      if (acc.token === token) return acc;
    }
    return null;
  }

  getAccount(accountId) { return this.accounts.get(accountId) || null; }

  // 旧版直连 agentId 的角色：挂到一个自动账号下（向后兼容）
  attachLegacyAgent(characterId, worldId, name) {
    this.#assertWritable();
    const acc = this.createAccount({ code: ` legacy·${name}` });
    const agent = this.worlds.get(worldId)?.game.getAgent(characterId);
    if (!agent) throw new ApiError('CHARACTER_NOT_FOUND', '角色不存在', 404);
    agent.accountId = acc.id;
    agent.worldId = worldId;
    acc.characters.push({ characterId, worldId, name, createdAt: agent.createdAt || Date.now() });
    acc.activeCharacterId = characterId;
    this.#save();
    return acc;
  }

  // ---------- 角色 ----------
  getCharacterLocation(characterId) {
    for (const [worldId, w] of this.worlds) {
      const agent = w.game.getAgent(characterId);
      if (agent) return { character: agent, game: w.game, worldId };
    }
    return null;
  }

  createCharacter(accountId, worldId, { name, path, body, comprehension, luck, clientLabel }) {
    this.#assertWritable();
    const acc = this.accounts.get(accountId);
    if (!acc) throw new ApiError('ACCOUNT_NOT_FOUND', '账号不存在', 404);
    const w = this.worlds.get(worldId);
    if (!w) throw new ApiError('WORLD_NOT_FOUND', `世界不存在：${worldId}`, 404);

    const limit = characterLimitForLevel(acc.level);
    if (acc.characters.length >= limit) {
      throw new ApiError('CHARACTER_LIMIT', `角色数量已达上限（${limit} 个${acc.level >= MAX_LEVEL ? '，满级账号' : '；账号满级 100 后扩至 10 个'}）`, 409);
    }

    const characterId = 'char_' + randomUUID();
    // 委托世界引擎创建角色实体（沿用全部修士字段）
    w.game.createAgent(characterId, {
      name, path, body, comprehension, luck,
      clientLabel: clientLabel || acc.code,
      accountId,
    });
    const agent = w.game.getAgent(characterId);
    agent.worldId = worldId;
    acc.characters.push({
      characterId, worldId, name: agent.name, createdAt: Date.now(),
    });
    acc.activeCharacterId = characterId;
    this.#save();
    return agent;
  }

  switchCharacter(accountId, characterId) {
    this.#assertWritable();
    const acc = this.accounts.get(accountId);
    if (!acc) throw new ApiError('ACCOUNT_NOT_FOUND', '账号不存在', 404);
    const ref = acc.characters.find(c => c.characterId === characterId);
    if (!ref) throw new ApiError('CHARACTER_NOT_FOUND', '该角色不属于当前账号', 404);
    const loc = this.getCharacterLocation(characterId);
    if (!loc) throw new ApiError('CHARACTER_NOT_FOUND', '角色数据缺失', 404);
    acc.activeCharacterId = characterId;
    this.#save();
    return { account: acc, character: loc.character, game: loc.game, worldId: ref.worldId };
  }

  deleteCharacter(accountId, characterId) {
    this.#assertWritable();
    const acc = this.accounts.get(accountId);
    if (!acc) throw new ApiError('ACCOUNT_NOT_FOUND', '账号不存在', 404);
    const ref = acc.characters.find(c => c.characterId === characterId);
    if (!ref) throw new ApiError('CHARACTER_NOT_FOUND', '该角色不属于当前账号', 404);
    const loc = this.getCharacterLocation(characterId);
    if (!loc) throw new ApiError('CHARACTER_NOT_FOUND', '角色数据缺失', 404);

    // 在途行为 / 战斗中 / 副本中禁止删除
    const { game, character } = loc;
    if (character.currentAction) {
      throw new ApiError('CHARACTER_BUSY', `角色正在「${character.currentAction.label}」，请先完成或中断后再删除`, 409);
    }
    if (game.agentStatus(character) === 'combat') {
      throw new ApiError('CHARACTER_IN_COMBAT', '角色正在战斗中，无法删除', 409);
    }
    if (character.dungeon) {
      throw new ApiError('CHARACTER_IN_DUNGEON', '角色正在副本中，请先退出副本再删除', 409);
    }

    game.removeAgent(characterId);
    acc.characters = acc.characters.filter(c => c.characterId !== characterId);
    if (acc.activeCharacterId === characterId) {
      acc.activeCharacterId = acc.characters[0]?.characterId || null;
    }
    this.#save();
    return { ok: true, activeCharacterId: acc.activeCharacterId };
  }

  // ---------- XP 入账 ----------
  gainXp(character, kind, amount) {
    if (!character?.accountId) return;
    const acc = this.accounts.get(character.accountId);
    if (!acc) return;
    const base = amount != null ? amount : XP_SOURCES[kind] || 0;
    if (!base) return;
    const before = acc.level;
    acc.xp += base;
    acc.level = levelFromXp(acc.xp);
    this.#save();
    if (acc.level > before) {
      const game = this.getCharacterLocation(character.id)?.game;
      game?.addLog(`【${acc.code}】账号等级提升至 ${acc.level} 级！（来源：${character.name} ${kind}）`, 'breakthrough');
    }
  }

  // ---------- 对外视图（观测台 / 账号查询） ----------
  accountView(acc) {
    const p = xpProgress(acc.xp);
    return {
      id: acc.id,
      code: acc.code,
      level: p.level,
      xp: p.xp,
      xpBase: p.base,
      xpNext: p.next,
      xpInto: p.into,
      xpNeed: p.need,
      xpPct: p.pct,
      maxed: p.maxed,
      characterLimit: characterLimitForLevel(acc.level),
      activeCharacterId: acc.activeCharacterId,
      migrated: !!acc.migrated,
      characters: acc.characters.map(ref => {
        const loc = this.getCharacterLocation(ref.characterId);
        const ch = loc?.character;
        const game = loc?.game;
        return {
          id: ref.characterId,
          name: ref.name,
          worldId: ref.worldId,
          active: acc.activeCharacterId === ref.characterId,
          createdAt: ref.createdAt,
          // 角色快照（跨世界聚合）
          realmIdx: ch?.realmIdx ?? null,
          realmName: ch ? game.realmName(ch.realmIdx) : null,
          pathName: ch ? (game.def.paths[ch.path]?.name || ch.path) : null,
          areaName: ch ? (game.agentArea(ch)?.name || '未知') : null,
          status: ch ? game.agentStatus(ch) : 'missing',
          dead: !!ch?.dead,
          online: !!ch?.online,
          cultivation: ch ? Math.floor(ch.cultivation) : null,
        };
      }),
    };
  }

  // 观测台公开视图（不含 token）
  publicAccounts() {
    return [...this.accounts.values()].map(acc => {
      const v = this.accountView(acc);
      delete v.token;
      return v;
    });
  }
}

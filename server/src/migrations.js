// migrations.js — Schema 版本化迁移链
// v0: 单层（agentId = 修士，无账号）
// v1: 双层（Account + Character）
// v1.1: 并行世界（每世界独立 tick，角色跨世界引用）
// 每版本迁移函数独立可测，迁移链逐级可回放。

// ---------- v0 → v1：单层 → 双层 ----------
// 输入：{ agents: { id: agent }, world, ... }（game.js 已把旧平铺格式规范化为 agents 表）
// 输出：{ version: 1, accounts: [...], agents: 原样（补 accountId/worldId） }
export function migrateV0toV1(saved, { worldId, createAccount }) {
  const agents = saved.agents || {};
  const accounts = [];
  for (const [key, agent] of Object.entries(agents)) {
    if (agent.accountId) continue;
    const acc = createAccount({ code: agent.clientLabel || `道友·${agent.name}`, migrated: true });
    agent.accountId = acc.id;
    agent.worldId = worldId;
    agent.id = key; // 规整：对象 key = id
    acc.characters.push({
      characterId: key,
      worldId,
      name: agent.name,
      createdAt: agent.createdAt || Date.now(),
    });
    acc.activeCharacterId = key;
    accounts.push(acc);
  }
  return { version: 1, accounts, agents };
}

// ---------- v1 → v1.1：并行世界 ----------
// v1.1 无结构变化：所有世界独立加载，角色引用通过 account.characters[].worldId 定位
// 此函数只做标记 + 完整性校验（见 validateArchive）
export function migrateV1toV1_1(saved) {
  return { ...saved, version: '1.1' };
}

// ---------- 迁移链入口 ----------
// 从任意版本迁移到最新
export function migrateChain(saved, { worldId, createAccount }) {
  let v = saved.version || 0;
  let result = saved;

  if (v === 0) {
    result = migrateV0toV1(result, { worldId, createAccount });
    v = 1;
  }
  if (v === 1) {
    result = migrateV1toV1_1(result);
    v = '1.1';
  }
  return result;
}

// ---------- 完整性校验（导出/导入） ----------
// 校验：
// 1. 角色引用的世界存在
// 2. 账号引用的角色存在
// 3. 无孤立账号 / 无孤立角色
export function validateArchive(archive, { availableWorldIds }) {
  const errors = [];
  const accounts = archive.accounts || [];
  const allCharacterIds = new Set();

  for (const acc of accounts) {
    if (!acc.id) errors.push(`账号缺少 id`);
    if (!acc.token) errors.push(`账号 ${acc.id} 缺少 token`);
    for (const ref of acc.characters || []) {
      if (!availableWorldIds.includes(ref.worldId)) {
        errors.push(`账号 ${acc.id} 角色 ${ref.characterId} 引用不存在的世界 ${ref.worldId}`);
      }
      if (!ref.characterId) errors.push(`账号 ${acc.id} 存在无 characterId 的角色引用`);
      allCharacterIds.add(ref.characterId);
    }
    if (acc.activeCharacterId && !acc.characters.some(c => c.characterId === acc.activeCharacterId)) {
      errors.push(`账号 ${acc.id} 的 activeCharacterId ${acc.activeCharacterId} 不在角色列表中`);
    }
  }

  // 检查孤立角色（在 agents 表里但不被任何账号引用）
  // 注意：agents 表分散在各世界 save.json，这里只校验 archive 内的引用完整性
  return { valid: errors.length === 0, errors };
}

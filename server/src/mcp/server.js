// mcp/server.js — MCP 服务器：每个会话绑定独立 Agent，让 Claude Code / Codex 等下场修仙
// 外部 Agent 通过标准 MCP 协议连接，调用工具操作世界，干完活向它的主人汇报。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AREA_TYPE_CN = {
  town: '城镇', forest: '森林', mine: '矿脉', river: '江河', market: '集市',
  sect: '宗门', mountain: '山脉', beach: '海滩', event: '奇缘', dungeon_entrance: '秘境入口',
};
const PATH_CN = { sword: '剑修', pill: '丹修', array: '阵修' };
const STATUS_CN = { idle: '闲适', busy: '行事中', moving: '赶路', combat: '战斗中', dungeon: '秘境中', dead: '已身殒', uncreated: '未创建' };

// 把 agentPublicState 压成 LLM 友好的紧凑文本
function stateText(game, agentId) {
  const st = game.agentPublicState(agentId);
  if (!st || !st.created) return '【尚未创角】世界静候修士踏入。请先用 xiuxian_create_character 创建角色。';
  if (st.agent.dead || st.world.dead) {
    return `【已身殒】${st.world.deathReason || '寿元耗尽'}\n可用 xiuxian_reincarnate 转世重修。`;
  }
  const a = st.agent;
  const inv = a.inventory.map((i) => `${i.name}×${i.count}`).join('、') || '空';
  const lines = [];
  lines.push(`【修士】${a.name}（${PATH_CN[a.path] || a.pathName} · ${a.realmName}，${a.age}/${a.lifespan}岁）`);
  lines.push(`【状态】${STATUS_CN[st.status] || st.status} · 位于 ${a.areaName}（${AREA_TYPE_CN[a.areaType] || a.areaType}）${a.areaDesc ? '：' + a.areaDesc : ''}`);
  lines.push(`【资源】生命 ${a.hp}/${a.maxHp} · 灵力 ${a.spirit}/${a.maxSpirit} · 体力 ${a.stamina}/${a.maxStamina} · 灵石 ${a.spiritStones}`);
  lines.push(`【修为】${a.cultivation}/${a.cultivationMax}${a.realmIdx < 7 ? `（圆满可突破至 ${a.nextRealmName}）` : '（已至大乘圆满）'}`);
  lines.push(`【背包】${inv}`);
  if (a.senseRange >= 9999) lines.push(`【神识】已可感知全域`);
  else lines.push(`【神识】感知范围 ${a.senseRange} 丈`);
  if (a.unreadMessages > 0) lines.push(`【传音】有 ${a.unreadMessages} 条未读传音，用 xiuxian_messages 查看`);
  lines.push(`【时间】第${st.world.gameYear}年 ${st.world.season}季第${st.world.dayOfYear}日 ${st.world.shichen}（流速${st.world.speed}倍${st.world.paused ? '·静止' : ''}）`);
  if (st.inCombat && st.combat && !st.combat.ended) {
    const c = st.combat;
    lines.push(`【战斗】第${c.round}回合 vs ${c.enemy.name}（敌方生命 ${Math.max(0, Math.floor(c.enemy.hp))}/${c.enemy.maxHp}）`);
  }
  if (st.inDungeon && st.dungeon) {
    const d = st.dungeon;
    lines.push(`【秘境】${d.name} 第${d.floor + 1}/${d.floors}层${d.floorCleared ? '（本层已清，可深入）' : '（未探索）'}${d.lastEvent ? ` · 上次：${d.lastEvent}` : ''}`);
  }
  if (st.currentAction) lines.push(`【进行中】${st.currentAction.label}（${Math.floor(st.currentAction.progress * 100)}%，剩 ${Math.ceil(st.currentAction.remainingMs / 1000)} 秒）`);
  // 神识感知到的其他修士
  if (st.nearbyAgents && st.nearbyAgents.length) {
    lines.push(`【感知修士】${st.nearbyAgents.map(x => `${x.name}(${x.realmName},${x.sameArea ? '同处此地' : `${x.distance}丈外`}${x.online ? ',在线' : ''})`).join('；')}`);
  } else {
    lines.push(`【感知修士】神识范围内无其他修士`);
  }
  return lines.join('\n');
}

function actionsText(game, agentId) {
  const acts = game.availableActions(agentId);
  if (!acts.length) return '（此刻无可为之事）';
  return acts.map((x) => `${x.type}${x.enabled ? '' : '（不可用）'}=${x.label}${x.cost && Object.keys(x.cost).length ? ` 耗${JSON.stringify(x.cost)}` : ''}`).join('; ');
}

function areasText(game, agentId) {
  const st = game.agentPublicState(agentId);
  if (!st) return '（未创建）';
  return (st.availableAreas || []).map((x) => `${x.id}(${x.name},${AREA_TYPE_CN[x.type] || x.type}${x.unlocked ? '' : ',境界不足'})`).join('; ');
}

export function createMcpServer({ game, runner, clientLabel, session, accounts }) {
  const def = game.def;
  // 2.0：会话懒建账号；getAgentId() 存到 session 上（角色创建后回填）
  const sess = session || { agentId: null };
  const getAgentId = () => sess.agentId;
  const isWestern = def.id === 'western' || def.id === 'mythos';

  const server = new McpServer(
    { name: 'ai-bing-world', version: '2.0.0' },
    {
      instructions: isWestern ? [
        'You are an adventurer in the Mythos Realm, a world of Greek and Norse mythology, adventuring on behalf of your master (the user).',
        'Eight realms of power: Mortal → Apprentice → Adept → Magus → Archon → Sage → Demigod → Divine. Breakthrough requires full cultivation and the corresponding ritual item.',
        'Core loop: cultivate when you have mana; gather resources (forest/mine/river) when low on gold; buy breakthrough items at the Bazaar; explore dungeons for loot and glory.',
        'Combat: use skills when mana is sufficient, defend or flee when low on HP.',
        'Actions take time: xiuxian_act / xiuxian_move will wait for completion and return the result.',
        'Multiple adventurers share this realm: use xiuxian_sense to detect nearby souls, xiuxian_talk to send them a message.',
        'Flow: xiuxian_overview → act/move → repeat until you achieve your master\'s goal, then report back.',
      ].join('\n') : [
        '你是修仙世界「云仙大世界」中的一名修士，替你的主人（用户）下场修行。',
        '境界八阶：凡人→筑基→金丹→元婴→化神→炼虚→合体→大乘；突破需境界圆满并持有对应丹药（筑基丹/金丹丹…，散修集市有售）。',
        '玩法要点：灵力充足就修炼；修为将满时先备突破丹再突破；灵石不足去森林采集/矿脉挖矿/江河赶海换钱；',
        '筑基后可探秘境副本（进入秘境入口→逐层探索→打 Boss）；战斗中灵力足用技能、血量低先防御或逃跑；体力不足要休息。',
        '行动需要时间完成：xiuxian_act / xiuxian_move 会自动等待行动结束并返回结果。',
        '多修士共在此界：境界越高神识越广，可用 xiuxian_sense 探查周围修士，xiuxian_talk 向其传音交流。',
        '常用流程：xiuxian_overview 看状态 → 行动/移动 → 循环，直到达成主人交办的目标，然后向主人汇报战果。',
      ].join('\n'),
    },
  );

  const who = () => clientLabel || '外部 Agent';
  const record = (action, ok, message) => {
    try { runner?.recordExternal({ client: who(), action, ok, message }); } catch { /* ignore */ }
  };

  // 检查 agent 是否存在
  const ensureAgent = () => {
    const agent = game.getAgent(getAgentId());
    if (!agent) return { error: '尚未创角，请先调用 xiuxian_create_character 创建角色。' };
    if (agent.dead) return { error: '已身殒，可用 xiuxian_reincarnate 转世重修。' };
    return null;
  };

  // 等待当前 Agent 行动完成
  async function waitForIdle(maxMs = 90000) {
    const t0 = Date.now();
    while (true) {
      const agent = game.getAgent(getAgentId());
      if (!agent) return { error: 'Agent 不存在' };
      if (agent.dead) return { dead: true };
      if (game.state.world.paused) return { paused: true };
      if (!agent.currentAction) return { done: true };
      if (Date.now() - t0 > maxMs) return { timeout: true };
      await sleep(250);
    }
  }

  // 行动启动 → 等待 → 取这段期间新增日志
  async function runAndAwait(fn, label) {
    const logLen = game.state.logs.length;
    let started;
    try { started = fn(); } catch (e) {
      record(label, false, e.message);
      return { ok: false, text: `✗ ${e.message}\n\n${stateText(game, getAgentId())}` };
    }
    const wait = await waitForIdle();
    const fresh = game.state.logs.slice(logLen).map((l) => l.text);
    record(label, true, fresh.join(' / ').slice(0, 60));
    let text = fresh.length ? fresh.join('\n') : `已执行：${label}`;
    if (wait.paused) text += '\n⚠ 时间处于静止（流速0），行动无法推进——可用 xiuxian_set_speed 恢复流速。';
    else if (wait.timeout) text += '\n⚠ 行动尚未完成（等待超时），可再次调用工具查看进度。';
    else if (wait.dead) text += '\n☠ 修士已身殒。';
    else if (wait.error) text += `\n✗ ${wait.error}`;
    return { ok: true, text: `${text}\n\n${stateText(game, getAgentId())}` };
  }

  const T = (text) => ({ content: [{ type: 'text', text }] });

  // ---------- 1. 总览 ----------
  server.registerTool('xiuxian_overview', {
    title: '修士总览',
    description: '查看当前完整状态：修士属性、资源、修为、所在地点、战斗/秘境情况、可用行动、可前往地点、神识感知到的其他修士。先调我，再决定做什么。',
  }, async () => {
    record('总览', true, '');
    return T(`${stateText(game, getAgentId())}\n【可行动】${actionsText(game, getAgentId())}\n【可前往】${areasText(game, getAgentId())}`);
  });

  // ---------- 2. 创角 ----------
  server.registerTool('xiuxian_create_character', {
    title: '踏入修行',
    description: '创建你的修士角色。道号1-12字；方向：sword剑修(攻伐)/pill丹修(疗伤)/array阵修(防御)；三项属性5-14，越高越好。',
    inputSchema: {
      name: z.string().min(1).max(12).describe('道号'),
      path: z.enum(['sword', 'pill', 'array']).describe('修炼方向'),
      body: z.number().int().min(5).max(14).optional().describe('体魄（生命与硬抗）'),
      comprehension: z.number().int().min(5).max(14).optional().describe('悟性（灵力与修炼效率）'),
      luck: z.number().int().min(4).max(13).optional().describe('气运（机缘与掉落）'),
    },
  }, async ({ name, path, body, comprehension, luck }) => {
    try {
      // 已有角色：切换提示（MCP 会话单角色操作，多角色请走 REST /characters）
      if (getAgentId() && game.getAgent(getAgentId())) {
        return T(`✗ 当前会话已有角色【${game.getAgent(getAgentId()).name}】。多角色管理请通过 REST API（/api/characters）切换。\n\n${stateText(game, getAgentId())}`);
      }
      // 懒建账号（2.0）
      if (!sess.accountId) {
        const acc = accounts.createAccount({ code: clientLabel });
        sess.accountId = acc.id;
      }
      const agent = accounts.createCharacter(sess.accountId, game.def.id, {
        name, path, body, comprehension, luck, clientLabel,
      });
      sess.agentId = agent.id;
      game.setAgentOnline(agent.id, null, clientLabel);
      runner?.updateConfig({ persona: name });
      record(`创角：${name}（${PATH_CN[path]}）`, true, '');
      return T(`${name} 踏入修行之路（${PATH_CN[path]}）。账号等级 ${accounts.getAccount(sess.accountId).level} 级。\n\n${stateText(game, getAgentId())}\n【可行动】${actionsText(game, getAgentId())}`);
    } catch (e) {
      record(`创角失败`, false, e.message);
      return T(`✗ ${e.message}`);
    }
  });

  // ---------- 3. 转世 ----------
  server.registerTool('xiuxian_reincarnate', {
    title: '转世重修',
    description: '身殒后转世重修：保留一半灵石，境界归零，修炼速度提升20%/世。',
  }, async () => {
    try {
      const agentId = getAgentId();
      game.reincarnateAgent(agentId);
      game.setAgentOnline(agentId, null, clientLabel);
      record('转世重修', true, '');
      return T(`天道有轮回，你已转世重修。\n\n${stateText(game, getAgentId())}`);
    } catch (e) {
      record(`转世失败`, false, e.message);
      return T(`✗ ${e.message}\n\n${stateText(game, getAgentId())}`);
    }
  });

  // ---------- 4. 通用行动 ----------
  server.registerTool('xiuxian_act', {
    title: '行动',
    description: '执行一项行动并等待完成：cultivate修炼(耗灵力5,涨修为)/rest休息(回复体力灵力)/collect采集(forest)/mine挖矿(mine)/fish赶海(river,beach)/ask请教(sect,mountain,耗灵石)/fortune探缘(event)/breakthrough突破境界(需圆满+丹药)。行动需在合适地点进行，不合适会报错。',
    inputSchema: {
      type: z.enum(['cultivate', 'rest', 'collect', 'mine', 'fish', 'ask', 'fortune', 'breakthrough']).describe('行动类型'),
    },
  }, async ({ type }) => {
    const err = ensureAgent();
    if (err) return T(err.error);
    const labels = { cultivate: '修炼', rest: '休息', collect: '采集', mine: '挖矿', fish: '赶海', ask: '请教', fortune: '探缘', breakthrough: '突破境界' };
    const res = await runAndAwait(() => game.startAction(getAgentId(), type), labels[type] || type);
    return T(res.text);
  });

  // ---------- 5. 移动 ----------
  server.registerTool('xiuxian_move', {
    title: '赶路',
    description: '前往相邻地点（只能走到相邻处，远途需多次调用）。地点id可用 xiuxian_overview 查看【可前往】列表。',
    inputSchema: { areaId: z.string().describe('目标地点 id') },
  }, async ({ areaId }) => {
    const err = ensureAgent();
    if (err) return T(err.error);
    const def = game.areaDef(areaId);
    if (!def) return T(`✗ 无此地点：${areaId}\n【可前往】${areasText(game, getAgentId())}`);
    const res = await runAndAwait(() => game.moveTo(getAgentId(), areaId), `前往${def.name}`);
    return T(res.text);
  });

  // ---------- 6. 战斗 ----------
  server.registerTool('xiuxian_combat', {
    title: '出手',
    description: '战斗行动（每回合一次）：attack普攻/defend防御(减伤+小回复)/skill技能(需skillIdx,耗灵力)/flee逃跑(约五成把握)。技能列表在总览的可用行动里（skill:N=技能名）。血量低先 defend 或 flee。',
    inputSchema: {
      action: z.enum(['attack', 'defend', 'skill', 'flee']).describe('战斗行动'),
      skillIdx: z.number().int().min(0).optional().describe('技能序号（action=skill 时必填）'),
    },
  }, async ({ action, skillIdx }) => {
    const err = ensureAgent();
    if (err) return T(err.error);
    try {
      const res = await game.combat(getAgentId(), action, skillIdx ?? 0);
      const r = res.result || {};
      record(`战斗·${action}${action === 'skill' ? ':' + (skillIdx ?? 0) : ''}`, true, r.message || '');
      let text = r.message || '交手一回合。';
      if (r.log?.length) text += `\n${r.log.slice(-4).join('\n')}`;
      if (r.victory) text += `\n⚔ 战斗胜利！${r.drops || ''}`;
      if (r.fled) text += '\n💨 遁走了。';
      text += `\n\n${stateText(game, getAgentId())}`;
      const agent = game.getAgent(getAgentId());
      if (agent?.combat && !agent.combat.ended) text += `\n【可行动】${actionsText(game, getAgentId())}`;
      return T(text);
    } catch (e) {
      record(`战斗·${action}`, false, e.message);
      return T(`✗ ${e.message}\n\n${stateText(game, getAgentId())}\n【可行动】${actionsText(game, getAgentId())}`);
    }
  });

  // ---------- 7. 秘境副本 ----------
  server.registerTool('xiuxian_dungeon', {
    title: '秘境',
    description: '副本操作：enter进入(需在秘境入口,给dungeonId)/explore探索本层(可能遇敌/宝箱/陷阱)/advance深入下一层(需本层已清)/exit退出副本。血量低于三成建议 exit。Boss在最后一层。',
    inputSchema: {
      action: z.enum(['enter', 'explore', 'advance', 'exit']).describe('副本操作'),
      dungeonId: z.string().optional().describe('副本 id（enter 时必填）'),
    },
  }, async ({ action, dungeonId }) => {
    const err = ensureAgent();
    if (err) return T(err.error);
    try {
      if (action === 'enter') {
        game.enterDungeonById(getAgentId(), dungeonId);
        record(`进入秘境:${dungeonId}`, true, '');
        return T(`踏入秘境。\n\n${stateText(game, getAgentId())}\n【可行动】${actionsText(game, getAgentId())}`);
      }
      const res = await game.dungeon(getAgentId(), action);
      const labels = { explore: '探索', advance: '深入', exit: '退出秘境' };
      const ev = res?.event;
      let text = ev?.text || `${labels[action]}完成。`;
      if (ev?.type === 'combat' || ev?.type === 'boss') text += `\n⚔ ${ev.enemy?.name || '强敌'}现身！请用 xiuxian_combat 应战。`;
      record(`秘境·${labels[action]}`, true, ev?.text?.slice(0, 40) || '');
      text += `\n\n${stateText(game, getAgentId())}\n【可行动】${actionsText(game, getAgentId())}`;
      return T(text);
    } catch (e) {
      record(`秘境·${action}`, false, e.message);
      return T(`✗ ${e.message}\n\n${stateText(game, getAgentId())}\n【可行动】${actionsText(game, getAgentId())}`);
    }
  });

  // ---------- 8. 坊市 ----------
  server.registerTool('xiuxian_shop', {
    title: '坊市',
    description: '集市买卖（需在 market 集市）：list看货架/buy购买/sell出售。突破丹药（筑基丹等）在此有售，修为将满时记得先买丹。',
    inputSchema: {
      action: z.enum(['list', 'buy', 'sell']).describe('坊市操作'),
      itemName: z.string().optional().describe('物品名（buy/sell 必填）'),
      count: z.number().int().min(1).max(99).optional().describe('数量，默认1'),
    },
  }, async ({ action, itemName, count }) => {
    const err = ensureAgent();
    if (err) return T(err.error);
    try {
      if (action === 'list') {
        const s = game.shopList(getAgentId());
        const buy = (s.items || []).map((i) => `${i.name}(${i.price}玉,${(i.desc || '').slice(0, 14)})`).join('; ');
        const sell = (s.sellable || []).map((i) => `${i.name}×${i.count}(${i.sell}玉)`).join('; ');
        record('坊市·看货', true, '');
        return T(`【在售】${buy || '空'}\n【可售】${sell || '背包无可售之物'}\n\n${stateText(game, getAgentId())}`);
      }
      const res = action === 'buy' ? game.buy(getAgentId(), itemName, count || 1) : game.sell(getAgentId(), itemName, count || 1);
      record(`坊市·${action === 'buy' ? '购' : '售'}${itemName}`, true, res.message || '');
      return T(`${res.message || '交易完成'}\n\n${stateText(game, getAgentId())}`);
    } catch (e) {
      record(`坊市·${action}`, false, e.message);
      return T(`✗ ${e.message}\n\n${stateText(game, getAgentId())}`);
    }
  });

  // ---------- 9. 服药 ----------
  server.registerTool('xiuxian_use_item', {
    title: '服药',
    description: '服用背包中的丹药：回血丹(回生命)/聚气丹(回灵力)/筑基丹(突破用,别乱吃)等。背包物品见总览。',
    inputSchema: { itemName: z.string().describe('物品名') },
  }, async ({ itemName }) => {
    const err = ensureAgent();
    if (err) return T(err.error);
    try {
      const res = game.useItem(getAgentId(), itemName);
      record(`服用${itemName}`, true, res.message || '');
      return T(`${res.message || `服下${itemName}`}。\n\n${stateText(game, getAgentId())}`);
    } catch (e) {
      record(`服用${itemName}`, false, e.message);
      return T(`✗ ${e.message}\n\n${stateText(game, getAgentId())}`);
    }
  });

  // ---------- 10. 神识探查 ----------
  server.registerTool('xiuxian_sense', {
    title: '神识探查',
    description: '以神识探查周围的修士。感知范围取决于你的境界——境界越高，神识越广。凡人只能感知同处一地者，大乘可感知全域。返回的修士列表包含其名号、境界、所在地、与你距离及在线状态。',
  }, async () => {
    const err = ensureAgent();
    if (err) return T(err.error);
    const nearby = game.senseNearby(getAgentId());
    record('神识探查', true, `${nearby.length}人`);
    if (!nearby.length) {
      const agent = game.getAgent(getAgentId());
      const range = game.senseRange(agent);
      return T(`【神识探查】神识铺展 ${range >= 9999 ? '全域' : range + ' 丈'}，未感知到其他修士。\n\n${stateText(game, getAgentId())}`);
    }
    const lines = nearby.map(a => {
      const loc = a.sameArea ? `同处【${a.areaName}】` : `距 ${a.distance} 丈（在${a.areaName}）`;
      const online = a.online ? ' ·元神在线' : ' ·元神离线';
      return `• 【${a.name}】${a.realmName} · ${a.pathName} · ${loc}${online} · ID:${a.id.slice(0, 8)}`;
    });
    return T(`【神识探查】感知到 ${nearby.length} 位修士：\n${lines.join('\n')}\n\n可用 xiuxian_talk 向其传音（需提供目标ID）。\n\n${stateText(game, getAgentId())}`);
  });

  // ---------- 11. 传音 ----------
  server.registerTool('xiuxian_talk', {
    title: '传音',
    description: '向神识范围内的修士传音交流。目标ID从 xiuxian_sense 获取。传音内容不超过200字。对方下次查看消息时能看到你的传音。',
    inputSchema: {
      targetId: z.string().describe('目标修士 ID（从 xiuxian_sense 获取，可用前8位匹配）'),
      text: z.string().max(200).describe('传音内容'),
    },
  }, async ({ targetId, text }) => {
    const err = ensureAgent();
    if (err) return T(err.error);
    try {
      // 支持前8位匹配
      const allAgents = game.allAgents();
      const target = allAgents.find(a => a.id === targetId) || allAgents.find(a => a.id.startsWith(targetId));
      if (!target) return T(`✗ 未找到 ID 为 ${targetId} 的修士。\n可用 xiuxian_sense 查看可传音的修士。`);
      const msg = game.converse(getAgentId(), target.id, text);
      record(`传音→${target.name}`, true, text.slice(0, 40));
      return T(`【传音】已向【${target.name}】（${msg.fromRealm}）传音：「${text}」\n\n${stateText(game, getAgentId())}`);
    } catch (e) {
      record(`传音失败`, false, e.message);
      return T(`✗ 传音失败：${e.message}\n\n${stateText(game, getAgentId())}`);
    }
  });

  // ---------- 12. 查看传音 ----------
  server.registerTool('xiuxian_messages', {
    title: '查看传音',
    description: '查看其他修士发给你的传音。调用后未读传音标记为已读。',
  }, async () => {
    const err = ensureAgent();
    if (err) return T(err.error);
    const convs = game.getConversations(getAgentId());
    game.markConversationsRead(getAgentId());
    record('查看传音', true, `${convs.length}条`);
    if (!convs.length) {
      return T(`【传音】暂无传音。\n\n${stateText(game, getAgentId())}`);
    }
    const lines = convs.map(m => {
      const time = new Date(m.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return `• [${time}] 【${m.fromName}】（${m.fromRealm}）：${m.text}`;
    });
    return T(`【传音】共 ${convs.length} 条：\n${lines.join('\n')}\n\n${stateText(game, getAgentId())}`);
  });

  // ---------- 13. 等待 ----------
  server.registerTool('xiuxian_wait', {
    title: '静候',
    description: '等待时间流逝：等当前行动完成，或纯粹等待若干秒（如等灵力自然恢复少量）。世界流速影响实际时长。',
    inputSchema: { seconds: z.number().min(1).max(300).optional().describe('最长等待秒数，默认30') },
  }, async ({ seconds }) => {
    const err = ensureAgent();
    if (err) return T(err.error);
    const maxMs = Math.min(300, seconds || 30) * 1000;
    const res = await waitForIdle(maxMs);
    let text = '静候片刻。';
    if (res.paused) text = '时间静止（流速0），无法等待。可用 xiuxian_set_speed 恢复。';
    else if (res.timeout) text = '仍在进行中……';
    else if (res.dead) text = '修士已身殒。';
    record('静候', true, '');
    return T(`${text}\n\n${stateText(game, getAgentId())}`);
  });

  // ---------- 14. 纪事 ----------
  server.registerTool('xiuxian_logs', {
    title: '翻阅纪事',
    description: '查看最近的世界纪事（奇遇、战斗、突破等经历），用于回顾与向主人汇报。',
    inputSchema: { count: z.number().int().min(1).max(50).optional().describe('条数，默认15') },
  }, async ({ count }) => {
    record('翻阅纪事', true, '');
    const n = Math.min(50, count || 15);
    const logs = game.state.logs.slice(-n);
    return T(logs.length ? logs.map((l) => `第${l.day}日 ${l.text}`).join('\n') : '尚无纪事。');
  });

  // ---------- 15. 时间流速 ----------
  server.registerTool('xiuxian_set_speed', {
    title: '时空法诀',
    description: '调整世界时间流速：0静止/1正常/2双倍/5五倍。挂机修炼可调快，精细操作调回1。此法诀影响全域时间。',
    inputSchema: { speed: z.enum(['0', '1', '2', '5']).describe('流速') },
  }, async ({ speed }) => {
    const sp = Number(speed);
    game.state.world.speed = sp;
    game.state.world.paused = sp === 0;
    game.addLog(sp === 0 ? '时间静止了。' : `时间流速调整为 ${sp} 倍。`, 'system');
    game.emit('update');
    game.markDirty();
    record(`时空法诀·${sp}倍`, true, '');
    return T(`时间流速已调为 ${sp} 倍。\n\n${stateText(game, getAgentId())}`);
  });

  return server;
}

// app.js — 上帝视角主控：多Agent状态同步 / 地图渲染 / 交互
(() => {
  'use strict';

  // ============ 工具 ============
  const $ = (id) => document.getElementById(id);
  const API = '/api';
  const S = {
    world: null,
    state: null,
    map: null,
    ws: null,
    wsOk: false,
    pollTimer: null,
    lastSig: '',
    selectedAgentId: null,
    selectedAreaId: null,
    btShown: {},
    mcpClients: 0,
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.APP = { S, api, toast, esc };

  async function api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  function toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = text;
    $('toast-wrap').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 2600);
  }

  const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  function cnNum(n) {
    n = Math.max(1, Math.floor(n));
    if (n <= 10) return CN_NUM[n];
    if (n < 20) return '十' + (n % 10 ? CN_NUM[n % 10] : '');
    if (n < 100) return CN_NUM[Math.floor(n / 10)] + '十' + (n % 10 ? CN_NUM[n % 10] : '');
    return String(n);
  }
  const AREA_TYPE_CN = {
    town: '城镇', forest: '森林', mine: '矿脉', river: '江河', market: '集市',
    sect: '宗门', mountain: '山脉', beach: '海滩', event: '奇缘', dungeon_entrance: '秘境入口',
  };
  const STATUS_CN = {
    idle: '闲适', busy: '行事', moving: '赶路', combat: '战斗', dungeon: '秘境', dead: '身殒', uncreated: '未生',
  };

  // ============ 启动 ============
  async function init() {
    try {
      const [worldRes, stateRes] = await Promise.all([
        api('GET', '/world'),
        api('GET', '/state'),
      ]);
      S.world = worldRes.world;
      S.state = stateRes;
      window.WORLD_DEF = S.world;
      initMap();
      bindUI();
      connectWS();
      renderAll(true);
      // 加载MCP信息
      loadMcpInfo();
    } catch (e) {
      document.body.insertAdjacentHTML('beforeend',
        `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#c9a961;font-size:15px;background:#0b0f15;z-index:999;text-align:center;line-height:2">无法连接服务端<br><small style="color:#6b6557">${esc(e.message)}</small></div>`);
    }
  }

  // ============ 地图 ============
  function initMap() {
    const def = { ...S.world, areas: S.world.areas, realms: S.world.realms };
    S.map = new InkMap($('map-canvas'), def, {
      onPick: (id) => pickArea(id),
      onPickAgent: (id) => selectAgent(id),
      realmIdx: 0,
    });
  }

  function updateMapAgents() {
    const st = S.state;
    if (!st || !S.map) return;
    const agents = (st.agents || []).map(a => ({
      id: a.id, name: a.name, color: a.color, online: a.online,
      areaId: a.areaId, dead: a.dead,
    }));
    S.map.setState({
      agents,
      areaPop: st.areaPop || {},
      selectedAgentId: S.selectedAgentId,
      realmIdx: Math.max(0, ...(st.agents || []).map(a => a.realmIdx)),
    });
  }

  // ============ 区域点击 ============
  function pickArea(id) {
    const st = S.state;
    const area = S.world.areas.find((a) => a.id === id);
    if (!area || !st?.created) return;
    S.selectedAreaId = id;
    const agentsHere = (st.agents || []).filter(a => a.areaId === id && !a.dead);
    $('mp-name').textContent = area.name;
    $('mp-type').textContent = AREA_TYPE_CN[area.type] || area.type;
    $('mp-desc').textContent = area.desc || '';
    const agentsBox = $('mp-agents');
    if (agentsHere.length) {
      agentsBox.innerHTML = agentsHere.map(a => `
        <div class="mp-agent" data-agent="${esc(a.id)}">
          <span class="mp-agent-dot" style="background:${a.color};${a.online ? '' : 'opacity:0.4'}"></span>
          <span class="mp-agent-name">${esc(a.name)}</span>
          <span class="mp-agent-realm">${esc(a.realmName)}</span>
          <span class="mp-agent-status ${a.online ? 'on' : 'off'}">${a.online ? '在线' : '离线'}</span>
        </div>`).join('');
      agentsBox.querySelectorAll('.mp-agent').forEach(el => {
        el.addEventListener('click', () => {
          selectAgent(el.dataset.agent);
          hidePopup();
        });
      });
    } else {
      agentsBox.innerHTML = '<div class="mp-agent-empty">此地无人</div>';
    }
    const pop = $('map-popup');
    pop.classList.remove('hidden');
    pop.style.left = 'auto'; pop.style.right = '14px'; pop.style.top = '14px';
  }
  function hidePopup() { $('map-popup').classList.add('hidden'); }

  // ============ Agent选择 ============
  function selectAgent(id) {
    S.selectedAgentId = id;
    renderDetail();
    updateMapAgents();
    // 滚动名册到选中项
    const el = document.querySelector(`.agent-card[data-id="${id}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ============ UI绑定 ============
  function bindUI() {
    $('mp-close').addEventListener('click', hidePopup);
    $('speed-group').querySelectorAll('.speed-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        const sp = +b.dataset.speed;
        try {
          await api('POST', '/game/speed', { speed: sp });
          setSpeedUI(sp);
        } catch (e) { toast(e.message, 'bad'); }
      });
    });
    $('reset-btn').addEventListener('click', async () => {
      if (!confirm('轮回重开将清空存档，一切从头再来。确定？')) return;
      try { await api('POST', '/reset'); location.reload(); }
      catch (e) { toast(e.message, 'bad'); }
    });
    $('mcp-badge').addEventListener('click', () => {
      $('agent-overlay').classList.remove('hidden');
    });
    $('agent-close').addEventListener('click', () => $('agent-overlay').classList.add('hidden'));
    document.querySelectorAll('.copy-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        const target = $(b.dataset.copy);
        if (target) {
          const text = target.textContent;
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            // Fallback
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
          }
          b.classList.add('copied');
          b.textContent = '已复制';
          setTimeout(() => { b.classList.remove('copied'); b.textContent = '复制'; }, 1500);
        }
      });
    });
  }

  function setSpeedUI(sp) {
    $('speed-group').querySelectorAll('.speed-btn').forEach((b) => {
      b.classList.toggle('active', +b.dataset.speed === sp);
    });
  }

  // ============ WebSocket ============
  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      S.ws = ws;
      ws.onopen = () => { S.wsOk = true; stopPolling(); };
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'state') applyState(msg.data);
        else if (msg.type === 'log') appendLog(msg.data);
        else if (msg.type === 'agent-chat') appendAgentChat(msg.data);
      };
      ws.onclose = () => { S.wsOk = false; startPolling(); setTimeout(connectWS, 3000); };
      ws.onerror = () => { try { ws.close(); } catch {} };
    } catch { startPolling(); }
  }
  function startPolling() {
    if (S.pollTimer || S.wsOk) return;
    S.pollTimer = setInterval(refreshState, 2500);
  }
  function stopPolling() { if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; } }

  async function refreshState() {
    try {
      const res = await api('GET', '/state');
      applyState(res);
    } catch { /* 断线由 WS 重连处理 */ }
  }

  // ============ 状态应用 ============
  function applyState(st) {
    if (!st) return;
    const prev = S.state;
    S.state = st;

    // 突破特效检测
    if (prev && prev.agents && st.agents) {
      for (const a of st.agents) {
        const old = prev.agents.find(x => x.id === a.id);
        if (old && a.realmIdx > old.realmIdx && !S.btShown[a.id]) {
          showBreakthrough(a.realmName, a.name);
          S.btShown[a.id] = true;
        }
      }
    }

    // 轻量diff
    const sig = JSON.stringify({
      a: (st.agents || []).map(a => [a.id, a.status, a.areaId, a.realmIdx, Math.floor(a.hp), a.online, a.unreadMessages]),
      w: st.world ? [st.world.gameDay, st.world.speed] : [],
      ap: st.areaPop,
    });
    if (sig !== S.lastSig) {
      S.lastSig = sig;
      renderAll();
    }
    setSpeedUI(st.world?.speed ?? 1);
    updateMapAgents();
    // 实时更新在线Agent计数
    const onlineCount = (st.agents || []).filter(a => a.online && !a.dead).length;
    if (onlineCount !== S.mcpClients) updateMcpBadge(onlineCount);
    // 更新MCP面板的接入列表
    updateMcpLive(st.agents || []);
  }

  function updateMcpLive(agents) {
    const live = $('mcp-live');
    const clients = $('mcp-clients');
    if (!live || !clients) return;
    const online = agents.filter(a => a.online && !a.dead);
    if (online.length) {
      live.classList.add('online');
      clients.textContent = `${online.length} 位修士元神在线：${online.map(a => a.name).join('、')}`;
    } else {
      live.classList.remove('online');
      clients.textContent = '尚无 Agent 驾临';
    }
  }

  function showBreakthrough(realmName, agentName) {
    $('bt-realm').textContent = realmName;
    $('bt-agent').textContent = agentName ? `· ${agentName} ·` : '';
    const ov = $('breakthrough-overlay');
    ov.classList.remove('hidden');
    setTimeout(() => ov.classList.add('hidden'), 2800);
  }

  // ============ 渲染 ============
  function renderAll(force = false) {
    const st = S.state;
    if (!st?.created) return;
    renderAgentList();
    renderTime();
    renderLogs();
    renderDetail();
    updateMapAgents();
  }

  // ---------- 修士名册 ----------
  function renderAgentList() {
    const st = S.state;
    const agents = st.agents || [];
    const box = $('agent-list');
    $('agent-count').textContent = agents.length;
    if (!agents.length) {
      box.innerHTML = '<div class="agent-list-empty">天地静候修士踏入</div>';
      return;
    }
    // 在线排前
    const sorted = [...agents].sort((a, b) => {
      if (a.online !== b.online) return b.online - a.online;
      if (a.dead !== b.dead) return a.dead - b.dead;
      return b.realmIdx - a.realmIdx;
    });
    box.innerHTML = sorted.map(a => {
      const isSel = a.id === S.selectedAgentId;
      const statusCN = STATUS_CN[a.status] || a.status;
      const deadClass = a.dead ? ' dead' : '';
      const onlineClass = a.online ? ' online' : '';
      const selClass = isSel ? ' selected' : '';
      const actText = a.currentAction ? a.currentAction.label : '';
      const unread = a.unreadMessages > 0 ? `<span class="agent-unread">${a.unreadMessages}</span>` : '';
      return `<div class="agent-card${deadClass}${onlineClass}${selClass}" data-id="${esc(a.id)}">
        <div class="agent-card-left">
          <span class="agent-dot" style="background:${a.color};${a.online ? '' : 'opacity:0.35'}"></span>
          <div class="agent-info">
            <div class="agent-card-name">${esc(a.name)}</div>
            <div class="agent-card-sub">${esc(a.realmName)} · ${esc(a.pathName)}</div>
            ${actText ? `<div class="agent-card-act">${esc(actText)}</div>` : ''}
          </div>
        </div>
        <div class="agent-card-right">
          ${unread}
          <span class="agent-card-status">${a.dead ? '殒' : statusCN}</span>
        </div>
      </div>`;
    }).join('');
    box.querySelectorAll('.agent-card').forEach(el => {
      el.addEventListener('click', () => selectAgent(el.dataset.id));
    });
  }

  // ---------- 时间 ----------
  function renderTime() {
    const w = S.state.world;
    if (!w) return;
    const dayInSeason = ((w.dayOfYear - 1) % 90) + 1;
    $('time-main').textContent = `第${cnNum(w.gameYear)}年 ${w.season} · 第${cnNum(dayInSeason)}日 · ${w.shichen}`;
    const onlineCount = (S.state.agents || []).filter(a => a.online && !a.dead).length;
    const totalCount = (S.state.agents || []).filter(a => !a.dead).length;
    $('time-sub').textContent = `${onlineCount} 修士在线 / ${totalCount} 在世` + (w.speed === 0 ? ' · 时间静止' : '');
  }

  // ---------- 纪事 ----------
  function renderLogs() {
    const pane = $('pane-logs');
    pane.innerHTML = '';
    (S.state.recentLogs || []).forEach((l) => appendLog(l, true));
  }
  function appendLog(entry, silent = false) {
    const pane = $('pane-logs');
    if (!entry?.text) return;
    const el = document.createElement('div');
    el.className = `log-line ${entry.type || 'system'}`;
    el.innerHTML = `<span class="log-day">第${entry.day ?? '?'}日</span>${esc(entry.text)}`;
    pane.appendChild(el);
    while (pane.children.length > 80) pane.firstChild.remove();
    const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
    if (nearBottom || silent) pane.scrollTop = pane.scrollHeight;
  }

  function appendAgentChat(ev) {
    // 传音事件在纪事中显示
    appendLog({ day: Math.floor(S.state.world?.gameDay || 0), text: `【${ev.from}】向【${ev.to}】传音：${ev.text}`, type: 'agent' });
  }

  // ---------- 修士详情 ----------
  function renderDetail() {
    const st = S.state;
    if (!st?.agents?.length) return;
    const a = st.agents.find(x => x.id === S.selectedAgentId) || st.agents[0];
    if (!a) {
      $('detail-empty').classList.remove('hidden');
      $('detail-content').classList.add('hidden');
      return;
    }
    S.selectedAgentId = a.id;
    $('detail-empty').classList.add('hidden');
    $('detail-content').classList.remove('hidden');

    $('detail-color-dot').style.background = a.color;
    $('detail-name').textContent = a.name;
    $('detail-realm').textContent = `${a.realmName} · ${a.pathName}`;
    const statusCN = STATUS_CN[a.status] || a.status;
    const badge = $('detail-status-badge');
    badge.textContent = a.dead ? '身殒' : (a.online ? `在线 · ${statusCN}` : `离线 · ${statusCN}`);
    badge.className = `char-status-badge ${a.dead ? 'dead' : a.online ? 'online' : 'offline'}`;

    // 属性条
    const barFill = (id, cur, max) => {
      $(`detail-bar-${id}`).style.width = `${Math.max(0, Math.min(100, (cur / (max || 1)) * 100))}%`;
      $(`detail-bar-${id}-text`).textContent = `${Math.floor(cur)} / ${max}`;
    };
    barFill('hp', a.hp, a.maxHp);
    barFill('spirit', a.spirit, a.maxSpirit);
    barFill('stamina', a.stamina, a.maxStamina);
    barFill('cult', a.cultivation, a.cultivationMax);

    // 属性
    $('detail-body').textContent = a.body;
    $('detail-comp').textContent = a.comprehension;
    $('detail-luck').textContent = a.luck;
    $('detail-age').textContent = `${a.age} / ${a.lifespan}岁`;

    // 灵石
    $('detail-stones').textContent = a.spiritStones;
    $('detail-kills').textContent = `斩妖 ${a.kills} · 秘境 ${a.dungeonsCleared}`;

    // 所在地 + 行动
    const infoRow = $('detail-info-row');
    let infoHtml = `<div class="detail-info-item"><span class="di-k">所在</span><span class="di-v">${esc(a.areaName)}</span></div>`;
    if (a.currentAction) {
      const pct = Math.floor((a.currentAction.progress || 0) * 100);
      infoHtml += `<div class="detail-info-item"><span class="di-k">行事</span><span class="di-v">${esc(a.currentAction.label)} ${pct}%</span></div>`;
    }
    if (a.inCombat) infoHtml += `<div class="detail-info-item"><span class="di-k">状态</span><span class="di-v" style="color:var(--cinnabar-bright)">战斗中</span></div>`;
    if (a.inDungeon) infoHtml += `<div class="detail-info-item"><span class="di-k">状态</span><span class="di-v" style="color:var(--purple)">秘境中</span></div>`;
    infoRow.innerHTML = infoHtml;

    // 乾坤袋
    const inv = a.inventory || [];
    const invBox = $('detail-inventory');
    if (!inv.length) {
      invBox.innerHTML = '<div class="inv-empty">空空如也</div>';
    } else {
      invBox.innerHTML = inv.map(i => {
        const def = S.world.items?.[i.name] || {};
        return `<div class="inv-item" title="${esc(def.desc || '')}">
          <span class="inv-name">${esc(i.name)}</span>
          <span class="inv-count">×${i.count}</span>
        </div>`;
      }).join('');
    }

    // 神识
    const sense = $('detail-sense');
    const range = a.senseRange;
    const rangeText = range >= 9999 ? '全域' : `${range} 丈`;
    const unread = a.unreadMessages || 0;
    sense.innerHTML = `<div class="sense-item"><span class="si-k">神识范围</span><span class="si-v">${rangeText}</span></div>
      <div class="sense-item"><span class="si-k">未读传音</span><span class="si-v">${unread} 条</span></div>
      <div class="sense-item"><span class="si-k">接入方式</span><span class="si-v">${esc(a.clientLabel || '未知')}</span></div>`;
  }

  // ============ MCP 信息 ============
  async function loadMcpInfo() {
    try {
      const res = await api('GET', '/mcp/info');
      $('mcp-cmd-claude').textContent = res.commands.claude;
      $('mcp-cmd-codex').textContent = res.commands.codex;
      updateMcpBadge(res.sessions?.sessions || 0);
    } catch { /* ignore */ }
  }

  function updateMcpBadge(count) {
    S.mcpClients = count;
    const badge = $('mcp-badge');
    const text = $('mcp-badge-text');
    if (count > 0) {
      badge.classList.remove('offline');
      badge.classList.add('online');
      text.textContent = `${count} 位元神接入`;
    } else {
      badge.classList.remove('online');
      badge.classList.add('offline');
      text.textContent = '无元神接入';
    }
  }

  // ============ 启动 ============
  document.addEventListener('DOMContentLoaded', init);
})();

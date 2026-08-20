// agent.js — 元神接入：外部 Agent（MCP）/ 托管元神（内置·云端）/ 道心（决策流）/ 传音（对话）
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const { S, api, toast, esc } = window.APP;

  const PROVIDERS = {
    builtin: { label: '内置灵智', needUrl: false, needKey: false, url: '', model: '' },
    claude: { label: 'Claude', needUrl: true, needKey: true, url: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
    openai: { label: 'OpenAI 兼容', needUrl: true, needKey: true, url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    ollama: { label: 'Ollama', needUrl: true, needKey: false, url: 'http://localhost:11434', model: 'qwen2.5:7b' },
  };

  let curProvider = 'builtin';
  let status = null;
  let mcpInfo = null;
  let mcpRefreshTimer = null;

  // ============ 初始化 ============
  async function init() {
    bindOverlay();
    bindTabs();
    await loadStatus();
    await loadMcpInfo();
  }

  async function loadStatus() {
    try {
      const res = await api('GET', '/agent/status');
      setStatus(res);
    } catch (e) { console.warn('[agent] loadStatus failed:', e); }
  }

  async function loadMcpInfo() {
    try {
      const res = await api('GET', '/mcp/info');
      mcpInfo = res;
      renderMcpInfo();
    } catch (e) { console.warn('[agent] loadMcpInfo failed:', e); }
  }

  function renderMcpInfo() {
    if (!mcpInfo) return;
    $('mcp-cmd-claude').textContent = mcpInfo.commands?.claude || '';
    $('mcp-cmd-codex').textContent = mcpInfo.commands?.codex || '';
    renderMcpClients(mcpInfo.clients || []);
  }

  function renderMcpClients(clients) {
    const live = $('mcp-live');
    const el = $('mcp-clients');
    if (clients.length) {
      live.classList.add('online');
      el.textContent = `${clients.map((c) => `【${c.name}】`).join('')} 驾临此界 · 操作实时显示于「道心」`;
    } else {
      live.classList.remove('online');
      el.textContent = '尚无 Agent 驾临 —— 复制下方命令接入 Claude Code / Codex';
    }
    updateBadge();
  }

  function setStatus(st) {
    status = st;
    updateBadge();
    // 用历史决策与传音填充面板
    if (st.decisions?.length) {
      st.decisions.forEach((d) => appendDecision(d, true));
    }
    if (st.chat?.length) {
      $('chat-feed').innerHTML = '';
      st.chat.forEach((m) => appendChat(m, true));
    }
    fillForm(st);
    updateStatusLine();
    renderMcpClients(mcpInfo?.clients?.length ? mcpInfo.clients : (st.mcp || []));
  }

  // 取最新鲜的外部 Agent 连接列表（mcpInfo 由定时刷新，优先）
  function extClients() {
    if (mcpInfo?.clients?.length) return mcpInfo.clients;
    return status?.mcp || [];
  }

  function updateBadge() {
    const badge = $('agent-badge');
    const text = $('agent-badge-text');
    const ext = extClients();
    badge.classList.remove('online', 'builtin', 'external', 'offline');
    if (ext.length) {
      badge.classList.add('external');
      text.textContent = `${ext[0].name} · 驾临`;
    } else if (status?.running) {
      badge.classList.add(status.provider === 'builtin' ? 'builtin' : 'online');
      text.textContent = `${PROVIDERS[status.provider]?.label || status.provider} · 运转中`;
    } else {
      text.textContent = '元神未接';
    }
  }

  // ============ 配置面板 ============
  function bindOverlay() {
    $('agent-badge').addEventListener('click', () => {
      $('agent-overlay').classList.remove('hidden');
      loadStatus();
      loadMcpInfo();
    });
    $('agent-close').addEventListener('click', () => $('agent-overlay').classList.add('hidden'));
    $('agent-overlay').addEventListener('click', (e) => {
      if (e.target === $('agent-overlay')) $('agent-overlay').classList.add('hidden');
    });

    // 复制接入命令
    document.querySelectorAll('.copy-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        const src = $(b.dataset.copy);
        if (!src?.textContent) return;
        try {
          await navigator.clipboard.writeText(src.textContent);
        } catch {
          // 兼容：降级选中复制
          const range = document.createRange();
          range.selectNodeContents(src);
          const sel = getSelection();
          sel.removeAllRanges(); sel.addRange(range);
          document.execCommand('copy'); sel.removeAllRanges();
        }
        const old = b.textContent;
        b.textContent = '已抄录';
        b.classList.add('copied');
        setTimeout(() => { b.textContent = old; b.classList.remove('copied'); }, 1400);
      });
    });

    document.querySelectorAll('.provider-card').forEach((c) => {
      c.addEventListener('click', () => {
        document.querySelectorAll('.provider-card').forEach((x) => x.classList.remove('active'));
        c.classList.add('active');
        curProvider = c.dataset.p;
        applyProviderForm(curProvider);
      });
    });

    $('agent-interval').addEventListener('input', (e) => {
      $('interval-val').textContent = `${e.target.value} 秒`;
    });

    $('prompt-toggle').addEventListener('click', () => {
      $('agent-prompt').classList.toggle('hidden');
    });

    $('agent-save').addEventListener('click', saveConfig);
    $('agent-toggle-run').addEventListener('click', toggleRun);

    // 面板打开时周期刷新 MCP 连接状态
    mcpRefreshTimer = setInterval(() => {
      if (!$('agent-overlay').classList.contains('hidden')) loadMcpInfo();
    }, 5000);
  }

  function applyProviderForm(p) {
    const cfg = PROVIDERS[p];
    $('row-baseurl').style.display = cfg.needUrl ? '' : 'none';
    $('row-apikey').style.display = cfg.needKey ? '' : 'none';
    $('row-model').style.display = cfg.needUrl ? '' : 'none';
    // 仅在切换且当前值为空或属于其他提供商默认值时填默认
    if (cfg.needUrl) {
      if (!$('agent-baseurl').value || Object.values(PROVIDERS).some((x) => x.url === $('agent-baseurl').value)) {
        $('agent-baseurl').value = cfg.url;
      }
      if (!$('agent-model').value || Object.values(PROVIDERS).some((x) => x.model === $('agent-model').value)) {
        $('agent-model').value = cfg.model;
      }
    }
  }

  function fillForm(st) {
    if (!st) return;
    curProvider = st.provider || 'builtin';
    document.querySelectorAll('.provider-card').forEach((x) => x.classList.toggle('active', x.dataset.p === curProvider));
    applyProviderForm(curProvider);
    $('agent-baseurl').value = st.baseUrl || '';
    $('agent-model').value = st.model || '';
    $('agent-apikey').value = '';
    $('agent-apikey').placeholder = st.hasKey ? `已存密钥 ${st.keyHint}（留空保持不变）` : 'sk-...';
    $('agent-interval').value = st.intervalSec || 12;
    $('interval-val').textContent = `${st.intervalSec || 12} 秒`;
    $('agent-prompt').value = st.systemPrompt || '';
    $('agent-toggle-run').textContent = st.running ? '停 止 元 神' : '启 动 元 神';
  }

  async function saveConfig() {
    const patch = collectForm();
    try {
      const res = await api('POST', '/agent/config', patch);
      status = { ...status, ...res.config };
      updateBadge();
      updateStatusLine();
      toast('配置已保存', 'good');
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function toggleRun() {
    try {
      if (status?.running) {
        const res = await api('POST', '/agent/stop');
        status = { ...status, running: false };
        toast(res.message || '元神已下线');
      } else {
        await saveConfigQuiet();
        const res = await api('POST', '/agent/start');
        status = { ...status, running: true };
        toast(res.message || '元神已启动', 'good');
      }
      $('agent-toggle-run').textContent = status?.running ? '停 止 元 神' : '启 动 元 神';
      updateBadge();
      updateStatusLine();
    } catch (e) {
      toast(e.message, 'bad');
      updateStatusLine();
    }
  }

  function collectForm() {
    const patch = {
      provider: curProvider,
      baseUrl: $('agent-baseurl').value.trim(),
      model: $('agent-model').value.trim(),
      intervalSec: +$('agent-interval').value,
      systemPrompt: $('agent-prompt').value,
    };
    if ($('agent-apikey').value.trim()) patch.apiKey = $('agent-apikey').value.trim();
    return patch;
  }

  async function saveConfigQuiet() {
    try { await api('POST', '/agent/config', collectForm()); } catch { /* 启动时会再报错 */ }
  }

  function updateStatusLine() {
    const line = $('agent-status-line');
    if (!line) return;
    const ext = extClients();
    let html = '';
    if (ext.length) {
      html = `<span class="ok">外部 Agent 在场：${ext.map((c) => esc(c.name)).join('、')}（MCP）</span>`;
    }
    if (status?.lastError) {
      html += `<span class="err">托管元神最近出错：${esc(status.lastError)}</span>`;
    } else if (status?.running) {
      html += `<span class="ok">${esc(PROVIDERS[status.provider]?.label || status.provider)} 运转中 · 每 ${status.intervalSec} 秒决策一次${status.lastTickAt ? ` · 上次决策 ${new Date(status.lastTickAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}</span>`;
    }
    line.innerHTML = html;
  }

  // ============ 道心（决策流） ============
  function bindTabs() { /* 标签切换已由 app.js 处理 */ }

  function appendDecision(d, silent = false) {
    const feed = $('mind-feed');
    $('mind-empty')?.classList.add('hidden');
    const el = document.createElement('div');
    el.className = 'mind-card' + (d.external ? ' external' : '');
    const time = new Date(d.t || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
    const actLabel = d.action?.startsWith('MOVE_TO:') ? `寻路 → ${esc(d.action.slice(8))}`
      : d.action?.startsWith('BUY:') ? `购买【${esc(d.action.slice(4))}】`
      : d.action?.startsWith('USE_PILL:') ? `服用【${esc(d.action.slice(9))}】`
      : esc(d.action || '?');
    el.innerHTML = `
      <div class="mind-action">▸ ${actLabel}${d.ok === false ? `<span class="fail">✗ ${esc(d.message || '失败')}</span>` : (d.ok && d.message ? `<span class="succ">${esc(d.message.slice(0, 40))}</span>` : '')}</div>
      ${d.say ? `<div class="mind-say">“${esc(d.say)}”</div>` : ''}
      <div class="mind-meta"><span>${esc(d.area || '')}${d.status ? ' · ' + esc(d.status) : ''}</span><span>${esc(d.provider || '')} ${time}</span></div>`;
    feed.appendChild(el);
    while (feed.children.length > 60) feed.firstChild.remove();
    const pane = $('pane-mind');
    const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
    if (nearBottom || silent) pane.scrollTop = pane.scrollHeight;
  }

  function appendStatusLine(text, isErr = false) {
    const feed = $('mind-feed');
    $('mind-empty')?.classList.add('hidden');
    const el = document.createElement('div');
    el.className = 'mind-card';
    el.innerHTML = `<div class="mind-action" style="${isErr ? 'color:var(--cinnabar-bright)' : 'color:var(--gold)'}">◆ ${esc(text)}</div>`;
    feed.appendChild(el);
    while (feed.children.length > 60) feed.firstChild.remove();
    $('pane-mind').scrollTop = $('pane-mind').scrollHeight;
  }

  // ============ 传音 ============
  function appendChat(m, silent = false) {
    const feed = $('chat-feed');
    // 移除首条系统提示（真实对话开始后）
    const sys = feed.querySelector('.chat-sys');
    if (sys && feed.children.length > 1) sys.remove();
    const el = document.createElement('div');
    const who = m.role === 'player' ? '道友（你）' : (S.state?.agent?.name || '修士');
    el.className = `bubble ${m.role === 'player' ? 'player' : 'agent'}`;
    el.innerHTML = `<div class="b-who">${esc(who)}</div>${esc(m.text)}`;
    feed.appendChild(el);
    while (feed.children.length > 60) feed.firstChild.remove();
    const pane = $('pane-chat');
    const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
    if (nearBottom || silent) pane.scrollTop = pane.scrollHeight;
  }

  // ============ WS 事件入口 ============
  function onAgentEvent(msg) {
    const ev = msg.data || {};
    const kind = ev.kind || msg.kind;
    if (kind === 'decision') {
      appendDecision(ev);
      status && (status.lastTickAt = ev.t);
      updateStatusLine();
    } else if (kind === 'chat') {
      appendChat(ev);
    } else if (kind === 'error') {
      appendStatusLine(ev.text, true);
      if (status) status.lastError = ev.text;
      updateStatusLine();
    } else if (kind === 'status') {
      // 两种：连接时的全量 status 或运行状态变化
      if (ev.running !== undefined) {
        status = { ...status, ...ev };
        updateBadge();
        $('agent-toggle-run').textContent = ev.running ? '停 止 元 神' : '启 动 元 神';
      } else if (ev.text) {
        appendStatusLine(ev.text);
        // MCP 驾临/离场 → 刷新连接状态
        loadMcpInfo();
      }
    }
  }

  window.AGENT_UI = { init, onAgentEvent, appendChat, appendDecision };
})();

// map.js — 水墨大地图：Canvas 渲染 / 拖拽平移 / 滚轮缩放 / 点击地点
// 依赖全局：window.WORLD_DEF（由 app.js 在加载世界后注入），MapUI 挂载到 window

class InkMap {
  constructor(canvas, worldDef, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.def = worldDef;
    this.onPick = opts.onPick || (() => {});
    this.onPickAgent = opts.onPickAgent || (() => {});
    this.realmIdx = opts.realmIdx ?? 0;
    this.currentAreaId = opts.currentAreaId ?? null;
    this.unlockedIds = opts.unlockedIds || null;
    this.agents = [];       // 多Agent标记数据
    this.areaPop = {};      // 区域人口
    this.selectedAgentId = null;

    // 视图变换
    this.scale = 1;
    this.minScale = 0.85;
    this.maxScale = 3.2;
    this.offsetX = 0;
    this.offsetY = 0;
    this.dragging = false;
    this.dragMoved = false;
    this.lastPt = null;
    this.hoverId = null;
    this.hoverAgentId = null;
    this.pulse = 0;
    this._agentMarkers = []; // 屏幕坐标缓存，用于点击检测

    this._bindEvents();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  setWorld(def) { this.def = def; }
  setState({ realmIdx, currentAreaId, unlockedIds, agents, areaPop, selectedAgentId }) {
    if (realmIdx !== undefined) this.realmIdx = realmIdx;
    if (currentAreaId !== undefined) this.currentAreaId = currentAreaId;
    if (unlockedIds !== undefined) this.unlockedIds = unlockedIds;
    if (agents !== undefined) this.agents = agents;
    if (areaPop !== undefined) this.areaPop = areaPop;
    if (selectedAgentId !== undefined) this.selectedAgentId = selectedAgentId;
  }

  // ---------- 事件 ----------
  _bindEvents() {
    const cv = this.canvas;
    cv.addEventListener('mousedown', (e) => {
      this.dragging = true;
      this.dragMoved = false;
      this.lastPt = { x: e.clientX, y: e.clientY };
      cv.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
      if (this.dragging) {
        const dx = e.clientX - this.lastPt.x;
        const dy = e.clientY - this.lastPt.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.dragMoved = true;
        this.offsetX += dx;
        this.offsetY += dy;
        this.lastPt = { x: e.clientX, y: e.clientY };
      } else {
        // 悬停检测：优先Agent标记
        const rect = cv.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;
        const agentHit = this._hitTestAgent(px, py);
        const areaHit = agentHit ? null : this._hitTest(px, py);
        this.hoverId = areaHit ? areaHit.id : null;
        this.hoverAgentId = agentHit ? agentHit.id : null;
        cv.style.cursor = (agentHit || areaHit) ? 'pointer' : 'grab';
      }
    });
    window.addEventListener('mouseup', () => {
      if (this.dragging) {
        this.dragging = false;
        this.canvas.style.cursor = 'grab';
      }
    });
    cv.addEventListener('mouseleave', () => { this.hoverId = null; this.hoverAgentId = null; });
    cv.addEventListener('click', (e) => {
      if (this.dragMoved) return;
      const rect = cv.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      // 优先点击Agent标记
      const agentHit = this._hitTestAgent(px, py);
      if (agentHit) { this.onPickAgent(agentHit.id); return; }
      const hit = this._hitTest(px, py);
      if (hit) this.onPick(hit.id);
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const ns = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
      // 以指针为中心缩放
      const rect = cv.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const k = ns / this.scale;
      this.offsetX = mx - (mx - this.offsetX) * k;
      this.offsetY = my - (my - this.offsetY) * k;
      this.scale = ns;
    }, { passive: false });
  }

  // 与 _draw 完全一致的世界→屏幕变换
  _viewTransform() {
    const map = this.def.map;
    const baseScale = Math.min(this.vw / map.width, this.vh / map.height) * 0.96;
    const s = baseScale * this.scale;
    const cx = this.vw / 2 + this.offsetX;
    const cy = this.vh / 2 + this.offsetY;
    return { s, cx, cy, hw: map.width / 2, hh: map.height / 2 };
  }

  worldToScreen(wx, wy) {
    const { s, cx, cy, hw, hh } = this._viewTransform();
    return { x: cx + s * (wx - hw), y: cy + s * (wy - hh) };
  }

  _hitTest(px, py) {
    if (!this.def) return null;
    for (const a of this.def.areas) {
      const p = this.worldToScreen(a.x, a.y);
      const r = 9 + 12 * this.scale;
      const dx = px - p.x, dy = py - p.y;
      if (dx * dx + dy * dy < r * r) return a;
    }
    return null;
  }

  _hitTestAgent(px, py) {
    for (const m of this._agentMarkers) {
      const dx = px - m.sx, dy = py - m.sy;
      const r = m.r + 4;
      if (dx * dx + dy * dy < r * r) return { id: m.id };
    }
    return null;
  }

  // ---------- 绘制循环 ----------
  _loop() {
    this.pulse += 0.03;
    this._resize();
    this._draw();
    requestAnimationFrame(this._loop);
  }

  _resize() {
    const cv = this.canvas;
    const parent = cv.parentElement;
    const w = parent.clientWidth, h = parent.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr;
      cv.height = h * dpr;
      cv.style.width = w + 'px';
      cv.style.height = h + 'px';
    }
    this.dpr = dpr;
    this.vw = w;
    this.vh = h;
  }

  _draw() {
    const ctx = this.ctx, dpr = this.dpr;
    if (!this.def) return;
    const map = this.def.map;
    const baseScale = Math.min(this.vw / map.width, this.vh / map.height) * 0.96;
    const s = baseScale * this.scale;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 海面底色
    const g = ctx.createLinearGradient(0, 0, 0, this.vh);
    g.addColorStop(0, '#0a1017');
    g.addColorStop(1, '#070b10');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.vw, this.vh);

    // 居中偏移
    const cx = this.vw / 2 + this.offsetX;
    const cy = this.vh / 2 + this.offsetY;
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.translate(-map.width / 2, -map.height / 2);

    // 大陆
    for (const c of map.continents) {
      ctx.beginPath();
      const poly = c.polygon;
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
      ctx.closePath();
      const cg = ctx.createLinearGradient(0, 100, 0, 700);
      cg.addColorStop(0, c.color);
      cg.addColorStop(1, '#0c1016');
      ctx.fillStyle = cg;
      ctx.fill();
      // 岸线光晕（多层描边模拟水墨晕染）
      ctx.strokeStyle = 'rgba(201,169,97,0.06)';
      ctx.lineWidth = 10 / s;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(201,169,97,0.30)';
      ctx.lineWidth = 1.8 / s;
      ctx.stroke();
    }

    // 区域名（屏幕恒定字号）
    ctx.font = `${15 / s}px "Kaiti SC","STKaiti","KaiTi",serif`;
    ctx.textAlign = 'center';
    for (const r of map.regions) {
      ctx.fillStyle = 'rgba(217,210,191,0.16)';
      ctx.fillText(r.name, r.labelPos[0], r.labelPos[1]);
    }

    // 道路（邻接边）
    const drawn = new Set();
    ctx.lineWidth = 1.2 / s;
    for (const a of this.def.areas) {
      for (const nid of a.adjacent || []) {
        const key = [a.id, nid].sort().join('|');
        if (drawn.has(key)) continue;
        drawn.add(key);
        const b = this.def.areas.find(x => x.id === nid);
        if (!b) continue;
        const both = this._unlocked(a) && this._unlocked(b);
        ctx.strokeStyle = both ? 'rgba(201,169,97,0.38)' : 'rgba(201,169,97,0.12)';
        ctx.setLineDash(both ? [] : [4 / s, 6 / s]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    // 地点（节点与文字均按屏幕尺寸恒定绘制）
    for (const a of this.def.areas) {
      const unlocked = this._unlocked(a);
      const isCur = a.id === this.currentAreaId;
      const isHover = a.id === this.hoverId;
      const color = isCur ? '#ecd28c' : unlocked ? '#c9a961' : '#6b6557';
      const rNode = (isCur ? 7 : isHover ? 6 : 5) / s;

      // 当前位置：双层脉冲光环 + 道标
      if (isCur) {
        const wave = (Math.sin(this.pulse) + 1) / 2; // 0..1
        const pr1 = (14 + wave * 9) / s;
        const pr2 = (26 + wave * 12) / s;
        ctx.beginPath();
        ctx.arc(a.x, a.y, pr1, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(236,210,140,${0.5 - wave * 0.25})`;
        ctx.lineWidth = 1.6 / s;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(a.x, a.y, pr2, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(236,210,140,${0.22 - wave * 0.14})`;
        ctx.stroke();
      }

      // 节点
      ctx.beginPath();
      ctx.arc(a.x, a.y, rNode, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = isCur ? '#ecd28c' : color;
      ctx.shadowBlur = (isCur ? 16 : isHover ? 12 : 7) / Math.max(s, 0.5);
      ctx.fill();
      ctx.shadowBlur = 0;

      // 副本入口用菱形标记
      if (a.type === 'dungeon_entrance') {
        ctx.save();
        ctx.translate(a.x, a.y - 13 / s);
        ctx.rotate(Math.PI / 4);
        const ds = 3.4 / s;
        ctx.strokeStyle = unlocked ? 'rgba(167,139,250,0.9)' : 'rgba(167,139,250,0.3)';
        ctx.lineWidth = 1.3 / s;
        ctx.strokeRect(-ds, -ds, ds * 2, ds * 2);
        ctx.restore();
      }

      // 名字（屏幕 12px，带阴影）
      ctx.font = `${(isCur ? 13 : 12) / s}px "Kaiti SC","STKaiti","KaiTi",serif`;
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 4 / Math.max(s, 0.5);
      ctx.fillStyle = isCur ? '#ecd28c' : unlocked ? 'rgba(224,218,200,0.92)' : 'rgba(150,144,126,0.55)';
      ctx.fillText(a.name, a.x, a.y + (rNode + 13 / s));
      ctx.shadowBlur = 0;
      if (!unlocked && s > 0.7) {
        ctx.font = `${10 / s}px "Kaiti SC","STKaiti","KaiTi",serif`;
        ctx.fillStyle = 'rgba(150,144,126,0.6)';
        ctx.fillText(`需${this.def.realms[a.minRealm] || ''}`, a.x, a.y + (rNode + 26 / s));
      }
    }

    // ===== Agent 标记 =====
    this._agentMarkers = [];
    // 按区域分组
    const agentsByArea = {};
    for (const ag of this.agents) {
      if (ag.dead) continue;
      if (!agentsByArea[ag.areaId]) agentsByArea[ag.areaId] = [];
      agentsByArea[ag.areaId].push(ag);
    }
    for (const [areaId, group] of Object.entries(agentsByArea)) {
      const area = this.def.areas.find(a => a.id === areaId);
      if (!area) continue;
      const n = group.length;
      for (let i = 0; i < n; i++) {
        const ag = group[i];
        // 多个Agent围绕区域节点排列
        let ox, oy;
        if (n === 1) { ox = 0; oy = 0; }
        else {
          const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
          const spread = 16 + n * 2;
          ox = Math.cos(angle) * spread;
          oy = Math.sin(angle) * spread;
        }
        const wx = area.x + ox, wy = area.y + oy;
        const sp = this.worldToScreen(wx, wy);
        const isHover = this.hoverAgentId === ag.id;
        const isSel = this.selectedAgentId === ag.id;
        const r = isSel ? 7 : isHover ? 6 : 5;

        // 选中光环
        if (isSel) {
          const wave = (Math.sin(this.pulse) + 1) / 2;
          ctx.beginPath();
          ctx.arc(wx, wy, (12 + wave * 6) / s, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${this._hexRGB(ag.color)},${0.6 - wave * 0.3})`;
          ctx.lineWidth = 2 / s;
          ctx.stroke();
        }

        // 离线灰化
        const markerColor = ag.online ? ag.color : '#6b6557';

        // 主体圆点
        ctx.beginPath();
        ctx.arc(wx, wy, r / s, 0, Math.PI * 2);
        ctx.fillStyle = markerColor;
        ctx.shadowColor = ag.online ? ag.color : 'transparent';
        ctx.shadowBlur = (ag.online ? 10 : 0) / Math.max(s, 0.5);
        ctx.fill();
        ctx.shadowBlur = 0;

        // 在线白点中心
        if (ag.online) {
          ctx.beginPath();
          ctx.arc(wx, wy, (r * 0.4) / s, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.fill();
        }

        // 悬停/选中时显示道号
        if (isHover || isSel) {
          ctx.font = `${11 / s}px "Kaiti SC","STKaiti","KaiTi",serif`;
          ctx.textAlign = 'center';
          ctx.shadowColor = 'rgba(0,0,0,0.9)';
          ctx.shadowBlur = 4 / Math.max(s, 0.5);
          ctx.fillStyle = ag.online ? '#ecd28c' : 'rgba(150,144,126,0.8)';
          ctx.fillText(ag.name, wx, wy - (r + 8) / s);
          ctx.shadowBlur = 0;
        }

        // 记录屏幕坐标用于点击检测
        this._agentMarkers.push({ id: ag.id, sx: sp.x, sy: sp.y, r });
      }

      // 区域人口徽章（当 >1 人时）
      if (n > 1) {
        const sp = this.worldToScreen(area.x, area.y);
        const bx = sp.x + 14, by = sp.y - 14;
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.beginPath();
        ctx.arc(bx, by, 9, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(201,169,97,0.9)';
        ctx.fill();
        ctx.font = 'bold 11px "PingFang SC",sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#0b0f15';
        ctx.fillText(String(n), bx, by);
        ctx.restore();
      }
    }
  }

  _hexRGB(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `${r},${g},${b}`;
  }

  _unlocked(area) {
    if (area.minRealm <= this.realmIdx) return true;
    if (this.unlockedIds) return this.unlockedIds.includes(area.id);
    return false;
  }

  // 聚焦某地点（将地图平移使该地点居中）
  focus(areaId) {
    const a = this.def?.areas.find(x => x.id === areaId);
    if (!a) return;
    const map = this.def.map;
    const baseScale = Math.min(this.vw / map.width, this.vh / map.height) * 0.96;
    const s = baseScale * this.scale;
    this.offsetX = -s * (a.x - map.width / 2);
    this.offsetY = -s * (a.y - map.height / 2);
  }
}

window.InkMap = InkMap;

/*
 * BVR COMMAND — 地图渲染（Canvas 2D）
 * 风格参照 DCS F10 全局视图：浅色地图、细网格、机型轮廓、小尺寸导弹符号。
 */
(function (root) {
  'use strict';

  const sim = root.BVR.sim;
  const SHAPES = root.BVR.SHAPES;
  const DEFAULT_SHAPE = root.BVR.DEFAULT_SHAPE;
  const DEG = Math.PI / 180;

  const COLORS = {
    blue: '#2f5fd0',
    blueSoft: 'rgba(47,95,208,0.30)',
    red: '#c02b3c',
    redSoft: 'rgba(192,43,60,0.30)',
    grid: 'rgba(255,255,255,0.55)',
    gridMajor: 'rgba(255,255,255,0.85)',
    bullseye: '#c026a8',
    text: '#101418',
    muted: '#5b6660',
    missile: '#d97706'
  };

  let canvas = null, ctx = null, dpr = 1;
  let terrain = null;

  function init(cv) {
    canvas = cv;
    ctx = cv.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  function resize() {
    if (!canvas) return;
    dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function viewSize() {
    const r = canvas.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  function makeView() {
    return { x: 0, y: 0, scale: 1.3 };
  }

  function fit(w, view) {
    const { w: cw, h: ch } = viewSize();
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const a of w.aircraft) {
      minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x);
      minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y);
    }
    const dx = Math.max(160, maxX - minX + 160);
    const dy = Math.max(120, maxY - minY + 120);
    view.scale = Math.min(cw / dx, ch / dy);
    view.x = (minX + maxX) / 2;
    view.y = (minY + maxY) / 2;
    return view;
  }

  function w2s(view, x, y) {
    const { w, h } = viewSize();
    return {
      x: (x - view.x) * view.scale + w / 2,
      y: h / 2 - (y - view.y) * view.scale
    };
  }

  function s2w(view, sx, sy) {
    const { w, h } = viewSize();
    return {
      x: (sx - w / 2) / view.scale + view.x,
      y: (h / 2 - sy) / view.scale + view.y
    };
  }

  // ---------------------------------------------------------------------------
  // 机型轮廓（单位：机身长度 = 1，机头朝 +X，翼展沿 ±Y）
  // 预先编译成指令数组，缓存复用，兼容没有 Path2D 的环境。
  // ---------------------------------------------------------------------------
  const shapeCache = {};

  // 由参数生成剪影：机身 + 主翼 + 平尾 + 鸭翼 + 垂尾（+ 圆盘/软管）
  function buildShape(typeKey) {
    const s = SHAPES[typeKey] || DEFAULT_SHAPE;
    const hw = s.hw || 0.04;
    const polys = [];

    // 机身：等宽窄条（v0.5 的经典画法）
    const prof = s.fuse || [
      [0.500, 0.00], [0.455, 0.50], [0.400, 0.85], [0.300, 1.00],
      [0.100, 1.00], [-0.150, 0.95], [-0.350, 0.80], [-0.500, 0.45]
    ];
    const fuse = prof.map(p => [p[0], p[1] * hw]);
    const leftF = fuse.slice(1, -1).reverse().map(p => [p[0], -p[1]]);
    polys.push(fuse.concat(leftF));

    // 翼面：前缘从翼根一路外掠到翼尖；给了 lex 时前缘先沿机身向前延伸一段，
    // 形成边条/翼身融合的视觉过渡（F-15、侧卫系列的肩部）。
    const surface = (w, rs, lex) => {
      if (!w) return;
      const tipLE = w.x - w.span * w.sweep;
      const tipTE = tipLE - w.tip;
      const rootTE = w.x - w.root;
      for (const sy of [1, -1]) {
        const pts = [];
        if (lex > 0.01) {
          pts.push([w.x + lex, sy * rs * 0.80]);
        } else {
          pts.push([w.x, sy * rs]);
        }
        pts.push([tipLE, sy * w.span]);
        pts.push([tipTE, sy * w.span]);
        pts.push([rootTE, sy * rs * 0.75]);
        polys.push(pts);
      }
    };

    surface(s.wing, hw * 0.62, s.lex || 0);
    surface(s.stab && { x: s.stab.x, span: s.stab.span, sweep: s.stab.sweep, root: s.stab.chord, tip: s.stab.chord * 0.55 }, hw * 0.55, 0);
    surface(s.canard && { x: s.canard.x, span: s.canard.span, sweep: s.canard.sweep, root: s.canard.chord, tip: s.canard.chord * 0.5 }, hw * 0.58, 0);

    // 垂尾：双垂尾画两片薄板（略超出机身，才看得见），单垂尾留一条中线
    if (s.fin) {
      const f = s.fin;
      if (s.twin) {
        for (const sy of [1, -1]) {
          const y = sy * (hw * 1.05 + f.h);
          polys.push([
            [f.x, y - f.h], [f.x - f.len, y - f.h * 1.6],
            [f.x - f.len, y + f.h * 1.6], [f.x, y + f.h]
          ]);
        }
      } else {
        polys.push([
          [f.x, -f.h * 0.6], [f.x - f.len, -f.h], [f.x - f.len, f.h], [f.x, f.h * 0.6]
        ]);
      }
    }

    const out = { polys, dome: s.dome || null, hoses: !!s.hoses, len: s.len || 1 };
    shapeCache[typeKey] = out;
    return out;
  }

  // 画三角形图标：白芯 + 本方颜色描边（DCS 风格的空心三角），机头朝 +X
  function drawTriangle(px, color, opts) {
    const L = px, W = px * 0.52;
    ctx.beginPath();
    ctx.moveTo(L * 0.50, 0);
    ctx.lineTo(-L * 0.40, W * 0.55);
    ctx.lineTo(-L * 0.40, -W * 0.55);
    ctx.closePath();
    ctx.fillStyle = 'rgba(250,252,248,0.96)';
    ctx.globalAlpha = opts.alpha != null ? opts.alpha : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = opts.lw || 1.5;
    if (opts.dash) ctx.setLineDash([3, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // px = 屏幕上的机身长度（像素）
  function drawShape(typeKey, px, color, opts) {
    opts = opts || {};
    if (opts.mode === 'tri') { drawTriangle(px, color, opts); return; }

    const sh = shapeCache[typeKey] || buildShape(typeKey);
    const scale = px * sh.len;

    ctx.save();
    ctx.scale(scale, scale);
    ctx.beginPath();
    for (const pts of sh.polys) {
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
    }
    ctx.fillStyle = opts.fill || color;
    ctx.globalAlpha = opts.alpha != null ? opts.alpha : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    // 实心轮廓不描边（内部接缝会露线），只有虚线的不确定航迹需要描边
    if (opts.dash) {
      ctx.strokeStyle = opts.stroke || 'rgba(10,14,18,0.5)';
      ctx.lineWidth = 1.3 / scale;
      ctx.setLineDash([0.045, 0.03]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 预警机圆盘
    if (sh.dome) {
      const [dx, dr] = sh.dome;
      ctx.beginPath();
      ctx.ellipse(dx, 0, dr, dr * 0.60, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(250,250,246,0.80)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(10,14,18,0.45)';
      ctx.lineWidth = 0.9 / scale;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(dx - dr, 0);
      ctx.lineTo(dx + dr, 0);
      ctx.stroke();
    }

    // 加油机软管：从尾锥往后拖出两根
    if (sh.hoses) {
      ctx.strokeStyle = opts.fill || color;
      ctx.lineWidth = 2.2 / scale;
      ctx.beginPath();
      ctx.moveTo(-0.46, 0.05); ctx.lineTo(-0.92, 0.09);
      ctx.moveTo(-0.46, -0.05); ctx.lineTo(-0.92, -0.09);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // 地形（纯装饰）
  // ---------------------------------------------------------------------------
  function ensureTerrain() {
    if (terrain) return terrain;
    let s = 1234567;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    terrain = [];
    for (let i = 0; i < 110; i++) {
      terrain.push({
        x: -420 + rnd() * 840,
        y: -320 + rnd() * 640,
        r: 25 + rnd() * 90,
        a: 0.03 + rnd() * 0.06,
        hue: rnd()
      });
    }
    return terrain;
  }

  function draw(w, view, ui) {
    const { w: cw, h: ch } = viewSize();
    if (!cw || !ch) return;

    const bg = ctx.createLinearGradient(0, 0, 0, ch);
    bg.addColorStop(0, '#e6ebe0');
    bg.addColorStop(1, '#dde4d7');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch);

    for (const t of ensureTerrain()) {
      const p = w2s(view, t.x, t.y);
      const rad = t.r * view.scale;
      if (p.x + rad < 0 || p.x - rad > cw || p.y + rad < 0 || p.y - rad > ch) continue;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
      const c = t.hue < 0.4 ? '110,125,85' : t.hue < 0.75 ? '150,150,110' : '95,115,90';
      g.addColorStop(0, 'rgba(' + c + ',' + t.a + ')');
      g.addColorStop(1, 'rgba(' + c + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      ctx.fill();
    }

    drawGrid(view, cw, ch);

    // 预警机探测圈
    for (const a of w.aircraft) {
      if (!a.alive || a.type.role !== 'awacs') continue;
      const p = w2s(view, a.x, a.y);
      ctx.save();
      ctx.setLineDash([3, 6]);
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.strokeStyle = a.side === 'blue' ? 'rgba(47,95,208,0.18)' : 'rgba(192,43,60,0.18)';
        ctx.lineWidth = 1;
        ctx.arc(p.x, p.y, i * 100 * view.scale, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawBullseye(w, view);

    // 选中飞机的雷达/数据链可视化
    drawSelectionViz(w, view, ui);

    // 敌方航迹：确认 / 模糊 / 记忆，三种画法
    if (!(ui && ui.showAll)) drawEnemyTracks(w, view, ui);

    // 指令连线
    for (const a of w.aircraft) {
      if (!a.alive || !a.orders.target) continue;
      const t = w.aircraft.find(x => x.id === a.orders.target);
      if (!t || !w.detected[a.side].has(t.id)) continue;
      const p1 = w2s(view, a.x, a.y), p2 = w2s(view, t.x, t.y);
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = a.side === 'blue' ? 'rgba(47,95,208,0.38)' : 'rgba(192,43,60,0.38)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      ctx.restore();
    }

    drawJam(w, view, ui);

    drawLinks(w, view, ui);

    drawMissiles(w, view, ui);

    // 己方飞机（永远精确）；全图模式下敌机也按真位画
    const showAll = ui && ui.showAll;
    const playerSide = (ui && ui.playerSide) || 'blue';
    for (const a of w.aircraft) {
      if (!a.alive) continue;
      if (a.side !== playerSide && !showAll) continue;
      const p = w2s(view, a.x, a.y);
      const color = a.side === playerSide ? COLORS.blue : COLORS.red;
      const selected = ui && ui.selection && ui.selection.has(a.id);

      if (selected) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(20,24,20,0.85)';
        ctx.lineWidth = 1.2;
        ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(-a.hdg);
      drawShape(a.typeKey, a.type.role === 'fighter' ? 17 : 16,
        color, { fill: color, alpha: a.health < 50 ? 0.75 : 0.92, mode: (ui && ui.iconMode) || 'shape' });
      ctx.restore();

      // RWR 告警：只有听见了才画（低可截获雷达锁定时可能什么都没有）
      if (a.lockWarn > 0) {
        ctx.save();
        ctx.strokeStyle = 'rgba(232,120,24,0.9)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = '#c25a00';
        ctx.font = 'bold 8px "Consolas", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('被锁定', p.x, p.y + 22);
      }

      // 小提示：加油中
      if (a.ai && a.ai.refueling) {
        ctx.fillStyle = '#0a7f4a';
        ctx.font = '9px "Consolas", monospace';
        ctx.fillText('⛽', p.x + 9, p.y - 9);
      }

      const label = a.type.name;
      const fl = Math.round(a.alt / 30.48 / 100);
      const fls = 'FL' + (fl < 100 ? '0' : '') + fl;
      const mach = a.mach.toFixed(2);
      drawLabel(p.x, p.y - 11, label, fls + '  ' + mach,
        color, selected, a.health < 50, a.type.role !== 'fighter');
    }

    // 爆炸效果
    if (w.effects) {
      for (const e of w.effects) {
        const p = w2s(view, e.x, e.y);
        const k = 1 - e.t / e.life;
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(230,120,40,' + (k * 0.8).toFixed(3) + ')';
        ctx.lineWidth = 2;
        ctx.arc(p.x, p.y, (1 - k) * 26 + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 框选
    if (ui && ui.box) {
      const b = ui.box;
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(20,30,40,0.7)';
      ctx.fillStyle = 'rgba(47,95,208,0.08)';
      const x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1);
      const bw = Math.abs(b.x1 - b.x0), bh = Math.abs(b.y1 - b.y0);
      ctx.fillRect(x, y, bw, bh);
      ctx.strokeRect(x, y, bw, bh);
      ctx.restore();
    }

    drawHud(w, view, ui, cw, ch);
  }

  // ---------------------------------------------------------------------------
  // 敌方航迹：确认（实心）、模糊（虚线 + 误差圆）、记忆（淡点）
  // ---------------------------------------------------------------------------
  function drawUncertainMark(x, y) {
    ctx.save();
    ctx.strokeStyle = 'rgba(192,43,60,0.8)';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#a8162a';
    ctx.font = 'bold 7px "Consolas", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('?', x, y + 2.6);
    ctx.restore();
  }

  function drawEnemyTracks(w, view, ui) {
    const side = (ui && ui.playerSide) || 'blue';
    const tracks = w.tracks && w.tracks[side];
    if (!tracks || !tracks.size) return;
    const C = root.BVR.CONFIG.trackQuality;

    for (const [, tr] of tracks) {
      const p = w2s(view, tr.x, tr.y);
      const big = tr.type && tr.type.role !== 'fighter';

      if (tr.q >= C.confirmed) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(-tr.hdg);
        drawShape(tr.typeKey, big ? 16 : 17, COLORS.red,
          { fill: COLORS.red, alpha: 0.92, mode: (ui && ui.iconMode) || 'shape' });
        ctx.restore();
        const fl = Math.round(tr.alt / 30.48 / 100);
        drawLabel(p.x, p.y - 11, tr.type ? tr.type.name : '?',
          'FL' + (fl < 100 ? '0' : '') + fl + '  ' + (tr.v / 340).toFixed(2),
          COLORS.red, false, false, big);
      } else if (tr.q >= C.uncertain) {
        // 不确定：只给大致位置和航向，用误差圆表示可能范围
        const errPx = Math.max(9, (1 - tr.q) * 48);
        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = 'rgba(192,43,60,0.28)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, errPx, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(-tr.hdg);
        drawShape(tr.typeKey, big ? 16 : 17, COLORS.red,
          { fill: 'rgba(192,43,60,0.16)', stroke: 'rgba(192,43,60,0.8)', dash: true,
            mode: (ui && ui.iconMode) || 'shape' });
        ctx.restore();
        drawUncertainMark(p.x, p.y - 13);
        if (ui && ui.view && ui.view.scale > 1.8) {
          ctx.fillStyle = 'rgba(168,22,42,0.85)';
          ctx.font = '8px "Consolas", monospace';
          ctx.textAlign = 'left';
          ctx.fillText('未确认', p.x + 7, p.y + 12);
        }
      } else {
        ctx.save();
        ctx.globalAlpha = 0.30;
        ctx.setLineDash([2, 3]);
        drawDot(p.x, p.y, 4, COLORS.red);
        ctx.restore();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 选中飞机：雷达探测圈 + 视场扇区 + 数据链连线
  // ---------------------------------------------------------------------------
  function drawSelectionViz(w, view, ui) {
    if (!ui || !ui.selection || !ui.selection.size) return;
    const side = (ui && ui.playerSide) || 'blue';
    const awacs = w.aircraft.find(a => a.side === side && a.alive && a.type.role === 'awacs');
    const blue = side === 'blue' ? '47,95,208' : '192,43,60';

    for (const id of ui.selection) {
      const a = w.aircraft.find(x => x.id === id && x.alive);
      if (!a || a.side !== side) continue;
      const p = w2s(view, a.x, a.y);
      const R = a.type.radar * view.scale;

      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = 'rgba(' + blue + ',0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.stroke();

      if (a.type.radarFov < 180) {
        const half = a.type.radarFov * DEG;
        const a0 = -(a.hdg + half), a1 = -(a.hdg - half);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.arc(p.x, p.y, R, a0, a1);
        ctx.closePath();
        ctx.fillStyle = 'rgba(' + blue + ',0.055)';
        ctx.fill();
      }
      ctx.restore();

      // 小小的图例文字：雷达距离 / 视场 / 数据链
      const dl = w.datalink && w.datalink[side];
      ctx.save();
      ctx.font = '8px "Consolas", monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(' + blue + ',0.85)';
      ctx.fillText('RDR ' + Math.round(a.type.radar) + 'km · ' +
        (a.type.radarFov >= 180 ? '360°' : '±' + a.type.radarFov + '°') +
        ' · DL ' + (dl ? 'ON' : 'OFF'), p.x + 10, p.y + 20);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------------
  // 导弹：小圆点 + 航向短线 + 淡尾迹；状态用颜色区分
  // ---------------------------------------------------------------------------
  function missileColor(m) {
    if (m.phase === 'lost') return '#7c7c7c';
    if (m.phase === 'terminal') return m.side === 'blue' ? '#1d4ed8' : '#a8162a';
    return m.side === 'blue' ? '#3b6fe0' : '#c7384a';
  }

  // ---------------------------------------------------------------------------
  // 火控照射线 / 导弹中制导线 / 数据链
  // ---------------------------------------------------------------------------
  // 电子战干扰扇区：己方开着干扰的吊舱画半透明扇形，敌方只画淡淡一层
  function drawJam(w, view, ui) {
    const side = (ui && ui.playerSide) || 'blue';
    const pods = root.BVR.PODS || {};
    for (const a of w.aircraft) {
      if (!a.alive || !a.pod || !a.jamOn) continue;
      const p = pods[a.pod];
      if (!p) continue;
      const mine = a.side === side;
      const sel = ui && ui.selection && ui.selection.has(a.id);
      if (!mine && !(ui && ui.showAll) && !sel) {
        // 敌方的干扰机只有在它被探测到时才画（而且很淡）
        if (!(w.detected[side] && w.detected[side].has(a.id))) continue;
      }
      const c = w2s(view, a.x, a.y);
      const rr = (p.range * view.scale) / 1;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.arc(c.x, c.y, rr, a.hdg - p.arc, a.hdg + p.arc);
      ctx.closePath();
      ctx.fillStyle = mine
        ? (sel ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.08)')
        : 'rgba(190,24,93,0.06)';
      ctx.fill();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = mine ? 'rgba(124,58,237,0.45)' : 'rgba(190,24,93,0.28)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawLinks(w, view, ui) {    const side = (ui && ui.playerSide) || 'blue';
    const tracks = w.tracks && w.tracks[side];

    // 1) 机载雷达链路：STT = 实线（连续照射），LPI = 点线（静默扫描/跟踪）。
    //    相控阵可以同时维持多条链路，所以逐条画。
    for (const a of w.aircraft) {
      if (!a.alive || a.side !== side || !a.links) continue;
      const sel = ui && ui.selection && ui.selection.has(a.id);
      const p1 = w2s(view, a.x, a.y);
      for (const l of a.links) {
        const tr = tracks && tracks.get(l.id);
        if (!tr) continue;
        const p2 = w2s(view, tr.x, tr.y);
        ctx.save();
        if (l.mode === 'stt') {
          ctx.setLineDash([]);
          ctx.strokeStyle = sel ? 'rgba(29,78,216,0.95)' : 'rgba(29,78,216,0.50)';
          ctx.lineWidth = sel ? 1.6 : 1.1;
        } else {
          ctx.setLineDash([1.5, 3.5]);
          ctx.strokeStyle = sel ? 'rgba(29,78,216,0.75)' : 'rgba(29,78,216,0.28)';
          ctx.lineWidth = 0.8;
        }
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
        ctx.restore();
      }
    }

    // 2) 导弹中制导数据链：制导机 → 导弹。A 射 B 导时用紫色虚线单独区分。
    for (const m of w.missiles) {
      if (!m.alive || m.side !== side || !m.datalinkOn) continue;
      const g = w.aircraft.find(x => x.id === m.guiderId);
      if (!g || !g.alive) continue;
      const p1 = w2s(view, g.x, g.y), p2 = w2s(view, m.x, m.y);
      const bGuide = g.id !== m.shooterId;
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = bGuide ? 'rgba(124,58,237,0.72)' : 'rgba(217,119,6,0.50)';
      ctx.lineWidth = bGuide ? 1.3 : 1;
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      if (bGuide) {
        const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(124,58,237,0.85)';
        ctx.font = '9px sans-serif';
        ctx.fillText('B导', mx + 3, my - 3);
      }
      ctx.restore();
    }

    // 3) 末段：导引头开机，弹自己锁住目标
    for (const m of w.missiles) {
      if (!m.alive || m.side !== side || !m.seekerOn) continue;
      const tgt = w.aircraft.find(x => x.id === m.targetId && x.alive);
      if (!tgt) continue;
      const p1 = w2s(view, m.x, m.y), p2 = w2s(view, tgt.x, tgt.y);
      ctx.save();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(180,83,9,0.75)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      ctx.beginPath();
      ctx.arc(p2.x, p2.y, 4.5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(180,83,9,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    // 4) 数据链：预警机 → 各战斗机（虚线，弱化，选中时高亮）
    const awacs = w.aircraft.filter(a => a.alive && a.side === side && a.type.role === 'awacs');
    if (awacs.length) {
      const pA = w2s(view, awacs[0].x, awacs[0].y);
      for (const a of w.aircraft) {
        if (!a.alive || a.side !== side || a.id === awacs[0].id) continue;
        if (a.type.role === 'tanker') continue;
        const sel = ui && ui.selection && ui.selection.has(a.id);
        const p = w2s(view, a.x, a.y);
        ctx.save();
        ctx.setLineDash([1, 4]);
        ctx.strokeStyle = sel ? 'rgba(20,120,90,0.55)' : 'rgba(20,120,90,0.16)';
        ctx.lineWidth = sel ? 1 : 0.7;
        ctx.beginPath(); ctx.moveTo(pA.x, pA.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        ctx.restore();
      }
    }
  }

  function drawMissiles(w, view, ui) {
    const side = (ui && ui.playerSide) || 'blue';
    const C = root.BVR.CONFIG;

    for (const m of w.missiles) {
      if (!m.alive) continue;
      // 只有自己发射的、或已被本方雷达/RWR 发现的导弹才画出来
      const visible = m.side === side || (m.seen && m.seen[side]);
      if (!visible) continue;
      const p = w2s(view, m.x, m.y);
      const col = missileColor(m);

      if (m.trail && m.trail.length > 1) {
        ctx.beginPath();
        ctx.strokeStyle = m.side === 'blue' ? 'rgba(59,111,224,0.28)' : 'rgba(199,56,74,0.28)';
        ctx.lineWidth = 0.8;
        for (let i = 0; i < m.trail.length; i++) {
          const q = w2s(view, m.trail[i].x, m.trail[i].y);
          i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
      }

      // 本体：1.6 px 圆点 + 3 px 方向线
      ctx.beginPath();
      ctx.fillStyle = col;
      ctx.arc(p.x, p.y, 1.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.cos(m.hdg) * 3.6, p.y - Math.sin(m.hdg) * 3.6);
      ctx.stroke();

      // 末段给个细环
      if (m.phase === 'terminal') {
        ctx.beginPath();
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 0.8;
        ctx.arc(p.x, p.y, 3.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // 放大后显示弹型与剩余距离
      if (ui && ui.view && ui.view.scale > 2.2) {
        ctx.font = '9px "Consolas", monospace';
        ctx.fillStyle = col;
        ctx.fillText(m.type.name + ' ' + Math.round(m.range || 0) + 'km', p.x + 5, p.y - 4);
      }
    }

    // 只收到告警、还没看到弹体的来袭导弹：在目标机旁边标一个 M!
    for (const m of w.missiles) {
      if (!m.alive || m.side === side) continue;
      if (!(m.warned && m.warned[side]) || (m.seen && m.seen[side])) continue;
      const t = w.aircraft.find(a => a.id === m.targetId && a.alive);
      if (!t) continue;
      const tp = w2s(view, t.x, t.y);
      ctx.save();
      ctx.fillStyle = '#c2410c';
      ctx.font = 'bold 9px "Consolas", monospace';
      ctx.fillText('M!', tp.x + 9, tp.y - 20);
      ctx.restore();
    }
  }

  function drawGrid(view, cw, ch) {
    const step = 50; // km
    const tl = s2w(view, 0, 0), br = s2w(view, cw, ch);
    const x0 = Math.floor(tl.x / step) * step, x1 = Math.ceil(br.x / step) * step;
    const y0 = Math.floor(br.y / step) * step, y1 = Math.ceil(tl.y / step) * step;

    ctx.lineWidth = 1;
    for (let x = x0; x <= x1; x += step) {
      const p = w2s(view, x, 0);
      ctx.strokeStyle = x % 100 === 0 ? COLORS.gridMajor : COLORS.grid;
      ctx.beginPath(); ctx.moveTo(p.x, 0); ctx.lineTo(p.x, ch); ctx.stroke();
    }
    for (let y = y0; y <= y1; y += step) {
      const p = w2s(view, 0, y);
      ctx.strokeStyle = y % 100 === 0 ? COLORS.gridMajor : COLORS.grid;
      ctx.beginPath(); ctx.moveTo(0, p.y); ctx.lineTo(cw, p.y); ctx.stroke();
    }
  }

  function drawBullseye(w, view) {
    const p = w2s(view, w.bullseye.x, w.bullseye.y);
    ctx.save();
    ctx.strokeStyle = COLORS.bullseye;
    ctx.fillStyle = COLORS.bullseye;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 7); ctx.lineTo(p.x + 7, p.y);
    ctx.lineTo(p.x, p.y + 7); ctx.lineTo(p.x - 7, p.y);
    ctx.closePath();
    ctx.stroke();
    ctx.font = '11px "Consolas", monospace';
    ctx.fillText('Bullseye', p.x + 11, p.y + 4);
    ctx.restore();
  }

  function drawDot(x, y, r, color) {
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawLabel(x, y, line1, line2, color, selected, damaged, big) {
    ctx.save();
    ctx.font = (big ? 9 : 10) + 'px "Consolas", monospace';
    const w1 = ctx.measureText(line1).width;
    const w2 = ctx.measureText(line2).width;
    const bw = Math.max(w1, w2) + 9;
    const bh = big ? 21 : 23;
    const bx = x - bw / 2, by = y - bh;

    ctx.fillStyle = selected ? 'rgba(255,255,255,0.97)' : 'rgba(255,255,255,0.84)';
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 1.4 : 0.8;
    ctx.beginPath();
    roundRect(bx, by, bw, bh, 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(line1, x, by + 9);
    ctx.fillStyle = damaged ? '#a02020' : '#2a3230';
    ctx.fillText(line2, x, by + (big ? 18 : 20));
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawHud(w, view, ui, cw, ch) {
    ctx.save();
    ctx.font = '12px "Consolas", monospace';
    ctx.textAlign = 'left';

    const side = (ui && ui.playerSide) || 'blue';
    const blue = w.aircraft.filter(a => a.side === 'blue' && a.alive).length;
    const red = w.aircraft.filter(a => a.side === 'red' && a.alive).length;
    const dl = w.datalink && w.datalink[side];
    const C = root.BVR.CONFIG.trackQuality;
    let conf = 0, unc = 0;
    const tracks = w.tracks && w.tracks[side];
    if (tracks) for (const t of tracks.values()) {
      if (t.q >= C.confirmed) conf++; else if (t.q >= C.uncertain) unc++;
    }
    const lines = [
      'T+' + sim.fmtTime(w.t),
      'BLUE ' + blue + '   RED ' + red,
      '航迹 确认 ' + conf + '  未确认 ' + unc,
      '数据链 ' + (dl ? '在线' : '中断'),
      'Scale ' + (view.scale * 50).toFixed(0) + ' px / 50 km'
    ];
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.fillRect(10, 10, 200, 18 * lines.length + 10);
    ctx.fillStyle = '#26302c';
    lines.forEach((s, i) => {
      ctx.fillStyle = i === 3 && !dl ? '#a02020' : (i === 2 && unc > 0 ? '#a8162a' : '#26302c');
      ctx.fillText(s, 18, 27 + i * 18);
    });

    // 视窗比例尺
    const barKm = 50;
    const barPx = barKm * view.scale;
    const bx = cw - barPx - 24, by = ch - 26;
    ctx.strokeStyle = '#2a3230';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by);
    ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4);
    ctx.moveTo(bx + barPx, by - 4); ctx.lineTo(bx + barPx, by + 4);
    ctx.stroke();
    ctx.fillStyle = '#2a3230';
    ctx.fillText('50 km', bx + barPx / 2 - 18, by - 8);

    ctx.restore();
  }

  root.BVR = root.BVR || {};
  root.BVR.render = { init, draw, fit, w2s, s2w, viewSize, resize, makeView, COLORS, shapeCache, buildShape };
})(typeof window !== 'undefined' ? window : globalThis);

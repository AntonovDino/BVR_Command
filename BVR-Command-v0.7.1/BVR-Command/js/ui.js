/*
 * BVR COMMAND — 界面与交互
 *
 * 三段式：header（想定/时间/数据链）、左侧（编队/接触/导弹）、右侧（指挥面板）。
 * 备战界面单独一层 overlay，负责编成与挂载。
 */
(function (root) {
  'use strict';

  const sim = root.BVR.sim;
  const render = root.BVR.render;
  const MISSILES = root.BVR.MISSILES;
  const AIRCRAFT = root.BVR.AIRCRAFT;
  const LOADOUTS = root.BVR.LOADOUTS;
  const SCENARIOS = root.BVR.SCENARIOS;
  const CONFIG = root.BVR.CONFIG;
  const PODS = root.BVR.PODS || {};

  const ui = {
    world: null,
    playerSide: 'blue',
    selection: new Set(),
    showAll: false,
    iconMode: 'shape',
    speed: 1,
    paused: true,
    pickMode: null,
    view: null,
    drag: null,
    box: null,
    prep: { scen: 'us_cn', force: [], open: false, dirty: false, enemy: 5, random: false }
  };

  let el = {};
  let bannerKey = '';
  let toastTimer = null;

  function $(id) { return document.getElementById(id); }

  // ---------------------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------------------
  function init() {
    el = {
      scenario: $('scenario'), restart: $('restart'), prepBtn: $('prepBtn'), clock: $('clock'),
      datalink: $('datalink'), flightList: $('flightList'), contactList: $('contactList'),
      missileList: $('missileList'), missileCount: $('missileCount'),
      detail: $('detail'), log: $('log'), banner: $('banner'), selInfo: $('selInfo'),
      showAll: $('showAll'), iconBtn: $('iconBtn'), canvas: $('map'), mapwrap: $('mapwrap'),
      blueCount: $('blueCount'), redCount: $('redCount'),
      prep: $('prep'), prepRoster: $('prepRoster'), prepPool: $('prepPool'),
      prepCount: $('prepCount'), prepSummary: $('prepSummary'), prepStart: $('prepStart'),
      prepScen: $('prepScen'), prepVer: $('prepVer'),
      enemyCount: $('enemyCount'), enemyNum: $('enemyNum'), enemyRandom: $('enemyRandom')
    };

    buildScenarioSelect();
    bindControls();
    bindCanvas();
    bindPrep();
    if (el.prepVer) el.prepVer.textContent = 'v' + CONFIG.version;
  }

  function buildScenarioSelect() {
    if (!el.scenario) return;
    el.scenario.innerHTML = '';
    for (const k in SCENARIOS) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = SCENARIOS[k].name;
      el.scenario.appendChild(o);
    }
  }

  function setWorld(world) {
    ui.world = world;
    ui.selection.clear();
    ui.pickMode = null;
    ui.box = null;
    ui.drag = null;
    if (el.scenario) el.scenario.value = world.scen;
    // 首帧渲染前画布尺寸可能为 0，延后一拍再 fit
    ui.view = render.fit(world, render.makeView());
    bannerKey = '';
    refresh();
  }

  // ---------------------------------------------------------------------------
  // 图标模式：真实轮廓 / 三角形
  // ---------------------------------------------------------------------------
  function toggleIconMode() {
    ui.iconMode = ui.iconMode === 'shape' ? 'tri' : 'shape';
    if (el.iconBtn) el.iconBtn.textContent = '图标：' + (ui.iconMode === 'shape' ? '真实' : '三角');
    refresh();
    return ui.iconMode;
  }

  // ---------------------------------------------------------------------------
  // 控件绑定
  // ---------------------------------------------------------------------------
  function bindControls() {
    el.scenario.addEventListener('change', () => {
      root.BVR.game.startBattle(el.scenario.value, null);
    });
    el.restart.addEventListener('click', () => {
      root.BVR.game.startBattle(ui.world ? ui.world.scen : el.scenario.value, null);
    });
    el.prepBtn.addEventListener('click', () => openPrep(true));
    el.showAll.addEventListener('change', () => { ui.showAll = el.showAll.checked; });
    if (el.iconBtn) el.iconBtn.addEventListener('click', toggleIconMode);

    document.querySelectorAll('[data-speed]').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = parseFloat(btn.dataset.speed);
        if (s === 0) { ui.paused = !ui.paused; }
        else { ui.speed = s; ui.paused = false; }
        markSpeed();
      });
    });
    markSpeed();

    el.flightList.addEventListener('click', ev => {
      const row = ev.target.closest('[data-id]');
      if (!row) return;
      const id = row.dataset.id;
      if (ev.shiftKey || ev.ctrlKey) {
        ui.selection.has(id) ? ui.selection.delete(id) : ui.selection.add(id);
      } else {
        ui.selection.clear();
        ui.selection.add(id);
      }
      refresh();
    });

    el.contactList.addEventListener('click', ev => {
      const row = ev.target.closest('[data-id]');
      if (!row) return;
      assignTarget(row.dataset.id);
    });

    el.missileList.addEventListener('click', ev => {
      const bg = ev.target.closest('[data-bg]');
      if (bg) {
        const m = ui.world.missiles.find(x => x.id === bg.dataset.bg);
        if (m) {
          ui.pickMode = 'guider';
          ui.guideMissile = m.id;
          toast('点击一架己方飞机，指定它来制导');
        }
        return;
      }
      const row = ev.target.closest('[data-mid]');
      if (!row) return;
      const m = ui.world.missiles.find(x => x.id === row.dataset.mid);
      if (m) { ui.view.x = m.x; ui.view.y = m.y; }
    });

    el.detail.addEventListener('click', ev => {
      const btn = ev.target.closest('[data-cmd]');
      if (!btn) return;
      applyCommand(btn.dataset.cmd, btn.dataset.value, btn.dataset);
    });

    el.detail.addEventListener('input', ev => {
      const inp = ev.target.closest('[data-live]');
      if (!inp) return;
      const list = selectedAircraft();
      const v = parseFloat(inp.value);
      if (!list.length || isNaN(v)) return;
      if (inp.dataset.live === 'alt') {
        for (const ac of list) { ac.orders.alt = v; ac.orders.altManual = true; }
      } else if (inp.dataset.live === 'mach') {
        for (const ac of list) { ac.orders.mach = v; ac.orders.machManual = true; }
      }
      const lab = inp.parentNode && inp.parentNode.querySelector
        ? inp.parentNode.querySelector('.val') : null;
      if (lab) lab.textContent = inp.dataset.live === 'alt'
        ? Math.round(v) + ' m' : 'M' + v.toFixed(2);
    });
  }

  function markSpeed() {
    document.querySelectorAll('[data-speed]').forEach(b => {
      const s = parseFloat(b.dataset.speed);
      const on = (!ui.paused && s === ui.speed) || (ui.paused && s === 0);
      b.classList.toggle('on', on);
    });
  }

  // ---------------------------------------------------------------------------
  // 备战
  // ---------------------------------------------------------------------------
  function bindPrep() {
    el.prepScen.addEventListener('change', () => {
      ui.prep.scen = el.prepScen.value;
      ui.prep.force = defaultForce(ui.prep.scen);
      ui.prep.enemy = scenarioEnemyCount(ui.prep.scen);
      if (el.enemyCount) el.enemyCount.value = ui.prep.enemy;
      renderPrep();
    });
    if (el.enemyCount) {
      el.enemyCount.addEventListener('input', () => {
        ui.prep.enemy = parseInt(el.enemyCount.value, 10) || 0;
        if (el.enemyNum) el.enemyNum.textContent = ui.prep.enemy;
        renderPrep();
      });
    }
    if (el.enemyRandom) {
      el.enemyRandom.addEventListener('change', () => {
        ui.prep.random = el.enemyRandom.checked;
        if (el.enemyCount) el.enemyCount.disabled = ui.prep.random;
        renderPrep();
      });
    }
    el.prepRoster.addEventListener('click', ev => {
      const rm = ev.target.closest('[data-rm]');
      if (!rm) return;
      ui.prep.force.splice(parseInt(rm.dataset.rm, 10), 1);
      renderPrep();
    });
    el.prepRoster.addEventListener('change', ev => {
      const sel = ev.target.closest('[data-lo]');
      if (sel) {
        const i = parseInt(sel.dataset.lo, 10);
        if (ui.prep.force[i]) ui.prep.force[i].loadout = sel.value;
        renderPrep();
        return;
      }
      const pod = ev.target.closest('[data-pod]');
      if (pod) {
        const i = parseInt(pod.dataset.pod, 10);
        if (ui.prep.force[i]) {
          ui.prep.force[i].pod = pod.value || null;
          renderPrep();
        }
      }
    });
    el.prepPool.addEventListener('click', ev => {
      const card = ev.target.closest('[data-add]');
      if (!card) return;
      addToForce(card.dataset.add);
    });
    el.prepStart.addEventListener('click', () => {
      const force = ui.prep.force;
      const fighters = force.filter(f => AIRCRAFT[f.type].role === 'fighter').length;
      if (!fighters) { toast('至少需要一架战斗机'); return; }
      if (force.length > CONFIG.maxAircraft) { toast('超出 ' + CONFIG.maxAircraft + ' 架上限'); return; }
      const enemy = ui.prep.random
        ? 2 + Math.floor(Math.random() * (CONFIG.maxEnemy - 1))
        : ui.prep.enemy;
      ui.prep.open = false;
      el.prep.classList.remove('show');
      root.BVR.game.startBattle(ui.prep.scen, {
        blue: { force: force.slice() },
        red: { count: enemy }
      });
    });
  }

  function defaultForce(scenKey) {
    const sc = SCENARIOS[scenKey] || SCENARIOS.us_cn;
    const out = [];
    if (sc.blue.awacs) out.push({ type: sc.blue.awacs, loadout: 'std' });
    if (sc.blue.tanker) out.push({ type: sc.blue.tanker, loadout: 'std' });
    for (const f of sc.blue.flights) {
      for (let i = 0; i < f.n; i++) out.push({ type: f.type, loadout: f.loadout || 'std' });
    }
    return out.slice(0, CONFIG.maxAircraft);
  }

  // 想定默认的敌方战斗机数量（备战滑杆的初始值）
  function scenarioEnemyCount(scenKey) {
    const sc = SCENARIOS[scenKey] || SCENARIOS.us_cn;
    return (sc.red.flights || []).reduce((s, f) => s + (f.n || 1), 0);
  }

  function openPrep(rebuild) {
    if (rebuild || !ui.prep.force.length) {
      ui.prep.scen = ui.world ? ui.world.scen : (el.scenario.value || 'us_cn');
      ui.prep.force = defaultForce(ui.prep.scen);
      ui.prep.enemy = scenarioEnemyCount(ui.prep.scen);
    }
    ui.prep.open = true;
    ui.paused = true;
    if (el.enemyCount) {
      el.enemyCount.value = ui.prep.enemy;
      el.enemyCount.disabled = ui.prep.random;
    }
    if (el.enemyRandom) el.enemyRandom.checked = ui.prep.random;
    markSpeed();
    el.prep.classList.remove('hidden');
    el.prep.classList.add('show');
    renderPrep();
  }

  function closePrep() {
    ui.prep.open = false;
    el.prep.classList.remove('show');
    el.prep.classList.add('hidden');
  }

  function addToForce(typeKey) {
    const t = AIRCRAFT[typeKey];
    if (!t) return;
    if (ui.prep.force.length >= CONFIG.maxAircraft) { toast('已达 ' + CONFIG.maxAircraft + ' 架上限'); return; }
    if (t.role !== 'fighter' && ui.prep.force.some(f => AIRCRAFT[f.type].role === t.role)) {
      toast(t.role === 'awacs' ? '只能带一架预警机' : '只能带一架加油机');
      return;
    }
    ui.prep.force.push({ type: typeKey, loadout: (LOADOUTS[typeKey] && LOADOUTS[typeKey][0].id) || 'std' });
    renderPrep();
  }

  function renderPrep() {
    if (!el.prep) return;
    const sc = SCENARIOS[ui.prep.scen] || SCENARIOS.us_cn;

    // 想定选择
    el.prepScen.innerHTML = '';
    for (const k in SCENARIOS) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = SCENARIOS[k].name;
      if (k === ui.prep.scen) o.selected = true;
      el.prepScen.appendChild(o);
    }

    // 序列
    el.prepRoster.innerHTML = ui.prep.force.map((f, i) => {
      const t = AIRCRAFT[f.type];
      const opts = (LOADOUTS[f.type] || []).map(l =>
        `<option value="${l.id}"${l.id === f.loadout ? ' selected' : ''}>${l.name}</option>`).join('');
      const tag = t.role === 'awacs' ? '<span class="rrole">预警</span>'
        : t.role === 'tanker' ? '<span class="rrole">加油</span>' : '';
      const podOpts = t.role === 'fighter'
        ? '<option value="">无吊舱</option>' + Object.keys(PODS).map(k =>
          `<option value="${k}"${f.pod === k ? ' selected' : ''}>${PODS[k].short}</option>`).join('')
        : '<option value="">—</option>';
      return `<div class="rrow">
        <span class="rn"><b>${t.name}</b>${tag}</span>
        <select class="rlo" data-lo="${i}">${opts}</select>
        <select class="rlo rpod" data-pod="${i}"${t.role === 'fighter' ? '' : ' disabled'}>${podOpts}</select>
        <button class="rrm" data-rm="${i}" title="移除">×</button>
      </div>`;
    }).join('') || '<div class="empty">还没有编成</div>';

    // 机池：本国战斗机 + 支援机
    const pool = [];
    for (const k in AIRCRAFT) {
      const t = AIRCRAFT[k];
      if (t.country !== sc.blue.country) continue;
      pool.push(t);
    }
    el.prepPool.innerHTML = pool.map(t => {
      const role = t.role === 'fighter' ? '战斗机' : t.role === 'awacs' ? '预警机' : '加油机';
      return `<button class="pcard" data-add="${t.key}">
        <b>${t.name}</b><small>${role} · RCS ${t.rcs} · 雷达 ${t.radar} km</small>
      </button>`;
    }).join('');

    // 统计
    const n = ui.prep.force.length;
    let missiles = 0, drag = 0, fighters = 0;
    for (const f of ui.prep.force) {
      const lo = (LOADOUTS[f.type] || []).find(l => l.id === f.loadout) || { missiles: {} };
      const eff = sim.loadEffects(lo);
      missiles += eff.count;
      drag += eff.drag - 1;
      if (AIRCRAFT[f.type].role === 'fighter') fighters++;
    }
    el.prepCount.textContent = n + '/' + CONFIG.maxAircraft;
    if (el.enemyNum) el.enemyNum.textContent = ui.prep.random ? '随机' : ui.prep.enemy;
    el.prepSummary.innerHTML =
      `战斗机 <b>${fighters}</b> 架 · 总挂弹 <b>${missiles}</b> 枚 · ` +
      `平均阻力 <b>+${n ? Math.round(drag / n * 100) : 0}%</b> · ` +
      `敌方战斗机 <b>${ui.prep.random ? '随机 2–' + CONFIG.maxEnemy : ui.prep.enemy}</b> 架` +
      (n > CONFIG.maxAircraft ? ' <em class="bad">超出上限</em>' : '') +
      `<div class="hint">${sc.brief || ''}</div>`;
  }

  // ---------------------------------------------------------------------------
  // 指令
  // ---------------------------------------------------------------------------
  function selectedAircraft() {
    return [...ui.selection]
      .map(id => ui.world.aircraft.find(a => a.id === id))
      .filter(a => a && a.alive);
  }

  function applyCommand(cmd, value) {
    if (cmd === 'prep') { openPrep(true); return; }
    const list = selectedAircraft();
    if (!list.length) return;

    if (cmd === 'target' || cmd === 'waypoint') {
      ui.pickMode = cmd;
      toast(cmd === 'target' ? '点击地图上的红方目标' : '点击地图设置航路点');
      return;
    }

    for (const ac of list) {
      if (cmd === 'alt') { ac.orders.alt = parseFloat(value); ac.orders.altManual = true; }
      else if (cmd === 'mach') { ac.orders.mach = parseFloat(value); ac.orders.machManual = true; }
      else if (cmd === 'roe') ac.orders.roe = ac.orders.roe === 'free' ? 'hold' : 'free';
      else if (cmd === 'mode') {
        ac.orders.mode = value;
        if (value === 'auto') { ac.orders.altManual = false; ac.orders.machManual = false; }
      }
      else if (cmd === 'clearTarget') ac.orders.target = null;
      else if (cmd === 'clearWaypoint') ac.orders.waypoint = null;
      else if (cmd === 'jam') {
        ac.orders.jamManual = !ac.jamOn;
        ac.jamOn = !ac.jamOn;
      }
      else if (cmd === 'jamAuto') ac.orders.jamManual = null;
      else if (cmd === 'flight') {
        const grp = ac.callsign.split('-')[0];
        for (const other of ui.world.aircraft) {
          if (other.alive && other.side === ac.side && other.callsign.split('-')[0] === grp) {
            ui.selection.add(other.id);
          }
        }
      } else if (cmd === 'all') {
        for (const other of ui.world.aircraft) {
          if (other.alive && other.side === ui.playerSide && other.type.role === 'fighter') {
            ui.selection.add(other.id);
          }
        }
      }
    }
    refresh();
  }

  function assignTarget(enemyId) {
    const list = selectedAircraft();
    if (!list.length) { toast('先选择己方飞机'); return; }
    const QC = root.BVR.CONFIG.trackQuality;
    const tr = ui.world.tracks && ui.world.tracks[ui.playerSide]
      ? ui.world.tracks[ui.playerSide].get(enemyId) : null;
    if (!tr || tr.q < QC.uncertain) { toast('该接触已丢失'); return; }
    if (tr.q < QC.confirmed) { toast('信号模糊，无法稳定锁定（需更近距离或预警机引导）'); return; }
    for (const ac of list) ac.orders.target = enemyId;
    ui.pickMode = null;
    refresh();
  }

  function toast(text) {
    if (!el.banner) return;
    el.banner.textContent = text;
    el.banner.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (!ui.world || !ui.world.result) el.banner.classList.remove('show');
    }, 2200);
  }

  // ---------------------------------------------------------------------------
  // 画布
  // ---------------------------------------------------------------------------
  function canvasPos(ev) {
    const r = el.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function bindCanvas() {
    const cv = el.canvas;

    cv.addEventListener('wheel', ev => {
      ev.preventDefault();
      const r = cv.getBoundingClientRect();
      const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
      const before = render.s2w(ui.view, sx, sy);
      const k = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      ui.view.scale = Math.max(0.3, Math.min(16, ui.view.scale * k));
      const after = render.s2w(ui.view, sx, sy);
      ui.view.x += before.x - after.x;
      ui.view.y += before.y - after.y;
    }, { passive: false });

    cv.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return;
      const p = canvasPos(ev);
      if (ev.shiftKey) {
        ui.box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        ui.drag = { mode: 'box' };
      } else {
        ui.drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, vx: ui.view.x, vy: ui.view.y, moved: false };
      }
    });

    cv.addEventListener('mousemove', ev => {
      const d = ui.drag;
      if (!d) return;
      if (d.mode === 'box') {
        const p = canvasPos(ev);
        ui.box.x1 = p.x; ui.box.y1 = p.y;
        return;
      }
      const dx = ev.clientX - d.sx, dy = ev.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.moved) {
        ui.view.x = d.vx - dx / ui.view.scale;
        ui.view.y = d.vy + dy / ui.view.scale;
      }
    });

    cv.addEventListener('mouseup', ev => {
      const d = ui.drag;
      ui.drag = null;
      if (!d) return;
      if (d.mode === 'box') {
        finishBox(ev);
        return;
      }
      if (!d.moved) handleClick(ev);
    });

    cv.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      const hit = pickAircraft(ev);
      if (hit && hit.side !== ui.playerSide) assignTarget(hit.id);
    });
  }

  function finishBox(ev) {
    const b = ui.box;
    ui.box = null;
    if (!b || !ui.world) return;
    const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1);
    const y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
    let n = 0;
    for (const a of ui.world.aircraft) {
      if (!a.alive || a.side !== ui.playerSide) continue;
      const p = render.w2s(ui.view, a.x, a.y);
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) { ui.selection.add(a.id); n++; }
    }
    if (!n && !ev.shiftKey) ui.selection.clear();
    refresh();
  }

  function pickAircraft(ev) {
    const p = canvasPos(ev);
    let best = null, bd = 15;
    for (const a of ui.world.aircraft) {
      if (!a.alive) continue;
      if (a.side !== ui.playerSide && !ui.world.detected[ui.playerSide].has(a.id)) continue;
      const q = render.w2s(ui.view, a.x, a.y);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  function handleClick(ev) {
    const p = canvasPos(ev);
    const hit = pickAircraft(ev);

    if (ui.pickMode === 'guider' && hit && hit.side === ui.playerSide) {
      const m = ui.world.missiles.find(x => x.id === ui.guideMissile);
      if (m) {
        m.guiderManual = hit.id;
        toast(hit.callsign + ' 接手这枚弹的制导');
      }
      ui.pickMode = null;
      ui.guideMissile = null;
      refresh();
      return;
    }
    if (ui.pickMode === 'target' && hit && hit.side !== ui.playerSide) {
      assignTarget(hit.id);
      return;
    }
    if (ui.pickMode === 'waypoint') {
      const q = render.s2w(ui.view, p.x, p.y);
      for (const ac of selectedAircraft()) {
        ac.orders.waypoint = { x: q.x, y: q.y };
        ac.orders.mode = 'auto';
      }
      ui.pickMode = null;
      refresh();
      return;
    }
    if (!hit) {
      if (!ev.shiftKey) { ui.selection.clear(); refresh(); }
      return;
    }
    if (hit.side !== ui.playerSide) {
      if (ui.selection.size) { assignTarget(hit.id); return; }
    }
    if (ev.shiftKey || ev.ctrlKey) {
      ui.selection.has(hit.id) ? ui.selection.delete(hit.id) : ui.selection.add(hit.id);
    } else {
      ui.selection.clear();
      ui.selection.add(hit.id);
    }
    refresh();
  }

  // ---------------------------------------------------------------------------
  // 刷新
  // ---------------------------------------------------------------------------
  function fmtFl(alt) {
    const fl = Math.round(alt / 30.48 / 100);
    return 'FL' + (fl < 100 ? '0' : '') + fl;
  }

  function callsignOf(w, id) {
    const a = w.aircraft.find(x => x.id === id);
    return a ? a.callsign : '?';
  }

  function totalMissiles(ac) {
    let n = 0;
    for (const k in ac.missiles) n += ac.missiles[k];
    return n;
  }

  function statusOf(ac) {
    if (!ac.alive) return { text: '损失', cls: 'dead' };
    if (ac.ai && ac.ai.refueling) return { text: '加油', cls: 'ok' };
    if (ac.health < 60) return { text: '重创', cls: 'warn' };
    if (ac.orders.mode === 'evade') return { text: '规避', cls: 'warn' };
    if (ac.orders.mode === 'rtb') return { text: '返航', cls: 'dim' };
    if (ac.type.role === 'awacs') return { text: '预警', cls: 'ok' };
    if (ac.type.role === 'tanker') return { text: '加油机', cls: 'ok' };
    if (totalMissiles(ac) === 0) return { text: '无弹', cls: 'dim' };
    return { text: '作战', cls: 'ok' };
  }

  function refresh() {
    if (!ui.world) return;
    refreshList();
    refreshContacts();
    refreshMissiles();
    refreshDetail();
    refreshClock();
    refreshLog();
    refreshBanner();
  }

  function refreshClock() {
    el.clock.textContent = 'T+' + sim.fmtTime(ui.world.t);
    const dl = ui.world.datalink && ui.world.datalink[ui.playerSide];
    el.datalink.textContent = '数据链 ' + (dl ? '在线' : '中断');
    el.datalink.classList.toggle('bad', !dl);
  }

  function refreshList() {
    const w = ui.world;
    const side = ui.playerSide;
    const mine = w.aircraft.filter(a => a.side === side);
    el.blueCount.textContent = mine.filter(a => a.alive).length + '/' + mine.length;

    el.flightList.innerHTML = mine.map(ac => {
      const st = statusOf(ac);
      const sel = ui.selection.has(ac.id) ? ' sel' : '';
      const role = ac.type.role !== 'fighter' ? ' support' : '';
      const tgt = ac.orders.target
        ? (w.aircraft.find(a => a.id === ac.orders.target) || {}).callsign : null;
      return `<div class="row${sel}${role}" data-id="${ac.id}">
        <div class="r1">
          <span class="cs">${ac.callsign}</span>
          <span class="st ${st.cls}">${st.text}</span>
        </div>
        <div class="r2">
          <span class="ty">${ac.type.name}</span>
          <span class="num">${fmtFl(ac.alt)} · M${ac.mach.toFixed(2)}</span>
        </div>
        <div class="r3">
          <span class="num">弹 ${totalMissiles(ac)}</span>
          ${ac.orders.roe === 'hold' ? '<span class="tag">持火</span>' : ''}
          ${tgt ? '<span class="tag tgt">→' + tgt + '</span>' : ''}
        </div>
      </div>`;
    }).join('');

    const n = ui.selection.size;
    el.selInfo.textContent = n ? ('已选 ' + n + ' 架 · 指令同步下达') : '未选择（Shift 多选 / Shift 拖拽框选）';
  }

  function refreshContacts() {
    const w = ui.world;
    const side = ui.playerSide;
    const QC = root.BVR.CONFIG.trackQuality;
    const tracks = w.tracks && w.tracks[side] ? Array.from(w.tracks[side].values()) : [];
    const vis = tracks.filter(t => t.q >= QC.uncertain);
    el.redCount.textContent = tracks.filter(t => t.q >= QC.confirmed).length +
      (vis.length > tracks.filter(t => t.q >= QC.confirmed).length ? '+' : '');

    if (!vis.length) {
      el.contactList.innerHTML = '<div class="empty">无目标接触</div>';
      return;
    }
    const awacs = w.aircraft.find(a => a.side === side && a.alive && a.type.role === 'awacs');
    el.contactList.innerHTML = vis
      .sort((a, b) => (awacs ? Math.hypot(awacs.x - a.x, awacs.y - a.y) - Math.hypot(awacs.x - b.x, awacs.y - b.y) : 0))
      .map(t => {
        const d = awacs ? Math.round(Math.hypot(awacs.x - t.x, awacs.y - t.y)) : 0;
        const confirmed = t.q >= QC.confirmed;
        const kind = !confirmed ? '信号模糊' :
          t.type.role === 'awacs' ? '预警机' : t.type.role === 'tanker' ? '加油机' : '战斗机';
        const name = confirmed && t.type ? t.type.name : '<span class="dim">未确认接触</span>';
        const alt = 'FL' + Math.round(t.alt / 30.48 / 100);
        const mach = (t.v / 340).toFixed(2);
        const acc = Math.round(t.q * 100);
        return `<div class="row contact${confirmed ? '' : ' faint'}" data-id="${t.id}">
          <div class="r1"><span class="cs ${confirmed ? 'red' : 'dim'}">${name}</span>
            <span class="num">${confirmed ? alt + ' M' + mach : '±' + (Math.max(2, (1 - t.q) * 40)).toFixed(0) + 'km'}</span></div>
          <div class="r2"><span class="num">${kind} · 距预警机 ${d} km · 置信 ${acc}%</span>
            ${confirmed ? '<span class="tag tgt">点击→指定</span>' : '<span class="tag">待确认</span>'}</div>
        </div>`;
      }).join('');
  }

  function phaseText(m) {
    if (m.phase === 'lost') return '失的';
    if (m.phase === 'terminal') return '末段';
    if (m.phase === 'boost') return '加速';
    return '巡航';
  }

  function refreshMissiles() {
    const w = ui.world;
    const side = ui.playerSide;
    const mine = w.missiles.filter(m => m.alive && m.side === side)
      .sort((a, b) => (a.tti || 0) - (b.tti || 0));
    const seenIn = w.missiles.filter(m => m.alive && m.side !== side && m.seen && m.seen[side] &&
      w.aircraft.find(a => a.id === m.targetId && a.side === side));
    const inbound = seenIn.length;
    const warnedOnly = w.missiles.filter(m => m.alive && m.side !== side &&
      m.warned && m.warned[side] && !(m.seen && m.seen[side]) &&
      w.aircraft.find(a => a.id === m.targetId && a.side === side)).length;

    el.missileCount.textContent = mine.length + (inbound ? ' / 来袭 ' + inbound : '');
    el.missileCount.classList.toggle('bad', inbound > 0);

    if (!mine.length && !inbound && !warnedOnly) {
      el.missileList.innerHTML = '<div class="empty">无在空导弹</div>';
      return;
    }
    const rowOf = (m, hostile) => {
      const t = w.aircraft.find(a => a.id === m.targetId);
      const name = hostile && !(m.seen && m.seen[side]) ? '未知弹' : m.type.name;
      const rng = hostile && !(m.seen && m.seen[side]) ? '—' : Math.round(m.range || 0) + ' km';
      const g = m.guiderId ? callsignOf(w, m.guiderId) : null;
      const guide = m.seekerOn ? '自身导引头'
        : g ? ((m.handoff ? '<span class="warn">B导</span> · ' : '制导 ') + g)
          : '<span class="warn">无制导</span>';
      return `<div class="row mrow${hostile ? ' hostile' : ''}" data-mid="${m.id}">
        <div class="r1"><span class="cs${hostile ? ' red' : ''}">${name}</span><span class="num">${rng} · ${(m.tti || 0).toFixed(0)}s</span></div>
        <div class="r2"><span class="num">→ ${t ? t.callsign : '已失的'}</span><span class="tag ${m.phase}">${phaseText(m)}</span></div>
        <div class="r2"><span class="num small">${guide}</span>${hostile ? '' : `<button class="bg" data-bg="${m.id}">B导</button>`}</div>
      </div>`;
    };
    el.missileList.innerHTML = mine.map(m => rowOf(m, false)).join('') +
      seenIn.map(m => rowOf(m, true)).join('') +
      (warnedOnly ? `<div class="row mrow warnrow"><div class="r1"><span class="cs red">来袭告警</span><span class="num">${warnedOnly} 枚 · 未捕获</span></div></div>` : '');
  }

  function refreshDetail() {
    const list = selectedAircraft();
    const w = ui.world;

    if (!list.length) {
      const alive = w.aircraft.filter(a => a.side === ui.playerSide && a.alive);
      const fighter = alive.filter(a => a.type.role === 'fighter').length;
      el.detail.innerHTML = `
        <div class="panel-title">指挥面板</div>
        <div class="hint big">
          你坐在预警机上：选择己方飞机（列表 / 地图 / Shift 框选），下达高度、速度、
          目标、开火权限与规避指令；不干预时飞机会自主交战。
        </div>
        <div class="kv"><span>己方在空</span><b>${alive.length} 架（战斗机 ${fighter}）</b></div>
        <div class="kv"><span>交战时间</span><b>T+${sim.fmtTime(w.t)}</b></div>
        <div class="kv"><span>战果</span><b>${w.stats[ui.playerSide]} : ${w.stats[ui.playerSide === 'blue' ? 'red' : 'blue']}</b></div>
        <div class="kv"><span>在空导弹</span><b>${w.missiles.filter(m => m.alive).length}</b></div>
        <div class="btns">
          <button data-cmd="all" class="wide">全选战斗机</button>
        </div>
        <div class="hint">快捷键：空格暂停 · 1/2/3/4/5 变速 · F 全图 · Esc 取消</div>`;
      return;
    }

    const first = list[0];
    const multi = list.length > 1;

    if (multi) {
      const rows = list.map(a =>
        `<div class="mini" data-id="${a.id}"><b>${a.callsign}</b> ${a.type.name}
         <span>${a.ai && a.ai.roleName ? a.ai.roleName + ' · ' : ''}${fmtFl(a.alt)} · M${a.mach.toFixed(2)} · 弹${totalMissiles(a)}</span></div>`).join('');
      el.detail.innerHTML = `
        <div class="panel-title">已选 ${list.length} 架 <span class="type">同步指挥</span></div>
        <div class="minilist">${rows}</div>
        ${commandBlocks(first, true)}
        <div class="sect">编队</div>
        <div class="btns">
          <button data-cmd="flight">选本编队</button>
          <button data-cmd="all">全选战斗机</button>
          <button data-cmd="prep">重新备战</button>
        </div>`;
      return;
    }

    const ac = first;
    const inv = Object.keys(ac.missiles)
      .filter(k => ac.missiles[k] > 0)
      .map(k => `<span class="chip">${MISSILES[k].name} ×${ac.missiles[k]}</span>`)
      .join('') || '<span class="chip dim">无弹</span>';
    const tgtName = ac.orders.target
      ? (w.aircraft.find(a => a.id === ac.orders.target) || {}).callsign : '自动';

    el.detail.innerHTML = `
      <div class="panel-title">${ac.callsign} <span class="type">${ac.type.name}</span></div>
      <div class="kv"><span>状态</span><b>${statusOf(ac).text}</b></div>
      <div class="kv"><span>高度 / 马赫</span><b>${fmtFl(ac.alt)} · M${ac.mach.toFixed(2)}</b></div>
      <div class="kv"><span>速度</span><b>${Math.round(ac.v * 3.6)} km/h</b></div>
      <div class="kv"><span>燃油</span><b>${Math.round(ac.fuel)} / ${Math.round(ac.maxFuel)} kg</b></div>
      <div class="kv"><span>干扰弹</span><b>${ac.chaff}</b></div>
      <div class="kv"><span>挂载</span><b class="small">${ac.loadoutName}</b></div>
      ${ac.pod ? `<div class="kv"><span>电子战</span><b>${PODS[ac.pod].name} · ${ac.jamOn
        ? '<span class="warn">干扰中</span>' : '待机'}</b></div>` : ''}
      <div class="kv"><span>角色</span><b>${ac.ai && ac.ai.roleName ? ac.ai.roleName : '—'}</b></div>
      ${ac.ai && ac.ai.maneuver ? `<div class="kv"><span>机动</span><b>${ac.ai.maneuver.name}</b></div>` : ''}
      <div class="kv"><span>雷达</span><b>${Math.round(ac.type.radar)} km · ${ac.type.radarFov >= 180 ? '360°' : '±' + ac.type.radarFov + '°'}${ac.type.lpi ? ' · LPI' : ''}</b></div>
      <div class="kv"><span>数据链</span><b>${w.datalink && w.datalink[ac.side] ? '在线（预警机融合）' : '中断（仅本机）'}</b></div>
      <div class="kv"><span>雷达模式</span><b>${ac.radarMode === 'stt'
        ? '<span class="warn">STT 单目标跟踪</span>'
        : 'LPI 静默扫描' + ((ac.links && ac.links.length) ? '（' + ac.links.length + ' 批）' : '')}</b></div>
      <div class="kv"><span>火控</span><b>${ac.guiding ? '照射 ' + callsignOf(w, ac.guiding) : '待机'}</b></div>
      <div class="kv"><span>告警</span><b>${ac.lockWarn > 0 ? '<span class="warn">被锁定 ×' + ac.lockWarn + '</span>' : '—'}</b></div>
      <div class="kv"><span>目标</span><b>${tgtName}</b></div>
      ${commandBlocks(ac, false)}
      <div class="sect">挂载</div>
      <div class="chips">${inv}</div>
      <div class="sect">编队</div>
      <div class="btns">
        <button data-cmd="flight">选本编队</button>
        <button data-cmd="all">全选战斗机</button>
        <button data-cmd="prep">重新备战</button>
      </div>`;
  }

  function commandBlocks(ac, multi) {
    const alt = Math.round(ac.alt / CONFIG.altStep) * CONFIG.altStep;
    const mach = Math.round(ac.mach * 100) / 100;
    return `
      <div class="sect">高度指令 ${multi ? '<span class="sm">（应用全部）</span>' : ''}</div>
      <div class="slider">
        <input type="range" data-live="alt" min="${CONFIG.altMin}" max="${CONFIG.altMax}"
               step="${CONFIG.altStep}" value="${alt}">
        <span class="val">${alt} m</span>
      </div>
      <div class="btns tight">
        ${[6000, 9000, 12000, 15000].map(a => `<button data-cmd="alt" data-value="${a}">${a / 1000}k</button>`).join('')}
      </div>

      <div class="sect">速度指令</div>
      <div class="slider">
        <input type="range" data-live="mach" min="0.5" max="1.6" step="0.02" value="${Math.min(1.6, mach)}">
        <span class="val">M${mach.toFixed(2)}</span>
      </div>
      <div class="btns tight">
        <button data-cmd="mach" data-value="0.7">0.7</button>
        <button data-cmd="mach" data-value="0.9">0.9</button>
        <button data-cmd="mach" data-value="1.1">1.1</button>
        <button data-cmd="mach" data-value="1.4">1.4</button>
      </div>

      <div class="sect">交战</div>
      <div class="btns">
        <button data-cmd="target" class="wide">指定目标（点地图）</button>
        <button data-cmd="clearTarget">清除目标</button>
        <button data-cmd="waypoint" class="wide">设置航路点</button>
      </div>

      <div class="sect">规则</div>
      <div class="btns">
        <button data-cmd="roe" class="${ac.orders.roe === 'free' ? 'on' : ''}">${ac.orders.roe === 'free' ? '自由开火' : '禁止开火'}</button>
        <button data-cmd="mode" data-value="auto" class="${ac.orders.mode === 'auto' ? 'on' : ''}">自主</button>
        <button data-cmd="mode" data-value="evade" class="${ac.orders.mode === 'evade' ? 'on' : ''}">规避</button>
        <button data-cmd="mode" data-value="refuel" class="${ac.orders.mode === 'refuel' ? 'on' : ''}">加油</button>
        <button data-cmd="mode" data-value="rtb" class="${ac.orders.mode === 'rtb' ? 'on' : ''}">返航</button>
      </div>
      ${ac.pod ? `<div class="sect">电子战（${PODS[ac.pod] ? PODS[ac.pod].short : ''}）</div>
      <div class="btns">
        <button data-cmd="jam" class="${ac.jamOn ? 'on' : ''}">${ac.jamOn ? '干扰 开' : '干扰 关'}</button>
        <button data-cmd="jamAuto" class="${ac.orders.jamManual == null ? 'on' : ''}">自动</button>
      </div>
      <div class="hint small">${PODS[ac.pod] ? PODS[ac.pod].desc : ''}</div>` : ''}`;
  }

  function refreshLog() {
    const w = ui.world;
    const items = w.events.slice(-7).reverse();
    el.log.innerHTML = items.map(e => {
      const col = e.side === 'blue' ? 'blue' : e.side === 'red' ? 'red' : 'neutral';
      return `<div class="logline ${col}"><span class="t">${sim.fmtTime(e.t)}</span>${e.text}</div>`;
    }).join('');
  }

  function refreshBanner() {
    const w = ui.world;
    if (!w.result) {
      if (bannerKey) { bannerKey = ''; }
      el.banner.classList.remove('result');
      return;
    }
    const key = w.result.winner + ':' + Math.round(w.result.t) + ':' + (w.result.timeout ? 1 : 0) + (w.result.dry ? 'd' : '');
    if (key === bannerKey) return;
    bannerKey = key;
    const win = w.result.winner;
    const mine = win === ui.playerSide;
    const text = win === 'draw' ? '两败俱伤' : (mine ? '我方胜利' : '我方战败');
    const enemy = ui.playerSide === 'blue' ? 'red' : 'blue';
    const how = w.result.dry ? '双方弹药耗尽' : w.result.swept ? '击溃敌方战斗机群'
      : w.result.idle ? '脱离接触' : w.result.timeout ? '超时判定' : '清场';
    el.banner.innerHTML = `<div class="big">${text}</div>
      <div class="sub">交战 ${sim.fmtTime(w.result.t)} · 战果 我 ${w.stats[ui.playerSide]} : ${w.stats[enemy]} · ${how}</div>
      <button onclick="BVR.game.startBattle()">再来一局</button>`;
    el.banner.classList.add('show', 'result');
  }

  root.BVR = root.BVR || {};
  root.BVR.ui = ui;
  root.BVR.ui.init = init;
  root.BVR.ui.setWorld = setWorld;
  root.BVR.ui.refresh = refresh;
  root.BVR.ui.openPrep = openPrep;
  root.BVR.ui.hidePrep = closePrep;
  root.BVR.ui.toast = toast;
  root.BVR.ui.toggleIconMode = toggleIconMode;
})(typeof window !== 'undefined' ? window : globalThis);

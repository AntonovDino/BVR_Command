/*
 * BVR COMMAND — 启动与主循环
 *
 * 固定步长 0.25 s；渲染跟随 requestAnimationFrame；界面每 0.2 s 刷新一次。
 * 想定与编成通过 game.startBattle(scenKey, setup) 切换，setup 结构：
 *   { blue: { force: [{ type, loadout }, ...] } }
 */
(function (root) {
  'use strict';

  const sim = root.BVR.sim;
  const render = root.BVR.render;
  const ui = root.BVR.ui;

  const STEP = 0.25;

  const game = {
    world: null,
    last: 0,
    acc: 0,
    lastUi: 0,
    lastSetup: null,

    startBattle(scenKey, setup) {
      const key = scenKey || (this.world && this.world.scen) || 'us_cn';
      const useSetup = setup === undefined ? this.lastSetup : setup;
      this.lastSetup = useSetup || null;
      const seed = (Date.now() % 1000000) ^ 0x5f3759df;
      const w = sim.createWorld(key, seed, useSetup || null);
      this.world = w;
      this.acc = 0;
      this.last = 0;
      ui.setWorld(w);
      ui.speed = 1;
      ui.paused = false;
      ui.refresh();
    },

    boot() {
      render.init(document.getElementById('map'));
      ui.init();
      this.startBattle('us_cn', null);
      // 首次进入先备战：想看默认编成直接点「开战」即可
      ui.openPrep(true);
      bindKeys();
      window.addEventListener('resize', () => {
        render.resize();
        if (this.world) ui.view = render.fit(this.world, ui.view);
      });
      requestAnimationFrame(frame);
    }
  };

  function bindKeys() {
    document.addEventListener('keydown', ev => {
      if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName || '')) return;
      const k = ev.key;
      if (k === ' ') {
        ev.preventDefault();
        ui.paused = !ui.paused;
        ui.refresh();
      } else if (k >= '1' && k <= '5') {
        const speeds = [1, 2, 4, 8, 16];
        ui.speed = speeds[parseInt(k, 10) - 1];
        ui.paused = false;
        ui.refresh();
      } else if (k === 'f' || k === 'F') {
        ui.showAll = !ui.showAll;
        const cb = document.getElementById('showAll');
        if (cb) cb.checked = ui.showAll;
      } else if (k === 't' || k === 'T') {
        if (ui.toggleIconMode) ui.toggleIconMode();
      } else if (k === 'Escape') {
        ui.pickMode = null;
        ui.selection.clear();
        ui.refresh();
      }
    });
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    const g = game;
    if (!g.world) return;

    const now = ts || 0;
    let dt = g.last ? (now - g.last) / 1000 : 0;
    g.last = now;
    dt = Math.min(dt, 0.12);

    if (!root.BVR.ui.paused && !g.world.result) {
      g.acc += dt * (root.BVR.ui.speed || 1);
      let guard = 0;
      while (g.acc >= STEP && guard++ < 96) {
        sim.stepWorld(g.world, STEP);
        g.acc -= STEP;
        if (g.world.result) break;
      }
    }

    render.draw(g.world, root.BVR.ui.view || render.makeView(), root.BVR.ui);

    if (now - g.lastUi > 200) {
      g.lastUi = now;
      root.BVR.ui.refresh();
    }
  }

  root.BVR = root.BVR || {};
  root.BVR.game = game;

  function ready() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => game.boot());
    } else {
      game.boot();
    }
  }
  ready();
})(typeof window !== 'undefined' ? window : globalThis);

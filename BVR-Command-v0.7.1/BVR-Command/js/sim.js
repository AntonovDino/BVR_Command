/*
 * BVR COMMAND — 仿真核心
 *
 * 纯逻辑，不依赖 DOM，可在 Node 中直接跑（见 test/smoke.js）。
 * 坐标系：x 向东、y 向北，单位 km；高度 m；速度 m/s；航向弧度（0=东）。
 */
(function (root) {
  'use strict';

  const atmos = root.BVR.atmos;
  const AIRCRAFT = root.BVR.AIRCRAFT;
  const MISSILES = root.BVR.MISSILES;
  const SCENARIOS = root.BVR.SCENARIOS;
  const LOADOUTS = root.BVR.LOADOUTS;
  const PODS = root.BVR.PODS || {};
  const CONFIG = root.BVR.CONFIG;

  const G = 9.80665;
  const DEG = Math.PI / 180;

  // 型号呼号
  const CALLSIGNS = {
    f15ex: 'EAGLE', f16c: 'VIPER', fa18e: 'HORNET', e3g: 'MAGIC',
    j16: 'FIREBIRD', j10c: 'DRAGON', j11bg: 'FLANKER', kj500: 'SKYEYE',
    su35s: 'FLANKER', su30sm2: 'SUKHOI', mig31bm: 'FOXHOUND', a50u: 'MAINSAY',
    kc135r: 'TEXACO', hy6: 'TANKER', il78m: 'TANKER'
  };

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function wrapPi(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function distKm(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function bearing(from, to) { return Math.atan2(to.y - from.y, to.x - from.x); }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtTime(t) {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return pad2(m) + ':' + pad2(s);
  }

  // ---------------------------------------------------------------------------
  // 挂载
  // ---------------------------------------------------------------------------
  function loadoutFor(typeKey, id) {
    const list = LOADOUTS[typeKey] || [{ id: 'std', name: '无挂载', missiles: {} }];
    return list.find(l => l.id === id) || list[0];
  }

  function loadEffects(lo) {
    let n = 0, mass = 0;
    for (const k in lo.missiles) {
      const c = lo.missiles[k];
      if (!c) continue;
      n += c;
      if (MISSILES[k]) mass += c * MISSILES[k].mass;
    }
    // 挂架与弹体的附加阻力/反射面积，按弹数线性估算
    return { count: n, mass, drag: 1 + 0.028 * n, rcs: 1 + 0.018 * n };
  }

  // ---------------------------------------------------------------------------
  // 世界创建
  // ---------------------------------------------------------------------------
  function createWorld(scenKey, seed, setup) {
    const scen = SCENARIOS[scenKey] || SCENARIOS.us_cn;
    const rng = mulberry32(seed == null ? 20261104 : seed);

    const w = {
      t: 0, scen: scen.key, rng,
      aircraft: [], missiles: [], events: [], effects: [],
      detected: { blue: new Set(), red: new Set() },
      tracks: { blue: new Map(), red: new Map() },
      ghosts: { blue: new Map(), red: new Map() },
      datalink: { blue: false, red: false },
      support: { blue: {}, red: {} },
      result: null, nextId: 1,
      bullseye: { x: 0, y: 0 },
      stats: { blue: 0, red: 0 },
      setup: setup || null,
      version: CONFIG.version
    };

    addSide(w, 'blue', scen.blue, scen.blue.hdg || 0, setup && setup.blue);
    addSide(w, 'red', scen.red, scen.red.hdg || Math.PI, setup && setup.red);

    logEvent(w, '想定开始：' + scen.name, null);
    return w;
  }

  function addSide(w, side, cfg, hdg, setup) {
    const force = normalizeForce(side, cfg, setup, w.rng);

    // 预警机
    const aw = cfg.awacs;
    if (aw) {
      w.aircraft.push(makeAircraft(w, side, aw, CALLSIGNS[aw] + ' 01',
        cfg.awacsX, cfg.awacsY, 9000, hdg, true, 'std'));
    }
    // 加油机
    if (cfg.tanker) {
      w.aircraft.push(makeAircraft(w, side, cfg.tanker, CALLSIGNS[cfg.tanker] + ' 02',
        cfg.tankerX, cfg.tankerY, 9500, hdg, true, 'std'));
    }

    const podKeys = Object.keys(PODS);
    let podsUsed = 0;
    let flightNo = 1;
    for (const f of force) {
      const cs = CALLSIGNS[f.type] + ' ' + (flightNo + 1);
      const n = f.n || 1;
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 9;
        const x = f.x + Math.cos(hdg + Math.PI / 2) * off;
        const y = f.y + Math.sin(hdg + Math.PI / 2) * off;
        const name = cs + '-' + (i + 1);
        const type = AIRCRAFT[f.type];
        const alt = 8500 + (i % 2) * 1200;
        const aiRole = type.role !== 'fighter' ? 'support' : 'strike';
        const ac = makeAircraft(w, side, f.type, name, x, y, alt, hdg, i === 0,
          f.loadout || 'std', aiRole);
        // 玩家选的吊舱优先；红方（AI）最多 2 架自带吊舱，避免全队都是干扰机
        let pod = f.pod || null;
        if (!pod && side === 'red' && podsUsed < 2 && type.role === 'fighter' && w.rng() < 0.3) {
          pod = podKeys[Math.floor(w.rng() * podKeys.length)];
        }
        if (pod) { applyPod(ac, pod); podsUsed++; }
        w.aircraft.push(ac);
      }
      flightNo++;
    }
  }

  // 电子战吊舱：占两个挂点（从存量最多的弹里扣 2 发），加质量、阻力与 RCS
  function applyPod(ac, key) {
    const p = PODS[key];
    if (!p) return;
    ac.pod = p.key;
    ac.podName = p.name;
    ac.jamOn = false;
    ac.mass += p.mass;
    ac.cd0 *= p.drag;
    ac.rcs *= p.rcs;
    let left = 2;
    const keys = Object.keys(ac.missiles).filter(k => ac.missiles[k] > 0)
      .sort((a, b) => ac.missiles[b] - ac.missiles[a]);
    for (const k of keys) {
      if (left <= 0) break;
      const take = Math.min(left, ac.missiles[k]);
      ac.missiles[k] -= take;
      left -= take;
    }
    ac.stores = Math.max(0, ac.stores - 2);
    ac.loadoutName = ac.loadoutName + ' + ' + p.short + '吊舱';
  }

  // 自定义编成 → 统一成 flights 结构；setup.count 用来生成指定数量的敌机
  function normalizeForce(side, cfg, setup, rng) {
    if (setup && setup.count != null && !(setup.force && setup.force.length)) {
      return forceFromCount(cfg, setup.count, side, rng);
    }
    if (!setup || !setup.force || !setup.force.length) return cfg.flights;
    const fighters = setup.force.filter(f => {
      const t = AIRCRAFT[f.type];
      return t && t.role === 'fighter';
    });
    const baseX = side === 'blue' ? cfg.awacsX + 95 : cfg.awacsX - 95;
    return fighters.map((f, i) => ({
      type: f.type,
      n: 1,
      loadout: f.loadout || 'std',
      pod: f.pod || null,
      x: baseX + (i % 3) * 14,
      y: -44 + Math.floor(i / 3) * 30 + (i % 3) * 9
    }));
  }

  // 按数量生成敌方/己方战斗机：循环使用想定里的机型模板，按批次向后排
  function forceFromCount(cfg, count, side, rng) {
    const tpl = (cfg.flights || []).slice();
    if (!tpl.length) return [];
    const n = Math.max(0, Math.min(CONFIG.maxEnemy, Math.round(count)));
    const dir = side === 'blue' ? -1 : 1;
    const podKeys = Object.keys(PODS);
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = tpl[i % tpl.length];
      const lane = Math.floor(i / tpl.length);
      out.push({
        type: t.type, n: 1, loadout: t.loadout || 'std', pod: null,
        x: t.x + dir * lane * 11,
        y: t.y + (i % 2 ? 8 : -8) - lane * 5
      });
    }
    return out;
  }

  function makeAircraft(w, side, typeKey, callsign, x, y, alt, hdg, isLeader, loadoutId, aiRole) {
    const t = AIRCRAFT[typeKey];
    const lo = loadoutFor(typeKey, loadoutId);
    const eff = loadEffects(lo);
    const maxFuel = t.fuel;
    const startFuel = t.role === 'tanker' ? maxFuel
      : t.role === 'awacs' ? maxFuel * 0.85 : maxFuel * 0.62;
    const role = t.role === 'fighter' ? (aiRole || 'strike') : 'support';

    return {
      id: 'a' + (w.nextId++),
      side, typeKey, type: t, callsign, leader: !!isLeader,
      x, y, alt, hdg,
      v: atmos.machToTas(0.8, alt),
      fuel: startFuel, maxFuel,
      health: 100, alive: true,
      n: 1, mach: 0.8,
      loadoutId: lo.id, loadoutName: lo.name, stores: eff.count,
      mass: t.mass + eff.mass, cd0: t.cd0 * eff.drag, rcs: t.rcs * eff.rcs,
      missiles: Object.assign({}, lo.missiles),
      orders: {
        alt, mach: t.role === 'awacs' ? 0.72 : 0.9,
        altManual: false, machManual: false,
        target: null, roe: 'free', mode: 'auto',
        waypoint: null, formation: null
      },
      ai: { defendUntil: 0, lastLaunch: 0, targetId: null, think: 0, refueling: false,
            role, roleName: role === 'strike' ? '主攻' : '支援',
            maneuver: null, maneuverUntil: 0,
            altBias: (w.rng() - 0.5) * 1600 },
      fired: 0, kills: 0, chaff: t.role === 'fighter' ? 30 : 60,
      pod: null, podName: null, jamOn: false, jamEff: 0
    };
  }

  // ---------------------------------------------------------------------------
  // 飞行性能
  // ---------------------------------------------------------------------------
  function performance(ac, h, v, n) {
    const rho = atmos.density(h);
    const a = atmos.soundSpeed(h);
    const q = 0.5 * rho * v * v;
    const m = ac.mass;
    const S = ac.type.S;
    const gLimit = ac.type.gLimit * (ac.health > 50 ? 1 : 0.65);

    // 可用过载：结构限制与升力限制取小
    const nLift = (ac.type.clmax * q * S) / (m * G);
    const nMax = Math.max(1, Math.min(gLimit, nLift));

    const CL = clamp((m * G * n) / (q * S), 0, ac.type.clmax);
    const Cd = ac.cd0 + 0.05 * CL * CL;
    const drag = q * Cd * S;

    const fuelFactor = ac.fuel > 0 ? 1 : 0;
    const thrust = ac.type.thrust * Math.pow(rho / atmos.RHO0, 0.7) * fuelFactor
      * (ac.health > 50 ? 1 : 0.6);

    // 可用转弯率
    const vSafe = Math.max(v, 60);
    const omega = (G * Math.sqrt(Math.max(0, nMax * nMax - 1))) / vSafe;

    return { rho, a, q, nMax, drag, thrust, omega, mach: v / a, mass: m };
  }

  // ---------------------------------------------------------------------------
  // 单机运动
  // ---------------------------------------------------------------------------
  function flyAircraft(w, ac, dt) {
    const t = ac.type;
    const cmd = ac.cmd || { hdg: ac.hdg, alt: ac.alt, mach: ac.orders.mach };

    // --- 转向 ---
    let perf = performance(ac, ac.alt, ac.v, Math.max(ac.n, 1));
    let dHdg = wrapPi(cmd.hdg - ac.hdg);
    const maxTurn = perf.omega * dt;
    dHdg = clamp(dHdg, -maxTurn, maxTurn);

    // 实际过载（用于阻力）
    const turnRate = Math.abs(dHdg) / Math.max(dt, 1e-6);
    const nTurn = Math.sqrt(1 + Math.pow((turnRate * ac.v) / G, 2));
    ac.n = clamp(nTurn, 1, 12);

    perf = performance(ac, ac.alt, ac.v, ac.n);
    ac.hdg = wrapPi(ac.hdg + dHdg);

    // --- 速度 ---
    const targetTas = Math.min(cmd.mach * perf.a, t.vmax);
    const dvThrust = (perf.thrust - perf.drag) / ac.mass;

    // --- 高度 ---
    let climb = clamp((cmd.alt - ac.alt) / 12, -260, 260);
    if (ac.v < 90) climb = Math.min(climb, -20);          // 失速下沉
    const excessPower = (perf.thrust - perf.drag) * ac.v / (ac.mass * G);
    if (climb > 0) climb = Math.min(climb, Math.max(0, excessPower * 0.8));
    climb = clamp(climb, -300, 300);

    let dv = dvThrust - (G * climb) / Math.max(ac.v, 60);

    // 速度趋近指令值（用发动机加减速能力自然逼近）
    if (ac.v < targetTas) {
      dv = Math.max(dv, -5);       // 加速时不要被负项压死
    } else {
      // 需要减速：收油门 + 减速板
      dv = Math.min(dv, 0) - 1.2;
    }
    ac.v = clamp(ac.v + dv * dt, 55, t.vmax * 1.05);

    // --- 位置 ---
    ac.alt = clamp(ac.alt + climb * dt, 100, t.ceil);
    ac.mach = ac.v / atmos.soundSpeed(ac.alt);
    ac.x += (ac.v * Math.cos(ac.hdg) * dt) / 1000;
    ac.y += (ac.v * Math.sin(ac.hdg) * dt) / 1000;

    // --- 燃油 ---
    ac.fuel = Math.max(0, ac.fuel - (perf.thrust + 12000) * 1.1e-5 * dt);
  }

  // ---------------------------------------------------------------------------
  // 导弹
  // ---------------------------------------------------------------------------
  function fireMissile(w, ac, targetId, keyOverride) {
    const target = w.aircraft.find(a => a.id === targetId && a.alive);
    if (!target) return false;
    const range = distKm(ac, target);

    let key = keyOverride;
    if (!key || !ac.missiles[key]) {
      // 选弹：远距优先雷达弹，20 km 内可换红外弹
      key = null;
      if (range > 22) {
        key = Object.keys(ac.missiles).find(k => ac.missiles[k] > 0 && MISSILES[k].rangeRef > 60);
      }
      if (!key) {
        key = Object.keys(ac.missiles).find(k => ac.missiles[k] > 0);
      }
    }
    if (!key) return false;

    const mt = MISSILES[key];
    ac.missiles[key]--;
    ac.fired++;
    w.lastShot = w.t;

    const m = {
      id: 'm' + (w.nextId++),
      key, type: mt, side: ac.side, shooterId: ac.id,
      x: ac.x, y: ac.y, alt: ac.alt, hdg: ac.hdg, v: ac.v + 30,
      t: 0, targetId, alive: true, losPrev: 0, rangePrev: range,
      launchAlt: ac.alt, launchRange: range, wasted: false, chaffed: 0,
      phase: 'boost', range, tti: range, targetLost: false,
      seen: { blue: ac.side === 'blue', red: ac.side === 'red' },
      warned: { blue: false, red: false }, seekerOn: false,
      trail: [], trailAcc: 0
    };
    m.losPrev = bearing(m, target);

    // 发射告警：只有被攻击方的 RWR 能在发射瞬间感知（不是全场广播）。
    // 距离太远（超过 RWR 作用距离）就连被攻击方也不知道。
    if (range < CONFIG.rwrRange) {
      m.warned[target.side] = true;
      if (target.side === 'blue') {
        logEvent(w, '告警：' + target.callsign + ' 遭 ' + ac.callsign + ' 火控锁定', 'blue');
      }
    }

    w.missiles.push(m);
    logEvent(w, ac.callsign + ' 发射 ' + mt.name + ' → ' + target.callsign +
      '（' + Math.round(range) + ' km）', ac.side);
    return true;
  }

  function stepMissiles(w, dt) {
    for (const m of w.missiles) {
      if (!m.alive) continue;
      const target = w.aircraft.find(a => a.id === m.targetId);
      m.t += dt;

      const mt = m.type;
      const rho = atmos.density(m.alt);
      const q = 0.5 * rho * m.v * m.v;
      const mass = Math.max(mt.mass * 0.45, mt.mass - mt.propMass * Math.min(1, m.t / mt.burn));
      const thrust = m.t < mt.burn ? mt.thrust : 0;
      const drag = q * mt.CdA;

      // 目标丢失 → 惯性直飞
      if (!target || !target.alive) {
        m.targetLost = true;
        m.phase = 'lost';
        m.v = Math.max(200, m.v + ((thrust - drag) / mass) * dt);
        advance(m, dt);
        pushTrail(m, dt);
        if (m.t > 120) m.alive = false;
        continue;
      }

      const range = distKm(m, target);
      const rangeRate = (range - m.rangePrev) / dt;

      // 中制导数据链：由 guiderId 指定的那架飞机提供（可以是发射机，也可以是 A 射 B 导的友机）。
      // 断链后弹上只能靠惯导外推，瞄准线逐渐漂移（漂 2.5° 在 60 km 上就是 2.6 km）。
      const guider = w.aircraft.find(a => a.id === m.guiderId);
      const gDist = guider ? distKm(guider, m) : Infinity;
      m.datalinkOn = !!(guider && guider.alive && !m.seekerOn && gDist <= CONFIG.jam.dlRange);
      if (!m.datalinkOn && !m.seekerOn) {
        m.drift = Math.min(0.045, (m.drift || 0) + 0.004 * dt);
      }
      const los = bearing(m, target) + (m.drift || 0);

      // 高低弹道：远距先爬升，末段俯冲
      let wantAlt = target.alt;
      if (mt.loft && range > 35 && m.t < mt.burn + 40) {
        wantAlt = Math.min(24000, m.launchAlt + 11000);
      }
      const climb = clamp((wantAlt - m.alt) / 20, -300, 300);

      let dv = (thrust - drag) / mass;
      dv -= (G * climb) / Math.max(m.v, 100);
      m.v = Math.max(120, m.v + dv * dt);
      m.alt = clamp(m.alt + climb * dt, 60, 26000);

      // 比例导引（水平）：Vc 取接近率，但设下限，避免目标侧切（notch）时
      // 接近率趋零导致导弹失去修正能力、直飞掠过目标。
      const losRate = wrapPi(los - m.losPrev) / dt;
      const Vc = Math.max(350, -rangeRate + 0.25 * m.v);
      const aCmd = 3.6 * Vc * losRate;
      const aMax = mt.gMax * G;
      const aLat = clamp(aCmd, -aMax, aMax);
      const turn = clamp(aLat / Math.max(m.v, 120), -0.6, 0.6);
      m.hdg = wrapPi(m.hdg + turn * dt);

      m.losPrev = los;
      m.rangePrev = range;
      m.range = range;
      m.tti = range / Math.max(250, -rangeRate);
      m.phase = m.t < mt.burn ? 'boost' : (range < 26 ? 'terminal' : 'cruise');
      m.seekerOn = range < mt.seeker * 1.15;

      // 命中判定：引信杀伤半径 1 km（一帧位移可达数百米，必须留足余量）
      if (range < 1.0) {
        resolveHit(w, m, target);
        m.alive = false;
        continue;
      }
      // 自毁：燃尽后速度掉到 220 m/s 以下，说明已经没有机动/追击能力，
      // 再滑翔下去只会被目标「撞上」凑出虚假射程。
      if (m.t > 220 || (m.t > mt.burn + 0.5 && m.v < 220)) {
        m.alive = false;
        m.wasted = true;
        if (m.t > 6) logEvent(w, m.type.name + ' 未命中：耗尽能量自毁', m.side);
      }
      advance(m, dt);
      pushTrail(m, dt);
    }
    // 清理
    w.missiles = w.missiles.filter(m => m.alive);
  }

  function advance(m, dt) {
    m.x += (m.v * Math.cos(m.hdg) * dt) / 1000;
    m.y += (m.v * Math.sin(m.hdg) * dt) / 1000;
  }

  function pushTrail(m, dt) {
    m.trailAcc += dt;
    if (m.trailAcc >= 0.5) {
      m.trailAcc = 0;
      m.trail.push({ x: m.x, y: m.y });
      if (m.trail.length > 90) m.trail.shift();
    }
  }

  function resolveHit(w, m, target) {
    // 命中概率修正：目标处于 3/9 线（notch）、释放干扰、机动过载
    const los = bearing(target, m);
    const off = Math.abs(wrapPi(target.hdg - los)) / DEG;
    const notch = (off > 55 && off < 125) ? 0.80 : 1.0;
    const chaff = m.chaffed > 0 ? 0.85 : 1.0;
    // 末段能量：远界打出去的弹到跟前已经没速度了，Pk 应该明显下降；
    // 只有进入不可逃逸区、弹还有 800 m/s 以上时才是「一击必杀」。
    const energy = clamp((m.v - 200) / 700, 0.3, 1);
    // 目标自己的自卫干扰：导引头在强干扰下锁定距离和精度都会下降
    const tjp = target.pod ? PODS[target.pod] : null;
    const jamPen = (tjp && target.jamOn) ? (1 - 0.35 * tjp.seeker) : 1;
    const pk = m.type.pk * notch * chaff * energy * jamPen * (target.health > 50 ? 1 : 0.85);

    if (w.rng() < pk) {
      target.health -= 90 + Math.floor(w.rng() * 40);   // 90–129，通常一发致命
      if (target.health <= 0) {
        target.alive = false;
        target.health = 0;
        w.stats[m.side]++;
        const shooter = w.aircraft.find(a => a.id === m.shooterId);
        if (shooter) shooter.kills++;
        const kind = target.type.role === 'awacs' ? '预警机'
          : target.type.role === 'tanker' ? '加油机' : '';
        logEvent(w, m.type.name + ' 命中：' + target.callsign + (kind ? '（' + kind + '）' : '') +
          ' 被击落' + '（' + (shooter ? shooter.callsign : '?') + ' 战果）', m.side);
        w.effects.push({ x: target.x, y: target.y, t: 0, life: 2.5 });
      } else {
        logEvent(w, m.type.name + ' 命中：' + target.callsign + ' 重创', m.side);
      }
    } else {
      logEvent(w, m.type.name + ' 脱靶：' + target.callsign + '（干扰/机动）', m.side);
    }
    m.alive = false;
  }

  // ---------------------------------------------------------------------------
  // 加油
  // ---------------------------------------------------------------------------
  function stepRefuel(w, dt) {
    for (const tk of w.aircraft) {
      if (!tk.alive || tk.type.role !== 'tanker') continue;
      if (!tk.offload) tk.offload = tk.type.offload || 0;
      for (const ac of w.aircraft) {
        if (!ac.alive || ac.side !== tk.side || ac === tk) continue;
        if (ac.type.role === 'tanker') continue;
        const near = distKm(ac, tk) < CONFIG.refuelRadius &&
          Math.abs(ac.alt - tk.alt) < 1200;
        if (!near || ac.fuel >= ac.maxFuel * CONFIG.refuelCeiling || tk.offload <= 0) {
          if (ac.ai.refueling && !near) ac.ai.refueling = false;
          continue;
        }
        const amt = Math.min(tk.offload, (tk.type.offloadRate || 800) * dt, ac.maxFuel - ac.fuel);
        if (amt <= 0) continue;
        tk.offload -= amt;
        ac.fuel += amt;
        if (!ac.ai.refueling) {
          ac.ai.refueling = true;
          logEvent(w, ac.callsign + ' 开始空中加油（' + tk.callsign + '）', ac.side);
        }
        if (ac.fuel >= ac.maxFuel * CONFIG.refuelCeiling) {
          ac.ai.refueling = false;
          logEvent(w, ac.callsign + ' 加油完毕', ac.side);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 探测与数据链
  //
  // v0.3 起不再是「看见/看不见」的二元判断，而是每架敌机维护一条航迹
  // （w.tracks[side]），并带一个 0–1 的质量值：
  //   q >= 0.75  火控级确认：位置、高度、速度都可信
  //   0.35–0.75  模糊接触：能维持跟踪，但位置有误差、可能丢失
  //   < 0.35     记忆航迹：只剩最后已知位置，很快消失
  // 数据链（预警机在空）会把预警机的航迹融合进来，这是蓝方最大的信息优势。
  // ---------------------------------------------------------------------------
  // 某架飞机受到的干扰：敌方正在开机的吊舱，按距离与指向判断是否覆盖到它
  function jamOnAircraft(w, victim) {
    let best = null;
    for (const a of w.aircraft) {
      if (!a.alive || a.side === victim.side || !a.pod || !a.jamOn) continue;
      const p = PODS[a.pod];
      if (!p) continue;
      const d = distKm(a, victim);
      if (d > p.range) continue;
      const rel = Math.abs(wrapPi(bearing(a, victim) - a.hdg));
      if (rel > p.arc) continue;
      const s = p.power * (0.35 + 0.65 * (1 - d / p.range));
      if (!best || s > best.s) best = { s, p, from: a };
    }
    if (!best) return null;
    let s = best.s;
    if (victim.type.lpi) s *= CONFIG.jam.eccm;   // AESA 阵面有抗干扰增益
    return { level: Math.min(1.5, s), pod: best.p, from: best.from };
  }

  function stepDetection(w) {
    const C = CONFIG.trackQuality;
    for (const side of ['blue', 'red']) {
      const friends = w.aircraft.filter(a => a.side === side && a.alive);
      const enemies = w.aircraft.filter(a => a.side !== side && a.alive);
      const tracks = w.tracks[side];
      const seenNow = new Map();
      const awacs = friends.find(a => a.type.role === 'awacs');

      for (const f of friends) {
        if (f.type.role === 'tanker') continue;      // 加油机不承担对空搜索
        const jam = jamOnAircraft(w, f);
        f.jamEff = jam ? jam.level : 0;
        for (const e of enemies) {
          let R = f.type.radar * Math.pow(Math.max(0.4, e.rcs), 0.25)
            * (f.type.role === 'awacs' ? 1.0 : 0.95);
          if (jam) R *= Math.max(CONFIG.jam.minR, 1 - jam.pod.detect * Math.min(1.2, jam.level));
          const d = distKm(f, e);
          if (d > R) continue;
          const rel = Math.abs(wrapPi(bearing(f, e) - f.hdg)) / DEG;
          if (rel > f.type.radarFov) continue;
          // 距离越接近探测边界，质量越差：0.35R 内满分，之后线性下降到 0.35R
          const ratio = d / R;
          let q;
          if (ratio <= 0.35) q = 1;
          else q = clamp(1 - (ratio - 0.35) / 0.60 * 0.62, C.uncertain, 1);
          if (f.type.role === 'awacs') q = Math.min(1, q + 0.06);
          if (jam) q *= Math.max(CONFIG.jam.minQ, 1 - jam.pod.track * Math.min(1.2, jam.level));
          const prev = seenNow.get(e.id);
          if (!prev || q > prev.q) seenNow.set(e.id, { q, src: f.id, e });
        }
      }

      // 数据链本身也会被干扰：把预警机航迹共享给全队时，接收机一侧的干扰
      // 会让共享航迹掉质量（预警机自己不受影响，但队里被压制得越狠，共享越差）。
      let linkJam = 0;
      for (const f of friends) {
        if (f.type.role !== 'fighter' || !f.alive) continue;
        linkJam = Math.max(linkJam, f.jamEff || 0);
      }
      const linkPenalty = Math.max(0.35, 1 - 0.30 * Math.min(1.2, linkJam));

      for (const [id, s] of seenNow) {
        const e = s.e;
        let q = s.q;
        // src 是预警机 → 这条航迹是共享的，接收端被干扰就打折
        if (linkJam > 0 && awacs && s.src === awacs.id) q *= linkPenalty;
        const jitter = (1 - q) * 4.0;
        const ph = (id.charCodeAt(1) || 3) * 1.7;
        tracks.set(id, {
          id, q, t: w.t, src: s.src,
          x: e.x + Math.sin(w.t * 0.03 + ph) * jitter,
          y: e.y + Math.cos(w.t * 0.027 + ph) * jitter,
          alt: e.alt + Math.sin(w.t * 0.05 + ph) * jitter * 200,
          hdg: e.hdg, v: e.v, typeKey: e.typeKey, type: e.type, side: e.side
        });
      }
      // 没被更新到的航迹：质量衰减、位置冻结，超过保持时间就删除
      for (const [id, tr] of tracks) {
        if (seenNow.has(id)) continue;
        tr.q -= C.decay;
        if (tr.q < 0.12 || w.t - tr.t > C.hold) tracks.delete(id);
      }

      w.detected[side] = new Set();
      for (const [id, tr] of tracks) if (tr.q >= C.uncertain) w.detected[side].add(id);

      w.datalink[side] = !!awacs;
      w.support[side] = {
        awacs: !!awacs,
        tanker: friends.some(a => a.type.role === 'tanker')
      };

      // 兼容旧渲染/日志：保留最后已知位置
      const ghosts = w.ghosts[side];
      for (const e of enemies) {
        if (w.detected[side].has(e.id)) ghosts.set(e.id, { x: e.x, y: e.y, t: w.t });
        else if (ghosts.has(e.id)) {
          const g = ghosts.get(e.id);
          if (w.t - g.t > C.hold) ghosts.delete(e.id);
        }
      }
    }
    updateMissileVisibility(w);
  }

  // 导弹对每一方的可见性：自己发射的当然看得见；敌方导弹只有被雷达
  // （预警机 40 km / 战斗机 18 km）发现、或导引头开机被 RWR 感知后才出现。
  // 发射瞬间只有被攻击方收到告警——其余友机不会立刻知道。
  function updateMissileVisibility(w) {
    for (const m of w.missiles) {
      if (!m.alive) continue;
      if (!m.seen) m.seen = { blue: false, red: false };
      if (!m.warned) m.warned = { blue: false, red: false };
      const target = w.aircraft.find(a => a.id === m.targetId);
      for (const side of ['blue', 'red']) {
        if (m.side === side) { m.seen[side] = true; m.warned[side] = true; continue; }
        let seen = !!m.seen[side];
        if (!seen && target && target.alive && target.side === side && m.seekerOn) seen = true;
        if (!seen) {
          for (const f of w.aircraft) {
            if (!f.alive || f.side !== side || f.type.role === 'tanker') continue;
            const R = f.type.role === 'awacs' ? CONFIG.missileRadarRange : CONFIG.missileFighterRange;
            if (distKm(f, m) > R) continue;
            const rel = Math.abs(wrapPi(bearing(f, m) - f.hdg)) / DEG;
            if (rel > f.type.radarFov) continue;
            seen = true;
            break;
          }
        }
        m.seen[side] = seen;
        if (seen) m.warned[side] = true;
      }
    }
  }

  function isTracked(w, side, enemyId) {
    const tr = w.tracks[side].get(enemyId);
    return !!tr && tr.q >= 0.45;   // 可交战的航迹质量门槛（低于此只能看，不能打）
  }

  function trackOf(w, side, enemyId) {
    return w.tracks[side].get(enemyId) || null;
  }

  // AI 用：只返回质量足够、可以据此分配火力的目标（真机对象，便于算距离）
  function enemyTracks(w, side) {
    return w.aircraft.filter(a => a.alive && a.side !== side && isTracked(w, side, a.id)
      && (w.tracks[side].get(a.id).q >= 0.45));
  }

  function missileKnown(w, side, m) {
    return !!(m.seen && m.seen[side]) || !!(m.warned && m.warned[side]);
  }

  // ---------------------------------------------------------------------------
  // 事件、胜负
  // ---------------------------------------------------------------------------
  function logEvent(w, text, side) {
    w.events.push({ t: w.t, text, side });
    if (w.events.length > 240) w.events.shift();
  }

  function ammoOf(ac) {
    let n = 0;
    for (const k in ac.missiles) n += ac.missiles[k];
    return n;
  }

  function decide(w, timeout) {
    const blue = w.aircraft.filter(a => a.side === 'blue' && a.alive);
    const red = w.aircraft.filter(a => a.side === 'red' && a.alive);
    // 先比战果（击落数），再比战斗机存活率；预警机/加油机不计入存活率，
    // 否则机队规模大的一方永远赢。
    const frac = side => {
      const all = w.aircraft.filter(a => a.side === side && a.type.role === 'fighter');
      if (!all.length) return 0;
      return all.filter(a => a.alive).length / all.length;
    };
    let winner = 'draw';
    if (w.stats.blue !== w.stats.red) {
      winner = w.stats.blue > w.stats.red ? 'blue' : 'red';
    } else if (blue.length === 0 && red.length > 0) winner = 'red';
    else if (red.length === 0 && blue.length > 0) winner = 'blue';
    else {
      const fb = frac('blue'), fr = frac('red');
      if (Math.abs(fb - fr) > 0.02) winner = fb > fr ? 'blue' : 'red';
    }
    w.result = { winner, t: w.t, timeout: !!timeout };
    return w.result;
  }

  function checkEnd(w) {
    if (w.result) return;
    const blue = w.aircraft.filter(a => a.side === 'blue' && a.alive);
    const red = w.aircraft.filter(a => a.side === 'red' && a.alive);
    if (blue.length === 0 && red.length === 0) w.result = { winner: 'draw', t: w.t };
    else if (blue.length === 0) w.result = { winner: 'red', t: w.t };
    else if (red.length === 0) w.result = { winner: 'blue', t: w.t };
    else {
      // 一方战斗机全部被击落、且空中没有还在飞的导弹：空战已经分出胜负，
      // 剩下的预警机/加油机只会掉头脱离，不必再追十分钟。
      const bf = blue.filter(a => a.type.role === 'fighter');
      const rf = red.filter(a => a.type.role === 'fighter');
      if (w.missiles.length === 0) {
        if (bf.length === 0) { w.result = { winner: 'red', t: w.t, swept: true }; return; }
        if (rf.length === 0) { w.result = { winner: 'blue', t: w.t, swept: true }; return; }
      }
      // 双方战斗机都没弹了、空中也没有导弹：再等一会儿按现有战果判定，
      // 不要把最后十几分钟浪费在双方兜圈子上。
      const fighters = w.aircraft.filter(a => a.alive && a.type.role === 'fighter');
      const dry = w.missiles.length === 0 && w.t - (w.lastShot || 0) > 90 &&
        fighters.every(a => ammoOf(a) === 0);
      if (dry) {
        decide(w, false);
        if (w.result) { w.result.dry = true; w.result.reason = '双方弹药耗尽'; }
        return;
      }
      // 打完了：很久没有发射、空中也没有导弹（双方都在返航/脱离），按战果判定。
      if (w.lastShot && w.missiles.length === 0 && w.t - w.lastShot > 240) {
        decide(w, false);
        if (w.result) { w.result.idle = true; w.result.reason = '双方脱离接触'; }
        return;
      }
      if (w.t >= CONFIG.engageTimeout) decide(w, true);
    }
  }

  // ---------------------------------------------------------------------------
  // 火控锁定：谁在照谁
  //   ac.guiding   本机火控雷达正在照射的目标 id
  //   ac.lockedBy  有多少架敌机在照自己
  //   ac.lockWarn  其中被自己 RWR 察觉到的数量（低可截获雷达可能察觉不到）
  // ---------------------------------------------------------------------------
  function updateLocks(w) {
    const C = CONFIG;
    for (const a of w.aircraft) {
      if (!a.alive) continue;
      a.guiding = null;
      a.links = [];
      a.radarMode = 'lpi';
      a.lockedBy = 0;
      a.lockedByLpi = 0;
      a.lockWarn = 0;
      a.lockSources = [];
    }

    for (const sh of w.aircraft) {
      if (!sh.alive || sh.type.role !== 'fighter') continue;
      const tracks = w.tracks[sh.side];
      if (!tracks) continue;
      const radar = sh.type.radar * 1.05;

      // 需要中制导支持的目标：本机还有导弹在飞、且导引头尚未开机
      const needStt = new Set();
      for (const m of w.missiles) {
        if (!m.alive || m.shooterId !== sh.id || m.seekerOn) continue;
        needStt.add(m.targetId);
      }

      const links = [];
      const addLink = (id, mode) => {
        const tr = tracks.get(id);
        if (!tr || tr.q < C.trackQuality.uncertain) return;
        if (Math.hypot(tr.x - sh.x, tr.y - sh.y) > radar) return;
        if (links.some(l => l.id === id)) return;
        links.push({ id, mode });
      };

      // 中制导目标一定用 STT（需要连续照射）；被干扰时可能打不成 STT，只能退回 LPI
      const jam = jamOnAircraft(w, sh);
      sh.jamEff = jam ? jam.level : 0;
      for (const id of needStt) {
        if (jam && w.rng() < jam.pod.stt * Math.min(1.2, jam.level)) { addLink(id, 'lpi'); continue; }
        addLink(id, 'stt');
      }

      const primary = sh.ai && sh.ai.targetId;
      const canStt = sh.orders.mode !== 'rtb' && sh.fuel > sh.maxFuel * 0.10;
      if (primary) {
        const tr = tracks.get(primary);
        const d = tr ? Math.hypot(tr.x - sh.x, tr.y - sh.y) : Infinity;
        // 进入 55 km 且还有弹、没有在返航时才转火控照射；更远只做 LPI 跟踪
        addLink(primary, canStt && tr && tr.q >= 0.45 && d <= 55 ? 'stt' : 'lpi');
      }

      // 多目标跟踪：再带两条最近的 LPI 航迹，体现相控阵的多目标能力
      let extra = 0;
      for (const [id, tr] of tracks) {
        if (extra >= 2) break;
        if (id === primary || needStt.has(id)) continue;
        if (tr.q < C.trackQuality.uncertain) continue;
        if (Math.hypot(tr.x - sh.x, tr.y - sh.y) > radar) continue;
        links.push({ id, mode: 'lpi' });
        extra++;
      }

      sh.links = links;
      sh.radarMode = links.some(l => l.mode === 'stt') ? 'stt' : 'lpi';
      const stt = links.find(l => l.mode === 'stt');
      sh.guiding = stt ? stt.id : null;

      // 被照射方：STT 全向可被 RWR 察觉，LPI 只有很近才听得到
      for (const l of links) {
        const tgt = w.aircraft.find(x => x.id === l.id && x.alive);
        if (!tgt) continue;
        tgt.lockedBy++;
        if (l.mode === 'lpi') tgt.lockedByLpi++;
        const reach = l.mode === 'stt'
          ? C.rwrRange
          : C.rwrRange * (sh.type.lpi ? C.lpiFactor : 1);
        const d = Math.hypot(tgt.x - sh.x, tgt.y - sh.y);
        if (d <= reach) {
          tgt.lockWarn++;
          tgt.lockSources.push(sh.id);
        }
      }
    }
    // ---- A 射 B 导：给还在中制导段的导弹分配制导机 ----
    const guideLoad = new Map();
    for (const m of w.missiles) {
      if (!m.alive || m.seekerOn) continue;
      const tgt = w.aircraft.find(a => a.id === m.targetId && a.alive);
      if (!tgt) { m.guiderId = null; m.datalinkOn = false; continue; }
      let pick = null;
      if (m.guiderManual) {
        const g = w.aircraft.find(a => a.id === m.guiderManual);
        if (g && canGuide(w, g, tgt) && (guideLoad.get(g.id) || 0) < CONFIG.jam.maxPerSide) pick = g;
      }
      if (!pick) {
        const shooter = w.aircraft.find(a => a.id === m.shooterId);
        const order = [];
        if (shooter) order.push(shooter);
        for (const a of w.aircraft) {
          if (a === shooter || a.side !== m.side) continue;
          order.push(a);
        }
        order.sort((a, b) => distKm(a, m) - distKm(b, m));
        for (const g of order) {
          if (!canGuide(w, g, tgt)) continue;
          if (distKm(g, m) > CONFIG.jam.dlRange) continue;
          if ((guideLoad.get(g.id) || 0) >= CONFIG.jam.maxPerSide) continue;
          pick = g;
          break;
        }
      }
      m.guiderId = pick ? pick.id : null;
      m.datalinkOn = false;
      if (pick) {
        guideLoad.set(pick.id, (guideLoad.get(pick.id) || 0) + 1);
        if (pick.id !== m.shooterId && !m.handoff) {
          m.handoff = true;
          logEvent(w, 'A 射 B 导：' + pick.callsign + ' 接手 ' +
            (w.aircraft.find(a => a.id === m.shooterId) || { callsign: '?' }).callsign + ' 的弹', m.side);
        }
      }
    }
  }

  // 制导资格：活着、不是加油机、对目标有足够质量的航迹且在雷达范围内；
  // 战斗机必须是 STT 照射者，预警机可以用高质量的 LPI 航迹做中制导。
  function canGuide(w, g, tgt) {
    if (!g.alive || g.type.role === 'tanker') return false;
    const tr = w.tracks[g.side] && w.tracks[g.side].get(tgt.id);
    if (!tr) return false;
    if (Math.hypot(tr.x - g.x, tr.y - g.y) > g.type.radar * 1.05) return false;
    if (g.type.role === 'awacs') return tr.q >= 0.55;
    return tr.q >= 0.45 && (g.links || []).some(l => l.id === tgt.id && l.mode === 'stt');
  }
  function stepWorld(w, dt) {
    if (w.result) return;
    const ai = root.BVR.ai;
    for (const ac of w.aircraft) {
      if (!ac.alive) continue;
      if (ai) ai.think(w, ac, dt);
      flyAircraft(w, ac, dt);
    }
    // 每 0.5 s 更新一次探测
    w.detectAcc = (w.detectAcc || 0) + dt;
    if (w.detectAcc >= 0.5) { stepDetection(w); updateLocks(w); w.detectAcc = 0; }
    stepMissiles(w, dt);
    stepRefuel(w, dt);
    for (const e of w.effects) e.t += dt;
    if (w.effects.length) w.effects = w.effects.filter(e => e.t < e.life);
    w.t += dt;
    checkEnd(w);
  }

  function run(w, seconds, dt) {
    const step = dt || 0.25;
    for (let i = 0; i < seconds / step; i++) stepWorld(w, step);
    return w;
  }

  root.BVR = root.BVR || {};
  root.BVR.sim = {
    createWorld, stepWorld, run, fireMissile,
    performance, distance: distKm, bearing, wrapPi, clamp, fmtTime,
    isTracked, trackOf, enemyTracks, missileKnown, logEvent, loadoutFor, loadEffects,
    updateLocks,
    // 供离线测试使用
    _internals: {
      makeAircraft, stepMissiles, stepDetection, updateMissileVisibility,
      flyAircraft, performance, stepRefuel
    }
  };
  root.BVR.SIM_CONST = { G, DEG };
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * BVR COMMAND — 自主作战 AI
 *
 * 每架飞机每隔 0.4–1.0 s 重新决策一次，输出 ac.cmd = {hdg, alt, mach}。
 * 玩家的指令（高度/马赫/目标/开火权限/规避/返航）都会写进 ac.orders，
 * AI 在此基础上执行，因此「玩家下指令 + 飞机自主」是同一套逻辑。
 *
 * v0.2：加油机调度、预警机/加油机被猎杀时的规避、更细的发射时机、
 *       防御中还手、油量红线。
 */
(function (root) {
  'use strict';

  const sim = root.BVR.sim;
  const MISSILES = root.BVR.MISSILES;
  const LOADOUTS = root.BVR.LOADOUTS;

  const DEG = Math.PI / 180;
  const G = 9.80665;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  const HOME = { blue: { x: -280, y: 0 }, red: { x: 280, y: 0 } };

  function think(w, ac, dt) {
    ac.ai.think -= dt;
    if (ac.ai.think > 0 && ac.cmd) return;
    ac.ai.think = 0.4 + w.rng() * 0.6;

    updateJam(w, ac);
    if (ac.type.role === 'awacs') return thinkSupport(w, ac, 'awacs');
    if (ac.type.role === 'tanker') return thinkSupport(w, ac, 'tanker');
    return thinkFighter(w, ac);
  }

  // 电子战：被锁定、有弹来袭、或敌机进入雷达探测圈附近就开机；
  // 玩家手动开关时（orders.jamManual != null）以玩家为准。
  function updateJam(w, ac) {
    if (!ac.pod) { ac.jamOn = false; return; }
    if (ac.orders.jamManual != null) { ac.jamOn = !!ac.orders.jamManual; return; }
    const inbound = nearestInbound(w, ac);
    let near = 1e9;
    for (const a of w.aircraft) {
      if (!a.alive || a.side === ac.side) continue;
      const d = sim.distance(ac, a);
      if (d < near) near = d;
    }
    ac.jamOn = ac.lockWarn > 0 || !!inbound || near < 210;
  }

  // ---------------------------------------------------------------------------
  // 支援机：预警机跑道形盘旋，加油机在后方定点盘旋；敌机逼近就后撤
  // ---------------------------------------------------------------------------
  function thinkSupport(w, ac, role) {
    const home = HOME[ac.side];
    const threats = sim.enemyTracks(w, ac.side);
    let nearest = null, nd = 1e9;
    for (const t of threats) {
      if (t.type.role === 'tanker') continue;
      const d = sim.distance(ac, t);
      if (d < nd) { nd = d; nearest = t; }
    }

    // 有导弹飞来：掉头拉开，别做 3/9 线（大飞机没那个过载）
    const inbound = nearestInbound(w, ac);
    if (inbound && sim.distance(ac, inbound) < 90) {
      ac.cmd = {
        hdg: sim.bearing(inbound, ac),
        alt: Math.max(6000, ac.alt - 1200),
        mach: 0.82
      };
      return;
    }

    const danger = role === 'awacs' ? 230 : 190;
    if (nearest && nd < danger) {
      const away = Math.atan2(ac.y - nearest.y, ac.x - nearest.x);
      ac.cmd = { hdg: away, alt: role === 'awacs' ? 10000 : 9000, mach: 0.8 };
      return;
    }

    // 加油机：有友机低油就主动靠过去（但保持在威胁圈外）
    if (role === 'tanker') {
      let needy = null, nd2 = 1e9;
      for (const a of w.aircraft) {
        if (!a.alive || a.side !== ac.side || a.type.role !== 'fighter') continue;
        if (a.fuel > a.maxFuel * 0.3) continue;
        if (nearest && sim.distance(a, nearest) < 120) continue;
        const d = sim.distance(ac, a);
        if (d < nd2) { nd2 = d; needy = a; }
      }
      if (needy && nd2 > 10) {
        ac.cmd = { hdg: sim.bearing(ac, needy), alt: needy.alt, mach: 0.78 };
        return;
      }
    }

    // 绕 home 做椭圆盘旋
    const ang = Math.atan2(ac.y - home.y, ac.x - home.x);
    const target = {
      x: home.x + Math.cos(ang + 0.45) * 32,
      y: home.y + Math.sin(ang + 0.45) * 32
    };
    ac.cmd = {
      hdg: sim.bearing(ac, target),
      alt: ac.orders.altManual ? ac.orders.alt : (role === 'awacs' ? 9000 : 9500),
      mach: 0.7
    };
  }

  // ---------------------------------------------------------------------------
  // 战斗机
  // ---------------------------------------------------------------------------
  function thinkFighter(w, ac) {
    // 0) 油量红线：除非导弹已经贴脸，否则先脱离保命
    const fuelPct = ac.fuel / ac.maxFuel;
    const inbound0 = findInbound(w, ac);
    if (fuelPct < 0.07 && !(inbound0 && sim.distance(ac, inbound0) < 25)) {
      const tk0 = nearestTanker(w, ac);
      if (tk0 && sim.distance(ac, tk0) < 60) {
        ac.cmd = { hdg: sim.bearing(ac, tk0), alt: tk0.alt, mach: 0.8 };
        return;
      }
      const home = HOME[ac.side];
      ac.cmd = { hdg: sim.bearing(ac, home), alt: 8000, mach: 0.78 };
      return;
    }

    // 1) 规避优先
    const inbound = findInbound(w, ac);
    if (ac.orders.mode === 'evade' || inbound) {
      if (inbound || w.t < ac.ai.defendUntil) {
        ac.ai.defendUntil = Math.max(ac.ai.defendUntil, w.t + 6);
        defend(w, ac, inbound);
        returnFire(w, ac);          // 边规避边还手，否则先手方滚雪球
        return;
      }
    }
    if (w.t > ac.ai.defendUntil) ac.ai.maneuver = null;

    // 2) 油量见底 / 玩家下令加油：找加油机
    if (ac.orders.mode === 'refuel' && ac.fuel >= ac.maxFuel * 0.9) {
      ac.orders.mode = 'auto';       // 加满了自动解除
    }
    const lowFuel = ac.fuel < ac.maxFuel * 0.18 || ac.orders.mode === 'refuel';
    if (lowFuel && ac.orders.mode !== 'rtb') {
      const tk = nearestTanker(w, ac);
      if (tk) {
        const d = sim.distance(ac, tk);
        if (d > 10) {
          ac.cmd = { hdg: sim.bearing(ac, tk), alt: tk.alt, mach: 0.78 };
        } else {
          // 在加油机附近盘旋等待对接
          const ang = Math.atan2(ac.y - tk.y, ac.x - tk.x) + 0.6;
          ac.cmd = {
            hdg: Math.atan2(Math.sin(ang), Math.cos(ang)),
            alt: tk.alt,
            mach: 0.62
          };
        }
        return;
      }
      // 没有可用加油机：直接返航
      const home = HOME[ac.side];
      ac.cmd = { hdg: sim.bearing(ac, home), alt: 8000, mach: 0.82 };
      return;
    }

    // 3) 返航
    if (ac.orders.mode === 'rtb' || totalMissiles(ac) === 0) {
      const home = HOME[ac.side];
      ac.cmd = { hdg: sim.bearing(ac, home), alt: 7000, mach: 0.82 };
      return;
    }

    // 4) 玩家指定航路点
    if (ac.orders.waypoint) {
      const d = Math.hypot(ac.orders.waypoint.x - ac.x, ac.orders.waypoint.y - ac.y);
      if (d < 8) ac.orders.waypoint = null;
      else {
        ac.cmd = {
          hdg: sim.bearing(ac, ac.orders.waypoint),
          alt: ac.orders.alt, mach: ac.orders.mach
        };
        return;
      }
    }

    // 5) 选目标
    const target = pickTarget(w, ac);
    const prevTarget = ac.ai.targetId;
    ac.ai.targetId = target ? target.id : null;
    if (ac.ai.targetId !== prevTarget) ac.ai.longShots = 0;

    if (!target) {
      updateDoctrine(w, ac, null);
      // 无目标：有敌预警机/加油机接触就压上去（纵深打击），否则朝敌方一侧巡航
      const support = enemySupportTrack(w, ac);
      if (support) {
        ac.cmd = {
          hdg: sim.bearing(ac, support),
          alt: ac.orders.altManual ? ac.orders.alt : 10000,
          mach: 0.88
        };
      } else {
        const dir = ac.side === 'blue' ? 0 : Math.PI;
        ac.cmd = { hdg: dir, alt: ac.orders.alt, mach: ac.orders.mach };
      }
      return;
    }

    // 6) 接近 + 开火
    const range = sim.distance(ac, target);
    updateDoctrine(w, ac, target);
    const alt = desiredAlt(ac, target, range);
    let hdg = leadHeading(ac, target);
    // 远距压制射击后做一段侧转（crank），保持雷达接触的同时把对方导弹甩到侧后方
    if (ac.ai.crankUntil && w.t < ac.ai.crankUntil) {
      const side = (ac.id.charCodeAt(1) % 2) ? 1 : -1;
      hdg = sim.wrapPi(hdg + side * 0.42);
    }
    ac.cmd = { hdg, alt, mach: ac.orders.mach };

    if (ac.orders.roe !== 'free') return;
    const longshot = ac.ai.role === 'longshot';
    // 带远距弹的飞机先把远距弹打完：射速更快、允许两发连续
    if (w.t - ac.ai.lastLaunch < (longshot ? 1.8 : 2.6)) return;
    if (!sim.isTracked(w, ac.side, target.id)) return;

    const key = bestMissile(ac, range);
    if (!key) return;

    // 同时在空中（本机）的导弹不超过 2 枚；同目标全队不超过 3 枚
    let mine = 0, onTarget = 0;
    for (const m of w.missiles) {
      if (!m.alive) continue;
      if (m.shooterId === ac.id) mine++;
      if (m.targetId === target.id && m.side === ac.side) onTarget++;
    }
    if (mine >= 2 || onTarget >= 3) return;

    const mt = MISSILES[key];
    const ref = mt.launchRef || mt.rangeRef;

    // 发射包线（运动学极限的比例）：
    //   远距压制 0.60–0.78：在远界就打，逼对方转防御、消耗能量
    //   主攻机   0.30–0.38：等目标进入不可逃逸区再打，追求一击必杀
    // 能量优势（高度、速度）会显著放宽包线——高空高速发射的弹本来就更远。
    const bigTarget = target.type.role !== 'fighter';
    let f;
    if (longshot) f = alt > 8000 ? 0.45 : 0.38;
    else f = alt > 8000 ? 0.40 : 0.32;

    const altAdv = ac.alt - target.alt;
    if (altAdv > 5000) f += 0.16;
    else if (altAdv > 2500) f += 0.10;
    else if (altAdv > 1000) f += 0.04;
    if (ac.v - target.v > 150) f += 0.05;
    if (bigTarget) f += longshot ? 0.10 : 0.12;

    // 迎头/侧向可以打，尾追（目标在跑）要求更近：冷目标把导弹的能量全耗在追击上
    const toTarget = sim.bearing(ac, target);
    const away = Math.cos(target.hdg - toTarget) * target.v;
    const closing = -away;                    // >0 = 正在接近
    if (closing < 0) f *= 0.55;
    else if (closing < 120) f *= 0.8;

    if (longshot) {
      // 远距压制不要求接近率：目标越躲，越要让它一直处在防御状态
      if (range > ref * f || range < 6) return;
    } else {
      if (closing < 50 && range > 45) return; // 追不上，别把主攻弹打空
      if (range > ref * f || range < 6) return;
      // 目标正在被己方导弹攻击且尚未进入必杀区：等结果
      const targetDefending = w.missiles.some(m => m.alive && m.targetId === target.id &&
        m.side === ac.side && sim.distance(m, target) > 18);
      if (targetDefending && range > ref * f * 0.9) return;
    }

    const rmin = key === 'r37m' ? 25 : 6;
    if (range < rmin) return;

    if (sim.fireMissile(w, ac, target.id, key)) {
      ac.ai.lastLaunch = w.t;
      if (longshot) {
        ac.ai.crankUntil = w.t + 7;
        ac.ai.longShots = (ac.ai.longShots || 0) + 1;
      }
    }
  }

  // 角色不是按空重定的，而是按「手里有什么弹、现在占不占能量优势」：
  //   射程比对方可能带的弹远 20 km 以上 → 远距压制，先在远界把远弹打完
  //   对目标有 2500 m 以上高度优势 → 高位主攻，包线自然放宽
  //   其余 → 主攻，等不可逃逸区
  function bestRangeOf(typeKey) {
    const los = LOADOUTS[typeKey] || [];
    let best = 0;
    for (const L of los) for (const k in L.missiles) best = Math.max(best, MISSILES[k].rangeRef);
    return best;
  }

  function updateDoctrine(w, ac, target) {
    if (ac.type.role !== 'fighter') return;
    let myBest = 0;
    for (const k in ac.missiles) {
      if (ac.missiles[k] > 0) myBest = Math.max(myBest, MISSILES[k].rangeRef);
    }
    const foeBest = target && target.typeKey ? bestRangeOf(target.typeKey) : 0;
    const altAdv = target ? ac.alt - target.alt : 0;
    // 远界弹每次交战最多甩两发：目的是逼对方转防御，不是把弹打光；
    // 两发之后回到主攻逻辑，进入不可逃逸区再打。
    const longLeft = (ac.ai.longShots || 0) < 2;
    if (myBest >= 150 && longLeft) {
      ac.ai.role = 'longshot';
      ac.ai.roleName = '远距压制';
    } else if (altAdv >= 2500) {
      ac.ai.role = 'advantage';
      ac.ai.roleName = '高位主攻';
    } else {
      ac.ai.role = 'strike';
      ac.ai.roleName = '主攻';
    }
  }

  function totalMissiles(ac) {
    let n = 0;
    for (const k in ac.missiles) n += ac.missiles[k];
    return n;
  }

  function nearestTanker(w, ac) {
    let best = null, bd = 1e9;
    for (const a of w.aircraft) {
      if (!a.alive || a.side !== ac.side || a.type.role !== 'tanker') continue;
      if (a.offload !== undefined && a.offload <= 0) continue;
      const d = sim.distance(ac, a);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  function bestMissile(ac, range) {
    // 中远距只打雷达弹；红外弹留到 10 km 内（迎头 12 km 打 IR 基本追不上）
    const keys = Object.keys(ac.missiles).filter(k => ac.missiles[k] > 0);
    if (!keys.length) return null;
    const bvr = keys.filter(k => MISSILES[k].rangeRef > 60)
      .sort((a, b) => MISSILES[b].rangeRef - MISSILES[a].rangeRef);
    const wvr = keys.filter(k => MISSILES[k].rangeRef <= 60)
      .sort((a, b) => MISSILES[b].rangeRef - MISSILES[a].rangeRef);
    if (range > 8) return bvr.length ? bvr[0] : null;
    if (wvr.length) return wvr[0];
    return bvr.length ? bvr[0] : null;
  }

  // 防御中仍可还手：包线收缩到 0.45/0.38，且本机只留一枚在空
  function returnFire(w, ac) {
    if (ac.orders.roe !== 'free') return;
    if (w.t - ac.ai.lastLaunch < 4.0) return;
    const target = pickTarget(w, ac);
    if (!target) return;
    if (!sim.isTracked(w, ac.side, target.id)) return;
    const range = sim.distance(ac, target);
    if (range < 6) return;
    const key = bestMissile(ac, range);
    if (!key) return;
    let mine = 0;
    for (const m of w.missiles) if (m.alive && m.shooterId === ac.id) mine++;
    if (mine >= 1) return;
    // 规避中仍优先把远距弹甩出去，不让对方白打
    const longshot = ac.ai.role === 'longshot';
    const f = longshot ? (ac.alt > 8000 ? 0.62 : 0.52) : (ac.alt > 8000 ? 0.45 : 0.38);
    const ref = MISSILES[key].launchRef || MISSILES[key].rangeRef;
    if (range > ref * f) return;
    if (sim.fireMissile(w, ac, target.id, key)) ac.ai.lastLaunch = w.t;
  }

  function pickTarget(w, ac) {
    const tracks = sim.enemyTracks(w, ac.side);
    if (!tracks.length) return null;

    // 玩家指定目标优先
    const o = ac.orders.target;
    if (o) {
      const t = tracks.find(a => a.id === o);
      if (t) return t;
    }

    let best = null, bestScore = 1e9;
    for (const t of tracks) {
      const d = sim.distance(ac, t);
      let score = d;
      if (t.type.role === 'awacs') score -= 220;          // 预警机高价值，值得纵深突击
      else if (t.type.role === 'tanker') score -= 90;      // 加油机次之
      if (t.health < 60) score -= 30;                     // 补刀
      if (t.id === ac.ai.targetId) score -= 15;           // 保持目标稳定
      // 已经被别人盯上的目标降权，避免全队挤一个
      const attackers = w.missiles.filter(m => m.alive && m.targetId === t.id).length;
      score += attackers * 18;
      if (score < bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  function enemySupportTrack(w, ac) {
    const tracks = sim.enemyTracks(w, ac.side);
    let best = null, bd = 1e9;
    for (const t of tracks) {
      if (t.type.role === 'fighter') continue;
      const d = sim.distance(ac, t);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  function desiredAlt(ac, target, range) {
    // 玩家手动指定高度时优先执行，AI 不再自作主张
    if (ac.orders.altManual) return ac.orders.alt;
    // 按距离分档：远距占高度（导弹射程随高度增加），进入交战区逐步下降，
    // 近距压到中低空换取机动能量；每架飞机再加一点偏置，避免全队一条线。
    let alt;
    if (range > 115) alt = 11500;
    else if (range > 85) alt = 10600;
    else if (range > 60) alt = 9600;
    else if (range > 38) alt = 8400;
    else alt = 7000;
    // 目标明显高/低于自己时做垂直机动，而不是平飞对撞
    if (range > 50 && target.alt > ac.alt + 3500) alt = Math.min(13500, target.alt + 700);
    else if (range < 65 && target.alt < ac.alt - 4000) alt = Math.max(4600, target.alt + 2600);
    alt += ac.ai.altBias || 0;
    return Math.round(clamp(alt, 3200, 15000) / 250) * 250;
  }

  function leadHeading(ac, target) {
    // 简单提前量：按目标速度与导弹平均速度估算交汇点
    const dist = sim.distance(ac, target);
    const vMissile = 700;
    const tof = Math.min(120, dist / vMissile);
    const px = target.x + Math.cos(target.hdg) * target.v * tof / 1000;
    const py = target.y + Math.sin(target.hdg) * target.v * tof / 1000;
    return Math.atan2(py - ac.y, px - ac.x);
  }

  // ---------------------------------------------------------------------------
  // 防御
  // ---------------------------------------------------------------------------
  function findInbound(w, ac) {
    let best = null, bd = 1e9;
    for (const m of w.missiles) {
      if (!m.alive || m.side === ac.side || m.targetId !== ac.id) continue;
      // 只有被攻击方知道有弹来袭（RWR 告警）；别的友机不会立刻知道
      if (!sim.missileKnown(w, ac.side, m)) continue;
      const d = sim.distance(ac, m);
      if (d < 70 && d < bd) { bd = d; best = m; }
    }
    return best;
  }

  function nearestInbound(w, ac) {
    let best = null, bd = 1e9;
    for (const m of w.missiles) {
      if (!m.alive || m.side === ac.side) continue;
      if (m.targetId !== ac.id && !(m.seen && m.seen[ac.side])) continue;
      const d = sim.distance(ac, m);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // 防御：水平与垂直机动组合
  //   远距：3/9 线（notch）、俯冲脱离、加速脱离、必要时垂直爬升
  //   中距：3/9 线、俯冲、急转
  //   近距：急转（break）、半滚倒转（split-S）、3/9 线
  // 每种机动保持 4–8 s，期间不断更新目标航向，避免每帧抖动。
  // ---------------------------------------------------------------------------
  const MANEUVERS = {
    crank:  { name: '侧转消耗', turn: 55,  dAlt: -400,  mach: 1.05 },
    notch:  { name: '3/9 线',   turn: 90,  dAlt: -900,  mach: 1.02 },
    dive:   { name: '俯冲脱离', turn: 150, dAlt: -3600, mach: 1.12 },
    extend: { name: '加速脱离', turn: 178, dAlt: -1200, mach: 1.16 },
    break:  { name: '急转',     turn: 115, dAlt: -1600, mach: 1.10 },
    splitS: { name: '半滚倒转', turn: 180, dAlt: -4800, mach: 1.18 },
    climb:  { name: '垂直爬升', turn: 55,  dAlt: 2400,  mach: 0.95 }
  };

  function chooseManeuver(w, ac, d) {
    const r = w.rng();
    let kind;
    if (d > 45) {
      // 远距：主要做侧转（crank），保持接近率、别把高度和速度全扔了
      kind = r < 0.50 ? 'crank' : r < 0.72 ? 'notch' : r < 0.90 ? 'dive' : 'climb';
    } else if (d > 14) {
      kind = r < 0.34 ? 'crank' : r < 0.58 ? 'notch' : r < 0.80 ? 'dive' : r < 0.92 ? 'break' : 'extend';
    } else {
      kind = r < 0.40 ? 'break' : r < 0.64 ? 'splitS' : r < 0.84 ? 'notch' : 'dive';
    }
    // 高度/能量约束：太低不能半滚倒转，太高不必再爬
    if (kind === 'splitS' && ac.alt < 5200) kind = 'break';
    if (kind === 'climb' && ac.alt > 12500) kind = 'notch';

    const mv = Object.assign({ kind }, MANEUVERS[kind]);
    mv.until = w.t + 4 + w.rng() * 4;
    return mv;
  }

  function defend(w, ac, missile) {
    const m = missile || nearestInbound(w, ac);
    if (!m) {
      ac.ai.maneuver = null;
      ac.orders.mode = ac.orders.mode === 'evade' ? 'auto' : ac.orders.mode;
      return;
    }

    const d = sim.distance(ac, m);
    const mb = sim.bearing(ac, m);

    if (!ac.ai.maneuver || w.t > ac.ai.maneuverUntil) {
      ac.ai.maneuver = chooseManeuver(w, ac, d);
      ac.ai.maneuverUntil = ac.ai.maneuver.until;
    }
    const mv = ac.ai.maneuver;

    // 水平转弯：notch/break 选转得少的一侧，其余随机左右
    let side;
    if (mv.kind === 'notch' || mv.kind === 'break' || mv.kind === 'crank') {
      const left = sim.wrapPi(mb + mv.turn * DEG);
      const right = sim.wrapPi(mb - mv.turn * DEG);
      side = Math.abs(sim.wrapPi(left - ac.hdg)) < Math.abs(sim.wrapPi(right - ac.hdg)) ? 1 : -1;
    } else {
      side = (ac.id.charCodeAt(2) + Math.floor(w.t / 7)) % 2 ? 1 : -1;
    }
    const hdg = sim.wrapPi(mb + mv.turn * DEG * side);

    // 垂直：每种机动有自己的高度变化（俯冲/半滚倒转大幅下降，爬升则上升）
    let alt = clamp(ac.alt + mv.dAlt, 3200, 14500);
    if (ac.orders.altManual && mv.kind === 'notch') alt = ac.orders.alt;

    // 释放干扰
    if (ac.chaff > 0 && w.t - (ac.ai.lastChaff || 0) > 3 && d < 18) {
      ac.chaff--;
      ac.ai.lastChaff = w.t;
      for (const mm of w.missiles) {
        if (mm.alive && mm.targetId === ac.id && sim.distance(ac, mm) < 20) mm.chaffed = 1;
      }
    }

    ac.cmd = { hdg, alt, mach: mv.mach };
  }

  // 机动名称，供 UI 显示
  function maneuverName(ac) {
    return ac.ai && ac.ai.maneuver ? ac.ai.maneuver.name : null;
  }

  root.BVR = root.BVR || {};
  root.BVR.ai = { think, HOME };
})(typeof window !== 'undefined' ? window : globalThis);

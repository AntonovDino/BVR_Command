/*
 * BVR COMMAND — 数据表
 *
 * 所有参数均为「公开信源估计值」，用于游戏平衡，不代表真实作战性能。
 * 主要参考：CSIS Missile Threat、IISS Military Balance、厂商公开资料
 * （Raytheon / Rosoboronexport / AVIC 宣传页）、FAS、公开航展数据。
 * 详见 README.md「参数与可信度」。
 *
 * v0.2 起，本文件同时承担「注册表」职责：新机型、新导弹、新挂载、新想定
 * 只要往对应表里加一条，仿真、AI、渲染、备战界面都会自动识别。
 */
(function (root) {
  'use strict';

  const CONFIG = {
    version: '0.7.1',
    maxAircraft: 10,          // 每方出战上限（含预警机、加油机）
    maxEnemy: 10,             // 敌方战斗机数量上限（备战界面可调）
    altMin: 3000,
    altMax: 18000,
    altStep: 250,
    engageTimeout: 1800,      // 30 分钟超时判定
    refuelRadius: 8,          // km，加油对接距离
    refuelCeiling: 0.92,      // 加到这个油量比例就脱离
    lpiFactor: 0.55,          // 低可截获雷达：RWR 能发现的距离缩到 rwrRange 的这个比例
    // 航迹质量：1.0 = 火控级确认，0.35 = 仅能维持跟踪，低于 0.12 丢失
    trackQuality: { confirmed: 0.75, uncertain: 0.35, decay: 0.035, hold: 75 },
    // 告警与导弹可见性（km）
    rwrRange: 220,            // 机载 RWR 对锁定/发射的告警距离
    missileRadarRange: 40,    // 预警机雷达对小目标（导弹）的发现距离
    missileFighterRange: 18,  // 战斗机雷达对导弹的发现距离
    missileSeekerWarn: 1.2,   // 导引头开机后，被攻击方可感知的距离系数
    // 电子战：干扰强度 = Σ 单机功率 × 距离因子，再乘 ECCM 系数
    jam: {
      dlRange: 320,           // A 射 B 导的数据链作用距离 km
      eccm: 0.55,             // AESA 阵面的抗干扰折扣
      minR: 0.35,             // 探测距离最多被压到原值的这个比例
      minQ: 0.35,             // 航迹质量最多被压到这个比例
      maxPerSide: 4           // 单机同时制导的上限（照射通道）
    }
  };

  // ---------------------------------------------------------------------------
  // 电子战吊舱
  // ---------------------------------------------------------------------------
  // 占两个挂点（少 2 发弹），加阻力与 RCS；开机能被 RWR 测向。
  // power/range/arc 决定干扰覆盖；detect/track/stt/seeker 决定效果强度。
  const PODS = {
    noise: {
      key: 'noise', name: '宽频噪声吊舱', short: '噪声',
      mass: 380, drag: 1.06, rcs: 1.30,
      power: 1.00, range: 250, arc: 1.05,
      detect: 0.60, track: 0.40, stt: 0.03, seeker: 0.55,
      desc: '大功率宽频压制：远距离削弱搜索与跟踪，但自己很显眼'
    },
    drfm: {
      key: 'drfm', name: 'DRFM 欺骗吊舱', short: '欺骗',
      mass: 260, drag: 1.03, rcs: 1.18,
      power: 0.85, range: 180, arc: 1.20,
      detect: 0.35, track: 0.70, stt: 0.14, seeker: 0.70,
      desc: '制造假目标、打断 STT 照射，距离越近越有效'
    },
    escort: {
      key: 'escort', name: '随队自卫吊舱', short: '随队',
      mass: 320, drag: 1.04, rcs: 1.22,
      power: 0.75, range: 90, arc: Math.PI,
      detect: 0.22, track: 0.30, stt: 0.05, seeker: 0.85,
      desc: '全向自卫干扰，保护本机与邻近友机'
    }
  };

  // ---------------------------------------------------------------------------
  // 空对空导弹
  // ---------------------------------------------------------------------------
  // mass      发射质量 kg
  // propMass  推进剂质量 kg
  // thrust    平均推力 N
  // burn      发动机工作时间 s
  // CdA       阻力面积 m²（0.5*rho*v^2*CdA = 阻力）
  // gMax      最大可用过载（g）
  // seeker    末制导截获距离 km
  // pk        无干扰单发命中概率
  // rangeRef  公开估计最大射程 km（迎头、高空）
  // loft      中段是否允许高抛弹道
  const MISSILES = {
    aim120d: {
      key: 'aim120d', name: 'AIM-120D', cn: 'AIM-120D AMRAAM',
      mass: 152, propMass: 45, thrust: 20984, burn: 6.0,
      CdA: 0.0085, gMax: 40, seeker: 20, pk: 0.72, rangeRef: 180, launchRef: 180, loft: true,
      color: '#3b6fe0'
    },
    pl15: {
      key: 'pl15', name: 'PL-15', cn: '霹雳-15',
      mass: 200, propMass: 70, thrust: 24606, burn: 8.0,
      CdA: 0.0105, gMax: 40, seeker: 25, pk: 0.72, rangeRef: 200, loft: true,
      color: '#3b6fe0'
    },
    r771: {
      key: 'r771', name: 'R-77-1', cn: 'R-77-1（产品180）',
      mass: 190, propMass: 60, thrust: 9550, burn: 6.0,
      CdA: 0.0100, gMax: 35, seeker: 15, pk: 0.62, rangeRef: 110, loft: true,
      color: '#c7384a'
    },
    r37m: {
      key: 'r37m', name: 'R-37M', cn: 'R-37M',
      mass: 510, propMass: 200, thrust: 165816, burn: 10.0,
      CdA: 0.0290, gMax: 20, seeker: 25, pk: 0.55, rangeRef: 300, loft: true,
      color: '#c7384a'
    },
    aim9x: {
      key: 'aim9x', name: 'AIM-9X', cn: 'AIM-9X Sidewinder',
      mass: 85, propMass: 25, thrust: 3377, burn: 3.0,
      CdA: 0.0048, gMax: 50, seeker: 10, pk: 0.70, rangeRef: 25, loft: false,
      color: '#3b6fe0'
    },
    pl10: {
      key: 'pl10', name: 'PL-10', cn: '霹雳-10',
      mass: 105, propMass: 32, thrust: 4010, burn: 3.5,
      CdA: 0.0070, gMax: 55, seeker: 12, pk: 0.72, rangeRef: 25, loft: false,
      color: '#3b6fe0'
    },
    r73: {
      key: 'r73', name: 'R-73', cn: 'R-73（AA-11）',
      mass: 105, propMass: 32, thrust: 3688, burn: 3.5,
      CdA: 0.0080, gMax: 40, seeker: 10, pk: 0.62, rangeRef: 20, loft: false,
      color: '#c7384a'
    }
  };

  // ---------------------------------------------------------------------------
  // 飞机
  // ---------------------------------------------------------------------------
  // mass    作战起飞质量 kg
  // S       机翼参考面积 m²
  // thrust  海平面静推力 N（加力）
  // cd0     零升阻力系数
  // clmax   最大升力系数
  // gLimit  结构过载限制
  // ceil    实用升限 m
  // rcs     正面雷达反射面积 m²（估计）
  // radar   对 1 m² 目标探测距离 km；fov 为半角（度），180 = 全向
  // vmax    最大平飞表速限制 m/s（结构/进气道限制）
  // offload / offloadRate  加油机可输出燃油 kg 与速率 kg/s
  const AIRCRAFT = {
    // ---------------- 美国 ----------------
    f15ex: {
      key: 'f15ex', name: 'F-15EX', cn: 'F-15EX「鹰 II」', country: 'US', role: 'fighter',
      mass: 20000, S: 56.5, thrust: 258000, cd0: 0.018, clmax: 1.40, gLimit: 9,
      ceil: 18300, rcs: 5.0, lpi: true, radar: 210, radarFov: 60, vmax: 820,
      loadout: { aim120d: 12, aim9x: 4 }, fuel: 6100
    },
    f16c: {
      key: 'f16c', name: 'F-16C', cn: 'F-16C Block 70', country: 'US', role: 'fighter',
      mass: 12000, S: 27.9, thrust: 129000, cd0: 0.019, clmax: 1.50, gLimit: 9,
      ceil: 15200, rcs: 1.2, lpi: true, radar: 160, radarFov: 60, vmax: 800,
      loadout: { aim120d: 6, aim9x: 2 }, fuel: 3200
    },
    fa18e: {
      key: 'fa18e', name: 'F/A-18E', cn: 'F/A-18E「超级大黄蜂」', country: 'US', role: 'fighter',
      mass: 18000, S: 46.5, thrust: 196000, cd0: 0.021, clmax: 1.60, gLimit: 7.5,
      ceil: 15200, rcs: 1.0, lpi: true, radar: 150, radarFov: 60, vmax: 700,
      loadout: { aim120d: 6, aim9x: 2 }, fuel: 4900
    },
    e3g: {
      key: 'e3g', name: 'E-3G', cn: 'E-3G「望楼」预警机', country: 'US', role: 'awacs',
      mass: 75000, S: 283, thrust: 372000, cd0: 0.022, clmax: 1.60, gLimit: 2.5,
      ceil: 12000, rcs: 80, radar: 420, radarFov: 180, vmax: 300,
      loadout: {}, fuel: 30000
    },
    kc135r: {
      key: 'kc135r', name: 'KC-135R', cn: 'KC-135R 加油机', country: 'US', role: 'tanker',
      mass: 70000, S: 283, thrust: 386000, cd0: 0.022, clmax: 1.55, gLimit: 2.5,
      ceil: 15000, rcs: 90, radar: 110, radarFov: 180, vmax: 260,
      loadout: {}, fuel: 90000, offload: 60000, offloadRate: 900
    },

    // ---------------- 中国 ----------------
    j16: {
      key: 'j16', name: 'J-16', cn: '歼-16', country: 'CN', role: 'fighter',
      mass: 21000, S: 62.0, thrust: 270000, cd0: 0.019, clmax: 1.50, gLimit: 9,
      ceil: 18000, rcs: 6.0, lpi: true, radar: 200, radarFov: 60, vmax: 760,
      loadout: { pl15: 6, pl10: 2 }, fuel: 9000
    },
    j10c: {
      key: 'j10c', name: 'J-10C', cn: '歼-10C', country: 'CN', role: 'fighter',
      mass: 13000, S: 39.0, thrust: 130000, cd0: 0.018, clmax: 1.50, gLimit: 9,
      ceil: 18000, rcs: 1.5, lpi: true, radar: 170, radarFov: 60, vmax: 760,
      loadout: { pl15: 4, pl10: 2 }, fuel: 4500
    },
    j11bg: {
      key: 'j11bg', name: 'J-11BG', cn: '歼-11BG', country: 'CN', role: 'fighter',
      mass: 21000, S: 62.0, thrust: 250000, cd0: 0.020, clmax: 1.50, gLimit: 9,
      ceil: 18000, rcs: 6.0, lpi: true, radar: 160, radarFov: 60, vmax: 760,
      loadout: { pl15: 4, pl10: 2 }, fuel: 9000
    },
    kj500: {
      key: 'kj500', name: 'KJ-500', cn: '空警-500 预警机', country: 'CN', role: 'awacs',
      mass: 60000, S: 120, thrust: 64000, cd0: 0.030, clmax: 1.80, gLimit: 2.5,
      ceil: 10000, rcs: 60, radar: 400, radarFov: 180, vmax: 200,
      loadout: {}, fuel: 20000
    },
    hy6: {
      key: 'hy6', name: 'HY-6', cn: '轰油-6 加油机', country: 'CN', role: 'tanker',
      mass: 55000, S: 120, thrust: 240000, cd0: 0.030, clmax: 1.70, gLimit: 2.5,
      ceil: 12000, rcs: 70, radar: 90, radarFov: 180, vmax: 230,
      loadout: {}, fuel: 37000, offload: 18000, offloadRate: 600
    },

    // ---------------- 俄罗斯 ----------------
    su35s: {
      key: 'su35s', name: 'Su-35S', cn: '苏-35S', country: 'RU', role: 'fighter',
      mass: 23000, S: 62.0, thrust: 284000, cd0: 0.019, clmax: 1.50, gLimit: 9,
      ceil: 18000, rcs: 6.0, lpi: true, radar: 250, radarFov: 60, vmax: 760,
      loadout: { r771: 4, r73: 2 }, fuel: 11500
    },
    su30sm2: {
      key: 'su30sm2', name: 'Su-30SM2', cn: '苏-30SM2', country: 'RU', role: 'fighter',
      mass: 22000, S: 62.0, thrust: 250000, cd0: 0.020, clmax: 1.50, gLimit: 9,
      ceil: 17000, rcs: 6.0, lpi: true, radar: 200, radarFov: 60, vmax: 760,
      loadout: { r771: 4, r73: 2 }, fuel: 9600
    },
    mig31bm: {
      key: 'mig31bm', name: 'MiG-31BM', cn: '米格-31BM', country: 'RU', role: 'fighter',
      mass: 35000, S: 61.6, thrust: 304000, cd0: 0.022, clmax: 1.30, gLimit: 5,
      ceil: 20600, rcs: 8.0, radar: 300, radarFov: 60, vmax: 830,
      loadout: { r37m: 4, r73: 2 }, fuel: 16000
    },
    a50u: {
      key: 'a50u', name: 'A-50U', cn: 'A-50U 预警机', country: 'RU', role: 'awacs',
      mass: 75000, S: 170, thrust: 468000, cd0: 0.024, clmax: 1.60, gLimit: 2.5,
      ceil: 12000, rcs: 70, radar: 350, radarFov: 180, vmax: 260,
      loadout: {}, fuel: 30000
    },
    il78m: {
      key: 'il78m', name: 'Il-78M', cn: '伊尔-78M 加油机', country: 'RU', role: 'tanker',
      mass: 72000, S: 170, thrust: 470000, cd0: 0.025, clmax: 1.60, gLimit: 2.5,
      ceil: 12000, rcs: 90, radar: 100, radarFov: 180, vmax: 250,
      loadout: {}, fuel: 105000, offload: 65000, offloadRate: 1000
    }
  };

  // ---------------------------------------------------------------------------
  // 俯视轮廓参数（渲染用，单位统一为「机身长度 = 1」，机头朝 +X）
  //   len    屏幕长度系数
  //   hw     机身半宽
  //   wing   主翼：x 根弦前缘位置、span 半翼展、sweep 后掠、root 根弦、tip 梢弦
  //   stab   平尾（同 wing 结构，用 chord 表示弦长）
  //   canard 鸭翼
  //   fin    垂尾：x 位置、len 长度、h 半厚
  //   twin   双垂尾
  //   dome   预警机圆盘 [x, r]
  //   hoses  加油机拖出的软管
  // 机身半宽剖面：[x, 半宽系数]，实际半宽 = hw × 系数。
  // 单发战斗机（F-16 / J-10 / MiG-31）略窄；F-15 与侧卫系列肩部明显外扩，
  // 用更饱满的剖面 + 主翼前缘延伸（lex）表现翼身融合。
  const FUSE_FIGHTER = [
    [0.500, 0.00], [0.472, 0.22], [0.440, 0.40], [0.395, 0.60],
    [0.330, 0.80], [0.250, 0.95], [0.150, 1.04], [0.000, 1.06],
    [-0.180, 1.02], [-0.340, 0.90], [-0.450, 0.74], [-0.500, 0.56]
  ];
  const FUSE_BLEND = [
    [0.500, 0.00], [0.478, 0.20], [0.452, 0.38], [0.418, 0.55],
    [0.370, 0.72], [0.310, 0.88], [0.240, 1.04], [0.150, 1.16],
    [0.040, 1.24], [-0.100, 1.26], [-0.240, 1.16], [-0.360, 0.98],
    [-0.450, 0.80], [-0.500, 0.62]
  ];
  const FUSE_HEAVY = [
    [0.500, 0.00], [0.480, 0.42], [0.450, 0.78], [0.400, 0.95],
    [0.300, 1.02], [0.100, 1.04], [-0.150, 1.00], [-0.320, 0.92],
    [-0.430, 0.80], [-0.500, 0.66]
  ];

    const SHAPES = {
    // 美
    f15ex: { len: 1.00, hw: 0.042,
      wing: { x: 0.10, span: 0.335, sweep: 1.00, root: 0.36, tip: 0.07 },
      stab: { x: -0.28, span: 0.21, chord: 0.12, sweep: 0.80 },
      fin: { x: -0.30, len: 0.24, h: 0.014 }, twin: true },
    f16c: { len: 0.94, hw: 0.028,
      wing: { x: 0.06, span: 0.333, sweep: 0.84, root: 0.34, tip: 0.06 },
      stab: { x: -0.30, span: 0.17, chord: 0.11, sweep: 0.70 },
      fin: { x: -0.28, len: 0.20, h: 0.012 } },
    fa18e: { len: 0.98, hw: 0.036,
      wing: { x: 0.07, span: 0.37, sweep: 0.55, root: 0.36, tip: 0.07 },
      stab: { x: -0.28, span: 0.19, chord: 0.10, sweep: 0.70 },
      fin: { x: -0.29, len: 0.21, h: 0.012 }, twin: true },
    e3g: { len: 1.34, hw: 0.050,
      wing: { x: 0.04, span: 0.476, sweep: 0.10, root: 0.21, tip: 0.15 },
      stab: { x: -0.36, span: 0.17, chord: 0.10, sweep: 0.30 },
      fin: { x: -0.34, len: 0.26, h: 0.016 }, dome: [0.05, 0.18] },
    kc135r: { len: 1.34, hw: 0.050,
      wing: { x: 0.04, span: 0.48, sweep: 0.28, root: 0.24, tip: 0.14 },
      stab: { x: -0.36, span: 0.17, chord: 0.10, sweep: 0.30 },
      fin: { x: -0.34, len: 0.26, h: 0.016 }, hoses: true },

    // 中
    j16: { len: 1.02, hw: 0.042,
      wing: { x: 0.10, span: 0.336, sweep: 0.90, root: 0.38, tip: 0.07 },
      stab: { x: -0.28, span: 0.21, chord: 0.12, sweep: 0.80 },
      fin: { x: -0.30, len: 0.22, h: 0.013 }, twin: true },
    j10c: { len: 0.95, hw: 0.030,
      wing: { x: 0.06, span: 0.30, sweep: 1.25, root: 0.56, tip: 0.04 },
      canard: { x: 0.26, span: 0.13, chord: 0.07, sweep: 0.90 },
      fin: { x: -0.30, len: 0.20, h: 0.012 } },
    j11bg: { len: 1.02, hw: 0.042,
      wing: { x: 0.10, span: 0.336, sweep: 0.90, root: 0.38, tip: 0.07 },
      stab: { x: -0.28, span: 0.21, chord: 0.12, sweep: 0.80 },
      fin: { x: -0.30, len: 0.22, h: 0.013 }, twin: true },
    kj500: { len: 1.30, hw: 0.048,
      wing: { x: 0.05, span: 0.50, sweep: 0.08, root: 0.20, tip: 0.14 },
      stab: { x: -0.35, span: 0.17, chord: 0.10, sweep: 0.28 },
      fin: { x: -0.33, len: 0.26, h: 0.015 }, dome: [0.04, 0.185] },
    hy6: { len: 1.28, hw: 0.048,
      wing: { x: 0.05, span: 0.48, sweep: 0.25, root: 0.22, tip: 0.13 },
      stab: { x: -0.35, span: 0.17, chord: 0.10, sweep: 0.28 },
      fin: { x: -0.33, len: 0.26, h: 0.015 }, hoses: true },

    // 俄
    su35s: { len: 1.02, hw: 0.042,
      wing: { x: 0.10, span: 0.336, sweep: 0.90, root: 0.38, tip: 0.07 },
      stab: { x: -0.28, span: 0.21, chord: 0.12, sweep: 0.80 },
      fin: { x: -0.30, len: 0.22, h: 0.013 }, twin: true },
    su30sm2: { len: 1.04, hw: 0.042,
      wing: { x: 0.10, span: 0.336, sweep: 0.90, root: 0.38, tip: 0.07 },
      stab: { x: -0.28, span: 0.21, chord: 0.12, sweep: 0.80 },
      canard: { x: 0.24, span: 0.15, chord: 0.08, sweep: 0.85 },
      fin: { x: -0.30, len: 0.22, h: 0.013 }, twin: true },
    mig31bm: { len: 1.10, hw: 0.048,
      wing: { x: 0.10, span: 0.30, sweep: 1.10, root: 0.40, tip: 0.07 },
      stab: { x: -0.30, span: 0.21, chord: 0.11, sweep: 0.90 },
      fin: { x: -0.32, len: 0.24, h: 0.014 }, twin: true },
    a50u: { len: 1.32, hw: 0.050,
      wing: { x: 0.04, span: 0.49, sweep: 0.10, root: 0.21, tip: 0.15 },
      stab: { x: -0.36, span: 0.17, chord: 0.10, sweep: 0.30 },
      fin: { x: -0.34, len: 0.26, h: 0.016 }, dome: [0.03, 0.19] },
    il78m: { len: 1.34, hw: 0.050,
      wing: { x: 0.04, span: 0.48, sweep: 0.30, root: 0.24, tip: 0.14 },
      stab: { x: -0.36, span: 0.17, chord: 0.10, sweep: 0.30 },
      fin: { x: -0.34, len: 0.26, h: 0.016 }, hoses: true }
  };

  const DEFAULT_SHAPE = SHAPES.su35s;


  // ---------------------------------------------------------------------------
  // 挂载方案
  // 每个方案的航程/机动代价由 sim 按「弹重 + 挂架阻力」自动计算：
  //   mass += Σ(missile.mass × 数量)
  //   cd0  ×= 1 + 0.028 × 弹数
  //   rcs  ×= 1 + 0.018 × 弹数
  // ---------------------------------------------------------------------------
  const LOADOUTS = {
    f15ex: [
      { id: 'std', name: '8× AIM-120D + 2× AIM-9X', missiles: { aim120d: 8, aim9x: 2 } },
      { id: 'bvr', name: '12× AIM-120D（纯超视距·压制）', missiles: { aim120d: 12 } },
      { id: 'light', name: '4× AIM-120D + 2× AIM-9X（轻载）', missiles: { aim120d: 4, aim9x: 2 } }
    ],
    f16c: [
      { id: 'std', name: '4× AIM-120D + 2× AIM-9X', missiles: { aim120d: 4, aim9x: 2 } },
      { id: 'bvr', name: '6× AIM-120D（超视距）', missiles: { aim120d: 6 } },
      { id: 'light', name: '2× AIM-120D + 2× AIM-9X（轻载）', missiles: { aim120d: 2, aim9x: 2 } }
    ],
    fa18e: [
      { id: 'std', name: '4× AIM-120D + 2× AIM-9X', missiles: { aim120d: 4, aim9x: 2 } },
      { id: 'bvr', name: '6× AIM-120D（超视距）', missiles: { aim120d: 6 } },
      { id: 'light', name: '2× AIM-120D + 2× AIM-9X（轻载）', missiles: { aim120d: 2, aim9x: 2 } }
    ],
    j16: [
      { id: 'std', name: '4× PL-15 + 2× PL-10', missiles: { pl15: 4, pl10: 2 } },
      { id: 'bvr', name: '6× PL-15（纯超视距·压制）', missiles: { pl15: 6 } },
      { id: 'light', name: '2× PL-15 + 2× PL-10（轻载）', missiles: { pl15: 2, pl10: 2 } }
    ],
    j10c: [
      { id: 'std', name: '2× PL-15 + 2× PL-10', missiles: { pl15: 2, pl10: 2 } },
      { id: 'bvr', name: '4× PL-15（超视距）', missiles: { pl15: 4 } },
      { id: 'light', name: '2× PL-10（纯格斗）', missiles: { pl10: 2 } }
    ],
    j11bg: [
      { id: 'std', name: '4× PL-15 + 2× PL-10', missiles: { pl15: 4, pl10: 2 } },
      { id: 'bvr', name: '6× PL-15（超视距）', missiles: { pl15: 6 } },
      { id: 'light', name: '2× PL-15 + 2× PL-10（轻载）', missiles: { pl15: 2, pl10: 2 } }
    ],
    su35s: [
      { id: 'std', name: '4× R-77-1 + 2× R-73', missiles: { r771: 4, r73: 2 } },
      { id: 'bvr', name: '6× R-77-1（超视距）', missiles: { r771: 6 } },
      { id: 'light', name: '2× R-77-1 + 2× R-73（轻载）', missiles: { r771: 2, r73: 2 } }
    ],
    su30sm2: [
      { id: 'std', name: '4× R-77-1 + 2× R-73', missiles: { r771: 4, r73: 2 } },
      { id: 'bvr', name: '6× R-77-1（超视距）', missiles: { r771: 6 } },
      { id: 'light', name: '2× R-77-1 + 2× R-73（轻载）', missiles: { r771: 2, r73: 2 } }
    ],
    mig31bm: [
      { id: 'std', name: '2× R-37M + 2× R-77-1', missiles: { r37m: 2, r771: 2 } },
      { id: 'bvr', name: '4× R-37M（远程截击·压制）', missiles: { r37m: 4 } },
      { id: 'light', name: '2× R-37M（轻载）', missiles: { r37m: 2 } }
    ],
    e3g:    [{ id: 'std', name: '无挂载（平台）', missiles: {} }],
    kj500:  [{ id: 'std', name: '无挂载（平台）', missiles: {} }],
    a50u:   [{ id: 'std', name: '无挂载（平台）', missiles: {} }],
    kc135r: [{ id: 'std', name: '无挂载（平台）', missiles: {} }],
    hy6:    [{ id: 'std', name: '无挂载（平台）', missiles: {} }],
    il78m:  [{ id: 'std', name: '无挂载（平台）', missiles: {} }]
  };

  const COUNTRIES = {
    US: { name: '美国空军', short: 'USAF', color: '#3b6fe0' },
    CN: { name: '中国空军', short: 'PLAAF', color: '#c7384a' },
    RU: { name: '俄罗斯空天军', short: 'VKS', color: '#c7384a' },
    blue: { name: '蓝方', short: 'BLUE', color: '#3b6fe0' },
    red: { name: '红方', short: 'RED', color: '#c7384a' }
  };

  // ---------------------------------------------------------------------------
  // 想定：双方编队。x 向东、y 向北，单位 km。
  // 交战纵深按「预警机在战斗机后方 250–300 km」设置：敌机要打预警机，
  // 必须先穿透战斗机屏障或绕行，这就是 v0.2 拉长交战距离的核心。
  // ---------------------------------------------------------------------------
  const SCENARIOS = {
    us_cn: {
      key: 'us_cn', name: '西太平洋 · 美国 vs 中国',
      brief: '蓝方 F-15EX/F-16C/F/A-18E 对阵红方 J-16/J-10C。双方各有一架预警机与一架加油机。',
      blue: {
        country: 'US', hdg: 0, awacs: 'e3g', awacsX: -245, awacsY: 0,
        tanker: 'kc135r', tankerX: -205, tankerY: 70,
        flights: [
          { type: 'f15ex', n: 2, x: -150, y: -42 },
          { type: 'f16c', n: 4, x: -155, y: 0 },
          { type: 'fa18e', n: 2, x: -145, y: 48 }
        ]
      },
      red: {
        country: 'CN', hdg: Math.PI, awacs: 'kj500', awacsX: 245, awacsY: 0,
        tanker: 'hy6', tankerX: 205, tankerY: -70,
        flights: [
          { type: 'j16', n: 3, x: 152, y: -30 },
          { type: 'j10c', n: 2, x: 148, y: 34 }
        ]
      }
    },
    us_ru: {
      key: 'us_ru', name: '波罗的海 · 美国 vs 俄罗斯',
      brief: '蓝方 F-15EX/F-16C/F/A-18E 对阵红方 Su-35S/Su-30SM2/MiG-31BM。MiG-31BM 的 R-37M 能威胁到 250 km 外的预警机。',
      blue: {
        country: 'US', hdg: 0, awacs: 'e3g', awacsX: -250, awacsY: 0,
        tanker: 'kc135r', tankerX: -210, tankerY: 70,
        flights: [
          { type: 'f15ex', n: 2, x: -155, y: -40 },
          { type: 'f16c', n: 4, x: -160, y: 0 },
          { type: 'fa18e', n: 2, x: -150, y: 46 }
        ]
      },
      red: {
        country: 'RU', hdg: Math.PI, awacs: 'a50u', awacsX: 250, awacsY: 0,
        tanker: 'il78m', tankerX: 210, tankerY: -70,
        flights: [
          { type: 'su35s', n: 3, x: 158, y: -10 },
          { type: 'mig31bm', n: 2, x: 172, y: 40 },
          { type: 'su30sm2', n: 1, x: 150, y: -52 }
        ]
      }
    },
    cn_ru: {
      key: 'cn_ru', name: '远东 · 中国 vs 俄罗斯',
      brief: '蓝方 J-16/J-10C/J-11BG 对阵红方 Su-35S/Su-30SM2/MiG-31BM。',
      blue: {
        country: 'CN', hdg: 0, awacs: 'kj500', awacsX: -245, awacsY: 0,
        tanker: 'hy6', tankerX: -205, tankerY: 70,
        flights: [
          { type: 'j16', n: 3, x: -152, y: -26 },
          { type: 'j10c', n: 3, x: -148, y: 30 },
          { type: 'j11bg', n: 2, x: -158, y: 62 }
        ]
      },
      red: {
        country: 'RU', hdg: Math.PI, awacs: 'a50u', awacsX: 250, awacsY: 0,
        tanker: 'il78m', tankerX: 208, tankerY: -66,
        flights: [
          { type: 'su35s', n: 4, x: 156, y: -10 },
          { type: 'mig31bm', n: 2, x: 170, y: 40 },
          { type: 'su30sm2', n: 2, x: 150, y: -50 }
        ]
      }
    }
  };

  // v0.3+ 扩展位：留给「地空导弹威胁区 / 电子战 / 反辐射」等模块
  const THREATS = {};

  root.BVR = root.BVR || {};
  root.BVR.CONFIG = CONFIG;
  root.BVR.MISSILES = MISSILES;
  root.BVR.AIRCRAFT = AIRCRAFT;
  root.BVR.SHAPES = SHAPES;
  root.BVR.DEFAULT_SHAPE = DEFAULT_SHAPE;
  root.BVR.LOADOUTS = LOADOUTS;
  root.BVR.PODS = PODS;
  root.BVR.COUNTRIES = COUNTRIES;
  root.BVR.SCENARIOS = SCENARIOS;
  root.BVR.THREATS = THREATS;
})(typeof window !== 'undefined' ? window : globalThis);

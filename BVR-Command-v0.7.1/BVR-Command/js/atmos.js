/*
 * BVR COMMAND — 大气模型
 *
 * 国际标准大气 ISA（1976）分层模型：
 *   0–11 km 对流层，温度线性递减 6.5 K/km
 *   11–20 km 平流层下层，等温 216.65 K
 *   20–32 km 平流层上层，温度回升 1 K/km
 * 密度由理想气体方程 rho = p / (R*T) 得到。
 */
(function (root) {
  'use strict';

  const R = 287.05287;        // 干空气气体常数 J/(kg·K)
  const G0 = 9.80665;         // 标准重力 m/s²
  const GAMMA = 1.4;          // 比热比
  const T0 = 288.15;
  const P0 = 101325;
  const RHO0 = 1.225;         // 海平面密度 kg/m³

  function temperature(h) {
    if (h < 11000) return T0 - 0.0065 * h;
    if (h < 20000) return 216.65;
    if (h < 32000) return 216.65 + 0.001 * (h - 20000);
    return 228.65;
  }

  function pressure(h) {
    if (h < 11000) {
      const t = T0 - 0.0065 * h;
      return P0 * Math.pow(t / T0, 5.25588);
    }
    if (h < 20000) {
      return 22632.06 * Math.exp(-G0 * (h - 11000) / (R * 216.65));
    }
    if (h < 32000) {
      const t = 216.65 + 0.001 * (h - 20000);
      return 5474.89 * Math.pow(t / 216.65, -34.1632);
    }
    return 868.02;
  }

  function density(h) {
    const t = temperature(h);
    if (t <= 0) return 1e-6;
    return pressure(h) / (R * t);
  }

  function soundSpeed(h) {
    return Math.sqrt(GAMMA * R * temperature(h));
  }

  /** 马赫数 → 真空速 m/s */
  function machToTas(mach, h) {
    return mach * soundSpeed(h);
  }

  /** 真空速 → 马赫数 */
  function tasToMach(tas, h) {
    return tas / soundSpeed(h);
  }

  /** 单位质量升力需求等用到的动压 */
  function q(rho, v) {
    return 0.5 * rho * v * v;
  }

  root.BVR = root.BVR || {};
  root.BVR.atmos = {
    R, G0, RHO0,
    temperature, pressure, density, soundSpeed, machToTas, tasToMach, q
  };
})(typeof window !== 'undefined' ? window : globalThis);

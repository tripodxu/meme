/**
 * P1.5-02 均值场/不动点分析（数值部分）。
 *
 * 解析推导见 docs/research/p15-mean-field.md；本模块实现其可检验预测：
 * 1. E–P 不动点：P=P0 时 Congestion=1，E*=env0[c]×Polarization(G*)。
 *    预测：对初始占比为正的阶级，P[c]>P0[c] ⇒ E[c] < E*[c]（拥挤负反馈符号为负）。
 * 2. O–Mup–S–G 环路符号（rule.md 42/43/44）：
 *    ∂Otarget/∂Mup = θM(1-Otarget)Otarget > 0；∂Otarget/∂G = -θG(...) < 0；
 *    ∂Otarget/∂S = -θS(...) < 0；∂cost/∂O = -λO×crossBase×(1-discount)×mult < 0。
 *    ⇒ O↑ ⇒ 跨越更便宜 ⇒ Mup↑（正反馈）；O↑ ⇒ 跨层连边↑ ⇒ S↓ ⇒ 又推高 Otarget（正反馈）。
 * 3. 顶层持有成本/收益比：need 增速 ψ[c]×B×E[c] vs 收益增速 B×E[c]×ge×F(hard)×Opp。
 *    对 ge×F(hard)×Opp < ψ[c] 的个体，顶层不可持续（被动跌落必然发生）→
 *    “旋转门”吸收子：人口反复升降而非顶层永久吸收。
 */

import type { RunConfig } from '../core/config/types.js';
import { effortFunction } from '../core/engine/settlement.js';
import { clamp } from '../core/engine/arith.js';

/** E–P 不动点：给定稳态阶级占比与 G，返回 E 的理论值。 */
export function equilibriumE(
  config: RunConfig,
  classSharesSteady: readonly number[],
  giniSteady: number,
): number[] {
  const classCount = config.population.classCount;
  return config.opportunity.env0.map((env0, c) => {
    const p0 = config.population.classShares[c] ?? 0;
    const p = classSharesSteady[c] ?? 0;
    const congestion = clamp(
      (p0 / Math.max(p, config.dynamics.emptyClassPopulationFloor)) **
        config.dynamics.congestionExponent,
      config.dynamics.congestionMin,
      config.dynamics.congestionMax,
    );
    const z = (2 * c) / (classCount - 1) - 1;
    const polarization = clamp(
      Math.exp(
        config.dynamics.polarizationExponent * z * (giniSteady - config.dynamics.giniReference),
      ),
      config.dynamics.polarizationMin,
      config.dynamics.polarizationMax,
    );
    return env0 * congestion * polarization;
  });
}

/**
 * 拥挤负反馈的符号检验：对每个初始占比为正的阶级，
 * 若仿真占比高于初始占比，则拥挤乘子应 <1（E 低于无拥挤基准）。
 */
export interface CongestionSignCheck {
  readonly classIndex: number;
  readonly p0: number;
  readonly p: number;
  readonly congestion: number;
  readonly signMatches: boolean;
  /** 初始占比为 0 的阶级不参与检验（v3 无入口激励）。 */
  readonly applicable: boolean;
}

export function checkCongestionSigns(
  config: RunConfig,
  classSharesObserved: readonly number[],
): CongestionSignCheck[] {
  return config.population.classShares.map((p0, c) => {
    const p = classSharesObserved[c] ?? 0;
    const congestion = clamp(
      (p0 / Math.max(p, config.dynamics.emptyClassPopulationFloor)) **
        config.dynamics.congestionExponent,
      config.dynamics.congestionMin,
      config.dynamics.congestionMax,
    );
    const applicable = p0 > 0 && Math.abs(p - p0) > 1e-9;
    const signMatches = !applicable ? true : p > p0 ? congestion < 1 : congestion > 1;
    return { classIndex: c, p0, p, congestion, signMatches, applicable };
  });
}

/**
 * 顶层可持续性裕度（rule.md 5/37 的机械推论，v4 含环境持有人乘子）：
 * `margin = median(ge×F(hard)×Opp) / (ψ[top]×(E[top]/E[0])^φ)`。
 * margin < 1 ⇒ 中位数个体在顶层必然入不敷出（需求线按 ψ×baseline×环境乘子增长），
 * 顶层人口由“升-耗-落”循环维持（旋转门）；margin 与 1 的差距随 φ 增大。
 */
export function topClassMargin(
  config: RunConfig,
  geValues: readonly number[],
  hardValues: number,
  eByClass?: readonly number[],
): number {
  const top = config.population.classCount - 1;
  const psi = config.need.needMultiplier[top] ?? 1;
  let envMultiplier = 1;
  if (eByClass !== undefined && config.need.envExponent !== 0) {
    const own = eByClass[top];
    const bottom = eByClass[0];
    if (own === undefined || bottom === undefined || !(bottom > 0)) {
      throw new Error('E 缺少阶级或 E[0] 非正');
    }
    envMultiplier = (own / bottom) ** config.need.envExponent;
  }
  const f = effortFunction(config.effort.shape, hardValues);
  const productivity = geValues.map((ge) => ge * f);
  const sorted = [...productivity].sort((a, b) => a - b);
  const medianProductivity = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return medianProductivity / (psi * envMultiplier);
}

/** Otarget 对 Mup/G/S 的解析偏导（rule.md 42，sigmoid 的局部斜率）。 */
export function oTargetGradients(
  config: RunConfig,
  oTarget: number,
): { readonly dO_dMup: number; readonly dO_dG: number; readonly dO_dS: number } {
  const slope = oTarget * (1 - oTarget);
  return {
    dO_dMup: config.openness.mobilityWeight * slope,
    dO_dG: -config.openness.giniWeight * slope,
    dO_dS: -config.openness.segregationWeight * slope,
  };
}

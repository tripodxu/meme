import type { RunConfig } from '../config/types.js';
import { errorCodes, StratifyError } from '../control/errors.js';
import { clamp } from '../engine/arith.js';
import { stableSigmoid } from '../engine/settlement.js';

/**
 * 阶段 H：每 tick 更新下一 tick 的 E（03 §6）。
 *
 * `Congestion=clamp((P0[c]/max(P[c],emptyClassPopulationFloor))^η, congestionMin, congestionMax)`；
 * 初始即为空的阶级（P0[c]=0）落到 congestionMin，不获得入口激励（rules-v3 语义）。
 */
export function updateClassEnvironment(
  config: RunConfig,
  eByClass: readonly number[],
  initialClassShares: readonly number[],
  classShares: readonly number[],
  gini: number,
): number[] {
  const classCount = config.population.classCount;
  const next: number[] = [];
  for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
    const p0 = initialClassShares[classIndex];
    const p = classShares[classIndex];
    if (p0 === undefined || p === undefined) {
      throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `阶级占比缺失: ${classIndex}`);
    }
    const congestion = clamp(
      (p0 / Math.max(p, config.dynamics.emptyClassPopulationFloor)) **
        config.dynamics.congestionExponent,
      config.dynamics.congestionMin,
      config.dynamics.congestionMax,
    );
    const z = polarizationZ(classIndex, classCount);
    const polarization = clamp(
      Math.exp(config.dynamics.polarizationExponent * z * (gini - config.dynamics.giniReference)),
      config.dynamics.polarizationMin,
      config.dynamics.polarizationMax,
    );
    const env0 = config.opportunity.env0[classIndex];
    const current = eByClass[classIndex];
    if (env0 === undefined || current === undefined) {
      throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `E 缺少阶级 ${classIndex}`);
    }
    const raw = env0 * congestion * polarization;
    next.push(
      (1 - config.dynamics.classSmoothing) * current + config.dynamics.classSmoothing * raw,
    );
  }
  return next;
}

/** 阶级标准化 `z[c]=2c/(C-1)-1`（rule.md 35）。 */
export function polarizationZ(classIndex: number, classCount: number): number {
  if (classCount < 2) {
    throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '阶级数必须 >=2');
  }
  return (2 * classIndex) / (classCount - 1) - 1;
}

/**
 * 仅决策周期更新 O（03 §6 阶段 H）：`Δt=tick-lastOpennessUpdateTick`，
 * 更新后写回；tick 0 的 Δt=0，首次更新不改变 O。
 * `openness.updateMode=fixed`（P1-10 消融开关）时跳过整个块，O 恒等于 `openness.initial`。
 */
export function maybeUpdateOpenness(
  config: RunConfig,
  input: {
    readonly tick: number;
    readonly openness: number;
    readonly lastOpennessUpdateTick: number;
    readonly mUp: number;
    readonly gini: number;
    readonly segregation: number;
  },
): { openness: number; lastOpennessUpdateTick: number } {
  if (config.openness.updateMode === 'fixed') {
    return {
      openness: config.openness.initial,
      lastOpennessUpdateTick: input.lastOpennessUpdateTick,
    };
  }
  const deltaT = input.tick - input.lastOpennessUpdateTick;
  const oTarget = stableSigmoid(
    config.openness.intercept +
      config.openness.mobilityWeight * (input.mUp - config.openness.mobilityReference) -
      config.openness.giniWeight * (input.gini - config.dynamics.giniReference) -
      config.openness.segregationWeight *
        (input.segregation - config.openness.segregationReference),
  );
  const updated =
    input.openness +
    (oTarget - input.openness) * (1 - Math.exp(-deltaT / config.openness.timeConstantDays));
  const bounded = clamp(updated, 0, 1);
  return { openness: bounded, lastOpennessUpdateTick: input.tick };
}

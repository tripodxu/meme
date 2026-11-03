import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RUN_CONFIG,
  mergeConfig,
  type DeepPartialConfig,
} from '../../../src/core/config/defaults.js';
import { validateRunConfig } from '../../../src/core/config/validate.js';
import { asSeed, type AgentId } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { step, type StepDecisions } from '../../../src/core/engine/engine.js';
import {
  computeNeedClass,
  computeNeedOwn,
  effortFunction,
} from '../../../src/core/engine/settlement.js';
import { computeAscendCost, enumerateLegalActions } from '../../../src/core/legal-actions.js';
import type { SimState } from '../../../src/core/model/state.js';
import { encodeSimState, decodeSimState } from '../../../src/core/model/serialize.js';

/**
 * rules-v6 需求参照系（D-06 选项 A′，changes/0008）接线测试：
 * - `need.referenceMode='own'` 与 v5 逐位一致（公式级；run 级见 own-parity.test.ts/G-D）；
 * - `class` 模式 need/ascendCost 以 refIncome 计价，`graceDays` 只控判定计时；
 * - refIncome EMA 更新发生在阶段 C 全部 gain 之后（先算后用）、空阶级保持上期值。
 */

const SEED = asSeed('reference-mode-seed');

/** 两阶级、无网络的最小配置（gain = B×env×ge×F(hard)，可手工复核）。 */
function minimalClassConfig(overrides: DeepPartialConfig = {}) {
  // 两段合并：先落基座（含 classCount=2 的全部定长数组），再深合并 overrides，
  // 避免顶层浅覆盖丢掉数组长度适配。
  const base = validateOrThrow(
    mergeConfig(DEFAULT_RUN_CONFIG, {
      population: { initialPopulation: 2, classCount: 2, classShares: [0.5, 0.5] },
      opportunity: { env0: [1, 1.5] },
      lifespan: { decay: [1.3, 1.15] },
      need: { needMultiplier: [1, 1.3] },
      ascent: { crossDays: [30] },
      network: { maxDegree: 0, initialDegree: 0 },
      decision: { interval: 10_000 },
      schedule: { totalTicks: 100, statsStride: 1, snapshotStride: 100 },
    }),
  );
  return validateOrThrow(mergeConfig(base, overrides));
}

function validateOrThrow(config: ReturnType<typeof mergeConfig>) {
  const result = validateRunConfig(config);
  if (!result.ok) {
    throw new Error(`配置非法: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

/** tick 0 是决策周期（0 % interval == 0）：全体 accumulate，不引入主动阶级变动。 */
function accumulateDecisions(state: SimState): StepDecisions {
  const map = new Map<AgentId, { selectedAction: string }>();
  if (state.society.tick % state.config.decision.interval !== 0) {
    return map;
  }
  for (const agent of state.society.agents) {
    if (agent.alive) {
      map.set(agent.id, { selectedAction: 'accumulate' });
    }
  }
  return map;
}

function gainOf(
  config: ReturnType<typeof minimalClassConfig>,
  agent: { ge: number; hard: number; classIndex: number },
): number {
  const env = config.opportunity.env0[agent.classIndex] as number;
  return (
    config.opportunity.dailyBase * env * agent.ge * effortFunction(config.effort.shape, agent.hard)
  );
}

describe("need.referenceMode='own'：与 v5 公式逐位一致", () => {
  it('computeNeedOwn = buffer(classAge)×baselineSum×ψ[c]×(env0[c]/env0[0])^φ', () => {
    const need = computeNeedOwn(DEFAULT_RUN_CONFIG, 30, 60, 3);
    // buffer(30,30)=1；60×2.5×(3.2/1)^1 = 480
    expect(need).toBe(60 * 2.5 * 3.2);
    const phi0 = computeNeedOwn(
      validateOrThrow(mergeConfig(DEFAULT_RUN_CONFIG, { need: { envExponent: 0 } })),
      15,
      10,
      2,
    );
    // φ=0：不做 pow，与 v3 公式逐位一致
    expect(phi0).toBe(1 * (14 / 29) * 10 * 1.8);
  });

  it('own 模式 run：refIncome 不被读取也不更新（保持初始值）', () => {
    const config = validateOrThrow(
      mergeConfig(DEFAULT_RUN_CONFIG, {
        need: { referenceMode: 'own' },
        schedule: { totalTicks: 40, statsStride: 1, snapshotStride: 100 },
      }),
    );
    const state = createSimulation(config, SEED);
    const initial = [...state.society.refIncome];
    let cursor = state;
    for (let i = 0; i < 40; i += 1) {
      cursor = step(cursor, accumulateDecisions(cursor), { runId: 'own-parity' }).state;
    }
    expect(cursor.society.refIncome).toEqual(initial);
    expect(initial).toEqual(
      config.opportunity.env0.map((env) => config.opportunity.dailyBase * env),
    );
  });
});

describe("need.referenceMode='class'：refIncome 计价与 EMA 更新", () => {
  it('computeNeedClass = refIncome[c]×bufferDays×ψ_eff[c]', () => {
    const config = DEFAULT_RUN_CONFIG;
    const refC = 4.4;
    const psiEff =
      (config.need.needMultiplier[2] as number) * (config.opportunity.env0[2] as number);
    expect(computeNeedClass(config, refC, 2)).toBe(refC * config.need.bufferDays * psiEff);
  });

  it('1 tick 后 refIncome[c] = (1-α)·初值 + α·当期阶级人均 gain；先算后用', () => {
    const config = minimalClassConfig({
      need: { referenceSmoothing: 0.25 },
    });
    const state = createSimulation(config, SEED);
    // 手工预期：按 agent 序求和（与引擎同序）
    const sums = [0, 0];
    const counts = [0, 0];
    for (const agent of state.society.agents) {
      sums[agent.classIndex] = (sums[agent.classIndex] as number) + gainOf(config, agent);
      counts[agent.classIndex] = (counts[agent.classIndex] as number) + 1;
    }
    const alpha = 0.25;
    const expected = state.society.refIncome.map((previous, c) =>
      (counts[c] as number) === 0
        ? previous
        : (1 - alpha) * previous + (alpha * (sums[c] as number)) / (counts[c] as number),
    );
    const result = step(state, accumulateDecisions(state), { runId: 'ref-ema' });
    expect(result.state.society.refIncome[0]).toBeCloseTo(expected[0] as number, 12);
    expect(result.state.society.refIncome[1]).toBeCloseTo(expected[1] as number, 12);
  });

  it('空阶级保持上期值（不参与 EMA）', () => {
    // classShares 让 class 1 无初始个体
    const config = minimalClassConfig({
      population: { classShares: [1, 0] },
      schedule: { totalTicks: 5 },
    });
    const state = createSimulation(config, SEED);
    const initial = [...state.society.refIncome];
    let cursor = state;
    for (let i = 0; i < 5; i += 1) {
      cursor = step(cursor, accumulateDecisions(cursor), { runId: 'empty-class' }).state;
    }
    // class 0 持续有人 → 更新；class 1 无人 → 保持初值
    expect(cursor.society.refIncome[1]).toBe(initial[1]);
    expect(cursor.society.refIncome[0]).not.toBe(initial[0]);
  });

  it('referenceSmoothing 接线：α 更大时 refIncome 更快逼近当期人均 gain', () => {
    const config = minimalClassConfig();
    const base = createSimulation(config, SEED);
    const sums = [0, 0];
    const counts = [0, 0];
    for (const agent of base.society.agents) {
      sums[agent.classIndex] = (sums[agent.classIndex] as number) + gainOf(config, agent);
      counts[agent.classIndex] = (counts[agent.classIndex] as number) + 1;
    }
    const mean0 = (sums[0] as number) / (counts[0] as number);
    const initial0 = base.society.refIncome[0] as number;
    const run = (alpha: number) => {
      const alphaConfig = minimalClassConfig({ need: { referenceSmoothing: alpha } });
      const state = createSimulation(alphaConfig, SEED);
      return step(state, accumulateDecisions(state), { runId: `alpha-${alpha}` }).state;
    };
    const low = run(0.05);
    const high = run(0.6);
    // EMA(α) = initial + α×(mean − initial)：α 大者距当期人均 gain 更近
    const gapLow = Math.abs((low.society.refIncome[0] as number) - mean0);
    const gapHigh = Math.abs((high.society.refIncome[0] as number) - mean0);
    expect(gapHigh).toBeLessThan(gapLow);
    expect(gapLow).toBeGreaterThan(Math.abs(initial0 - mean0) * (1 - 0.05) - 1e-9);
    expect(gapHigh).toBeLessThan(Math.abs(initial0 - mean0) * (1 - 0.6) + 1e-9);
  });
});

describe('need.graceDays：判定计时宽限期（仅 class 模式）', () => {
  /** 让 class-1 个体必然低于需求线并观察跌落时机。 */
  function descendTick(graceDays: number, maxTicks: number): number | null {
    const config = minimalClassConfig({
      need: {
        threshold: 0.99,
        belowNeedLimit: 3,
        graceDays,
        bufferDays: 2,
      },
      schedule: { totalTicks: maxTicks, statsStride: 1, snapshotStride: 100 },
    });
    let state = createSimulation(config, SEED);
    const agent = state.society.agents.find((entry) => entry.classIndex === 1);
    if (agent === undefined) throw new Error('无 class-1 个体');
    (agent as { ge: number }).ge = 0.2;
    (agent as { hard: number }).hard = 0.2;
    agent.remainingLife = 100_000;
    for (let tick = 0; tick < maxTicks; tick += 1) {
      const result = step(state, accumulateDecisions(state), { runId: 'grace' });
      const after = result.state.society.agents.find((entry) => entry.id === agent.id);
      if (after !== undefined && after.classIndex === 0) {
        return tick;
      }
      state = result.state;
      if (result.endReason !== null) break;
    }
    return null;
  }

  it('graceDays=0：streak 即刻起算，belowNeedLimit=3 → 第 3 tick 触发跌落', () => {
    expect(descendTick(0, 30)).toBe(2);
  });

  it('graceDays=5：streak 第 6 日起算 → 第 8 tick 触发跌落', () => {
    expect(descendTick(5, 30)).toBe(7);
  });

  it('graceDays=30：30 tick 内不跌落（宽限期内不累加 streak）', () => {
    expect(descendTick(30, 30)).toBeNull();
  });
});

describe('ascendCost 参照系（rules-v6）', () => {
  it('class 模式：crossBase = crossDays[c]×refIncome[c+1]；own 模式保持 B×E[c+1] 旧式', () => {
    const agent = { classIndex: 1, maxClassIndex: 1 };
    const eByClass = [1, 2, 4];
    const refIncome = [3, 5, 11];
    const ownConfig = validateOrThrow(
      mergeConfig(DEFAULT_RUN_CONFIG, {
        population: {
          classCount: 3,
          classShares: [0.4, 0.4, 0.2],
        },
        opportunity: { env0: [1, 2, 4] },
        lifespan: { decay: [1.3, 1.15, 1.0] },
        need: { needMultiplier: [1, 1.3, 1.8], referenceMode: 'own' },
        ascent: { crossDays: [30, 40] },
        openness: { ascentCostWeight: 0 },
      }),
    );
    const classConfig = validateOrThrow(
      mergeConfig(ownConfig, { need: { referenceMode: 'class' } }),
    );
    // own：crossDays[1]×B×E[2] = 40×2×4
    expect(computeAscendCost(ownConfig, agent, eByClass, 0.5, refIncome)).toBe(40 * 2 * 4);
    // class：crossDays[1]×refIncome[2] = 40×11
    expect(computeAscendCost(classConfig, agent, eByClass, 0.5, refIncome)).toBe(40 * 11);
  });

  it('class 模式下合法行动枚举使用与引擎一致的 refIncome 口径', () => {
    const config = minimalClassConfig();
    const state = createSimulation(config, SEED);
    const agent = state.society.agents[0];
    if (agent === undefined) throw new Error('roster 过小');
    agent.classIndex = 0;
    agent.maxClassIndex = 0;
    agent.value = 1_000_000;
    const legal = enumerateLegalActions(state, agent.id);
    expect(legal.actions).toContain('ascend');
    if (legal.ascendCost === null) throw new Error('ascendCost 不应为 null');
    // 初值 refIncome[1] = B×env0[1] = 3；crossDays[0]=30，O=0.5、λO=2 → openMultiplier=1
    const expected = 30 * (config.opportunity.dailyBase * (config.opportunity.env0[1] as number));
    expect(legal.ascendCost).toBeCloseTo(expected, 9);
  });
});

describe('refIncome 序列化（stratify-state-v2）', () => {
  it('encode/decode 往返保持 refIncome', () => {
    const config = minimalClassConfig();
    const state = createSimulation(config, SEED);
    const stepped = step(state, accumulateDecisions(state), { runId: 'serde' }).state;
    const roundTripped = decodeSimState(JSON.parse(JSON.stringify(encodeSimState(stepped))));
    expect(roundTripped.society.refIncome).toEqual(stepped.society.refIncome);
    expect(roundTripped.society.refIncome.length).toBe(config.population.classCount);
  });

  it('refIncome 缺失/长度错误/非正数在信任边界拒绝', () => {
    const config = minimalClassConfig();
    const state: SimState = createSimulation(config, SEED);
    const encoded = JSON.parse(JSON.stringify(encodeSimState(state))) as Record<string, unknown>;

    const missing = JSON.parse(JSON.stringify(encoded)) as Record<string, unknown>;
    delete (missing['society'] as Record<string, unknown>)['refIncome'];
    expect(() => decodeSimState(missing)).toThrowError(/refIncome/);

    const wrongLength = JSON.parse(JSON.stringify(encoded)) as Record<string, unknown>;
    (wrongLength['society'] as Record<string, unknown>)['refIncome'] = [1];
    expect(() => decodeSimState(wrongLength)).toThrowError(/refIncome/);

    const nonPositive = JSON.parse(JSON.stringify(encoded)) as Record<string, unknown>;
    (nonPositive['society'] as Record<string, unknown>)['refIncome'] = [1, 0];
    expect(() => decodeSimState(nonPositive)).toThrowError(/refIncome/);

    const nan = JSON.parse(JSON.stringify(encoded)) as Record<string, unknown>;
    (nan['society'] as Record<string, unknown>)['refIncome'] = [1, Number.NaN];
    expect(() => decodeSimState(nan)).toThrowError(/refIncome/);
  });
});

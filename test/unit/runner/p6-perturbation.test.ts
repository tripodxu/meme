import { describe, expect, it } from 'vitest';

import { HASH_DOMAINS } from '../../../src/core/hash/domains.js';
import { hashValue } from '../../../src/core/hash/hash.js';
import type { TickStats } from '../../../src/core/macros/tick-metrics.js';
import {
  buildP6PerturbationHashInput,
  buildP6PerturbationManifest,
  classifyPerturbationPair,
  computeP6PerturbationHash,
  firstTrailingMeanDeviationTick,
  perTickTvSeries,
  summarizeEventFlips,
  summarizeNormalFluctuation,
  summarizePerturbationAnalysis,
  tickClassShares,
  tickTv,
  type PerturbationBaselineRecord,
  type PerturbationPairRecord,
} from '../../../src/runner/p6-perturbation.js';
import type { P6WindowMetrics } from '../../../src/runner/p6-analysis.js';

function stats(overrides: Partial<TickStats> = {}): TickStats {
  return {
    tick: 0,
    aliveCount: 10,
    classCounts: [5, 3, 2, 0, 0],
    gini: 0.4,
    medianValue: 1,
    topWealthShare: 0.2,
    mUp: 0.1,
    mDown: 0.1,
    segregation: 0.1,
    edgeCount: 10,
    openness: 0.5,
    deathCount: 0,
    competitionLoss: 0,
    competitionGain: 0,
    fallbackRate: 0,
    eByClass: [0, 0, 0, 0, 0],
    crossClassEdgeShare: 0.2,
    avgDegree: 2,
    connectedComponents: 1,
    flowMatrix: [[0]],
    ...overrides,
  };
}

function windowOf(overrides: Partial<P6WindowMetrics> = {}): P6WindowMetrics {
  return {
    classShares: [0.5, 0.3, 0.15, 0.04, 0.01],
    gini: 0.4,
    mUp: 0.5,
    mDown: 0.5,
    segregation: 0.1,
    openness: 0.5,
    fallbackRate: 0,
    tickCount: 365,
    observedTicks: 365,
    missingTicks: 0,
    ...overrides,
  };
}

function flowsMap(
  entries: readonly (readonly [number, readonly (readonly number[])[]])[],
): ReadonlyMap<number, readonly (readonly number[])[]> {
  return new Map(entries);
}

describe('P6-03 预注册（07 §7）', () => {
  it('两个体制：stable 无覆盖，critical 为 interaction 且差异路径 >=2', () => {
    const manifest = buildP6PerturbationManifest();
    expect(manifest.regimes).toHaveLength(2);
    const stable = manifest.regimes.find((regime) => regime.regimeKey === 'stable');
    const critical = manifest.regimes.find((regime) => regime.regimeKey === 'critical');
    expect(stable?.design).toBe('baseline');
    expect(stable?.changedPaths).toEqual([]);
    expect(critical?.design).toBe('interaction');
    expect((critical?.changedPaths.length ?? 0) >= 2).toBe(true);
    expect(critical?.changedPaths).toContain('need.threshold');
  });

  it('cell 覆盖 control + 财富三档 + 两个参数各三档', () => {
    const manifest = buildP6PerturbationManifest();
    expect(manifest.cells).toHaveLength(10);
    expect(manifest.cells.filter((cell) => cell.kind === 'control')).toHaveLength(1);
    expect(manifest.cells.filter((cell) => cell.kind === 'wealth_absolute')).toHaveLength(3);
    expect(manifest.cells.filter((cell) => cell.kind === 'param_relative')).toHaveLength(6);
    expect(manifest.cells.find((cell) => cell.kind === 'control')?.delta).toBe(0);
    const fields = new Set(
      manifest.cells.filter((cell) => cell.kind === 'param_relative').map((cell) => cell.field),
    );
    expect(fields).toEqual(new Set(['need.threshold', 'need.needMultiplier[1]']));
  });

  it('30 个独立种子，预算覆盖全部 run（60 任务 × 12 run）', () => {
    const manifest = buildP6PerturbationManifest();
    expect(manifest.seeds).toHaveLength(30);
    expect(new Set(manifest.seeds).size).toBe(30);
    expect(manifest.seeds.every((seed) => seed.startsWith('p6-perturb-seed-'))).toBe(true);
    const runs = manifest.regimes.length * manifest.seeds.length * (1 + 1 + manifest.cells.length);
    expect(runs).toBeLessThanOrEqual(manifest.budgets.maxRuns);
  });

  it('预注册哈希覆盖种子、检查点、cell 幅度、体制与预算', () => {
    const manifest = buildP6PerturbationManifest();
    const input = buildP6PerturbationHashInput(manifest);
    const baseHash = hashValue(HASH_DOMAINS.preregistration, input);
    expect(baseHash).toBe(computeP6PerturbationHash());

    const mutations = [
      { ...input, seeds: [...input.seeds.slice(0, -1), 'p6-perturb-seed-999'] },
      { ...input, checkpointTick: 366 },
      {
        ...input,
        cells: input.cells.map((cell, index) => (index === 1 ? { ...cell, delta: 0.5 } : cell)),
      },
      {
        ...input,
        regimes: input.regimes.map((regime, index) =>
          index === 1 ? { ...regime, fullConfigHash: 'sha256:mutated' } : regime,
        ),
      },
      { ...input, budgets: { ...input.budgets, maxRuns: input.budgets.maxRuns + 1 } },
    ];
    for (const mutated of mutations) {
      expect(hashValue(HASH_DOMAINS.preregistration, mutated)).not.toBe(baseHash);
    }
  });
});

describe('P6-03 纯分析：事件翻转与结构偏离', () => {
  it('逐 tick 阶级占比与 TV', () => {
    const left = tickClassShares([stats({ tick: 1, classCounts: [5, 5, 0, 0, 0] })]);
    const right = tickClassShares([stats({ tick: 1, classCounts: [4, 6, 0, 0, 0] })]);
    expect(left[0]?.shares).toEqual([0.5, 0.5, 0, 0, 0]);
    expect(tickTv(left[0]?.shares ?? null, right[0]?.shares ?? null)).toBeCloseTo(0.1, 10);
    expect(tickTv(null, [0.5])).toBeNull();
    expect(tickClassShares([stats({ aliveCount: 0 })])[0]).toBeNull();
  });

  it('事件签名只认死亡数与转移矩阵；相同则零翻转', () => {
    const baselineStats = [stats({ tick: 10, deathCount: 0 })];
    const treatmentStats = [stats({ tick: 10, deathCount: 0 })];
    const same = summarizeEventFlips(
      baselineStats,
      flowsMap([
        [
          10,
          [
            [0, 0],
            [0, 0],
          ],
        ],
      ]),
      treatmentStats,
      flowsMap([
        [
          10,
          [
            [0, 0],
            [0, 0],
          ],
        ],
      ]),
    );
    expect(same).toEqual({ firstEventFlipTick: null, eventFlipTicks: 0, flippedEventCount: 0 });

    const changed = summarizeEventFlips(
      baselineStats,
      flowsMap([
        [
          10,
          [
            [0, 0],
            [0, 0],
          ],
        ],
      ]),
      treatmentStats,
      flowsMap([
        [
          10,
          [
            [0, 1],
            [0, 0],
          ],
        ],
      ]),
    );
    expect(changed).toEqual({ firstEventFlipTick: 10, eventFlipTicks: 1, flippedEventCount: 1 });
  });

  it('缺少 flow 行按零矩阵处理；一侧提前结束的 tick 计为翻转', () => {
    const noFlows = summarizeEventFlips(
      [stats({ tick: 10 })],
      new Map(),
      [stats({ tick: 10 })],
      new Map(),
    );
    expect(noFlows).toEqual({
      firstEventFlipTick: null,
      eventFlipTicks: 0,
      flippedEventCount: 0,
    });

    const truncated = summarizeEventFlips(
      [stats({ tick: 10 }), stats({ tick: 11 })],
      new Map(),
      [stats({ tick: 10 })],
      new Map(),
    );
    expect(truncated).toEqual({
      firstEventFlipTick: 11,
      eventFlipTicks: 1,
      flippedEventCount: 1,
    });
  });

  it('首次结构偏离用 30 tick 尾随均值，单日尖峰不算', () => {
    const series = Array.from({ length: 130 }, (_, index) => ({
      tick: index,
      tv: index < 100 ? 0 : 0.2,
    }));
    // 30 个 0.2 的块均值达到 0.1 需要 15 个 tick：100+14 = 114。
    expect(firstTrailingMeanDeviationTick(series, 0.1)).toBe(114);
    const spike = series.map((entry) => ({ ...entry, tv: entry.tick === 100 ? 1 : 0 }));
    expect(firstTrailingMeanDeviationTick(spike, 0.1)).toBeNull();
    expect(firstTrailingMeanDeviationTick(series.slice(0, 10), 0.1)).toBeNull();
  });

  it('逐 tick TV 序列只保留两侧都有的 tick', () => {
    const series = perTickTvSeries(
      [stats({ tick: 1 }), stats({ tick: 2 }), stats({ tick: 3 })],
      [stats({ tick: 1 }), stats({ tick: 3, classCounts: [4, 4, 2, 0, 0] })],
    );
    expect(series.map((entry) => entry.tick)).toEqual([1, 3]);
    expect(series[0]?.tv).toBe(0);
    expect(series[1]?.tv).toBeGreaterThan(0);
  });
});

describe('P6-03 分类与聚合', () => {
  it('区分 identical / 吸收 / 轨迹不同 / 结构不同', () => {
    const base = {
      baselineFinalStateHash: 'sha256:a',
      treatmentFinalStateHash: 'sha256:b',
      eventFlipTicks: 5,
      windowTv: 0.2,
      windowD: 0.2,
      baselineD95: 0.1,
      tvThreshold: 0.1,
    };
    expect(classifyPerturbationPair({ ...base, treatmentFinalStateHash: 'sha256:a' })).toBe(
      'identical',
    );
    expect(classifyPerturbationPair({ ...base, eventFlipTicks: 0 })).toBe('absorbed');
    expect(classifyPerturbationPair(base)).toBe('structural');
    expect(classifyPerturbationPair({ ...base, windowTv: 0.05 })).toBe('trajectory-only');
    expect(classifyPerturbationPair({ ...base, windowD: 0.05 })).toBe('trajectory-only');
  });

  it('baseline 正常波动区间来自跨种子两两 TV/D', () => {
    const baselines = Array.from({ length: 30 }, (_, index) => ({
      regimeKey: 'stable',
      seed: `s-${index}`,
      window: windowOf({
        classShares: [0.5 + index * 0.001, 0.3, 0.15, 0.04, 0.01 - index * 0.001],
      }),
      tickShares: [{ tick: 365, shares: [0.5 + index * 0.001, 0.3, 0.15, 0.04, 0.01] }],
    })) satisfies readonly PerturbationBaselineRecord[];
    const normal = summarizeNormalFluctuation(baselines)[0];
    expect(normal?.regimeKey).toBe('stable');
    expect(normal?.baselinePairs).toBe(435);
    expect(normal?.windowTvP95).toBeGreaterThan(0);
    expect(normal?.windowD95).toBeGreaterThan(0);
    expect(normal?.tickTvP95).toBeGreaterThan(0);
  });

  it('control 全同、财富扰动全结构时，聚合给出分类计数与结构证据', () => {
    const manifest = buildP6PerturbationManifest();
    const baselines: PerturbationBaselineRecord[] = Array.from({ length: 30 }, (_, index) => ({
      regimeKey: 'stable',
      seed: manifest.seeds[index] as string,
      window: windowOf({
        classShares: [0.5 + index * 0.001, 0.3, 0.15, 0.04, 0.01 - index * 0.001],
      }),
      tickShares: [{ tick: 365, shares: [0.5, 0.3, 0.15, 0.04, 0.01] }],
    }));
    const pairs: PerturbationPairRecord[] = [];
    for (let index = 0; index < 30; index += 1) {
      const seed = manifest.seeds[index] as string;
      pairs.push({
        regimeKey: 'stable',
        seed,
        cellKey: 'control=0',
        kind: 'control',
        field: null,
        delta: 0,
        applied: true,
        invalidReason: null,
        checkpointStateHash: 'sha256:checkpoint',
        baselineFinalStateHash: 'sha256:same',
        treatmentFinalStateHash: 'sha256:same',
        firstDivergenceTick: null,
        firstEventFlipTick: null,
        eventFlipTicks: 0,
        flippedEventCount: 0,
        firstStructuralDeviationTick: null,
        windowTv: 0,
        windowD: 0,
        window: windowOf(),
        extinct: false,
        fallbackRate: 0,
        aliveAtEnd: 200,
      });
      pairs.push({
        regimeKey: 'stable',
        seed,
        cellKey: 'wealth_absolute=1e-2',
        kind: 'wealth_absolute',
        field: null,
        delta: 1e-2,
        applied: true,
        invalidReason: null,
        checkpointStateHash: 'sha256:checkpoint',
        baselineFinalStateHash: 'sha256:same',
        treatmentFinalStateHash: `sha256:t-${index}`,
        firstDivergenceTick: 370,
        firstEventFlipTick: 371,
        eventFlipTicks: 10,
        flippedEventCount: 12,
        firstStructuralDeviationTick: 400,
        windowTv: 0.2,
        windowD: 0.2,
        window: windowOf({
          classShares: [0.6, 0.2, 0.1, 0.06, 0.04],
        }),
        extinct: false,
        fallbackRate: 0,
        aliveAtEnd: 200,
      });
    }
    const analysis = summarizePerturbationAnalysis(manifest, baselines, pairs);
    const stable = analysis.regimes.find((regime) => regime.regimeKey === 'stable');
    const control = stable?.cells.find((cell) => cell.cellKey === 'control=0');
    const wealth = stable?.cells.find((cell) => cell.cellKey === 'wealth_absolute=1e-2');
    expect(control?.classified.identical).toBe(30);
    expect(control?.classified.absorbed).toBe(0);
    expect(control?.structuralEvidence).toBe(false);
    expect(wealth?.classified.structural).toBe(30);
    expect(wealth?.structuralEvidence).toBe(true);
    expect(wealth?.firstEventFlipTickMedian).toBe(371);
    expect(wealth?.firstStructuralDeviationTickMedian).toBe(400);
  });
});

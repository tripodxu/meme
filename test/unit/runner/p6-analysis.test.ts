import { describe, expect, it } from 'vitest';

import {
  bootstrapMedianCi,
  evaluateStageA,
  evaluateStageB,
  metricKeyForPrimary,
  signFlipPermutationP,
  type P6AnalysisRun,
  type P6Prereg,
  type P6WindowMetrics,
} from '../../../src/runner/p6-analysis.js';

const SEEDS = Array.from(
  { length: 30 },
  (_, index) => `seed-${String(index + 1).padStart(3, '0')}`,
);

const PREREG: P6Prereg = {
  primaryMetric: 'TV(P)',
  seeds: SEEDS,
  differenceThresholds: {
    tv: 0.1,
    gini: 0.03,
    mUp: 0.05,
    segregation: 0.05,
    openness: 0.05,
  },
  hypothesis: '主指标 TV(P) 达到门槛。',
};

function windowOf(overrides: Partial<P6WindowMetrics> = {}): P6WindowMetrics {
  return {
    classShares: [0.5, 0.3, 0.15, 0.04, 0.01],
    gini: 0.4,
    mUp: 0.5,
    mDown: 0.5,
    segregation: 0.1,
    openness: 0.5,
    fallbackRate: 0,
    ...overrides,
  };
}

function buildRuns(
  options: {
    readonly candidateW2b?: Partial<P6WindowMetrics>;
    readonly candidateW3?: Partial<P6WindowMetrics>;
    readonly baselineW2b?: Partial<P6WindowMetrics>;
    readonly omitCandidateSeed?: string;
  } = {},
): {
  runs: P6AnalysisRun[];
  totals: { due: number; ok: number; failed: number; resumed: number };
} {
  const runs: P6AnalysisRun[] = [];
  for (const seed of SEEDS) {
    runs.push({
      cellKey: 'baseline',
      seed,
      extinct: false,
      w2b: windowOf(options.baselineW2b),
      w3: windowOf(options.baselineW2b),
    });
    if (seed !== options.omitCandidateSeed) {
      runs.push({
        cellKey: 'cell',
        seed,
        extinct: false,
        w2b: windowOf(options.candidateW2b),
        w3: windowOf(options.candidateW3),
      });
    }
  }
  return {
    runs,
    totals: { due: 60, ok: 60, failed: 0, resumed: 0 },
  };
}

describe('P6 Stage B 判读（07 §8/§9）', () => {
  it('按预注册主指标判定：主指标未达门槛时，次要指标超门槛也不能确认', () => {
    const { runs, totals } = buildRuns({
      candidateW2b: {
        classShares: [0.55, 0.29, 0.11, 0.04, 0.01],
        gini: 0.45,
      },
    });
    const result = evaluateStageB({
      cellKey: 'cell',
      targetCellKey: 'cell',
      prereg: PREREG,
      runs,
      totals,
    });

    expect(result.primary?.median).toBeCloseTo(0.05, 10);
    expect(result.primary?.overThreshold).toBe(false);
    expect(result.metrics.gini?.overThreshold).toBe(true);
    expect(result.criteria.primaryOverThreshold).toBe(false);
    expect(result.confirmed).toBe(false);
  });

  it('主指标达到门槛且区间/方向/波动带/完整性满足时确认', () => {
    const { runs, totals } = buildRuns({
      candidateW2b: {
        classShares: [0.62, 0.28, 0.08, 0.015, 0.005],
        gini: 0.45,
        mUp: 0.55,
        openness: 0.55,
      },
    });
    const result = evaluateStageB({
      cellKey: 'cell',
      targetCellKey: 'cell',
      prereg: PREREG,
      runs,
      totals,
    });

    expect(result.primary?.median).toBeCloseTo(0.12, 10);
    expect(result.primary?.overThreshold).toBe(true);
    expect(result.primary?.ciCrossesZero).toBe(false);
    expect(result.primary?.directionAgree).toBe(1);
    expect(result.beyondBandRate).toBe(1);
    expect(result.completeness.ok).toBe(true);
    expect(result.confirmed).toBe(true);
  });

  it('w3 相邻窗口的效应不参与确认（07 §8 第 4 条）', () => {
    const { runs, totals } = buildRuns({
      candidateW3: {
        classShares: [0.65, 0.25, 0.07, 0.02, 0.01],
        gini: 0.5,
      },
    });
    const result = evaluateStageB({
      cellKey: 'cell',
      targetCellKey: 'cell',
      prereg: PREREG,
      runs,
      totals,
    });

    expect(result.primary?.median).toBe(0);
    expect(result.adjacentWindow.tv?.median).toBeCloseTo(0.15, 10);
    expect(result.confirmed).toBe(false);
  });

  it('缺少配对 seed 时完整性失败，不得确认', () => {
    const { runs, totals } = buildRuns({
      omitCandidateSeed: SEEDS[0] as string,
      candidateW2b: {
        classShares: [0.62, 0.28, 0.08, 0.015, 0.005],
        gini: 0.45,
      },
    });
    const result = evaluateStageB({
      cellKey: 'cell',
      targetCellKey: 'cell',
      prereg: PREREG,
      runs,
      totals,
    });

    expect(result.completeness.paired).toBe(29);
    expect(result.completeness.ok).toBe(false);
    expect(result.confirmed).toBe(false);
  });

  it('预注册 hypothesis 与 07 冲突时标记 protocolConflict，但仍按主指标判定', () => {
    const { runs, totals } = buildRuns({
      candidateW2b: {
        classShares: [0.62, 0.28, 0.08, 0.015, 0.005],
        gini: 0.45,
      },
    });
    const result = evaluateStageB({
      cellKey: 'cell',
      targetCellKey: 'cell',
      prereg: {
        ...PREREG,
        hypothesis: '主指标 TV(P) ≥ 0.10 或其他预注册指标超门槛。',
      },
      runs,
      totals,
    });

    expect(result.protocolConflict).toBe(true);
    expect(result.confirmed).toBe(true);
  });

  it('bootstrap 区间是重采样区间，不是 [min, max]', () => {
    const values = Array.from({ length: 30 }, (_, index) => index + 1);
    const first = bootstrapMedianCi(values, { iterations: 2000, seed: 7 });
    const second = bootstrapMedianCi(values, { iterations: 2000, seed: 7 });
    expect(first).toEqual(second);
    expect(first[0]).toBeGreaterThan(values[0] as number);
    expect(first[1]).toBeLessThan(values[29] as number);
    expect(first[0]).toBeLessThan(first[1] as number);
  });

  it('符号翻转置换检验对全正强效应给出小 p 值', () => {
    const values = Array.from({ length: 30 }, (_, index) => 0.1 + index * 0.01);
    expect(signFlipPermutationP(values, { iterations: 2000, seed: 7 })).toBeLessThan(0.01);
  });

  it('主指标名映射与未知名称拒绝', () => {
    expect(metricKeyForPrimary('TV(P)')).toBe('tv');
    expect(metricKeyForPrimary('G')).toBe('gini');
    expect(metricKeyForPrimary('Mup')).toBe('mUp');
    expect(metricKeyForPrimary('Mdown')).toBe('mDown');
    expect(metricKeyForPrimary('S')).toBe('segregation');
    expect(metricKeyForPrimary('O')).toBe('openness');
    expect(() => metricKeyForPrimary('D')).toThrow(/未知的 primaryMetric/);
  });
});

describe('P6 Stage A 严格筛查（07 主指标，w1）', () => {
  function buildStageARuns(
    options: {
      readonly candidateW1?: Partial<P6WindowMetrics>;
      readonly omitCandidateSeed?: string;
    } = {},
  ): {
    runs: P6AnalysisRun[];
    totals: { due: number; ok: number; failed: number; resumed: number };
  } {
    const runs: P6AnalysisRun[] = [];
    for (const seed of SEEDS) {
      runs.push({ cellKey: 'baseline', seed, extinct: false, w1: windowOf() });
      if (seed !== options.omitCandidateSeed) {
        runs.push({
          cellKey: 'cell',
          seed,
          extinct: false,
          w1: windowOf(options.candidateW1),
        });
      }
    }
    return { runs, totals: { due: 60, ok: 60, failed: 0, resumed: 0 } };
  }

  it('TV 未达门槛时，Gini 超门槛也不能入选', () => {
    const { runs, totals } = buildStageARuns({
      candidateW1: { classShares: [0.55, 0.29, 0.11, 0.04, 0.01], gini: 0.45 },
    });
    const result = evaluateStageA({
      populationSize: 40,
      cellKey: 'cell',
      targetCellKey: 'cell',
      prereg: PREREG,
      runs,
      totals,
    });

    expect(result.primary?.median).toBeCloseTo(0.05, 10);
    expect(result.primary?.overThreshold).toBe(false);
    expect(result.metrics.gini?.overThreshold).toBe(true);
    expect(result.screenedIn).toBe(false);
  });

  it('TV 达门槛且完整时入选；TV 方向标为不适用', () => {
    const { runs, totals } = buildStageARuns({
      candidateW1: { classShares: [0.62, 0.28, 0.08, 0.015, 0.005], gini: 0.45 },
    });
    const result = evaluateStageA({
      populationSize: 40,
      cellKey: 'cell',
      targetCellKey: 'cell',
      prereg: PREREG,
      runs,
      totals,
    });

    expect(result.primary?.median).toBeCloseTo(0.12, 10);
    expect(result.primary?.overThreshold).toBe(true);
    expect(result.primary?.directionApplicable).toBe(false);
    expect(result.screenedIn).toBe(true);
  });

  it('缺配对 seed 时完整性失败，不得入选', () => {
    const { runs, totals } = buildStageARuns({
      omitCandidateSeed: SEEDS[0] as string,
      candidateW1: { classShares: [0.62, 0.28, 0.08, 0.015, 0.005], gini: 0.45 },
    });
    const result = evaluateStageA({
      populationSize: 40,
      cellKey: 'cell',
      targetCellKey: 'cell',
      prereg: PREREG,
      runs,
      totals,
    });

    expect(result.completeness.paired).toBe(29);
    expect(result.completeness.ok).toBe(false);
    expect(result.screenedIn).toBe(false);
  });
});

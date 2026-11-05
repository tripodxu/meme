import { describe, expect, it } from 'vitest';

import {
  bhAdjust,
  baselinePairwiseD95,
  directionAgreement,
  liveRunExclusionReasons,
  pairLiveRuns,
  percentileNearestRank,
  summarizeFormalLive,
  type LivePromptStyle,
  type LiveRunRecord,
} from '../../../src/runner/p6-live-comparison.js';

function windowWith(
  shares: readonly number[],
  overrides: Partial<LiveRunRecord['window']> = {},
): LiveRunRecord['window'] {
  return {
    classShares: shares,
    gini: 0.45,
    mUp: 0.5,
    mDown: 0.49,
    segregation: 0.06,
    openness: 0.62,
    fallbackRate: 0,
    missingTicks: 0,
    observedTicks: 365,
    tickCount: 365,
    ...overrides,
  };
}

function run(
  seed: string,
  policyVersion: string,
  promptStyle: LivePromptStyle | null,
  overrides: Partial<LiveRunRecord> = {},
): LiveRunRecord {
  return {
    runKey: `${policyVersion}:${promptStyle ?? 'none'}:${seed}`,
    seed,
    policyVersion,
    promptStyle,
    window: windowWith([0.55, 0.29, 0.13, 0.02, 0.01]),
    extinct: false,
    endReason: null,
    cancelled: false,
    fallbackRate: 0,
    responseModels: policyVersion === 'jev_live' ? ['jev-1.13-free'] : [],
    missingUsage: 0,
    ...overrides,
  };
}

describe('liveRunExclusionReasons', () => {
  it('接受干净 run', () => {
    expect(liveRunExclusionReasons(run('s1', 'jev_live', 'neutral'))).toEqual([]);
  });

  it('剔除回退率、模型漂移、extinct、窗口不完整与 missing usage', () => {
    const reasons = liveRunExclusionReasons(
      run('s1', 'jev_live', 'neutral', {
        fallbackRate: 0.21,
        responseModels: ['jev-1.13-free', 'jev-1.14-free'],
        extinct: true,
        missingUsage: 2,
        window: windowWith([0.55, 0.29, 0.13, 0.02, 0.01], {
          observedTicks: 300,
          tickCount: 365,
        }),
      }),
    );
    expect(reasons).toContain('extinct');
    expect(reasons).toContain('window-incomplete');
    expect(reasons).toContain('fallback-rate>0.20');
    expect(reasons).toContain('model-drift');
    expect(reasons).toContain('missing-usage');
  });
});

describe('pairLiveRuns', () => {
  it('按 07 §8 计算 TV 与 D', () => {
    const candidate = run('s1', 'jev_live', 'neutral', {
      window: windowWith([0.5, 0.3, 0.1, 0.05, 0.05], { gini: 0.48 }),
    });
    const baseline = run('s1', 'mock-weighted-v1', null, {
      window: windowWith([0.4, 0.3, 0.2, 0.05, 0.05], { gini: 0.44 }),
    });
    const pair = pairLiveRuns(candidate, baseline);
    expect(pair.tv).toBeCloseTo(0.1, 12);
    expect(pair.gini).toBeCloseTo(0.04, 12);
    expect(pair.d).toBeCloseTo(0.3 * 0.04 + 0.25 * 0.1, 12);
  });
});

describe('directionAgreement', () => {
  it('全部同号返回 1', () => {
    expect(directionAgreement([0.1, 0.2, 0.3])).toBe(1);
  });

  it('按中位数符号统计', () => {
    expect(directionAgreement([0.1, 0.2, -0.3])).toBeCloseTo(2 / 3, 12);
  });

  it('中位数为 0 时只统计 0', () => {
    expect(directionAgreement([-1, 0, 1])).toBeCloseTo(1 / 3, 12);
  });
});

describe('percentileNearestRank', () => {
  it('空数组为 null，单值返回该值', () => {
    expect(percentileNearestRank([], 0.95)).toBeNull();
    expect(percentileNearestRank([3], 0.95)).toBe(3);
  });

  it('最近秩不插值', () => {
    expect(percentileNearestRank([1, 2, 3, 4], 0.95)).toBe(4);
    expect(percentileNearestRank([1, 2, 3, 4], 0.5)).toBe(3);
  });
});

describe('baselinePairwiseD95', () => {
  it('少于两个可用 run 时为 null', () => {
    expect(baselinePairwiseD95([run('s1', 'mock-weighted-v1', null)])).toBeNull();
  });

  it('同配置不同 seed 的两两 D 取 95 分位', () => {
    const runs = [
      run('s1', 'mock-weighted-v1', null, {
        window: windowWith([0.5, 0.3, 0.1, 0.05, 0.05]),
      }),
      run('s2', 'mock-weighted-v1', null, {
        window: windowWith([0.45, 0.3, 0.15, 0.05, 0.05]),
      }),
      run('s3', 'mock-weighted-v1', null, {
        window: windowWith([0.4, 0.3, 0.2, 0.05, 0.05]),
      }),
    ];
    const d95 = baselinePairwiseD95(runs);
    expect(d95).not.toBeNull();
    expect(d95).toBeGreaterThan(0);
  });
});

describe('bhAdjust', () => {
  it('按 rank 单调化并与输入同序', () => {
    const adjusted = bhAdjust([0.01, 0.04, 0.03, 0.002]);
    expect(adjusted).toEqual([0.02, 0.04, 0.04, 0.008]);
  });

  it('空输入返回空数组', () => {
    expect(bhAdjust([])).toEqual([]);
  });
});

describe('summarizeFormalLive', () => {
  const seeds = Array.from({ length: 10 }, (_, index) => `s-${String(index + 1).padStart(3, '0')}`);
  const shifted: readonly number[] = [0.35, 0.29, 0.23, 0.08, 0.05];

  function makeRuns(): LiveRunRecord[] {
    const runs: LiveRunRecord[] = [];
    for (const seed of seeds) {
      runs.push(
        run(seed, 'mock-weighted-v1', null, {
          window: windowWith([0.55, 0.29, 0.13, 0.02, 0.01], { gini: 0.44 }),
        }),
        run(seed, 'random-uniform-v1', null, {
          window: windowWith([0.75, 0.15, 0.07, 0.02, 0.01], { gini: 0.52 }),
        }),
        run(seed, 'jev_live', 'neutral', {
          window: windowWith(shifted, { gini: 0.56 }),
        }),
        run(seed, 'jev_live', 'survival_hint', {
          window: windowWith(shifted, { gini: 0.57 }),
        }),
      );
    }
    return runs;
  }

  it('构造五个比较、BH 校正与描述性候选判定', () => {
    const summary = summarizeFormalLive(makeRuns(), {
      nRequired: 10,
      bootstrapIterations: 100,
      permutationIterations: 200,
    });
    expect(summary.excluded).toEqual([]);
    expect(summary.comparisons).toHaveLength(5);
    expect(summary.family.pValues).toHaveLength(5);
    expect(summary.family.bhAdjusted).toHaveLength(5);
    const neutralVsMock = summary.comparisons.find(
      (entry) => entry.name === 'live(neutral) vs mock',
    );
    expect(neutralVsMock?.n).toBe(10);
    expect(neutralVsMock?.tvMedian).toBeCloseTo(0.2, 12);
    expect(neutralVsMock?.passes.primaryThreshold).toBe(true);
    expect(neutralVsMock?.passes.direction).toBe(true);
    expect(neutralVsMock?.meetsStructuralCriteria).toBe(true);
    expect(summary.verdict).toBe('descriptive-structural-candidate');
    expect(summary.confirmationStatus).toBe('not-confirmatory-single-seed-set');
  });

  it('质量闸门剔除 run 后不再满足样本量', () => {
    const runs = makeRuns().map((entry) =>
      entry.seed === 's-001' && entry.policyVersion === 'jev_live'
        ? { ...entry, fallbackRate: 0.5 }
        : entry,
    );
    const summary = summarizeFormalLive(runs, {
      nRequired: 10,
      bootstrapIterations: 100,
      permutationIterations: 200,
    });
    expect(summary.excluded).toHaveLength(2);
    const neutralVsMock = summary.comparisons.find(
      (entry) => entry.name === 'live(neutral) vs mock',
    );
    expect(neutralVsMock?.n).toBe(9);
    expect(neutralVsMock?.passes.sampleSize).toBe(false);
    expect(neutralVsMock?.meetsStructuralCriteria).toBe(false);
  });
});

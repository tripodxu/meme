import { describe, expect, it } from 'vitest';

import {
  icc21,
  meanPairwiseTv,
  summarizeReliability,
  type ReliabilityRecord,
} from '../../../src/runner/reliability.js';

const LEGAL = ['accumulate', 'ascend'] as const;

function record(overrides: Partial<ReliabilityRecord> = {}): ReliabilityRecord {
  return {
    selectedAction: 'ascend',
    probabilities: { accumulate: 0.2, ascend: 0.8 },
    probabilitySource: 'exact',
    source: 'jev_live',
    fallbackReason: null,
    responseModel: 'jev-1.13-free',
    ...overrides,
  };
}

describe('Jev 重测信度纯分析（07 §11）', () => {
  it('ICC(2,1)：列完全一致时为 1，评分者反向时为负', () => {
    expect(
      icc21([
        [0.8, 0.8, 0.8],
        [0.2, 0.2, 0.2],
      ]),
    ).toBeCloseTo(1, 10);
    expect(
      icc21([
        [0.8, 0.2],
        [0.2, 0.8],
      ]),
    ).toBeNull();
    expect(
      icc21([
        [0.9, 0.1],
        [0.1, 0.9],
        [0.2, 0.2],
      ]),
    ).toBeLessThan(0.5);
    expect(icc21([[0.8]])).toBeNull();
    expect(icc21([[0.8, 0.2], [0.2]])).toBeNull();
  });

  it('平均两两 TV：相同为 0，正交为 1', () => {
    expect(
      meanPairwiseTv([
        [1, 0],
        [1, 0],
      ]),
    ).toBe(0);
    expect(
      meanPairwiseTv([
        [1, 0],
        [0, 1],
      ]),
    ).toBe(1);
    expect(meanPairwiseTv([[1, 0]])).toBeNull();
  });

  it('20 次完全一致 → reliable', () => {
    const summary = summarizeReliability(
      Array.from({ length: 20 }, () => record()),
      LEGAL,
    );
    expect(summary.validRepeats).toBe(20);
    expect(summary.top1Agreement).toBe(1);
    expect(summary.meanTv).toBe(0);
    expect(summary.icc21).toBeCloseTo(1, 10);
    expect(summary.verdict).toBe('reliable');
    expect(summary.passed).toBe(true);
    expect(summary.optionDistribution).toEqual({ ascend: 20 });
    expect(summary.responseModels).toEqual(['jev-1.13-free']);
  });

  it('top-1 50% 且概率反向 → model_unstable', () => {
    const records = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0
        ? record({ selectedAction: 'accumulate', probabilities: { accumulate: 1, ascend: 0 } })
        : record({ selectedAction: 'ascend', probabilities: { accumulate: 0, ascend: 1 } }),
    );
    const summary = summarizeReliability(records, LEGAL);
    expect(summary.top1Agreement).toBe(0.5);
    expect(summary.meanTv).toBeCloseTo(100 / 190, 10);
    expect(summary.verdict).toBe('model_unstable');
  });

  it('少于 20 次只能标 exploratory', () => {
    const summary = summarizeReliability(
      Array.from({ length: 10 }, () => record()),
      LEGAL,
    );
    expect(summary.verdict).toBe('exploratory');
    expect(summary.passed).toBe(false);
  });

  it('任一回退使有效重复不足 20 → model_unstable', () => {
    const records = [
      ...Array.from({ length: 19 }, () => record()),
      record({
        selectedAction: 'accumulate',
        probabilities: null,
        probabilitySource: 'none',
        source: 'fallback',
        fallbackReason: 'timeout',
      }),
    ];
    const summary = summarizeReliability(records, LEGAL);
    expect(summary.fallbacks).toBe(1);
    expect(summary.validRepeats).toBe(19);
    expect(summary.fallbackReasons).toEqual({ timeout: 1 });
    expect(summary.verdict).toBe('model_unstable');
  });

  it('概率缺失的选项按 0 补齐，不因缺键错位', () => {
    const summary = summarizeReliability(
      Array.from({ length: 20 }, () => record({ probabilities: { ascend: 1 } })),
      LEGAL,
    );
    expect(summary.icc21).toBeCloseTo(1, 10);
    expect(summary.verdict).toBe('reliable');
  });
});

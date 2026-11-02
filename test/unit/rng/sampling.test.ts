import { describe, expect, it, vi } from 'vitest';

import {
  fisherYatesShuffle,
  sampleTruncatedLognormal,
  sampleTruncatedNormal,
  standardNormalFromPair,
  uniformIndex,
  weightedSampleIndex,
} from '../../../src/core/rng/sampling.js';
import { createDraw } from '../../../src/core/rng/rng.js';
import { RNG_EVENT_TAGS } from '../../../src/core/rng/tags.js';

describe('标准抽样算法（03 §4.2）', () => {
  describe('uniformIndex', () => {
    it('j=floor(R×length) 且落在 [0,length)', () => {
      expect(uniformIndex(0, 5)).toBe(0);
      expect(uniformIndex(0.999, 5)).toBe(4);
      expect(uniformIndex(0.4, 5)).toBe(2);
    });

    it('length=0 返回 -1 表示无候选', () => {
      expect(uniformIndex(0.5, 0)).toBe(-1);
    });

    it('非法输入抛不变量错误', () => {
      expect(() => uniformIndex(1, 5)).toThrowError();
      expect(() => uniformIndex(-0.1, 5)).toThrowError();
      expect(() => uniformIndex(0.5, -1)).toThrowError();
      expect(() => uniformIndex(0.5, 2.5)).toThrowError();
    });
  });

  describe('fisherYatesShuffle', () => {
    it('保持多重集合并确定性重排', () => {
      const draw = createDraw('seed-x', -1, 'population');
      const input = [0, 0, 1, 1, 2, 3];
      const first = fisherYatesShuffle(input, (counter) =>
        draw(RNG_EVENT_TAGS.initClassShuffle, counter),
      );
      const second = fisherYatesShuffle(input, (counter) =>
        draw(RNG_EVENT_TAGS.initClassShuffle, counter),
      );
      expect(first).toEqual(second);
      expect([...first].sort((a, b) => a - b)).toEqual(input);
      expect(first).not.toEqual(input); // 该 seed 下确实发生了重排
    });

    it('n<=1 时不消费随机数', () => {
      const draw = vi.fn(() => 0.5);
      expect(fisherYatesShuffle([], draw)).toEqual([]);
      expect(fisherYatesShuffle(['only'], draw)).toEqual(['only']);
      expect(draw).not.toHaveBeenCalled();
    });

    it('counter 从 0 递增消费', () => {
      const counters: number[] = [];
      fisherYatesShuffle(['a', 'b', 'c', 'd'], (counter) => {
        counters.push(counter);
        return 0.1;
      });
      expect(counters).toEqual([0, 1, 2]);
    });
  });

  describe('weightedSampleIndex', () => {
    it('按累计权重选择首个满足 target<cumulative 的候选', () => {
      // weights [1, 3]; r=0.2 → target=0.8 < 1 → 0；r=0.5 → target=2 >= 1 → 1
      expect(weightedSampleIndex([1, 3], 0.2)).toBe(0);
      expect(weightedSampleIndex([1, 3], 0.5)).toBe(1);
    });

    it('零权重候选不会被选中', () => {
      expect(weightedSampleIndex([0, 2], 0.01)).toBe(1);
      expect(weightedSampleIndex([0, 0, 5], 0.99)).toBe(2);
    });

    it('sum=0 视为无候选返回 -1', () => {
      expect(weightedSampleIndex([0, 0], 0.5)).toBe(-1);
    });

    it('非法权重抛不变量错误', () => {
      expect(() => weightedSampleIndex([-1, 2], 0.5)).toThrowError();
      expect(() => weightedSampleIndex([Number.NaN, 2], 0.5)).toThrowError();
      expect(() => weightedSampleIndex([Number.POSITIVE_INFINITY], 0.5)).toThrowError();
    });
  });

  describe('standardNormalFromPair', () => {
    it('与公式逐项一致', () => {
      const u1 = 0.3;
      const u2 = 0.7;
      const expected =
        Math.sqrt(-2 * Math.log(Math.max(u1, 2 ** -53))) * Math.cos(2 * Math.PI * u2);
      expect(standardNormalFromPair(u1, u2)).toBe(expected);
    });

    it('u1 极小时使用 2^-53 下限', () => {
      const expected = Math.sqrt(-2 * Math.log(2 ** -53)) * Math.cos(2 * Math.PI * 0.5);
      expect(standardNormalFromPair(0, 0.5)).toBe(expected);
    });
  });

  describe('截断分布先验校验', () => {
    it('sigma/min/max 非法时抛不变量错误', () => {
      const draw = vi.fn(() => 0.5);
      expect(() =>
        sampleTruncatedLognormal({ sigma: Number.NaN, median: 1, min: 0.2, max: 3 }, draw),
      ).toThrowError(/先验非法/);
      expect(() =>
        sampleTruncatedLognormal({ sigma: 0.5, median: 1, min: 0, max: 3 }, draw),
      ).toThrowError(/先验非法/);
      expect(() =>
        sampleTruncatedLognormal({ sigma: 0.5, median: 1, min: 3, max: 0.2 }, draw),
      ).toThrowError(/先验非法/);
      expect(() => sampleTruncatedNormal({ mean: 1, sigma: 1, min: 3, max: 2 }, draw)).toThrowError(
        /先验非法/,
      );
      expect(draw).not.toHaveBeenCalled();
    });

    it('中位数/均值必须位于截断区间内', () => {
      const draw = vi.fn(() => 0.5);
      expect(() =>
        sampleTruncatedLognormal({ sigma: 0.5, median: 0.1, min: 0.2, max: 3 }, draw),
      ).toThrowError(/中位数/);
      expect(() =>
        sampleTruncatedLognormal({ sigma: 0.5, median: 5, min: 0.2, max: 3 }, draw),
      ).toThrowError(/中位数/);
      expect(() => sampleTruncatedNormal({ mean: 0, sigma: 1, min: 1, max: 3 }, draw)).toThrowError(
        /均值/,
      );
      expect(draw).not.toHaveBeenCalled();
    });
  });

  describe('截断对数正态', () => {
    it('sigma=0 直接取中位数且不消费随机数', () => {
      const draw = vi.fn(() => 0.5);
      const sample = sampleTruncatedLognormal({ sigma: 0, median: 1, min: 0.2, max: 3 }, draw);
      expect(sample).toBe(1);
      expect(draw).not.toHaveBeenCalled();
    });

    it('所有样本落在截断区间内', () => {
      const draw = createDraw('trunc-seed', -1, 'a-0000');
      for (let index = 0; index < 200; index += 1) {
        const sample = sampleTruncatedLognormal(
          { sigma: 0.5, median: 1, min: 0.2, max: 3 },
          (counter) => draw(RNG_EVENT_TAGS.initGe, index * 100 + counter),
        );
        expect(sample).toBeGreaterThanOrEqual(0.2);
        expect(sample).toBeLessThanOrEqual(3);
      }
    });

    it('样本分布中心接近中位数', () => {
      const draw = createDraw('center-seed', -1, 'a-0000');
      let sum = 0;
      const runs = 500;
      for (let index = 0; index < runs; index += 1) {
        sum += sampleTruncatedLognormal({ sigma: 0.5, median: 1, min: 0.2, max: 3 }, (counter) =>
          draw(RNG_EVENT_TAGS.initGe, index * 100 + counter),
        );
      }
      const mean = sum / runs;
      expect(mean).toBeGreaterThan(0.85);
      expect(mean).toBeLessThan(1.15);
    });

    it('不可满足的截断区间超限后抛 invariant_violated', () => {
      const draw = createDraw('impossible', -1, 'a-0000');
      // min=max=median=1 且 sigma>0：exp(sigma·z) 恰好等于 1 的概率为 0。
      expect(() =>
        sampleTruncatedLognormal({ sigma: 0.5, median: 1, min: 1, max: 1 }, (counter) =>
          draw(RNG_EVENT_TAGS.initGe, counter),
        ),
      ).toThrowError(/尝试上限/);
    });
  });

  describe('截断正态', () => {
    it('sigma=0 直接取均值且不消费随机数', () => {
      const draw = vi.fn(() => 0.5);
      expect(sampleTruncatedNormal({ mean: 10, sigma: 0, min: 1, max: 20 }, draw)).toBe(10);
      expect(draw).not.toHaveBeenCalled();
    });

    it('所有样本落在截断区间内且确定性可复现', () => {
      const draw = createDraw('life-seed', -1, 'a-0003');
      const first = sampleTruncatedNormal(
        { mean: 25550, sigma: 1825, min: 3650, max: 43800 },
        (counter) => draw(RNG_EVENT_TAGS.initLife, counter),
      );
      const second = sampleTruncatedNormal(
        { mean: 25550, sigma: 1825, min: 3650, max: 43800 },
        (counter) => draw(RNG_EVENT_TAGS.initLife, counter),
      );
      expect(first).toBe(second);
      expect(first).toBeGreaterThanOrEqual(3650);
      expect(first).toBeLessThanOrEqual(43800);
    });

    it('不可满足的截断区间超限后抛 invariant_violated', () => {
      const draw = createDraw('impossible-normal', -1, 'a-0000');
      expect(() =>
        sampleTruncatedNormal({ mean: 1, sigma: 1, min: 1, max: 1 }, (counter) =>
          draw(RNG_EVENT_TAGS.initLife, counter),
        ),
      ).toThrowError(/尝试上限/);
    });
  });
});

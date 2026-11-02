import { describe, expect, it } from 'vitest';

import { computeGini, computeSegregation } from '../../../src/core/macros/metrics.js';

describe('基尼系数（03 §6 阶段 G）', () => {
  it('空人口与全零财富返回 0', () => {
    expect(computeGini([])).toBe(0);
    expect(computeGini([0, 0, 0, 0])).toBe(0);
  });

  it('完全平等的财富分布 G=0', () => {
    expect(computeGini([5, 5, 5, 5])).toBe(0);
  });

  it('已知分布与公式一致', () => {
    // 升序 [1,2,3,4]：G = Σ(2i-n-1)x[i]/(nΣx) = (-3+(-1)+1+3)/... 手算
    const values = [1, 2, 3, 4];
    const n = 4;
    const sum = 10;
    const weighted =
      (2 * 1 - n - 1) * 1 + (2 * 2 - n - 1) * 2 + (2 * 3 - n - 1) * 3 + (2 * 4 - n - 1) * 4;
    expect(computeGini(values)).toBe(weighted / (n * sum));
  });

  it('单个体 G=0；极端集中接近 1', () => {
    expect(computeGini([7])).toBe(0);
    expect(computeGini([0, 0, 0, 100])).toBeCloseTo(0.75, 12);
  });

  it('非法输入抛不变量错误', () => {
    expect(() => computeGini([-1, 2])).toThrowError(/有限且 >=0/);
    expect(() => computeGini([Number.NaN])).toThrowError(/有限且 >=0/);
    expect(() => computeGini([Number.POSITIVE_INFINITY])).toThrowError(/有限且 >=0/);
  });
});

describe('调整后隔离度 S（03 §6 阶段 G）', () => {
  it('无边时 S=0', () => {
    expect(computeSegregation(0, 0, [2, 2])).toBe(0);
  });

  it('随机混合（sameShare==expectedShare）时 S≈0', () => {
    // P=[0.5,0.5] → expectedShare=0.5；2 条边中 1 条同层 → sameShare=0.5 → S=0
    expect(computeSegregation(1, 2, [1, 1])).toBe(0);
  });

  it('全部同层时 S=1', () => {
    expect(computeSegregation(4, 4, [2, 0])).toBe(1);
  });

  it('无同层边时 S=-1', () => {
    expect(computeSegregation(0, 4, [2, 2])).toBe(-1);
  });

  it('跨层多于随机时 S 位于 (-1,0)', () => {
    const s = computeSegregation(1, 4, [1, 1]);
    expect(s).toBeLessThan(0);
    expect(s).toBeGreaterThan(-1);
  });

  it('expectedShare 极端接近 1 时仍位于 [-1,1]', () => {
    const s = computeSegregation(0, 3, [9, 1, 0, 0, 0]);
    expect(s).toBeGreaterThanOrEqual(-1);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('非法输入抛不变量错误', () => {
    expect(() => computeSegregation(3, 2, [1, 1])).toThrowError(/同层边数/);
    expect(() => computeSegregation(0, 2, [])).toThrowError(/空人口/);
    expect(() => computeSegregation(1.5, 2, [1, 1])).toThrowError(/非负整数/);
  });
});

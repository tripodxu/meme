import { describe, expect, it } from 'vitest';

import { allocateClassCounts } from '../../../src/core/init/allocate.js';

describe('最大余数法分配（03 §4.3）', () => {
  it('默认 40 人配置得到 [18,12,6,3,1]', () => {
    expect(allocateClassCounts([0.45, 0.3, 0.15, 0.08, 0.02], 40)).toEqual([18, 12, 6, 3, 1]);
  });

  it('余数按小数部分降序分配', () => {
    // floors: [1,0,0,0,0]，剩余 2，余数 .9(c1) > .45(c2) > .35(c0)
    expect(allocateClassCounts([0.45, 0.3, 0.15, 0.08, 0.02], 3)).toEqual([1, 1, 1, 0, 0]);
  });

  it('余数并列时优先较小 classIndex', () => {
    expect(allocateClassCounts([0.5, 0.5], 3)).toEqual([2, 1]);
    expect(allocateClassCounts([1 / 3, 1 / 3, 1 / 3], 2)).toEqual([1, 1, 0]);
  });

  it('总人数严格等于 population', () => {
    expect(allocateClassCounts([0.6, 0.25, 0.1, 0.04, 0.01], 17).reduce((a, b) => a + b, 0)).toBe(
      17,
    );
  });

  it('允许某些阶级人数为 0', () => {
    const counts = allocateClassCounts([1, 0, 0], 5);
    expect(counts).toEqual([5, 0, 0]);
  });

  it('非法输入抛不变量错误', () => {
    expect(() => allocateClassCounts([0.5, -0.1], 4)).toThrowError();
    expect(() => allocateClassCounts([0.5, 0.5], 2.5)).toThrowError();
    expect(() => allocateClassCounts([0.5, 0.6], 10)).toThrowError(/负余数/);
    // 比例总和不足且余数多于阶级数时无法补齐到总人口。
    expect(() => allocateClassCounts([0.1, 0.1, 0.1], 10)).toThrowError(/分配总数/);
  });
});

import { describe, expect, it } from 'vitest';

import { buildClassStack } from '../../../src/ui/workspaces/overview.js';

describe('阶级结构堆叠数据', () => {
  it('每个 tick 独立累加 class 0..i，且不超过 [0,1]', () => {
    const rows = [
      { tick: 0, aliveCount: 40, classCounts: [10, 20, 10] },
      { tick: 1, aliveCount: 40, classCounts: [0, 30, 10] },
      { tick: 2, aliveCount: 0, classCounts: [0, 0, 0] },
    ];
    const series = buildClassStack(rows, 3);
    expect(series.map((entry) => entry.label)).toEqual(['Class 0', 'Class 1', 'Class 2']);
    expect(series[0]?.points).toEqual([
      { x: 1, y: 0.25 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
    expect(series[1]?.points).toEqual([
      { x: 1, y: 0.75 },
      { x: 2, y: 0.75 },
      { x: 3, y: 0 },
    ]);
    expect(series[2]?.points.map((point) => point.y)).toEqual([1, 1, 0]);
    for (const entry of series) {
      for (const point of entry.points) {
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(1);
      }
    }
  });

  it('空数据返回空序列', () => {
    expect(buildClassStack([], 5)).toEqual([]);
  });
});

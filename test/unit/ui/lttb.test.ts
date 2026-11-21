import { describe, expect, it } from 'vitest';

import { lttb, pixelThreshold } from '../../../src/ui/charts/lttb.js';

function series(length: number): { x: number; y: number }[] {
  return Array.from({ length }, (_, index) => ({
    x: index,
    y: Math.sin(index / 7) * 10 + (index % 5),
  }));
}

describe('LTTB 降采样（P3-07）', () => {
  it('保留首尾点且输出不超过阈值', () => {
    const data = series(2000);
    const sampled = lttb(data, 200);
    expect(sampled.length).toBeLessThanOrEqual(200);
    expect(sampled[0]).toEqual(data[0]);
    expect(sampled[sampled.length - 1]).toEqual(data[data.length - 1]);
  });

  it('阈值不小于数据长度时原样返回', () => {
    const data = series(50);
    expect(lttb(data, 50)).toEqual(data);
    expect(lttb(data, 100)).toEqual(data);
  });

  it('保留尖峰形状而非均匀抽样', () => {
    const data = series(1000);
    data[500] = { x: 500, y: 1000 };
    const sampled = lttb(data, 100);
    expect(sampled.some((point) => point.x === 500)).toBe(true);
  });

  it('像素阈值至少为 3', () => {
    expect(pixelThreshold(1)).toBe(3);
    expect(pixelThreshold(640)).toBe(640);
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { renderBarChart } from '../../../src/ui/charts/core.js';

describe('renderBarChart 类别轴渲染（F0）', () => {
  it('只渲染类别标签，不在 x 轴绘制 0..1 数值刻度', () => {
    const svg = renderBarChart(
      [
        { label: 'accumulate', value: 12 },
        { label: 'ascend', value: 3 },
        { label: 'descend', value: 1 },
        { label: 'compete', value: 8 },
      ],
      { title: '行动分布' },
    );

    const texts = [...svg.querySelectorAll('text.chart-axis')].map((el) => el.textContent ?? '');
    expect(texts).toContain('accumulate');
    expect(texts).toContain('ascend');
    expect(texts).toContain('descend');
    expect(texts).toContain('compete');
    expect(texts).not.toContain('0.250');
    expect(texts).not.toContain('0.500');
    expect(texts).not.toContain('0.750');
  });
});

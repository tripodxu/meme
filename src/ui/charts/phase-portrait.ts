import type { TickStats } from '../../core/macros/tick-metrics.js';
import { emptyChart, svgEl } from './core.js';
import { lttb } from './lttb.js';

export type PhaseYAxis = 'segregation' | 'gini';

export function renderPhasePortrait(
  rows: readonly TickStats[],
  options: {
    readonly yAxis?: PhaseYAxis;
    readonly ghostRows?: readonly TickStats[];
    readonly width?: number;
    readonly height?: number;
  } = {},
): SVGSVGElement {
  const yAxis = options.yAxis ?? 'segregation';
  if (rows.length === 0) {
    return emptyChart('尚无该窗口相空间数据', { height: options.height ?? 215 });
  }
  const width = options.width ?? 460;
  const height = options.height ?? 215;
  const left = 44;
  const top = 16;
  const boxW = width - 60;
  const boxH = height - 44;

  const yMin = yAxis === 'segregation' ? -0.2 : 0;
  const yMax = yAxis === 'segregation' ? 0.65 : 1;

  const xOf = (o: number): number => left + Math.min(1, Math.max(0, o)) * boxW;
  const yOf = (val: number): number => {
    const ratio = (Math.min(yMax, Math.max(yMin, val)) - yMin) / (yMax - yMin);
    return top + (1 - ratio) * boxH;
  };

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart',
    role: 'img',
    'aria-label': `相空间轨迹图 O vs ${yAxis === 'segregation' ? 'S' : 'G'}`,
  });

  // 网格参考线
  for (let i = 0; i <= 4; i += 1) {
    const y = top + (boxH * i) / 4;
    const val = yMax - ((yMax - yMin) * i) / 4;
    svg.append(
      svgEl('line', { x1: left, y1: y, x2: left + boxW, y2: y, stroke: 'var(--border-subtle)' }),
      svgEl(
        'text',
        { x: left - 6, y: y + 3, 'text-anchor': 'end', class: 'chart-axis' },
        val.toFixed(2),
      ),
    );
    const x = left + (boxW * i) / 4;
    svg.append(
      svgEl('line', {
        x1: x,
        y1: top,
        x2: x,
        y2: top + boxH,
        stroke: 'var(--border-subtle)',
        class: 'chart-grid-line',
      }),
      svgEl(
        'text',
        { x, y: top + boxH + 14, 'text-anchor': 'middle', class: 'chart-axis' },
        (i * 0.25).toFixed(2),
      ),
    );
  }

  // D1 校准体制参考质心（仅在 S 轴展示，来自 changes/0089）
  if (yAxis === 'segregation') {
    const centroids = [
      { label: 'D1 体制 I', o: 0.672, s: 0.257 },
      { label: 'D1 体制 II', o: 0.901, s: 0.016 },
    ];
    for (const c of centroids) {
      const cx = xOf(c.o);
      const cy = yOf(c.s);
      svg.append(
        svgEl('circle', {
          cx,
          cy,
          r: 7,
          fill: 'none',
          stroke: 'var(--text-muted)',
          'stroke-dasharray': '2 2',
          'stroke-width': 1.2,
        }),
        svgEl('text', { x: cx, y: cy - 10, 'text-anchor': 'middle', class: 'chart-axis' }, c.label),
      );
    }
  }

  const buildPath = (src: readonly TickStats[]): string => {
    const sampled =
      src.length > 260
        ? lttb(
            src.map((r) => ({
              x: r.openness,
              y: yAxis === 'segregation' ? r.segregation : r.gini,
            })),
            260,
          )
        : src.map((r) => ({ x: r.openness, y: yAxis === 'segregation' ? r.segregation : r.gini }));
    return sampled
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${xOf(p.x).toFixed(1)},${yOf(p.y).toFixed(1)}`)
      .join(' ');
  };

  if (options.ghostRows !== undefined && options.ghostRows.length > 0) {
    svg.append(
      svgEl('path', {
        d: buildPath(options.ghostRows),
        fill: 'none',
        stroke: 'var(--text-muted)',
        'stroke-width': 1.3,
        'stroke-dasharray': '3 3',
        'stroke-opacity': 0.55,
      }),
    );
  }

  svg.append(
    svgEl('path', {
      d: buildPath(rows),
      fill: 'none',
      stroke: 'var(--accent)',
      'stroke-width': 1.9,
      'stroke-linejoin': 'round',
    }),
  );

  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const yStart = yAxis === 'segregation' ? first.segregation : first.gini;
  const yEnd = yAxis === 'segregation' ? last.segregation : last.gini;
  svg.append(
    svgEl('circle', {
      cx: xOf(first.openness),
      cy: yOf(yStart),
      r: 3.5,
      fill: 'var(--bg-panel)',
      stroke: 'var(--accent)',
      'stroke-width': 1.6,
    }),
    svgEl('circle', {
      cx: xOf(last.openness),
      cy: yOf(yEnd),
      r: 4.2,
      fill: 'var(--accent)',
    }),
    svgEl(
      'text',
      { x: left, y: 11, class: 'chart-label' },
      yAxis === 'segregation' ? 'S (隔离度)' : 'G (基尼系数)',
    ),
    svgEl(
      'text',
      { x: left + boxW / 2, y: height - 4, 'text-anchor': 'middle', class: 'chart-label' },
      'O (制度开放度)',
    ),
  );
  return svg;
}

import { lttb, pixelThreshold, type Point } from './lttb.js';

export interface Series {
  readonly label: string;
  readonly color: string;
  readonly points: readonly Point[];
  readonly dashed?: boolean;
}

export interface ChartOptions {
  readonly width?: number;
  readonly height?: number;
  readonly yMin?: number;
  readonly yMax?: number;
  readonly xMin?: number;
  readonly xMax?: number;
  readonly xLabel?: string;
  readonly yLabel?: string;
  readonly title?: string;
  /** 显式声明窗口/单位，避免把终局值冒名窗口均值（06 §5）。 */
  readonly windowLabel?: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  text?: string,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    element.setAttribute(key, String(value));
  }
  if (text !== undefined) element.textContent = text;
  return element;
}

export function emptyChart(message: string, options: ChartOptions = {}): SVGSVGElement {
  const width = options.width ?? 480;
  const height = options.height ?? 180;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart chart-empty',
    role: 'img',
    'aria-label': message,
  });
  svg.append(
    svgEl('rect', {
      x: 0,
      y: 0,
      width,
      height,
      fill: 'transparent',
    }),
    svgEl(
      'text',
      {
        x: width / 2,
        y: height / 2,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        class: 'chart-empty-text',
      },
      message,
    ),
  );
  return svg;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function boxOf(width: number, height: number): Box {
  return { left: 48, top: 18, width: width - 64, height: height - 50 };
}

function bounds(
  series: readonly Series[],
  options: ChartOptions,
): {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
} {
  const points = series.flatMap((entry) => entry.points);
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  const xMin = options.xMin ?? Math.min(...xValues, 0);
  const xMax = options.xMax ?? Math.max(...xValues, 1);
  let yMin = options.yMin ?? Math.min(...yValues, 0);
  let yMax = options.yMax ?? Math.max(...yValues, 1);
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    yMin = 0;
    yMax = 1;
  }
  if (yMin === yMax) {
    yMin -= 0.5;
    yMax += 0.5;
  }
  return { xMin, xMax, yMin, yMax };
}

function xOf(value: number, boundsValue: ReturnType<typeof bounds>, box: Box): number {
  const span = boundsValue.xMax - boundsValue.xMin || 1;
  return box.left + ((value - boundsValue.xMin) / span) * box.width;
}

function yOf(value: number, boundsValue: ReturnType<typeof bounds>, box: Box): number {
  const span = boundsValue.yMax - boundsValue.yMin || 1;
  return box.top + (1 - (value - boundsValue.yMin) / span) * box.height;
}

function pathOf(
  points: readonly Point[],
  boundsValue: ReturnType<typeof bounds>,
  box: Box,
  threshold: number,
): string {
  const sampled = points.length > threshold ? lttb(points, threshold) : [...points];
  return sampled
    .map((point, index) => {
      const x = xOf(point.x, boundsValue, box);
      const y = yOf(point.y, boundsValue, box);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

function addFrame(
  svg: SVGSVGElement,
  options: ChartOptions,
  boundsValue: ReturnType<typeof bounds>,
  box: Box,
): void {
  const width = options.width ?? 480;
  const height = options.height ?? 180;
  const grid = svgEl('g', { class: 'chart-grid' });
  for (let index = 0; index <= 4; index += 1) {
    const y = box.top + (box.height * index) / 4;
    const value = boundsValue.yMax - ((boundsValue.yMax - boundsValue.yMin) * index) / 4;
    grid.append(
      svgEl('line', { x1: box.left, y1: y, x2: box.left + box.width, y2: y }),
      svgEl(
        'text',
        {
          x: box.left - 8,
          y: y + 3,
          'text-anchor': 'end',
          class: 'chart-axis',
        },
        formatAxis(value),
      ),
    );
  }
  for (let index = 0; index <= 4; index += 1) {
    const x = box.left + (box.width * index) / 4;
    const value = boundsValue.xMin + ((boundsValue.xMax - boundsValue.xMin) * index) / 4;
    grid.append(
      svgEl('line', {
        x1: x,
        y1: box.top,
        x2: x,
        y2: box.top + box.height,
        class: 'chart-grid-line',
      }),
      svgEl(
        'text',
        {
          x,
          y: box.top + box.height + 16,
          'text-anchor': 'middle',
          class: 'chart-axis',
        },
        formatAxis(value),
      ),
    );
  }
  svg.append(grid);
  if (options.xLabel !== undefined) {
    svg.append(
      svgEl(
        'text',
        {
          x: box.left + box.width / 2,
          y: height - 8,
          'text-anchor': 'middle',
          class: 'chart-label',
        },
        options.xLabel,
      ),
    );
  }
  if (options.yLabel !== undefined) {
    svg.append(
      svgEl(
        'text',
        {
          x: 12,
          y: box.top + box.height / 2,
          'text-anchor': 'middle',
          transform: `rotate(-90 12 ${box.top + box.height / 2})`,
          class: 'chart-label',
        },
        options.yLabel,
      ),
    );
  }
  void width;
}

function formatAxis(value: number): string {
  if (Math.abs(value) >= 1000) return value.toExponential(1);
  if (Math.abs(value) >= 10) return value.toFixed(0);
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

export function renderLineChart(
  series: readonly Series[],
  options: ChartOptions = {},
): SVGSVGElement {
  const populated = series.filter((entry) => entry.points.length > 0);
  if (populated.length === 0) return emptyChart('暂无数据', options);
  const width = options.width ?? 480;
  const height = options.height ?? 180;
  const box = boxOf(width, height);
  const boundsValue = bounds(populated, options);
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart',
    role: 'img',
    'aria-label': options.title ?? options.yLabel ?? '折线图',
  });
  addFrame(svg, options, boundsValue, box);
  const group = svgEl('g', { class: 'chart-series' });
  const threshold = pixelThreshold(box.width);
  for (const entry of populated) {
    group.append(
      svgEl('path', {
        d: pathOf(entry.points, boundsValue, box, threshold),
        fill: 'none',
        stroke: entry.color,
        'stroke-width': 2,
        'stroke-dasharray': entry.dashed === true ? '4 4' : 'none',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    );
  }
  svg.append(group);
  return svg;
}

export function renderStackedArea(
  series: readonly Series[],
  options: ChartOptions = {},
): SVGSVGElement {
  const populated = series.filter((entry) => entry.points.length > 0);
  if (populated.length === 0) return emptyChart('暂无数据', options);
  const width = options.width ?? 480;
  const height = options.height ?? 220;
  const box = boxOf(width, height);
  const boundsValue = bounds(populated, { ...options, yMin: 0, yMax: options.yMax ?? 1 });
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart',
    role: 'img',
    'aria-label': options.title ?? '堆叠面积图',
  });
  addFrame(svg, options, boundsValue, box);
  const xs = populated[0]?.points.map((point) => point.x) ?? [];
  const layers: string[] = [];
  for (let index = 0; index < populated.length; index += 1) {
    const entry = populated[index];
    if (entry === undefined) continue;
    const points = entry.points;
    const sampled =
      points.length > pixelThreshold(box.width) ? lttb(points, pixelThreshold(box.width)) : points;
    const top = sampled
      .map(
        (point) =>
          `${xOf(point.x, boundsValue, box).toFixed(2)},${yOf(point.y, boundsValue, box).toFixed(2)}`,
      )
      .join(' ');
    const bottomPoints = index === 0 ? [] : (populated[index - 1]?.points ?? []);
    const bottomMap = new Map(bottomPoints.map((point) => [point.x, point.y]));
    const bottom = sampled
      .slice()
      .reverse()
      .map((point) => {
        const base = bottomMap.get(point.x) ?? 0;
        return `${xOf(point.x, boundsValue, box).toFixed(2)},${yOf(base, boundsValue, box).toFixed(2)}`;
      })
      .join(' ');
    layers.push(
      `<polygon points="${top} ${bottom}" fill="${entry.color}" fill-opacity="0.55" stroke="${entry.color}" stroke-width="1"/>`,
    );
  }
  svg.append(htmlToSvg(layers.join('')));
  void xs;
  return svg;
}

export function renderBarChart(
  bars: readonly { label: string; value: number; color?: string }[],
  options: ChartOptions = {},
): SVGSVGElement {
  if (bars.length === 0) return emptyChart('暂无数据', options);
  const width = options.width ?? 480;
  const height = options.height ?? 200;
  const box = boxOf(width, height);
  const max = Math.max(...bars.map((bar) => bar.value), 1);
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart',
    role: 'img',
    'aria-label': options.title ?? '柱状图',
  });
  addFrame(svg, options, { xMin: 0, xMax: 1, yMin: 0, yMax: max }, box);
  const slot = box.width / bars.length;
  bars.forEach((bar, index) => {
    const x = box.left + slot * index + slot * 0.15;
    const barWidth = slot * 0.7;
    const y = yOf(bar.value, { xMin: 0, xMax: 1, yMin: 0, yMax: max }, box);
    svg.append(
      svgEl('rect', {
        x,
        y,
        width: barWidth,
        height: box.top + box.height - y,
        fill: bar.color ?? 'var(--accent)',
        rx: 2,
      }),
      svgEl(
        'text',
        {
          x: x + barWidth / 2,
          y: box.top + box.height + 16,
          'text-anchor': 'middle',
          class: 'chart-axis',
        },
        bar.label,
      ),
    );
  });
  return svg;
}

export function renderHeatmap(
  matrix: readonly (readonly number[])[],
  rowLabels: readonly string[],
  colLabels: readonly string[],
  options: ChartOptions = {},
): SVGSVGElement {
  if (matrix.length === 0) return emptyChart('暂无转移矩阵', options);
  const width = options.width ?? 360;
  const height = options.height ?? 300;
  const left = 42;
  const top = 22;
  const cell = Math.min(
    (width - left - 10) / colLabels.length,
    (height - top - 10) / rowLabels.length,
  );
  const max = Math.max(...matrix.flat(), 1);
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart',
    role: 'img',
    'aria-label': options.title ?? '转移矩阵热力图',
  });
  matrix.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      const intensity = value / max;
      svg.append(
        svgEl('rect', {
          x: left + colIndex * cell,
          y: top + rowIndex * cell,
          width: cell - 2,
          height: cell - 2,
          fill: 'var(--accent)',
          'fill-opacity': 0.08 + intensity * 0.82,
          rx: 2,
        }),
        svgEl(
          'text',
          {
            x: left + colIndex * cell + cell / 2,
            y: top + rowIndex * cell + cell / 2 + 3,
            'text-anchor': 'middle',
            class: 'chart-axis',
          },
          value === 0 ? '' : String(value),
        ),
      );
    });
    svg.append(
      svgEl(
        'text',
        {
          x: left - 8,
          y: top + rowIndex * cell + cell / 2 + 3,
          'text-anchor': 'end',
          class: 'chart-axis',
        },
        rowLabels[rowIndex] ?? '',
      ),
    );
  });
  colLabels.forEach((label, index) => {
    svg.append(
      svgEl(
        'text',
        {
          x: left + index * cell + cell / 2,
          y: top - 6,
          'text-anchor': 'middle',
          class: 'chart-axis',
        },
        label,
      ),
    );
  });
  return svg;
}

function htmlToSvg(markup: string): SVGGElement {
  const group = svgEl('g');
  const template = document.createElement('template');
  template.innerHTML = `<svg xmlns="${SVG_NS}">${markup}</svg>`;
  const root = template.content.firstElementChild;
  if (root !== null) {
    for (const child of Array.from(root.childNodes)) {
      group.append(child.cloneNode(true));
    }
  }
  return group;
}

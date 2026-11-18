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
      x: 8,
      y: 8,
      width: width - 16,
      height: height - 16,
      rx: 6,
      fill: 'none',
      stroke: 'var(--border-subtle)',
      'stroke-dasharray': '3 3',
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
  return { left: 48, top: 16, width: width - 64, height: height - 46 };
}

/**
 * O(N) 紧循环求边界（彻底避免 `Math.min(...xValues)` 在数万点时调用栈溢出与大数组分配）。
 */
function bounds(
  series: readonly Series[],
  options: ChartOptions,
): {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const entry of series) {
    for (const point of entry.points) {
      if (Number.isFinite(point.x)) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
      }
      if (Number.isFinite(point.y)) {
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
      }
    }
  }

  const xMin = options.xMin ?? (Number.isFinite(minX) ? Math.min(minX, 0) : 0);
  const xMax = options.xMax ?? (Number.isFinite(maxX) ? Math.max(maxX, 1) : 1);
  let yMin = options.yMin ?? (Number.isFinite(minY) ? Math.min(minY, 0) : 0);
  let yMax = options.yMax ?? (Number.isFinite(maxY) ? Math.max(maxY, 1) : 1);
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
  const clamped = Math.min(boundsValue.yMax, Math.max(boundsValue.yMin, value));
  return box.top + (1 - (clamped - boundsValue.yMin) / span) * box.height;
}

function pathOf(
  points: readonly Point[],
  boundsValue: ReturnType<typeof bounds>,
  box: Box,
  threshold: number,
): string {
  const sampled = points.length > threshold ? lttb(points, threshold) : points;
  const parts: string[] = [];
  for (let i = 0; i < sampled.length; i += 1) {
    const point = sampled[i];
    if (point === undefined) continue;
    const x = xOf(point.x, boundsValue, box);
    const y = yOf(point.y, boundsValue, box);
    parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return parts.join(' ');
}

function addFrame(
  svg: SVGSVGElement,
  options: ChartOptions,
  boundsValue: ReturnType<typeof bounds>,
  box: Box,
): void {
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
          y: box.top + box.height + 15,
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
          y: height - 6,
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
}

function formatAxis(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 1000) return value.toExponential(1);
  if (Math.abs(value) >= 10) return value.toFixed(0);
  if (Math.abs(value) >= 1) return value.toFixed(2);
  if (value === 0) return '0';
  return value.toFixed(3);
}

/** 交互式悬停十字线与读数横条：无额外全局状态，随鼠标平滑探查历史点。 */
function bindHoverReadout(
  svg: SVGSVGElement,
  series: readonly Series[],
  boundsValue: ReturnType<typeof bounds>,
  box: Box,
): void {
  const first = series[0];
  if (first === undefined || first.points.length === 0) return;
  const overlay = svgEl('g', { class: 'chart-hover', style: 'display:none;pointer-events:none' });
  const vLine = svgEl('line', {
    x1: box.left,
    y1: box.top,
    x2: box.left,
    y2: box.top + box.height,
    stroke: 'var(--accent)',
    'stroke-width': 1,
    'stroke-dasharray': '3 2',
  });
  const labelBg = svgEl('rect', {
    x: box.left + 4,
    y: box.top + 2,
    width: 180,
    height: 18,
    rx: 4,
    fill: 'var(--bg-elevated)',
    stroke: 'var(--border-strong)',
    'fill-opacity': 0.92,
  });
  const labelText = svgEl('text', {
    x: box.left + 10,
    y: box.top + 14,
    class: 'chart-axis',
    fill: 'var(--text-primary)',
  });
  overlay.append(vLine, labelBg, labelText);

  const hitRect = svgEl('rect', {
    x: box.left,
    y: box.top,
    width: box.width,
    height: box.height,
    fill: 'transparent',
    style: 'cursor:crosshair',
  });

  hitRect.addEventListener('mousemove', (event: MouseEvent) => {
    const ctm = svg.getScreenCTM();
    if (ctm === null) return;
    const svgX = (event.clientX - ctm.e) / ctm.a;
    const ratio = Math.min(1, Math.max(0, (svgX - box.left) / (box.width || 1)));
    const targetX = boundsValue.xMin + ratio * (boundsValue.xMax - boundsValue.xMin);
    // 二分定位最近点
    const pts = first.points;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((pts[mid]?.x ?? 0) < targetX) lo = mid + 1;
      else hi = mid;
    }
    const chosenIdx =
      lo > 0 && Math.abs((pts[lo - 1]?.x ?? 0) - targetX) < Math.abs((pts[lo]?.x ?? 0) - targetX)
        ? lo - 1
        : lo;
    const chosenPoint = pts[chosenIdx];
    if (chosenPoint === undefined) return;
    const px = xOf(chosenPoint.x, boundsValue, box);
    vLine.setAttribute('x1', px.toFixed(1));
    vLine.setAttribute('x2', px.toFixed(1));
    const snippets = series
      .slice(0, 3)
      .map((s) => {
        const p = s.points[Math.min(chosenIdx, s.points.length - 1)];
        return `${s.label}:${p !== undefined ? formatAxis(p.y) : '—'}`;
      })
      .join('  ');
    const summary = `t=${Math.round(chosenPoint.x)} · ${snippets}`;
    labelText.textContent = summary;
    const approxWidth = Math.min(box.width - 8, Math.max(96, summary.length * 5.8 + 14));
    const bx = px + approxWidth + 10 > box.left + box.width ? px - approxWidth - 6 : px + 6;
    labelBg.setAttribute('x', Math.max(box.left + 2, bx).toFixed(1));
    labelBg.setAttribute('width', approxWidth.toFixed(1));
    labelText.setAttribute('x', (Math.max(box.left + 2, bx) + 6).toFixed(1));
    overlay.style.display = '';
  });

  hitRect.addEventListener('mouseleave', () => {
    overlay.style.display = 'none';
  });

  svg.append(overlay, hitRect);
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
        'stroke-width': 1.9,
        'stroke-dasharray': entry.dashed === true ? '4 3' : 'none',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    );
  }
  svg.append(group);
  bindHoverReadout(svg, populated, boundsValue, box);
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

  // 对齐同一组采样下标，直接构造 SVG polygon，无需大 Map 与 innerHTML 解析
  const totalLen = populated[0]?.points.length ?? 0;
  const threshold = pixelThreshold(box.width);
  const indices: number[] = [];
  if (totalLen <= threshold) {
    for (let i = 0; i < totalLen; i += 1) indices.push(i);
  } else {
    indices.push(0);
    const step = (totalLen - 1) / (threshold - 1);
    for (let i = 1; i < threshold - 1; i += 1) {
      const idx = Math.round(i * step);
      if (idx > (indices[indices.length - 1] ?? 0) && idx < totalLen - 1) {
        indices.push(idx);
      }
    }
    indices.push(totalLen - 1);
  }

  const group = svgEl('g', { class: 'chart-series' });
  for (let layerIdx = 0; layerIdx < populated.length; layerIdx += 1) {
    const entry = populated[layerIdx];
    if (entry === undefined) continue;
    const prevPoints = layerIdx === 0 ? null : (populated[layerIdx - 1]?.points ?? null);
    const coords: string[] = [];
    for (let k = 0; k < indices.length; k += 1) {
      const ptIdx = indices[k] as number;
      const pt = entry.points[ptIdx];
      if (pt === undefined) continue;
      coords.push(
        `${xOf(pt.x, boundsValue, box).toFixed(2)},${yOf(pt.y, boundsValue, box).toFixed(2)}`,
      );
    }
    for (let k = indices.length - 1; k >= 0; k -= 1) {
      const ptIdx = indices[k] as number;
      const pt = entry.points[ptIdx];
      if (pt === undefined) continue;
      const baseVal = prevPoints === null ? 0 : (prevPoints[ptIdx]?.y ?? 0);
      coords.push(
        `${xOf(pt.x, boundsValue, box).toFixed(2)},${yOf(baseVal, boundsValue, box).toFixed(2)}`,
      );
    }
    group.append(
      svgEl('polygon', {
        points: coords.join(' '),
        fill: entry.color,
        'fill-opacity': 0.58,
        stroke: entry.color,
        'stroke-width': 1,
      }),
    );
  }
  svg.append(group);
  bindHoverReadout(svg, populated, boundsValue, box);
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
  let max = 1;
  for (const bar of bars) {
    if (Number.isFinite(bar.value) && bar.value > max) max = bar.value;
  }
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart',
    role: 'img',
    'aria-label': options.title ?? '柱状图',
  });
  addFrame(svg, options, { xMin: 0, xMax: 1, yMin: 0, yMax: max }, box);
  const slot = box.width / bars.length;
  bars.forEach((bar, index) => {
    const x = box.left + slot * index + slot * 0.16;
    const barWidth = Math.max(4, slot * 0.68);
    const y = yOf(bar.value, { xMin: 0, xMax: 1, yMin: 0, yMax: max }, box);
    svg.append(
      svgEl('rect', {
        x,
        y,
        width: barWidth,
        height: Math.max(0, box.top + box.height - y),
        fill: bar.color ?? 'var(--accent)',
        'fill-opacity': 0.85,
        rx: 3,
      }),
      svgEl(
        'text',
        {
          x: x + barWidth / 2,
          y: box.top + box.height + 15,
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
  const height = options.height ?? 270;
  const left = 42;
  const top = 22;
  const cell = Math.min(
    (width - left - 10) / Math.max(1, colLabels.length),
    (height - top - 10) / Math.max(1, rowLabels.length),
  );
  let max = 1;
  for (const row of matrix) {
    for (const val of row) {
      if (Number.isFinite(val) && val > max) max = val;
    }
  }
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart',
    role: 'img',
    'aria-label': options.title ?? '转移矩阵热力图',
  });
  matrix.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      const intensity = value / max;
      const isDiag = rowIndex === colIndex;
      svg.append(
        svgEl('rect', {
          x: left + colIndex * cell,
          y: top + rowIndex * cell,
          width: Math.max(2, cell - 3),
          height: Math.max(2, cell - 3),
          fill: isDiag ? 'var(--violet)' : 'var(--accent)',
          'fill-opacity': value === 0 ? 0.05 : 0.14 + intensity * 0.78,
          stroke: value > 0 ? 'var(--border-highlight)' : 'var(--border-subtle)',
          'stroke-width': 0.75,
          rx: 3,
        }),
        svgEl(
          'text',
          {
            x: left + colIndex * cell + (cell - 3) / 2,
            y: top + rowIndex * cell + (cell - 3) / 2 + 3,
            'text-anchor': 'middle',
            class: 'chart-axis',
            fill: value > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
          },
          value === 0 ? '·' : String(value),
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

/** 五维结构指纹雷达图（归一化至 [0,1] 科学展示，不代表校准阈值）。 */
export function renderRadarChart(
  axes: readonly {
    readonly label: string;
    readonly normalized: number;
    readonly display: string;
  }[],
  options: { width?: number; height?: number; title?: string } = {},
): SVGSVGElement {
  const width = options.width ?? 270;
  const height = options.height ?? 220;
  const cx = width / 2;
  const cy = height / 2 + 4;
  const radius = Math.min(width, height) * 0.34;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart',
    role: 'img',
    'aria-label': options.title ?? '五维结构指纹雷达图',
  });
  const count = axes.length;
  if (count < 3) return emptyChart('维度不足', options);

  // 同心五边形网格
  for (const ring of [0.25, 0.5, 0.75, 1]) {
    const pts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
      pts.push(
        `${(cx + Math.cos(angle) * radius * ring).toFixed(1)},${(cy + Math.sin(angle) * radius * ring).toFixed(1)}`,
      );
    }
    svg.append(
      svgEl('polygon', {
        points: pts.join(' '),
        fill: 'none',
        stroke: 'var(--border-subtle)',
        'stroke-width': 1,
      }),
    );
  }

  // 轴线与标签
  const valuePts: string[] = [];
  axes.forEach((axis, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const ox = cx + Math.cos(angle) * radius;
    const oy = cy + Math.sin(angle) * radius;
    svg.append(
      svgEl('line', {
        x1: cx,
        y1: cy,
        x2: ox.toFixed(1),
        y2: oy.toFixed(1),
        stroke: 'var(--border-subtle)',
        'stroke-width': 1,
      }),
    );
    const norm = Math.min(1, Math.max(0, Number.isFinite(axis.normalized) ? axis.normalized : 0));
    const vx = cx + Math.cos(angle) * radius * norm;
    const vy = cy + Math.sin(angle) * radius * norm;
    valuePts.push(`${vx.toFixed(1)},${vy.toFixed(1)}`);

    const lx = cx + Math.cos(angle) * (radius + 22);
    const ly = cy + Math.sin(angle) * (radius + 16);
    svg.append(
      svgEl(
        'text',
        {
          x: lx.toFixed(1),
          y: (ly - 3).toFixed(1),
          'text-anchor': 'middle',
          class: 'chart-label',
        },
        axis.label,
      ),
      svgEl(
        'text',
        {
          x: lx.toFixed(1),
          y: (ly + 9).toFixed(1),
          'text-anchor': 'middle',
          class: 'chart-axis',
          fill: 'var(--accent)',
        },
        axis.display,
      ),
    );
  });

  svg.append(
    svgEl('polygon', {
      points: valuePts.join(' '),
      fill: 'var(--accent)',
      'fill-opacity': 0.22,
      stroke: 'var(--accent)',
      'stroke-width': 2,
    }),
  );
  for (const coord of valuePts) {
    const [px, py] = coord.split(',');
    svg.append(
      svgEl('circle', {
        cx: px ?? '0',
        cy: py ?? '0',
        r: 3,
        fill: 'var(--accent)',
      }),
    );
  }
  return svg;
}

/** 参数实时数学函数微图（Sparkline，用于实验设置页直观展示参数形态）。 */
export function renderSparkline(
  points: readonly Point[],
  options: { width?: number; height?: number; color?: string; label?: string } = {},
): SVGSVGElement {
  const width = options.width ?? 150;
  const height = options.height ?? 44;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'sparkline',
    role: 'img',
    'aria-label': options.label ?? '函数预览微图',
  });
  if (points.length < 2) return svg;
  const b = bounds([{ label: 's', color: '', points }], {});
  const pad = 4;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const spanX = b.xMax - b.xMin || 1;
  const spanY = b.yMax - b.yMin || 1;
  const coords = points.map((p, i) => {
    const x = pad + ((p.x - b.xMin) / spanX) * innerW;
    const y = pad + (1 - (p.y - b.yMin) / spanY) * innerH;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const areaCoords = [
    ...coords,
    `L${(width - pad).toFixed(1)},${(height - pad).toFixed(1)}`,
    `L${pad.toFixed(1)},${(height - pad).toFixed(1)}`,
    'Z',
  ];
  const stroke = options.color ?? 'var(--accent)';
  svg.append(
    svgEl('path', {
      d: areaCoords.join(' '),
      fill: stroke,
      'fill-opacity': 0.14,
      stroke: 'none',
    }),
    svgEl('path', {
      d: coords.join(' '),
      fill: 'none',
      stroke,
      'stroke-width': 1.75,
      'stroke-linecap': 'round',
    }),
  );
  return svg;
}

/** 个体自我中心网络拓扑微图（Ego-Network SVG）。 */
export function renderEgoNetwork(
  self: { id: string; classIndex: number },
  neighbors: readonly { id: string; classIndex: number; value: number; alive: boolean }[],
  onSelectNeighbor?: (id: string) => void,
): SVGSVGElement {
  const width = 360;
  const height = 200;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 68;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart ego-svg',
    role: 'img',
    'aria-label': `${self.id} 自我中心关系网`,
  });

  neighbors.forEach((n, idx) => {
    const angle = -Math.PI / 2 + (idx * 2 * Math.PI) / Math.max(1, neighbors.length);
    const nx = cx + Math.cos(angle) * radius;
    const ny = cy + Math.sin(angle) * radius;
    const crossClass = n.classIndex !== self.classIndex;
    svg.append(
      svgEl('line', {
        x1: cx,
        y1: cy,
        x2: nx.toFixed(1),
        y2: ny.toFixed(1),
        stroke: crossClass ? 'var(--gold)' : 'var(--border-strong)',
        'stroke-width': crossClass ? 2 : 1.3,
        'stroke-dasharray': crossClass ? 'none' : '3 2',
      }),
    );
    const nodeGroup = svgEl('g', {
      style: onSelectNeighbor !== undefined ? 'cursor:pointer' : '',
    });
    nodeGroup.append(
      svgEl('circle', {
        cx: nx.toFixed(1),
        cy: ny.toFixed(1),
        r: 13,
        fill: `var(--class-${n.classIndex}-color)`,
        'fill-opacity': n.alive ? 0.25 : 0.08,
        stroke: `var(--class-${n.classIndex}-color)`,
        'stroke-width': 1.8,
      }),
      svgEl(
        'text',
        {
          x: nx.toFixed(1),
          y: (ny + 3).toFixed(1),
          'text-anchor': 'middle',
          class: 'chart-axis',
          fill: 'var(--text-primary)',
        },
        `C${n.classIndex}`,
      ),
      svgEl(
        'text',
        {
          x: nx.toFixed(1),
          y: (ny + 24).toFixed(1),
          'text-anchor': 'middle',
          class: 'chart-axis',
        },
        n.id,
      ),
    );
    if (onSelectNeighbor !== undefined) {
      nodeGroup.addEventListener('click', () => onSelectNeighbor(n.id));
    }
    svg.append(nodeGroup);
  });

  svg.append(
    svgEl('circle', {
      cx,
      cy,
      r: 18,
      fill: `var(--class-${self.classIndex}-color)`,
      'fill-opacity': 0.32,
      stroke: 'var(--accent)',
      'stroke-width': 2.4,
    }),
    svgEl(
      'text',
      {
        x: cx,
        y: cy + 4,
        'text-anchor': 'middle',
        class: 'chart-label',
        fill: 'var(--text-primary)',
      },
      self.id,
    ),
  );
  return svg;
}

/** 洛伦兹财富不平等微图（含完全均等 45° 虚线基准，06 §5）。 */
export function renderLorenzChart(
  points: readonly Point[],
  options: { width?: number; height?: number } = {},
): SVGSVGElement {
  const width = options.width ?? 160;
  const height = options.height ?? 120;
  if (points.length < 2) return emptyChart('尚无样本', { width, height });
  const padL = 26;
  const padR = 10;
  const padT = 10;
  const padB = 20;
  const w = width - padL - padR;
  const hBox = height - padT - padB;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart',
    role: 'img',
    'aria-label': '财富洛伦兹曲线',
  });
  svg.append(
    svgEl('rect', {
      x: padL,
      y: padT,
      width: w,
      height: hBox,
      fill: 'none',
      stroke: 'var(--border-subtle)',
    }),
    svgEl('line', {
      x1: padL,
      y1: padT + hBox,
      x2: padL + w,
      y2: padT,
      stroke: 'var(--text-muted)',
      'stroke-dasharray': '3 3',
      'stroke-width': 1,
    }),
  );
  const sampled = points.length > 80 ? lttb(points, 80) : points;
  const d = sampled
    .map((p, idx) => {
      const px = padL + Math.min(1, Math.max(0, p.x)) * w;
      const py = padT + (1 - Math.min(1, Math.max(0, p.y))) * hBox;
      return `${idx === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(' ');
  svg.append(
    svgEl('path', {
      d,
      fill: 'none',
      stroke: 'var(--gold)',
      'stroke-width': 1.8,
    }),
    svgEl(
      'text',
      { x: padL + w / 2, y: height - 4, 'text-anchor': 'middle', class: 'chart-axis' },
      'Lorenz 人口累计→财富累计',
    ),
  );
  return svg;
}

/** ≥30 配对种子 Bootstrap 95% 置信区间森林图（Forest Plot，06 §7）。 */
export function renderForestPlot(
  items: readonly {
    readonly metric: string;
    readonly estimate: number;
    readonly ciLow: number;
    readonly ciHigh: number;
  }[],
  options: { width?: number; rowHeight?: number; title?: string } = {},
): SVGSVGElement {
  const width = options.width ?? 560;
  const rowH = options.rowHeight ?? 32;
  const height = Math.max(120, items.length * rowH + 44);
  if (items.length === 0) return emptyChart('无置信区间条目', { width, height });

  let minV = -0.15;
  let maxV = 0.15;
  for (const it of items) {
    if (it.ciLow < minV) minV = it.ciLow * 1.15;
    if (it.ciHigh > maxV) maxV = it.ciHigh * 1.15;
  }
  const left = 110;
  const right = width - 115;
  const plotW = Math.max(80, right - left);
  const span = maxV - minV || 1;
  const mapX = (v: number): number => left + ((v - minV) / span) * plotW;
  const zeroX = mapX(0);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart',
    role: 'img',
    'aria-label': options.title ?? '配对批次置信区间森林图',
  });

  // 零效应基准竖线
  svg.append(
    svgEl('line', {
      x1: zeroX.toFixed(1),
      y1: 14,
      x2: zeroX.toFixed(1),
      y2: height - 24,
      stroke: 'var(--border-strong)',
      'stroke-dasharray': '4 3',
      'stroke-width': 1.2,
    }),
  );

  items.forEach((it, idx) => {
    const cy = 26 + idx * rowH;
    const x1 = mapX(it.ciLow);
    const x2 = mapX(it.ciHigh);
    const xm = mapX(it.estimate);
    const excludesZero = it.ciLow > 0 || it.ciHigh < 0;
    const color = excludesZero ? 'var(--accent)' : 'var(--text-secondary)';
    svg.append(
      svgEl(
        'text',
        { x: left - 10, y: cy + 4, 'text-anchor': 'end', class: 'chart-label' },
        it.metric,
      ),
      svgEl('line', {
        x1: x1.toFixed(1),
        y1: cy,
        x2: x2.toFixed(1),
        y2: cy,
        stroke: color,
        'stroke-width': 2.2,
      }),
      svgEl('line', {
        x1: x1.toFixed(1),
        y1: cy - 5,
        x2: x1.toFixed(1),
        y2: cy + 5,
        stroke: color,
        'stroke-width': 1.5,
      }),
      svgEl('line', {
        x1: x2.toFixed(1),
        y1: cy - 5,
        x2: x2.toFixed(1),
        y2: cy + 5,
        stroke: color,
        'stroke-width': 1.5,
      }),
      svgEl('circle', {
        cx: xm.toFixed(1),
        cy,
        r: 4.2,
        fill: color,
      }),
      svgEl(
        'text',
        { x: right + 8, y: cy + 3, 'text-anchor': 'start', class: 'chart-axis' },
        `${it.estimate.toFixed(3)} [${it.ciLow.toFixed(3)}, ${it.ciHigh.toFixed(3)}]`,
      ),
    );
  });

  svg.append(
    svgEl(
      'text',
      { x: zeroX.toFixed(1), y: height - 6, 'text-anchor': 'middle', class: 'chart-axis' },
      'Δ = 0 (无差异基准)',
    ),
  );
  return svg;
}

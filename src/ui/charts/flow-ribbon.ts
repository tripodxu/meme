import { svgEl } from './core.js';

const CLASS_COLORS = [
  'var(--class-0)',
  'var(--class-1)',
  'var(--class-2)',
  'var(--class-3)',
  'var(--class-4)',
] as const;

export function renderFlowRibbon(
  matrix: readonly (readonly number[])[],
  labels: readonly string[],
  options: { readonly width?: number; readonly height?: number; readonly title?: string } = {},
): SVGSVGElement {
  const width = options.width ?? 420;
  const height = options.height ?? 190;
  const n = Math.min(labels.length, matrix.length);
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart',
    role: 'img',
    'aria-label': options.title ?? '阶层流动流带图',
  });

  if (n === 0) return svg;

  const rowTotals = matrix.slice(0, n).map((row) => row.reduce((a, b) => a + b, 0));
  const colTotals = new Array<number>(n).fill(0);
  let grandTotal = 0;
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      const v = matrix[r]?.[c] ?? 0;
      colTotals[c] = (colTotals[c] ?? 0) + v;
      grandTotal += v;
    }
  }

  if (grandTotal <= 0) {
    svg.append(
      svgEl(
        'text',
        {
          x: width / 2,
          y: height / 2,
          'text-anchor': 'middle',
          class: 'chart-empty-text',
        },
        '当前窗口暂无跨阶层转移事件',
      ),
    );
    return svg;
  }

  const leftX = 56;
  const rightX = width - 56;
  const topY = 16;
  const usableH = height - 32;
  const slotGap = 5;
  const nodeW = 10;

  const scaleH = (usableH - slotGap * Math.max(0, n - 1)) / grandTotal;
  const leftNodes: { y: number; h: number; cursor: number }[] = [];
  const rightNodes: { y: number; h: number; cursor: number }[] = [];

  let ly = topY;
  let ry = topY;
  for (let i = 0; i < n; i += 1) {
    const lh = Math.max(6, (rowTotals[i] ?? 0) * scaleH);
    leftNodes.push({ y: ly, h: lh, cursor: ly });
    ly += lh + slotGap;

    const rh = Math.max(6, (colTotals[i] ?? 0) * scaleH);
    rightNodes.push({ y: ry, h: rh, cursor: ry });
    ry += rh + slotGap;
  }

  // 绘制流动弧带
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      const val = matrix[r]?.[c] ?? 0;
      if (val <= 0) continue;
      const src = leftNodes[r];
      const dst = rightNodes[c];
      if (src === undefined || dst === undefined) continue;
      const bandH = Math.max(1.5, val * scaleH);
      const y1 = src.cursor + bandH / 2;
      const y2 = dst.cursor + bandH / 2;
      src.cursor += bandH;
      dst.cursor += bandH;

      const midX = (leftX + nodeW + rightX) / 2;
      const d = `M${leftX + nodeW},${y1.toFixed(1)} C${midX},${y1.toFixed(1)} ${midX},${y2.toFixed(1)} ${rightX},${y2.toFixed(1)}`;
      const color =
        c > r
          ? 'var(--action-ascend)'
          : c < r
            ? 'var(--action-descend)'
            : (CLASS_COLORS[r] ?? 'var(--text-muted)');
      svg.append(
        svgEl('path', {
          d,
          fill: 'none',
          stroke: color,
          'stroke-width': bandH.toFixed(1),
          'stroke-opacity': c === r ? '0.22' : '0.68',
        }),
      );
    }
  }

  // 绘制左右阶层节点柱与标签
  for (let i = 0; i < n; i += 1) {
    const ln = leftNodes[i];
    const rn = rightNodes[i];
    const color = CLASS_COLORS[i] ?? 'var(--accent)';
    const label = labels[i] ?? `C${i}`;
    if (ln !== undefined) {
      svg.append(
        svgEl('rect', { x: leftX, y: ln.y, width: nodeW, height: ln.h, rx: 2, fill: color }),
        svgEl(
          'text',
          { x: leftX - 6, y: ln.y + ln.h / 2 + 3, 'text-anchor': 'end', class: 'chart-axis' },
          `${label} (${rowTotals[i] ?? 0})`,
        ),
      );
    }
    if (rn !== undefined) {
      svg.append(
        svgEl('rect', { x: rightX, y: rn.y, width: nodeW, height: rn.h, rx: 2, fill: color }),
        svgEl(
          'text',
          {
            x: rightX + nodeW + 6,
            y: rn.y + rn.h / 2 + 3,
            'text-anchor': 'start',
            class: 'chart-axis',
          },
          `${label} (${colTotals[i] ?? 0})`,
        ),
      );
    }
  }

  return svg;
}

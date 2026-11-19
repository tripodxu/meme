import {
  formatNumber,
  type AgentMechanismAnatomy,
  type LifeTimelinePoint,
} from '../../app/view-model.js';
import { h } from '../dom.js';
import { svgEl } from './core.js';

export function renderAccumulationAnatomy(anatomy: AgentMechanismAnatomy): HTMLElement {
  const pills: readonly { label: string; value: string; tip: string }[] = [
    {
      label: `E[C${anatomy.classIndex}]`,
      value: formatNumber(anatomy.eClass, 2),
      tip: '所在阶层当期动态环境系数 E[c]',
    },
    {
      label: 'ge',
      value: formatNumber(anatomy.ge, 2),
      tip: '个体先天禀赋系数',
    },
    {
      label: 'F(hard)',
      value: formatNumber(anatomy.effortFactor, 2),
      tip: '努力度饱和映射函数产出乘子',
    },
    {
      label: 'Opp',
      value: formatNumber(anatomy.opportunity, 2),
      tip: '邻里中位数财富相对于全社会中位数的网络机会乘子',
    },
  ];

  return h('div', { class: 'anatomy-block' }, [
    h('div', { class: 'anatomy-head' }, [
      h('span', { class: 'muted', text: '单日积累配方' }),
      h('strong', {
        class: 'mono',
        text: `+${formatNumber(anatomy.expectedDailyGain, 2)} V/日`,
      }),
    ]),
    h(
      'div',
      { class: 'anatomy-pills' },
      pills.map((p) =>
        h('span', { class: 'anatomy-pill', title: p.tip }, [
          h('span', { class: 'muted', text: `${p.label} ` }),
          h('strong', { class: 'mono', text: p.value }),
        ]),
      ),
    ),
  ]);
}

export function renderAscentWaterfall(anatomy: AgentMechanismAnatomy): HTMLElement {
  if (!anatomy.canAscendFurther) {
    return h('div', { class: 'anatomy-block' }, [
      h('span', { class: 'muted', text: '已处最高阶层，无更高升阶门槛。' }),
    ]);
  }
  const total = Math.max(1e-6, anatomy.ascendTotalRequired);
  const costPct = (anatomy.ascendCost / total) * 100;
  const cushionPct = (anatomy.ascendCushion / total) * 100;
  const barrierPct = (anatomy.ascendBarrier / total) * 100;
  const wealthPct = Math.min(100, (anatomy.value / total) * 100);

  return h('div', { class: 'anatomy-block' }, [
    h('div', { class: 'anatomy-head' }, [
      h('span', { class: 'muted', text: `升入 C${anatomy.classIndex + 1} 三段门槛` }),
      h('span', {
        class: 'mono',
        text:
          anatomy.ascendGap <= 0
            ? '已达标'
            : `尚缺 ${formatNumber(anatomy.ascendGap, 1)} / 需 ${formatNumber(total, 1)}`,
      }),
    ]),
    h(
      'div',
      {
        class: 'waterfall-track',
        title: '蓝色=跨越费 | 青色=持有裕度 | 琥珀=稀缺壁垒 | 竖线=当前财富',
      },
      [
        h('div', { class: 'waterfall-seg seg-cost', style: `width:${costPct.toFixed(1)}%` }),
        h('div', { class: 'waterfall-seg seg-cushion', style: `width:${cushionPct.toFixed(1)}%` }),
        h('div', { class: 'waterfall-seg seg-barrier', style: `width:${barrierPct.toFixed(1)}%` }),
        h('div', {
          class: 'waterfall-marker',
          style: `left:${wealthPct.toFixed(1)}%`,
          title: `当前财富 ${formatNumber(anatomy.value, 1)}`,
        }),
      ],
    ),
    h('div', { class: 'anatomy-sub mono muted' }, [
      h('span', { text: `费 ${formatNumber(anatomy.ascendCost, 0)}` }),
      h('span', { text: `裕度 ${formatNumber(anatomy.ascendCushion, 0)}` }),
      h('span', { text: `壁垒 ${formatNumber(anatomy.ascendBarrier, 0)}` }),
    ]),
  ]);
}

export function renderLifeTrajectoryStrip(
  points: readonly LifeTimelinePoint[],
  maxTick: number,
  classCount = 5,
): SVGSVGElement {
  const width = 460;
  const height = 82;
  const left = 26;
  const right = width - 12;
  const top = 10;
  const bottom = height - 18;
  const spanX = Math.max(1, maxTick);
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart',
    role: 'img',
    'aria-label': '个体人生阶梯轨迹带',
  });

  for (let c = 0; c < classCount; c += 1) {
    const y = bottom - (c / Math.max(1, classCount - 1)) * (bottom - top);
    svg.append(
      svgEl('line', {
        x1: left,
        y1: y,
        x2: right,
        y2: y,
        stroke: 'var(--border-subtle)',
        'stroke-width': 1,
      }),
      svgEl('text', { x: left - 4, y: y + 3, 'text-anchor': 'end', class: 'chart-axis' }, `C${c}`),
    );
  }

  if (points.length === 0) return svg;

  const xOfTick = (t: number): number =>
    left + Math.min(1, Math.max(0, t / spanX)) * (right - left);
  const yOfClass = (c: number): number =>
    bottom - (c / Math.max(1, classCount - 1)) * (bottom - top);

  const pathParts: string[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    const x = xOfTick(p.tick);
    const y = yOfClass(p.classIndex);
    if (i === 0) {
      pathParts.push(`M${x.toFixed(1)},${y.toFixed(1)}`);
    } else {
      const prevY = yOfClass(points[i - 1]!.classIndex);
      pathParts.push(`L${x.toFixed(1)},${prevY.toFixed(1)} L${x.toFixed(1)},${y.toFixed(1)}`);
    }
  }
  const last = points[points.length - 1]!;
  pathParts.push(`L${xOfTick(maxTick).toFixed(1)},${yOfClass(last.classIndex).toFixed(1)}`);

  svg.append(
    svgEl('path', {
      d: pathParts.join(' '),
      fill: 'none',
      stroke: 'var(--accent)',
      'stroke-width': 1.8,
    }),
  );

  for (const p of points) {
    if (p.kind === 'born') continue;
    const x = xOfTick(p.tick);
    const y = yOfClass(p.classIndex);
    const color =
      p.kind === 'ascend'
        ? 'var(--action-ascend)'
        : p.kind === 'descend'
          ? 'var(--action-descend)'
          : p.kind === 'compete_win'
            ? 'var(--ok)'
            : p.kind === 'died'
              ? 'var(--danger)'
              : 'var(--action-compete)';
    const dot = svgEl('circle', { cx: x, cy: y, r: 3.2, fill: color });
    dot.append(svgEl('title', {}, `t${p.tick} · ${p.label}`));
    svg.append(dot);
  }

  svg.append(
    svgEl('text', { x: left, y: height - 3, class: 'chart-axis' }, 't0'),
    svgEl(
      'text',
      { x: right, y: height - 3, 'text-anchor': 'end', class: 'chart-axis' },
      `t${maxTick}`,
    ),
  );
  return svg;
}

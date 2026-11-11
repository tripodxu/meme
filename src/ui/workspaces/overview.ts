import type { ControllerSnapshot } from '../../app/types.js';
import { buildKpis, eventViews, formatNumber, formatPercent } from '../../app/view-model.js';
import type { Series } from '../charts/core.js';
import {
  emptyChart,
  renderBarChart,
  renderHeatmap,
  renderLineChart,
  renderStackedArea,
} from '../charts/core.js';
import { badge, card, h, table } from '../dom.js';
import type { StratifyApp } from '../app.js';

const CLASS_COLORS = [
  'var(--class-0-color)',
  'var(--class-1-color)',
  'var(--class-2-color)',
  'var(--class-3-color)',
  'var(--class-4-color)',
];

export function renderOverview(root: HTMLElement, app: StratifyApp): void {
  const snapshot = app.getSnapshot();
  root.append(
    h('div', { class: 'span-12' }, [
      card('结构指纹与核心指标', [kpiGrid(snapshot)], {
        subtitle: `全周期窗口 · 当前 Tick ${snapshot.tick} · 所有指标来自核心，不在前端重算结构公式`,
        actions: [
          badge(`alive ${snapshot.aliveCount}`, 'muted'),
          badge(
            snapshot.endReason === null ? snapshot.status : snapshot.endReason,
            snapshot.status === 'failed' ? 'danger' : 'muted',
          ),
        ],
      }),
    ]),
    h('div', { class: 'span-6' }, [
      card('阶级结构堆叠', [classChart(snapshot)], {
        subtitle: '各阶级存活人口占比；死亡不折算为流动。全周期窗口。',
      }),
    ]),
    h('div', { class: 'span-6' }, [
      card('财富与不平等', [wealthChart(snapshot)], {
        subtitle: `G 与 Top10% 同轴；中位数 ${formatNumber(snapshot.latestStats?.medianValue)}。全周期窗口。`,
      }),
    ]),
    h('div', { class: 'span-4' }, [
      card('双向流动', [mobilityChart(snapshot)], {
        subtitle: 'Mup/Mdown 为 metrics.mobilityWindowDays 日参与率；二者分开显示。',
      }),
    ]),
    h('div', { class: 'span-4' }, [
      card('网络结构', [networkChart(snapshot)], {
        subtitle: '无连边时显示 edgeCount=0，不用 S=1 代替空网络。',
      }),
    ]),
    h('div', { class: 'span-4' }, [
      card('开放度与机会', [opennessChart(snapshot)], {
        subtitle: 'O 为慢变量；E 为各阶级环境持有人系数。全周期窗口。',
      }),
    ]),
    h('div', { class: 'span-6' }, [
      card('转移矩阵', [flowMatrix(snapshot)], {
        subtitle: `metrics.flowWindowDays=${snapshot.config?.metrics.flowWindowDays ?? '—'} 日窗口，行=来源阶级，列=目的阶级。`,
      }),
    ]),
    h('div', { class: 'span-6' }, [
      card('行动分布与决策遥测', [decisionChart(snapshot)], {
        subtitle: '最近 500 条决策；mock/random 不显示伪模型成本。',
      }),
    ]),
    h('div', { class: 'span-12' }, [
      card('事件流（有界最近 500 条）', [eventList(snapshot)], {
        subtitle: '完整事件应通过导出 bundle 保存；界面只保留近期事件。',
      }),
    ]),
  );
}

function kpiGrid(snapshot: ControllerSnapshot): HTMLElement {
  const kpis = buildKpis(snapshot);
  const grid = h('div', { class: 'kpi-grid' });
  for (const kpi of kpis) {
    grid.append(
      h('div', { class: 'kpi', title: kpi.definition }, [
        h('div', { class: 'kpi-label' }, [
          h('span', { text: kpi.label }),
          h('span', { class: 'mono', text: kpi.symbol }),
        ]),
        h('div', { class: 'kpi-value', text: kpi.value }),
        h('div', { class: 'kpi-unit', text: kpi.unit }),
      ]),
    );
  }
  return grid;
}

function classChart(snapshot: ControllerSnapshot): SVGSVGElement {
  if (snapshot.stats.length === 0) return emptyChart('尚无 tick 数据');
  const classCount = snapshot.config?.population.classCount ?? 5;
  const points = snapshot.stats;
  const cumulative: Series[] = [];
  for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
    let running = 0;
    const seriesPoints = points.map((row) => {
      const total = row.aliveCount > 0 ? row.aliveCount : 1;
      running += (row.classCounts[classIndex] ?? 0) / total;
      return { x: row.tick + 1, y: running };
    });
    cumulative.push({
      label: `Class ${classIndex}`,
      color: CLASS_COLORS[classIndex] ?? 'var(--accent)',
      points: seriesPoints,
    });
  }
  return renderStackedArea(cumulative, {
    height: 220,
    yMin: 0,
    yMax: 1,
    xLabel: 'tick',
    yLabel: '存活人口占比',
    title: '阶级结构堆叠',
  });
}

function wealthChart(snapshot: ControllerSnapshot): SVGSVGElement {
  if (snapshot.stats.length === 0) return emptyChart('尚无 tick 数据');
  const gini: Series = {
    label: 'Gini',
    color: 'var(--class-4-color)',
    points: snapshot.stats.map((row) => ({ x: row.tick + 1, y: row.gini })),
  };
  const top10: Series = {
    label: 'Top10%',
    color: 'var(--class-3-color)',
    points: snapshot.stats.map((row) => ({ x: row.tick + 1, y: row.topWealthShare })),
    dashed: true,
  };
  return renderLineChart([gini, top10], {
    height: 220,
    yMin: 0,
    yMax: 1,
    xLabel: 'tick',
    yLabel: '[0,1]',
    title: '财富基尼与前 10% 占比',
  });
}

function mobilityChart(snapshot: ControllerSnapshot): SVGSVGElement {
  if (snapshot.stats.length === 0) return emptyChart('尚无 tick 数据');
  return renderLineChart(
    [
      {
        label: 'Mup',
        color: 'var(--action-ascend)',
        points: snapshot.stats.map((row) => ({ x: row.tick + 1, y: row.mUp })),
      },
      {
        label: 'Mdown',
        color: 'var(--action-descend)',
        points: snapshot.stats.map((row) => ({ x: row.tick + 1, y: row.mDown })),
        dashed: true,
      },
    ],
    { height: 190, yMin: 0, yMax: 1, xLabel: 'tick', yLabel: '窗口参与率', title: '双向流动' },
  );
}

function networkChart(snapshot: ControllerSnapshot): SVGSVGElement {
  const latest = snapshot.latestStats;
  if (latest === null) return emptyChart('尚无 tick 数据');
  if (latest.edgeCount === 0) {
    return emptyChart('edgeCount = 0（无存活连边；S 置 0，不代表完全隔离）', { height: 190 });
  }
  return renderLineChart(
    [
      {
        label: 'crossClassEdgeShare',
        color: 'var(--class-2-color)',
        points: snapshot.stats.map((row) => ({ x: row.tick + 1, y: row.crossClassEdgeShare })),
      },
      {
        label: 'S',
        color: 'var(--class-3-color)',
        points: snapshot.stats.map((row) => ({ x: row.tick + 1, y: row.segregation })),
        dashed: true,
      },
    ],
    { height: 190, yMin: -1, yMax: 1, xLabel: 'tick', yLabel: '比例 / S', title: '网络结构' },
  );
}

function opennessChart(snapshot: ControllerSnapshot): SVGSVGElement {
  if (snapshot.stats.length === 0) return emptyChart('尚无 tick 数据');
  const series: Series[] = [
    {
      label: 'O',
      color: 'var(--accent)',
      points: snapshot.stats.map((row) => ({ x: row.tick + 1, y: row.openness })),
    },
  ];
  const classCount = snapshot.config?.population.classCount ?? 5;
  for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
    series.push({
      label: `E[${classIndex}]`,
      color: CLASS_COLORS[classIndex] ?? 'var(--accent)',
      points: snapshot.stats.map((row) => ({
        x: row.tick + 1,
        y: row.eByClass[classIndex] ?? 0,
      })),
      dashed: classIndex !== 0,
    });
  }
  const maxE = Math.max(1, ...snapshot.stats.flatMap((row) => row.eByClass));
  return renderLineChart(series, {
    height: 190,
    yMin: 0,
    yMax: Math.max(1, maxE),
    xLabel: 'tick',
    yLabel: 'O / E',
    title: '开放度与动态机会',
  });
}

function flowMatrix(snapshot: ControllerSnapshot): HTMLElement {
  const latest = snapshot.latestStats;
  if (latest === null || latest.flowMatrix.length === 0) {
    return h('div', {}, [emptyChart('窗口内尚无阶级转移')]);
  }
  const labels = latest.flowMatrix.map((_, index) => `C${index}`);
  return h('div', {}, [
    renderHeatmap(latest.flowMatrix, labels, labels, { height: 280, title: '阶级转移矩阵' }),
    h('p', {
      class: 'muted',
      text: '数值为窗口内转移计数；空矩阵表示该窗口没有阶级转移。',
    }),
  ]);
}

function decisionChart(snapshot: ControllerSnapshot): HTMLElement {
  if (snapshot.decisions.length === 0) return h('div', {}, [emptyChart('尚无决策记录')]);
  const counts: Record<string, number> = {
    accumulate: 0,
    ascend: 0,
    descend: 0,
    compete: 0,
  };
  for (const record of snapshot.decisions.slice(-500)) {
    if (record.selectedAction === 'accumulate')
      counts['accumulate'] = (counts['accumulate'] ?? 0) + 1;
    else if (record.selectedAction === 'ascend') counts['ascend'] = (counts['ascend'] ?? 0) + 1;
    else if (record.selectedAction === 'descend') counts['descend'] = (counts['descend'] ?? 0) + 1;
    else counts['compete'] = (counts['compete'] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0) || 1;
  return h('div', {}, [
    renderBarChart(
      [
        {
          label: 'accumulate',
          value: counts['accumulate'] ?? 0,
          color: 'var(--action-accumulate)',
        },
        { label: 'ascend', value: counts['ascend'] ?? 0, color: 'var(--action-ascend)' },
        { label: 'descend', value: counts['descend'] ?? 0, color: 'var(--action-descend)' },
        { label: 'compete', value: counts['compete'] ?? 0, color: 'var(--action-compete)' },
      ],
      { height: 190, yLabel: '决策数', title: '行动分布' },
    ),
    table(
      ['行动', '数量', '占比'],
      Object.entries(counts).map(([action, count]) => [
        action,
        String(count),
        formatPercent(count / total),
      ]),
    ),
  ]);
}

function eventList(snapshot: ControllerSnapshot): HTMLElement {
  const events = eventViews(snapshot.events, 120);
  if (events.length === 0) return h('p', { class: 'muted', text: '尚无事件。' });
  const list = h('ul', { class: 'event-list' });
  for (const event of events) {
    list.append(
      h('li', {}, [
        h('span', { text: `t${event.tick}.${event.seq}` }),
        h('span', { text: event.type }),
        h('span', { text: event.summary }),
      ]),
    );
  }
  return list;
}

import type { TickStats } from '../../core/macros/tick-metrics.js';
import type { ControllerSnapshot } from '../../app/types.js';
import {
  buildKpis,
  competitionByDirection,
  eventViews,
  firstDivergenceTick,
  formatNumber,
  formatPercent,
  lorenzCurvePoints,
  remainingLifeBins,
  statsToCsv,
  summarizeWindowStats,
  type WindowAggregate,
} from '../../app/view-model.js';
import type { Series } from '../charts/core.js';
import {
  emptyChart,
  renderBarChart,
  renderHeatmap,
  renderLineChart,
  renderLorenzChart,
  renderRadarChart,
  renderStackedArea,
} from '../charts/core.js';
import { renderFlowRibbon } from '../charts/flow-ribbon.js';
import { sampleRows } from '../charts/lttb.js';
import { renderPhasePortrait, type PhaseYAxis } from '../charts/phase-portrait.js';
import { chartFrame } from '../components/chart-frame.js';
import { icon } from '../components/icon.js';
import { badge, card, CLASS_SYMBOLS, h, table } from '../dom.js';
import type { StratifyApp } from '../app.js';

const CLASS_COLORS = [
  'var(--class-0-color)',
  'var(--class-1-color)',
  'var(--class-2-color)',
  'var(--class-3-color)',
  'var(--class-4-color)',
] as const;

/** 预降采样绘制点数上限：彻底消除每帧对数万行 stats 做 20 次全量 .map() 的 GC 卡顿。 */
const PRE_SAMPLE_LIMIT = 520;

export function renderOverview(root: HTMLElement, app: StratifyApp): void {
  const snapshot = app.getSnapshot();
  const classCount = snapshot.config?.population.classCount ?? 5;
  const winSummary = summarizeWindowStats(snapshot.stats, app.overviewWindow, classCount);
  const zoomedRows = sliceZoomRange(winSummary.rows, app.zoomRange[0], app.zoomRange[1]);
  // 绘图序列仅对窗口内已过滤行做预降采样，指标均值仍由全量原始序列计算
  const plotRows = sampleRows(zoomedRows, PRE_SAMPLE_LIMIT);
  const ghostRows =
    app.importedBundle === null
      ? []
      : sampleRows(
          sliceZoomRange(
            summarizeWindowStats(app.importedBundle.stats, app.overviewWindow, classCount).rows,
            app.zoomRange[0],
            app.zoomRange[1],
          ),
          PRE_SAMPLE_LIMIT,
        );

  const zoomPresets: readonly { label: string; range: readonly [number, number] }[] = [
    { label: '全区间', range: [0, 100] },
    { label: '0–50%', range: [0, 50] },
    { label: '50–100%', range: [50, 100] },
    { label: '末 25%', range: [75, 100] },
  ];

  const divTick =
    app.importedBundle === null
      ? null
      : firstDivergenceTick(snapshot.stats, app.importedBundle.stats);

  const windowToolbar = h('div', { class: 'window-toolbar span-12' }, [
    h('div', { class: 'actions-row' }, [
      h('span', { class: 'muted', style: 'font-size:12px', text: '区间缩放：' }),
      ...zoomPresets.map((zp) => {
        const active = app.zoomRange[0] === zp.range[0] && app.zoomRange[1] === zp.range[1];
        return h('button', {
          class: `btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}`.trim(),
          type: 'button',
          ariaPressed: String(active),
          text: zp.label,
          onClick: () => {
            app.zoomRange = zp.range;
            app.render();
          },
        });
      }),
    ]),
    h('div', { class: 'actions-row' }, [
      ghostRows.length > 0
        ? badge(
            divTick === null ? '幽灵对照（尚未偏离）' : `幽灵对照 · 首次偏离 t${divTick}`,
            'violet',
          )
        : null,
      h(
        'button',
        {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          disabled: winSummary.rows.length === 0,
          onClick: () => downloadStatsCsv(snapshot.runId, app.overviewWindow, winSummary.rows),
        },
        [icon('download', 13), h('span', { text: '导出 CSV' })],
      ),
      h(
        'button',
        {
          class: `btn btn-sm ${app.overviewTableMode ? 'btn-primary' : 'btn-ghost'}`.trim(),
          type: 'button',
          onClick: () => {
            app.overviewTableMode = !app.overviewTableMode;
            app.render();
          },
        },
        [icon('table', 13), h('span', { text: app.overviewTableMode ? '图形视图' : '聚合数据表' })],
      ),
      h(
        'button',
        {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          onClick: () => app.setSurface('sandbox'),
        },
        [icon('layers', 13), h('span', { text: '生态场视角' })],
      ),
    ]),
  ]);

  root.append(
    windowToolbar,
    h('div', { class: 'span-8' }, [
      chartFrame(
        '结构指纹与核心指标',
        [kpiGrid(snapshot), app.overviewTableMode ? windowSummaryTable(winSummary) : null],
        {
          windowLabel: winSummary.spec.shortLabel,
          subtitle: `${winSummary.spec.label}（已观测 ${winSummary.sampleCount} tick）· 实时值来自最新 tick`,
          definition:
            '结构指纹包含 8 个核心宏观量；实时 KPI 取最新已结算 tick，窗口聚合均值在下方数据表与右侧五维雷达图独立呈报，绝不混用。',
          actions: [
            badge(`alive ${snapshot.aliveCount}`, 'info'),
            snapshot.aliveCount === 0 && snapshot.tick > 0
              ? badge('全死亡：不可用于结构判异', 'danger')
              : badge(
                  snapshot.endReason === null ? snapshot.status : snapshot.endReason,
                  snapshot.status === 'failed' ? 'danger' : 'muted',
                ),
          ],
        },
      ),
    ]),
    h('div', { class: 'span-4' }, [
      chartFrame('五维窗口均值指纹', [fingerprintRadar(winSummary)], {
        windowLabel: winSummary.spec.shortLabel,
        subtitle: '窗口内存活日算术均值（未校准描述）',
        definition:
          '在所选观察窗（w1/w2/w3 或全周期）内对存活日取算术均值，映射至 Gini、Top10、Mup、Open O、Seg S 五轴。',
      }),
    ]),
    h('div', { class: 'span-6' }, [
      chartFrame('阶级结构堆叠', [classChart(plotRows, classCount), classLegend()], {
        windowLabel: winSummary.spec.shortLabel,
        subtitle: `各阶级存活人口占比；当前存活总数 N=${snapshot.aliveCount}（死亡不折算为流动）`,
        definition: 'P[c] = aliveInClass[c] / aliveTotal，分母仅含存活个体。',
      }),
    ]),
    h('div', { class: 'span-6' }, [
      chartFrame(
        '财富与不平等',
        [
          h('div', { class: 'wealth-split' }, [
            h('div', { class: 'wealth-main-col' }, [
              wealthChart(plotRows, app.wealthLogScale, ghostRows),
              legend(
                app.wealthLogScale
                  ? [['log10(中位数财富+1)', 'var(--gold)']]
                  : [
                      ['Gini', 'var(--class-4-color)'],
                      ['Top10% 份额', 'var(--class-3-color)'],
                    ],
              ),
            ]),
            h('div', { class: 'wealth-lorenz-col' }, [
              renderLorenzChart(lorenzCurvePoints(app.controller.getState()), {
                width: 165,
                height: 155,
              }),
            ]),
          ]),
        ],
        {
          windowLabel: winSummary.spec.shortLabel,
          subtitle: `最新中位数财富 ${formatNumber(snapshot.latestStats?.medianValue)} · 含实时洛伦兹曲线`,
          definition:
            '基尼系数 G 与前 10% 财富占比基于存活个体当前 Value 计算；虚线为对照基准幽灵轨迹。',
          actions: [
            h('button', {
              class: `btn btn-sm ${app.wealthLogScale ? 'btn-primary' : 'btn-ghost'}`.trim(),
              type: 'button',
              text: app.wealthLogScale ? 'log10 中位数' : 'Gini / Top10%',
              onClick: () => {
                app.wealthLogScale = !app.wealthLogScale;
                app.render();
              },
            }),
          ],
        },
      ),
    ]),
    h('div', { class: 'span-4' }, [
      chartFrame(
        '双向流动',
        [
          mobilityChart(plotRows, ghostRows),
          legend([
            ['Mup (上升参与率)', 'var(--action-ascend)'],
            ['Mdown (下降参与率)', 'var(--action-descend)'],
          ]),
        ],
        {
          windowLabel: `${snapshot.config?.metrics.mobilityWindowDays ?? 365}d`,
          subtitle: '滑动窗口参与率（仅计存活者）',
          definition: 'Mup / Mdown 为滑动窗口内至少完成一次向上/向下跨层的存活者比例。',
        },
      ),
    ]),
    h('div', { class: 'span-4' }, [
      chartFrame(
        '网络结构',
        [
          networkChart(snapshot, plotRows, ghostRows),
          legend([
            ['跨层边占比', 'var(--class-2-color)'],
            ['调整后隔离度 S', 'var(--class-3-color)'],
          ]),
        ],
        {
          windowLabel: winSummary.spec.shortLabel,
          subtitle: `边数 ${snapshot.latestStats?.edgeCount ?? 0} · 均度 ${formatNumber(snapshot.latestStats?.avgDegree, 2)} · 连通分量 ${snapshot.latestStats?.connectedComponents ?? 0}`,
          definition:
            '调整后网络隔离度 S ∈ [-1, 1]；当存活连边为 0 时 S 显式置 0 并标注 edgeCount=0。',
        },
      ),
    ]),
    h('div', { class: 'span-4' }, [
      chartFrame(
        '开放度与动态机会 E',
        [
          opennessChart(plotRows, classCount, ghostRows),
          legend([
            ['O (制度开放度)', 'var(--accent)'],
            ...Array.from(
              { length: classCount },
              (_, c) => [`E[C${c}]`, CLASS_COLORS[c] ?? 'var(--accent)'] as const,
            ),
          ]),
        ],
        {
          windowLabel: winSummary.spec.shortLabel,
          subtitle: '实线 O 为制度开放度慢变量；虚线为五阶层动态环境系数 E[c]',
          definition: 'O 随制度慢变量更新；E[c] 决定各阶层每日产出基准与跨越门槛参考。',
        },
      ),
    ]),
    h('div', { class: 'span-4' }, [
      card(
        '竞争与净损耗',
        [
          competitionChart(plotRows),
          legend([
            ['败者损失 (loss)', 'var(--action-descend)'],
            ['胜者获得 (gain)', 'var(--action-ascend)'],
          ]),
          competitionDirectionTable(snapshot),
        ],
        {
          subtitle: '单 tick 竞争损失/获得及按原发起方向分组统计',
        },
      ),
    ]),
    h('div', { class: 'span-4' }, [
      card('寿命与按阶级死亡', [deathChart(snapshot, app)], {
        subtitle: '累计离世趋势、各阶层终态死亡与存活剩余寿命直方图',
      }),
    ]),
    h('div', { class: 'span-4' }, [
      chartFrame('窗口阶级转移矩阵', [flowMatrix(snapshot)], {
        subtitle: `最近 ${snapshot.config?.metrics.flowWindowDays ?? 365} 日窗口计数（行=来源层，列=目标层）`,
      }),
    ]),
    h('div', { class: 'span-4' }, [phasePortraitCard(plotRows, ghostRows)]),
    h('div', { class: 'span-4' }, [
      chartFrame('行动分布与决策遥测', [decisionChart(snapshot)], {
        subtitle: '最近 500 条个体决策统计；离线策略不伪造模型 Token 成本',
      }),
    ]),
    h('div', { class: 'span-12' }, [
      chartFrame('实时审计事件流（最近有界 500 条）', [eventList(snapshot, app)], {
        subtitle: '点击带个体编号的事件可直接选中对应个体；完整日志请通过 Bundle 导出保存',
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
          h('span', { class: 'mono kpi-symbol', text: kpi.symbol }),
        ]),
        h('div', { class: 'kpi-value', text: kpi.value }),
        h('div', { class: 'kpi-unit', text: kpi.unit }),
      ]),
    );
  }
  return grid;
}

function windowSummaryTable(win: WindowAggregate): HTMLElement {
  if (win.sampleCount === 0) {
    return h('p', {
      class: 'muted',
      style: 'margin-top:10px',
      text: '当前运行尚未推进至所选评估窗口区间。',
    });
  }
  return h('div', { style: 'margin-top:12px' }, [
    table(
      ['窗口指标', '均值 / 统计值', '区间定义'],
      [
        [
          '观测范围',
          `Tick ${win.startObserved ?? 0} .. ${win.endObserved ?? 0} (${win.sampleCount} 行)`,
          win.spec.label,
        ],
        ['窗口均值 Gini', formatNumber(win.meanGini), '存活日算术平均'],
        ['窗口均值 Top10%', formatPercent(win.meanTop10), '存活日算术平均'],
        [
          '窗口均值 Mup / Mdown',
          `${formatNumber(win.meanMUp)} / ${formatNumber(win.meanMDown)}`,
          '双向滑动参与率均值',
        ],
        [
          '窗口均值 S / O',
          `${formatNumber(win.meanSegregation)} / ${formatNumber(win.meanOpenness)}`,
          '隔离度与开放度均值',
        ],
        [
          '阶级平均占比 P[0..4]',
          win.meanClassShares.map((v) => formatPercent(v, 1)).join(' · '),
          '各层存活占比均值',
        ],
      ],
    ),
  ]);
}

function fingerprintRadar(win: WindowAggregate): HTMLElement {
  if (win.sampleCount === 0) {
    return h('div', {}, [emptyChart('该窗口尚无已结算样本', { width: 270, height: 210 })]);
  }
  const sNorm = win.meanSegregation === null ? 0.5 : (win.meanSegregation + 1) * 0.5;
  return h('div', {}, [
    renderRadarChart(
      [
        { label: 'Gini', normalized: win.meanGini ?? 0, display: formatNumber(win.meanGini, 2) },
        {
          label: 'Top10',
          normalized: win.meanTop10 ?? 0,
          display: formatPercent(win.meanTop10, 0),
        },
        {
          label: 'Mup',
          normalized: Math.min(1, (win.meanMUp ?? 0) * 2),
          display: formatNumber(win.meanMUp, 2),
        },
        {
          label: 'Open O',
          normalized: win.meanOpenness ?? 0,
          display: formatNumber(win.meanOpenness, 2),
        },
        { label: 'Seg S', normalized: sNorm, display: formatNumber(win.meanSegregation, 2) },
      ],
      { width: 270, height: 215, title: '五维窗口结构指纹' },
    ),
  ]);
}

export interface ClassStackRow {
  readonly tick: number;
  readonly aliveCount: number;
  readonly classCounts: readonly number[];
}

/**
 * 阶级堆叠图的每一层上边界：同一 tick 内累加 class 0..i 的存活占比。
 *
 * 累加必须按 tick 独立进行；不能把 running 跨 tick 延续，否则曲线会随
 * 时间单调上升并远超 [0,1]，在图表里冲出画布。
 */
export function buildClassStack(rows: readonly ClassStackRow[], classCount: number): Series[] {
  if (rows.length === 0) return [];
  const cumulative = new Array<number>(rows.length).fill(0);
  const series: Series[] = [];
  for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (row === undefined) continue;
      const total = row.aliveCount > 0 ? row.aliveCount : 1;
      const share = (row.classCounts[classIndex] ?? 0) / total;
      cumulative[rowIndex] = (cumulative[rowIndex] ?? 0) + share;
    }
    series.push({
      label: `Class ${classIndex}`,
      color: CLASS_COLORS[classIndex] ?? 'var(--accent)',
      points: rows.map((row, rowIndex) => ({
        x: row.tick + 1,
        y: Math.min(1, Math.max(0, cumulative[rowIndex] ?? 0)),
      })),
    });
  }
  return series;
}

function classChart(rows: readonly TickStats[], classCount: number): SVGSVGElement {
  if (rows.length === 0) return emptyChart('尚无该窗口 tick 数据', { title: '阶级结构堆叠' });
  return renderStackedArea(buildClassStack(rows, classCount), {
    height: 215,
    yMin: 0,
    yMax: 1,
    xLabel: 'tick',
    yLabel: '存活人口占比',
    title: '阶级结构堆叠',
  });
}

function sliceZoomRange(
  rows: readonly TickStats[],
  startPct: number,
  endPct: number,
): readonly TickStats[] {
  if (rows.length <= 2 || (startPct <= 0 && endPct >= 100)) return rows;
  const lo = Math.max(0, Math.min(rows.length - 1, Math.floor((rows.length * startPct) / 100)));
  const hi = Math.max(lo + 1, Math.min(rows.length, Math.ceil((rows.length * endPct) / 100)));
  return rows.slice(lo, hi);
}

function downloadStatsCsv(
  runId: string | null,
  windowKey: string,
  rows: readonly TickStats[],
): void {
  if (rows.length === 0) return;
  const csv = statsToCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const anchor = h('a', {
    href: URL.createObjectURL(blob),
    download: `${runId ?? 'stratify'}-${windowKey}-stats.csv`,
  });
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

function wealthChart(
  rows: readonly TickStats[],
  logMedianMode = false,
  ghostRows: readonly TickStats[] = [],
): SVGSVGElement {
  if (rows.length === 0) return emptyChart('尚无该窗口 tick 数据');
  if (logMedianMode) {
    const logSeries: Series = {
      label: 'log10(median+1)',
      color: 'var(--gold)',
      points: rows.map((row) => ({
        x: row.tick + 1,
        y: Math.log10(Math.max(0, row.medianValue) + 1),
      })),
    };
    const ghostLog: Series[] =
      ghostRows.length === 0
        ? []
        : [
            {
              label: '对照 log10',
              color: 'var(--gold)',
              points: ghostRows.map((row) => ({
                x: row.tick + 1,
                y: Math.log10(Math.max(0, row.medianValue) + 1),
              })),
            },
          ];
    return renderLineChart([logSeries], {
      height: 215,
      yMin: 0,
      xLabel: 'tick',
      yLabel: 'log10(V+1)',
      title: '中位数财富对数轨迹',
      ghostSeries: ghostLog,
    });
  }
  const gini: Series = {
    label: 'Gini',
    color: 'var(--class-4-color)',
    points: rows.map((row) => ({ x: row.tick + 1, y: row.gini })),
  };
  const top10: Series = {
    label: 'Top10%',
    color: 'var(--class-3-color)',
    points: rows.map((row) => ({ x: row.tick + 1, y: row.topWealthShare })),
    dashed: true,
  };
  const ghostSeries: Series[] =
    ghostRows.length === 0
      ? []
      : [
          {
            label: '对照 Gini',
            color: 'var(--class-4-color)',
            points: ghostRows.map((row) => ({ x: row.tick + 1, y: row.gini })),
          },
        ];
  return renderLineChart([gini, top10], {
    height: 215,
    yMin: 0,
    yMax: 1,
    xLabel: 'tick',
    yLabel: '[0,1]',
    title: '财富基尼与前 10% 占比',
    ghostSeries,
  });
}

function mobilityChart(
  rows: readonly TickStats[],
  ghostRows: readonly TickStats[] = [],
): SVGSVGElement {
  if (rows.length === 0) return emptyChart('尚无该窗口 tick 数据');
  const ghostSeries: Series[] =
    ghostRows.length === 0
      ? []
      : [
          {
            label: '对照 Mup',
            color: 'var(--action-ascend)',
            points: ghostRows.map((row) => ({ x: row.tick + 1, y: row.mUp })),
          },
          {
            label: '对照 Mdown',
            color: 'var(--action-descend)',
            points: ghostRows.map((row) => ({ x: row.tick + 1, y: row.mDown })),
          },
        ];
  return renderLineChart(
    [
      {
        label: 'Mup',
        color: 'var(--action-ascend)',
        points: rows.map((row) => ({ x: row.tick + 1, y: row.mUp })),
      },
      {
        label: 'Mdown',
        color: 'var(--action-descend)',
        points: rows.map((row) => ({ x: row.tick + 1, y: row.mDown })),
        dashed: true,
      },
    ],
    {
      height: 185,
      yMin: 0,
      yMax: 1,
      xLabel: 'tick',
      yLabel: '窗口参与率',
      title: '双向流动',
      ghostSeries,
    },
  );
}

function networkChart(
  snapshot: ControllerSnapshot,
  rows: readonly TickStats[],
  ghostRows: readonly TickStats[] = [],
): SVGSVGElement {
  const latest = snapshot.latestStats;
  if (latest === null || rows.length === 0)
    return emptyChart('尚无该窗口 tick 数据', { height: 185 });
  if (latest.edgeCount === 0) {
    return emptyChart('edgeCount = 0（无存活连边；S 置 0，不代表完全隔离）', { height: 185 });
  }
  const ghostSeries: Series[] =
    ghostRows.length === 0
      ? []
      : [
          {
            label: '对照 S',
            color: 'var(--class-3-color)',
            points: ghostRows.map((row) => ({ x: row.tick + 1, y: row.segregation })),
          },
        ];
  return renderLineChart(
    [
      {
        label: 'crossShare',
        color: 'var(--class-2-color)',
        points: rows.map((row) => ({ x: row.tick + 1, y: row.crossClassEdgeShare })),
      },
      {
        label: 'S',
        color: 'var(--class-3-color)',
        points: rows.map((row) => ({ x: row.tick + 1, y: row.segregation })),
        dashed: true,
      },
    ],
    {
      height: 185,
      yMin: -1,
      yMax: 1,
      xLabel: 'tick',
      yLabel: '比例 / S',
      title: '网络结构',
      ghostSeries,
    },
  );
}

function opennessChart(
  rows: readonly TickStats[],
  classCount: number,
  ghostRows: readonly TickStats[] = [],
): SVGSVGElement {
  if (rows.length === 0) return emptyChart('尚无该窗口 tick 数据', { height: 185 });
  const series: Series[] = [
    {
      label: 'O',
      color: 'var(--accent)',
      points: rows.map((row) => ({ x: row.tick + 1, y: row.openness })),
    },
  ];
  let maxE = 1;
  for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
    const pts = rows.map((row) => {
      const val = row.eByClass[classIndex] ?? 0;
      if (val > maxE) maxE = val;
      return { x: row.tick + 1, y: val };
    });
    series.push({
      label: `E[${classIndex}]`,
      color: CLASS_COLORS[classIndex] ?? 'var(--accent)',
      points: pts,
      dashed: true,
    });
  }
  const ghostSeries: Series[] =
    ghostRows.length === 0
      ? []
      : [
          {
            label: '对照 O',
            color: 'var(--accent)',
            points: ghostRows.map((row) => ({ x: row.tick + 1, y: row.openness })),
          },
        ];
  return renderLineChart(series, {
    height: 185,
    yMin: 0,
    yMax: Math.max(1, maxE),
    xLabel: 'tick',
    yLabel: 'O / E',
    title: '开放度与动态机会',
    ghostSeries,
    directLabels: false,
  });
}

function legend(items: readonly (readonly [string, string])[]): HTMLElement {
  return h(
    'div',
    { class: 'legend' },
    items.map(([label, color]) =>
      h('span', {}, [h('span', { class: 'legend-swatch', style: `background:${color}` }), label]),
    ),
  );
}

function classLegend(): HTMLElement {
  return legend(
    CLASS_COLORS.map(
      (color, index) => [`${CLASS_SYMBOLS[index] ?? '•'} Class ${index}`, color] as const,
    ),
  );
}

function competitionChart(rows: readonly TickStats[]): SVGSVGElement {
  if (rows.length === 0) return emptyChart('尚无该窗口 tick 数据', { height: 185 });
  const loss: Series = {
    label: 'loss',
    color: 'var(--action-descend)',
    points: rows.map((row) => ({ x: row.tick + 1, y: row.competitionLoss })),
  };
  const gain: Series = {
    label: 'gain',
    color: 'var(--action-ascend)',
    points: rows.map((row) => ({ x: row.tick + 1, y: row.competitionGain })),
    dashed: true,
  };
  return renderLineChart([loss, gain], {
    height: 185,
    yMin: 0,
    xLabel: 'tick',
    yLabel: 'Value',
    title: '竞争损失与获得',
  });
}

function competitionDirectionTable(snapshot: ControllerSnapshot): HTMLElement {
  const dirRows = competitionByDirection(snapshot.events);
  return h('div', { style: 'margin-top:8px' }, [
    table(
      ['发起方向', '场次', '发起胜率', '净损耗'],
      dirRows.map((r) => [
        r.label,
        String(r.count),
        r.winRate === null ? '—' : formatPercent(r.winRate, 0),
        formatNumber(r.netFriction, 1),
      ]),
    ),
  ]);
}

function deathChart(snapshot: ControllerSnapshot, app: StratifyApp): HTMLElement {
  if (snapshot.stats.length === 0) return h('div', {}, [emptyChart('尚无 tick 数据')]);
  const sampled = sampleRows(snapshot.stats, PRE_SAMPLE_LIMIT);
  // 用全量序列累加精确死亡数后按采样 tick 提取，保证曲线单调准确且点数有界
  const cumAtTick = new Map<number, number>();
  let cumulative = 0;
  for (const row of snapshot.stats) {
    cumulative += row.deathCount;
    cumAtTick.set(row.tick, cumulative);
  }
  const points = sampled.map((row) => ({
    x: row.tick + 1,
    y: cumAtTick.get(row.tick) ?? 0,
  }));

  const state = app.controller.getState();
  const classCount = snapshot.config?.population.classCount ?? 5;
  const deathsByClass = new Array<number>(classCount).fill(0);
  if (state !== null) {
    for (const agent of state.society.agents) {
      if (!agent.alive) {
        deathsByClass[agent.classIndex] = (deathsByClass[agent.classIndex] ?? 0) + 1;
      }
    }
  }
  const lifeBins = remainingLifeBins(state);
  return h('div', {}, [
    renderLineChart([{ label: 'deaths', color: 'var(--class-0-color)', points }], {
      height: 115,
      yMin: 0,
      xLabel: 'tick',
      yLabel: '人',
      title: '累计死亡',
    }),
    renderBarChart(
      deathsByClass.map((value, index) => ({
        label: `C${index}`,
        value,
        color: CLASS_COLORS[index] ?? 'var(--accent)',
      })),
      { height: 95, title: '按阶级死亡' },
    ),
    renderBarChart(lifeBins, { height: 95, title: '存活个体剩余寿命直方图' }),
  ]);
}

function phasePortraitCard(
  rows: readonly TickStats[],
  ghostRows: readonly TickStats[],
): HTMLElement {
  let yAxis: PhaseYAxis = 'segregation';
  const body = h('div', {});
  const toggleBtn = h('button', {
    class: 'btn btn-sm btn-ghost',
    type: 'button',
    text: '纵轴: S / 切至 Gini',
    onClick: () => {
      yAxis = yAxis === 'segregation' ? 'gini' : 'segregation';
      toggleBtn.textContent =
        yAxis === 'segregation' ? '纵轴: S / 切至 Gini' : '纵轴: Gini / 切至 S';
      renderBody();
    },
  });
  const renderBody = (): void => {
    body.replaceChildren(renderPhasePortrait(rows, { yAxis, ghostRows }));
  };
  renderBody();
  return chartFrame('体制相空间轨迹 (O × S/G)', [body], {
    subtitle: '开放度 O 与隔离度 S（或基尼 G）的动力学吸引域轨迹；虚圈为 D1 参考质心',
    definition:
      '横轴为制度开放度 O，纵轴为隔离度 S 或基尼 G；空心圆为起点，实心圆为当前状态；D1 参考质心仅限 rules-v16 / N=200 / mock 口径。',
    actions: [toggleBtn],
  });
}

function flowMatrix(snapshot: ControllerSnapshot): HTMLElement {
  const latest = snapshot.latestStats;
  if (latest === null || latest.flowMatrix.length === 0) {
    return h('div', {}, [emptyChart('窗口内尚无阶级转移', { height: 240 })]);
  }
  const labels = latest.flowMatrix.map((_, index) => `C${index}`);
  let showMatrix = false;
  const host = h('div', {});
  const toggleBtn = h('button', {
    class: 'btn btn-sm btn-ghost',
    type: 'button',
    text: '切换 5×5 矩阵',
    onClick: () => {
      showMatrix = !showMatrix;
      toggleBtn.textContent = showMatrix ? '切换流带图' : '切换 5×5 矩阵';
      renderBody();
    },
  });
  const body = h('div', {});
  const renderBody = (): void => {
    body.replaceChildren(
      showMatrix
        ? renderHeatmap(latest.flowMatrix, labels, labels, { height: 220, title: '阶级转移矩阵' })
        : renderFlowRibbon(latest.flowMatrix, labels, { height: 210, title: '阶层流动流带图' }),
    );
  };
  renderBody();
  host.append(
    h('div', { class: 'actions-row', style: 'justify-content:flex-end;margin-bottom:4px' }, [
      toggleBtn,
    ]),
    body,
  );
  return host;
}

function decisionChart(snapshot: ControllerSnapshot): HTMLElement {
  if (snapshot.decisions.length === 0) return h('div', {}, [emptyChart('尚无决策记录')]);
  const counts: Record<string, number> = {
    accumulate: 0,
    ascend: 0,
    descend: 0,
    compete: 0,
  };
  let fallbackCount = 0;
  const recentSlice = snapshot.decisions.slice(-500);
  for (const record of recentSlice) {
    if (record.source === 'fallback') fallbackCount += 1;
    if (record.selectedAction === 'accumulate')
      counts['accumulate'] = (counts['accumulate'] ?? 0) + 1;
    else if (record.selectedAction === 'ascend') counts['ascend'] = (counts['ascend'] ?? 0) + 1;
    else if (record.selectedAction === 'descend') counts['descend'] = (counts['descend'] ?? 0) + 1;
    else counts['compete'] = (counts['compete'] ?? 0) + 1;
  }
  const total = recentSlice.length || 1;
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
      { height: 155, yLabel: '决策数', title: '行动分布' },
    ),
    h('div', { class: 'actions-row', style: 'margin:6px 0' }, [
      badge(`样本 ${recentSlice.length} 条`, 'muted'),
      badge(
        `回退率 ${formatPercent(fallbackCount / total, 1)}`,
        fallbackCount / total > 0.2 ? 'danger' : 'ok',
      ),
    ]),
    table(
      ['行动类型', '频次', '占比'],
      Object.entries(counts).map(([action, count]) => [
        action,
        String(count),
        formatPercent(count / total),
      ]),
    ),
  ]);
}

function eventList(snapshot: ControllerSnapshot, app: StratifyApp): HTMLElement {
  const filterButtons = h('div', { class: 'actions-row', style: 'margin-bottom:8px' }, [
    ...(['all', 'mobility', 'compete', 'death'] as const).map((kind) =>
      h('button', {
        class: `btn btn-sm ${app.eventFilter === kind ? 'btn-primary' : 'btn-ghost'}`.trim(),
        type: 'button',
        text:
          kind === 'all'
            ? '全部事件'
            : kind === 'mobility'
              ? '▲▼ 升降阶'
              : kind === 'compete'
                ? '⚡ 竞争博弈'
                : '◌ 死亡与失效',
        onClick: () => {
          app.eventFilter = kind;
          app.render();
        },
      }),
    ),
  ]);

  const filteredEvents =
    app.eventFilter === 'all'
      ? snapshot.events
      : snapshot.events.filter((ev) => {
          if (app.eventFilter === 'mobility') {
            return ev.type === 'class_ascended' || ev.type === 'class_descended';
          }
          if (app.eventFilter === 'compete') {
            return ev.type === 'competition_resolved';
          }
          return ev.type === 'agent_died' || ev.type === 'action_invalid';
        });

  const events = eventViews(filteredEvents, 100);
  if (events.length === 0) {
    return h('div', {}, [
      filterButtons,
      h('p', { class: 'muted', text: '当前筛选条件下尚无事件。' }),
    ]);
  }
  const list = h('ul', { class: 'event-list' });
  for (const event of events) {
    const matchAgent = /a-\d{4}/.exec(event.summary)?.[0] ?? null;
    list.append(
      h(
        'li',
        {
          style: matchAgent !== null ? 'cursor:pointer' : '',
          title: matchAgent !== null ? `点击在检查器查看 ${matchAgent}` : '',
          onClick: () => {
            if (matchAgent !== null) {
              app.selectedAgentId = matchAgent;
              app.setTab('inspector');
            }
          },
        },
        [
          h('span', { class: 'muted', text: `t${event.tick}.${event.seq}` }),
          h('span', { class: 'event-type-pill', text: event.type }),
          h('span', { text: event.summary }),
        ],
      ),
    );
  }
  return h('div', {}, [filterButtons, list]);
}

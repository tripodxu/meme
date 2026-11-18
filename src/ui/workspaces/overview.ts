import type { TickStats } from '../../core/macros/tick-metrics.js';
import type { ControllerSnapshot } from '../../app/types.js';
import {
  buildKpis,
  competitionByDirection,
  eventViews,
  formatNumber,
  formatPercent,
  lorenzCurvePoints,
  OVERVIEW_WINDOWS,
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
import { sampleRows } from '../charts/lttb.js';
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

  const zoomPresets: readonly { label: string; range: readonly [number, number] }[] = [
    { label: '全区间', range: [0, 100] },
    { label: '0–50%', range: [0, 50] },
    { label: '50–100%', range: [50, 100] },
    { label: '末 25%', range: [75, 100] },
  ];

  const windowToolbar = h('div', { class: 'window-toolbar span-12' }, [
    h('div', { class: 'actions-row' }, [
      h('span', { class: 'muted', style: 'font-size:12px', text: '观察窗：' }),
      ...OVERVIEW_WINDOWS.map((spec) => {
        const outOfRange = snapshot.totalTicks > 0 && snapshot.totalTicks <= spec.startTick;
        return h('button', {
          class: `btn btn-sm ${app.overviewWindow === spec.id ? 'btn-primary' : ''}`.trim(),
          type: 'button',
          disabled: outOfRange,
          ariaPressed: String(app.overviewWindow === spec.id),
          text: spec.label,
          onClick: () => {
            app.overviewWindow = spec.id;
            app.render();
          },
        });
      }),
      h('span', { class: 'muted', style: 'font-size:12px;margin-left:6px', text: '缩放：' }),
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
      h('button', {
        class: 'btn btn-sm btn-ghost',
        type: 'button',
        disabled: winSummary.rows.length === 0,
        text: '⬇ 导出窗口 CSV',
        onClick: () => downloadStatsCsv(snapshot.runId, app.overviewWindow, winSummary.rows),
      }),
      h('button', {
        class: `btn btn-sm ${app.overviewTableMode ? 'btn-primary' : 'btn-ghost'}`.trim(),
        type: 'button',
        text: app.overviewTableMode ? '📊 返回图形视图' : '📋 查看窗口聚合数据表',
        onClick: () => {
          app.overviewTableMode = !app.overviewTableMode;
          app.render();
        },
      }),
      h('button', {
        class: 'btn btn-sm btn-ghost',
        type: 'button',
        text: '✦ 切至生态沙盒视角',
        onClick: () => app.setSurface('sandbox'),
      }),
    ]),
  ]);

  root.append(
    windowToolbar,
    h('div', { class: 'span-8' }, [
      card(
        '结构指纹与核心指标',
        [kpiGrid(snapshot), app.overviewTableMode ? windowSummaryTable(winSummary) : null],
        {
          subtitle: `${winSummary.spec.label}（已观测 ${winSummary.sampleCount} tick）· 实时值来自最新 tick，不把终局值冒充窗口均值`,
          actions: [
            badge(`alive ${snapshot.aliveCount}`, 'info'),
            snapshot.aliveCount === 0 && snapshot.tick > 0
              ? badge('⚠ 全死亡：不可用于结构判异', 'danger')
              : badge(
                  snapshot.endReason === null ? snapshot.status : snapshot.endReason,
                  snapshot.status === 'failed' ? 'danger' : 'muted',
                ),
          ],
        },
      ),
    ]),
    h('div', { class: 'span-4' }, [
      card('五维窗口均值指纹', [fingerprintRadar(winSummary)], {
        subtitle: `${winSummary.spec.shortLabel} 窗口内存活日算术均值（未校准描述）`,
      }),
    ]),
    h('div', { class: 'span-6' }, [
      card('阶级结构堆叠', [classChart(plotRows, classCount), classLegend()], {
        subtitle: `各阶级存活人口占比；当前存活总数 N=${snapshot.aliveCount}（死亡不折算为流动）`,
      }),
    ]),
    h('div', { class: 'span-6' }, [
      card(
        '财富与不平等',
        [
          h('div', { class: 'wealth-split' }, [
            h('div', { class: 'wealth-main-col' }, [
              wealthChart(plotRows, app.wealthLogScale),
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
          subtitle: `最新中位数财富 ${formatNumber(snapshot.latestStats?.medianValue)} · 含实时洛伦兹曲线`,
          actions: [
            h('button', {
              class: `btn btn-sm ${app.wealthLogScale ? 'btn-primary' : 'btn-ghost'}`.trim(),
              type: 'button',
              text: app.wealthLogScale ? 'log₁₀ 中位数财富' : 'Gini / Top10%',
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
      card(
        '双向流动',
        [
          mobilityChart(plotRows),
          legend([
            ['Mup (上升参与率)', 'var(--action-ascend)'],
            ['Mdown (下降参与率)', 'var(--action-descend)'],
          ]),
        ],
        {
          subtitle: `${snapshot.config?.metrics.mobilityWindowDays ?? 365} 日滑动参与率（仅计存活者）`,
        },
      ),
    ]),
    h('div', { class: 'span-4' }, [
      card(
        '网络结构',
        [
          networkChart(snapshot, plotRows),
          legend([
            ['跨层边占比', 'var(--class-2-color)'],
            ['调整后隔离度 S', 'var(--class-3-color)'],
          ]),
        ],
        {
          subtitle: `边数 ${snapshot.latestStats?.edgeCount ?? 0} · 均度 ${formatNumber(snapshot.latestStats?.avgDegree, 2)} · 连通分量 ${snapshot.latestStats?.connectedComponents ?? 0}`,
        },
      ),
    ]),
    h('div', { class: 'span-4' }, [
      card(
        '开放度与动态机会 E',
        [
          opennessChart(plotRows, classCount),
          legend([
            ['O (制度开放度)', 'var(--accent)'],
            ...Array.from(
              { length: classCount },
              (_, c) => [`E[C${c}]`, CLASS_COLORS[c] ?? 'var(--accent)'] as const,
            ),
          ]),
        ],
        {
          subtitle: '实线 O 为制度开放度慢变量；虚线为五阶层动态环境系数 E[c]',
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
      card('窗口阶级转移矩阵', [flowMatrix(snapshot)], {
        subtitle: `最近 ${snapshot.config?.metrics.flowWindowDays ?? 365} 日窗口计数（行=来源层，列=目标层）`,
      }),
    ]),
    h('div', { class: 'span-5' }, [
      card('行动分布与决策遥测', [decisionChart(snapshot)], {
        subtitle: '最近 500 条个体决策统计；离线策略不伪造模型 Token 成本',
      }),
    ]),
    h('div', { class: 'span-7' }, [
      card('实时审计事件流（最近有界 500 条）', [eventList(snapshot, app)], {
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

function wealthChart(rows: readonly TickStats[], logMedianMode = false): SVGSVGElement {
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
    return renderLineChart([logSeries], {
      height: 215,
      yMin: 0,
      xLabel: 'tick',
      yLabel: 'log10(V+1)',
      title: '中位数财富对数轨迹',
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
  return renderLineChart([gini, top10], {
    height: 215,
    yMin: 0,
    yMax: 1,
    xLabel: 'tick',
    yLabel: '[0,1]',
    title: '财富基尼与前 10% 占比',
  });
}

function mobilityChart(rows: readonly TickStats[]): SVGSVGElement {
  if (rows.length === 0) return emptyChart('尚无该窗口 tick 数据');
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
    { height: 185, yMin: 0, yMax: 1, xLabel: 'tick', yLabel: '窗口参与率', title: '双向流动' },
  );
}

function networkChart(snapshot: ControllerSnapshot, rows: readonly TickStats[]): SVGSVGElement {
  const latest = snapshot.latestStats;
  if (latest === null || rows.length === 0)
    return emptyChart('尚无该窗口 tick 数据', { height: 185 });
  if (latest.edgeCount === 0) {
    return emptyChart('edgeCount = 0（无存活连边；S 置 0，不代表完全隔离）', { height: 185 });
  }
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
    { height: 185, yMin: -1, yMax: 1, xLabel: 'tick', yLabel: '比例 / S', title: '网络结构' },
  );
}

function opennessChart(rows: readonly TickStats[], classCount: number): SVGSVGElement {
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
  return renderLineChart(series, {
    height: 185,
    yMin: 0,
    yMax: Math.max(1, maxE),
    xLabel: 'tick',
    yLabel: 'O / E',
    title: '开放度与动态机会',
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

function flowMatrix(snapshot: ControllerSnapshot): HTMLElement {
  const latest = snapshot.latestStats;
  if (latest === null || latest.flowMatrix.length === 0) {
    return h('div', {}, [emptyChart('窗口内尚无阶级转移', { height: 240 })]);
  }
  const labels = latest.flowMatrix.map((_, index) => `C${index}`);
  return h('div', {}, [
    renderHeatmap(latest.flowMatrix, labels, labels, { height: 245, title: '阶级转移矩阵' }),
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

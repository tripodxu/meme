import type { RunConfig } from '../core/config/types.js';
import type { TickStats } from '../core/macros/tick-metrics.js';

/**
 * 07 §5 窗口聚合。统计一律基于全分辨率 tick 数据（运行内 `statsStride=1`），
 * 不使用 D1 采样行近似。30 日块只用于自相关观察，不二次加权。
 */

/**
 * 预注册窗口（07 §5 / v5 预注册）：w2b（1825–2554）是 v5 burn-in 后的主分析窗口；
 * w1/w2 仅作诊断（非平稳/极限环观察），不参与结构主判定。w3 为紧邻的后续窗口。
 */
export const ANALYSIS_WINDOWS = [
  { label: 'w1', start: 365, end: 1094 },
  { label: 'w2', start: 1095, end: 1824 },
  { label: 'w2b', start: 1825, end: 2554 },
  { label: 'w3', start: 2555, end: 3284 },
] as const;

export type WindowLabel = (typeof ANALYSIS_WINDOWS)[number]['label'];

export interface WindowSummary {
  readonly label: WindowLabel;
  readonly start: number;
  readonly end: number;
  readonly tickCount: number;
  /** 窗口内全死亡导致的缺失日数；>0 时该 run 标 extinct 且窗口不参与正常结构判异。 */
  readonly missingTicks: number;
  /** P/G/topWealthShare/Mup/Mdown/S/O 的窗口日均值（07 §5 唯一算法）。 */
  readonly classShares: number[];
  readonly gini: number;
  readonly topWealthShare: number;
  readonly mUp: number;
  readonly mDown: number;
  readonly segregation: number;
  readonly openness: number;
  readonly eByClass: number[];
  readonly medianValue: number;
  readonly aliveTickAverage: number;
  /** 死亡率 = 窗口死亡数 / 存活人日暴露量（07 §5）。 */
  readonly deathRate: number;
  /** 竞争损耗率 = Σ(loss-gain)/Σloss；分母 0 时为 0（07 §5）。 */
  readonly competitionLossRate: number;
  /** 回退率 = fallback 决策数/到期决策数；分母 0 时为 null（07 §5）。 */
  readonly fallbackRate: number | null;
  /** 窗口转移矩阵（按事件计数）与行转移率；行暴露量为 0 时该行为 null，不冒充 0。 */
  readonly flowCounts: readonly (readonly number[])[];
  readonly flowRowRates: readonly (readonly (number | null)[])[];
  /** edgeCount==0 的窗口标记 networkEmpty，不参与依赖 S 的标签与 O 反馈诊断。 */
  readonly networkEmpty: boolean;
  readonly edgeCountAverage: number;
  readonly crossClassEdgeShare: number;
  readonly avgDegree: number;
  readonly connectedComponents: number;
  /** 30 日块（观察自相关；末尾残块并入前一块并标记 partialBlockMerged）。 */
  readonly blocks30d: readonly {
    readonly start: number;
    readonly gini: number;
    readonly openness: number;
    readonly classShares: readonly number[];
  }[];
  readonly partialBlockMerged: boolean;
}

export interface WindowInputs {
  readonly config: RunConfig;
  /** 全分辨率 tick stats（tick=t 为完成 t 结算后的行）。 */
  readonly stats: readonly TickStats[];
  /** 每 tick 阶级转移计数矩阵（来自该 tick 的阶级事件）。 */
  readonly flowsByTick: ReadonlyMap<number, readonly (readonly number[])[]>;
  /** 每 tick {到期决策数, 回退决策数}。 */
  readonly decisionsByTick: ReadonlyMap<
    number,
    { readonly due: number; readonly fallbacks: number }
  >;
}

/** 窗口无数据时的占位摘要（不可用于结构判异）。 */
function unavailableWindow(
  label: WindowLabel,
  start: number,
  end: number,
  missingTicks: number,
  classCount: number,
): WindowSummary {
  return {
    label,
    start,
    end,
    tickCount: 0,
    missingTicks,
    classShares: new Array<number>(classCount).fill(0),
    gini: 0,
    topWealthShare: 0,
    mUp: 0,
    mDown: 0,
    segregation: 0,
    openness: 0,
    eByClass: new Array<number>(classCount).fill(0),
    medianValue: 0,
    aliveTickAverage: 0,
    deathRate: 0,
    competitionLossRate: 0,
    fallbackRate: null,
    flowCounts: Array.from({ length: classCount }, () => new Array<number>(classCount).fill(0)),
    flowRowRates: Array.from({ length: classCount }, () =>
      new Array<number | null>(classCount).fill(null),
    ),
    networkEmpty: true,
    edgeCountAverage: 0,
    crossClassEdgeShare: 0,
    avgDegree: 0,
    connectedComponents: 0,
    blocks30d: [],
    partialBlockMerged: false,
  };
}

/** 窗口 [start,end]（含端点）聚合。 */
export function summarizeWindow(
  inputs: WindowInputs,
  label: WindowLabel,
  start: number,
  end: number,
): WindowSummary {
  const { config, stats, flowsByTick, decisionsByTick } = inputs;
  const classCount = config.population.classCount;
  const rows = stats.filter((row) => row.tick >= start && row.tick <= end);
  const expectedTicks = end - start + 1;
  const missingTicks = expectedTicks - rows.length;
  const n = rows.length;
  if (n === 0) {
    // run 短于窗口（如冒烟/预检）：返回不可用摘要，missingTicks 覆盖全窗口，
    // 标签判定将其视为不参与结构判异。
    return unavailableWindow(label, start, end, missingTicks, classCount);
  }
  const mean = (pick: (row: TickStats) => number): number =>
    rows.reduce((sum, row) => sum + pick(row), 0) / n;

  const classShares = Array.from(
    { length: classCount },
    (_, c) =>
      rows.reduce((sum, row) => sum + (row.classCounts[c] ?? 0) / Math.max(row.aliveCount, 1), 0) /
      n,
  );
  const eByClass = Array.from(
    { length: classCount },
    (_, c) => rows.reduce((sum, row) => sum + (row.eByClass[c] ?? 0), 0) / n,
  );

  // 死亡暴露量：各 tick 期初存活人日 = 当期期末存活数 + 当期死亡数。
  const aliveExposure = rows.reduce((sum, row) => sum + row.aliveCount + row.deathCount, 0);
  const deaths = rows.reduce((sum, row) => sum + row.deathCount, 0);
  const lossTotal = rows.reduce((sum, row) => sum + row.competitionLoss, 0);
  const gainTotal = rows.reduce((sum, row) => sum + row.competitionGain, 0);

  // 窗口转移矩阵：直接累计窗口内各 tick 的转移事件计数。
  const flowCounts: number[][] = Array.from({ length: classCount }, () =>
    new Array<number>(classCount).fill(0),
  );
  for (let tick = start; tick <= end; tick += 1) {
    const flows = flowsByTick.get(tick);
    if (flows === undefined) {
      continue;
    }
    for (let from = 0; from < classCount; from += 1) {
      for (let to = 0; to < classCount; to += 1) {
        const cell = flows[from]?.[to] ?? 0;
        const targetRow = flowCounts[from] as number[];
        targetRow[to] = (targetRow[to] as number) + cell;
      }
    }
  }
  // 行暴露量：各 tick 期初处于该行阶级的存活人日 = 上一 tick 期末行人数；
  // 窗口首 tick 的期初取更早一行（stats 必须包含 start-1；tick 0 由初始化行兜底）。
  const rowExposure = new Array<number>(classCount).fill(0);
  for (let tick = start; tick <= end; tick += 1) {
    const prev = stats.find((row) => row.tick === tick - 1);
    if (prev !== undefined) {
      for (let c = 0; c < classCount; c += 1) {
        rowExposure[c] = (rowExposure[c] as number) + (prev.classCounts[c] ?? 0);
      }
    }
  }
  const flowRowRates = flowCounts.map((row, from) =>
    row.map((count) =>
      (rowExposure[from] as number) > 0 ? count / (rowExposure[from] as number) : null,
    ),
  );

  // 窗口决策汇总。
  let due = 0;
  let fallbacks = 0;
  for (let tick = start; tick <= end; tick += 1) {
    const entry = decisionsByTick.get(tick);
    if (entry !== undefined) {
      due += entry.due;
      fallbacks += entry.fallbacks;
    }
  }

  // 30 日块：窗口起点起每 30 日一块；末尾残块并入前一块（partialBlockMerged）。
  const blocks30d: {
    start: number;
    gini: number;
    openness: number;
    classShares: number[];
  }[] = [];
  let partialBlockMerged = false;
  const blockStarts: number[] = [];
  for (let tick = start; tick <= end; tick += 30) {
    blockStarts.push(tick);
  }
  const lastStart = blockStarts[blockStarts.length - 1];
  if (lastStart !== undefined && end - lastStart + 1 < 30 && blockStarts.length > 1) {
    blockStarts.pop();
    partialBlockMerged = true;
  }
  for (let index = 0; index < blockStarts.length; index += 1) {
    const blockStart = blockStarts[index] as number;
    const blockEnd =
      index === blockStarts.length - 1 ? end : (blockStarts[index + 1] as number) - 1;
    const blockRows = rows.filter((row) => row.tick >= blockStart && row.tick <= blockEnd);
    const bn = blockRows.length;
    if (bn === 0) {
      continue;
    }
    blocks30d.push({
      start: blockStart,
      gini: blockRows.reduce((sum, row) => sum + row.gini, 0) / bn,
      openness: blockRows.reduce((sum, row) => sum + row.openness, 0) / bn,
      classShares: Array.from(
        { length: classCount },
        (_, c) =>
          blockRows.reduce(
            (sum, row) => sum + (row.classCounts[c] ?? 0) / Math.max(row.aliveCount, 1),
            0,
          ) / bn,
      ),
    });
  }

  const lastRow = rows[n - 1] as TickStats;
  return {
    label,
    start,
    end,
    tickCount: n,
    missingTicks,
    classShares,
    gini: mean((row) => row.gini),
    topWealthShare: mean((row) => row.topWealthShare),
    mUp: mean((row) => row.mUp),
    mDown: mean((row) => row.mDown),
    segregation: mean((row) => row.segregation),
    openness: mean((row) => row.openness),
    eByClass,
    medianValue: mean((row) => row.medianValue),
    aliveTickAverage: mean((row) => row.aliveCount),
    deathRate: aliveExposure === 0 ? 0 : deaths / aliveExposure,
    competitionLossRate: lossTotal === 0 ? 0 : (lossTotal - gainTotal) / lossTotal,
    fallbackRate: due === 0 ? null : fallbacks / due,
    flowCounts,
    flowRowRates,
    networkEmpty: lastRow.edgeCount === 0,
    edgeCountAverage: mean((row) => row.edgeCount),
    crossClassEdgeShare: mean((row) => row.crossClassEdgeShare),
    avgDegree: mean((row) => row.avgDegree),
    connectedComponents: mean((row) => row.connectedComponents),
    blocks30d,
    partialBlockMerged,
  };
}

import type { WindowSummary } from './window-stats.js';

/**
 * W1 机制门禁 G-A/G-B/G-C/G-D 判定逻辑（`2026-11-03-p15-w0-w1-handoff.md` §4.1）。
 *
 * 门禁是**机制筛查**（07 §6.1 探索层），不是 G1.5 聚类判定；判据是 handoff 冻结的
 * 常量，登记在 `GATE_CRITERIA`，不得在脚本里散落字面量或事后调整。
 * I/O（跑批、读写 out/）在 `scripts/p15-gates.mjs`；本模块保持纯函数可测。
 */

/** 门禁判据（diagnosis §5，2026-11-04 按 07 §8.1 修订程序重推定，见 D-10；新旧口径同报）。 */
export const GATE_CRITERIA = Object.freeze({
  /** G-A：baseline 30 种子均值 P0(w3) 下限（2026-11-03 原口径，不变）。 */
  p0MeanMin: 0.15,
  /**
   * G-A 净流量上界（2026-11-04 D-10 重推定，替代原 `mUpMeanMax=0.6`）：
   * 原「mUp≤0.60 扶梯降速」针对的病理是**单向抽空**（v5：mUp 0.95 且 P0→0）；
   * 位移准入引入 1:1 零和环流后，毛流量不再度量该病理（环流下 mUp≈mDown≈0.95
   * 而底层为储水池）。改用净流量 `mean(|mUp−mDown|) ≤ 0.10` 直接度量单向性：
   * 病理量级 0.92（v5），健康环流 ≈0.001，阈值取低一个数量级。
   */
  netFlowMax: 0.1,
  /**
   * G-B 响应面判据（2026-11-04 D-10 重推定）：≥2 个相邻参数档位间 ‖ΔP‖₁ ≥ 0.10。
   * 原「P4 极差 ≥0.40」子句废弃为描述性报告：1:1 位移把顶层占比结构性钉死
   *（v8 全网格 P4 极差 0.0065 而 8/10 对 ‖ΔP‖₁≥0.10——形状响应移至中产轴），
   * 该子句在任何 1:1 位移变体下不可满足。
   */
  pL1PairMin: 0.1,
  /** G-B：达到 ‖ΔP‖₁ 门槛的相邻档位对数量下限。 */
  minDistinctPairs: 2,
  /** G-C：‖P(w2b)−P(w3)‖₁ 均值上限（吸引子平稳性，不变）。 */
  w2bW3L1Max: 0.1,
} as const);

/** 门禁种子集：探索层沿用冻结的 p15-seed 列表；确认轮种子（D-07）另行预注册，不在此复用。 */
export const GATE_SEEDS: readonly string[] = Array.from(
  { length: 30 },
  (_, index) => `p15-seed-${String(index + 1).padStart(3, '0')}`,
);

/** 单 run 的门禁输入：同一 run 的 w2b/w3 窗口摘要。 */
export interface GateRunWindows {
  readonly seed: string;
  readonly w2b: WindowSummary;
  readonly w3: WindowSummary;
}

export interface GateAResult {
  readonly gate: 'A';
  readonly passed: boolean;
  readonly seedCount: number;
  readonly extinctCount: number;
  readonly p0Mean: number;
  /** 毛流量（原口径 mUpMeanMax=0.6 的输入，D-10 起仅报告不判定）。 */
  readonly mUpMean: number;
  /** 判定量（D-10）：净流量 mean(|mUp−mDown|)。 */
  readonly netFlowMean: number;
  readonly criteria: { readonly p0MeanMin: number; readonly netFlowMax: number };
  readonly detail: string;
}

/**
 * G-A（D-10 修订口径）：baseline 30 种子均值 `P0(w3) ≥ 0.15` 且净流量
 * `mean(|mUp−mDown|) ≤ 0.10`（无单向抽空；原 mUp≤0.60 口径同报不判定）。
 * 全灭 run（07 §5 排除规则）不计入均值但必须报告——全灭比例过高本身就是未通过信号。
 */
export function evaluateGateA(runs: readonly GateRunWindows[], classIndex = 0): GateAResult {
  const criteria = { p0MeanMin: GATE_CRITERIA.p0MeanMin, netFlowMax: GATE_CRITERIA.netFlowMax };
  const available = runs.filter((run) => run.w3.missingTicks === 0 && !run.w3.networkEmpty);
  const extinct = runs.length - available.length;
  if (available.length === 0) {
    return {
      gate: 'A',
      passed: false,
      seedCount: runs.length,
      extinctCount: extinct,
      p0Mean: Number.NaN,
      mUpMean: Number.NaN,
      netFlowMean: Number.NaN,
      criteria,
      detail: '无可用 w3 窗口',
    };
  }
  const p0Mean = mean(available.map((run) => run.w3.classShares[classIndex] ?? 0));
  const mUpMean = mean(available.map((run) => run.w3.mUp));
  const netFlowMean = mean(available.map((run) => Math.abs(run.w3.mUp - run.w3.mDown)));
  const passed = p0Mean >= criteria.p0MeanMin && netFlowMean <= criteria.netFlowMax;
  return {
    gate: 'A',
    passed,
    seedCount: runs.length,
    extinctCount: extinct,
    p0Mean,
    mUpMean,
    netFlowMean,
    criteria,
    detail: `P0(w3)=${round(p0Mean)} 净流量=${round(netFlowMean)}（毛 mUp=${round(mUpMean)}，${available.length}/${runs.length} 可用）`,
  };
}

export interface GateCResult {
  readonly gate: 'C';
  readonly passed: boolean;
  readonly seedCount: number;
  readonly l1Mean: number;
  readonly l1Max: number;
  readonly criteria: { readonly w2bW3L1Max: number };
  readonly detail: string;
}

/**
 * G-C：`‖P(w2b)−P(w3)‖₁ < 0.10`（均值）。窗口间分布漂移过大说明 burn-in 不足
 * 或极限环；handoff §8 要求此时报告轨迹而不是调参。
 */
export function evaluateGateC(runs: readonly GateRunWindows[]): GateCResult {
  const criteria = { w2bW3L1Max: GATE_CRITERIA.w2bW3L1Max };
  const available = runs.filter((run) => run.w2b.missingTicks === 0 && run.w3.missingTicks === 0);
  if (available.length === 0) {
    return {
      gate: 'C',
      passed: false,
      seedCount: runs.length,
      l1Mean: Number.NaN,
      l1Max: Number.NaN,
      criteria,
      detail: '无可用 w2b/w3 窗口对',
    };
  }
  const distances = available.map((run) => l1(run.w2b.classShares, run.w3.classShares));
  const l1Mean = mean(distances);
  const l1Max = Math.max(...distances);
  const passed = l1Mean < criteria.w2bW3L1Max;
  return {
    gate: 'C',
    passed,
    seedCount: runs.length,
    l1Mean,
    l1Max,
    criteria,
    detail: `‖P(w2b)−P(w3)‖₁ mean=${round(l1Mean)} max=${round(l1Max)}`,
  };
}

/** G-B 输入：单个参数档位（cell）的 P 向量均值。 */
export interface GateBLevel {
  readonly cellKey: string;
  readonly parameter: string;
  readonly levelIndex: number;
  readonly classSharesMean: readonly number[];
}

export interface GateBPair {
  readonly parameter: string;
  readonly fromLevel: number;
  readonly toLevel: number;
  readonly l1: number;
}

export interface GateBResult {
  readonly gate: 'B';
  readonly passed: boolean;
  /** 描述性报告（D-10 起不判定）：顶层占比在网格上的极差（1:1 位移下结构性钉死）。 */
  readonly p4Range: number;
  readonly distinctPairs: GateBPair[];
  readonly criteria: {
    readonly pL1PairMin: number;
    readonly minDistinctPairs: number;
  };
  readonly detail: string;
}

/**
 * G-B（D-10 修订口径）：形状可被参数拉开——至少 2 个相邻参数档位间
 * `‖ΔP‖₁ ≥ 0.10`。相邻档位（level0↔level1、level1↔level2）而非极值对：
 * 极值对达标可能只是两个端点各自塌缩。
 * 原「P4 极差 ≥0.40」子句（handoff §4.1）废弃为描述性报告：1:1 位移把顶层
 * 占比结构性钉死，P4 轴在任何位移变体下都不可张开（0009/0010 实测）。
 */
export function evaluateGateB(levels: readonly GateBLevel[]): GateBResult {
  const criteria = {
    pL1PairMin: GATE_CRITERIA.pL1PairMin,
    minDistinctPairs: GATE_CRITERIA.minDistinctPairs,
  };
  if (levels.length === 0) {
    return {
      gate: 'B',
      passed: false,
      p4Range: Number.NaN,
      distinctPairs: [],
      criteria,
      detail: '无参数档位',
    };
  }
  const topIndex = Math.max(...levels.map((level) => level.classSharesMean.length - 1));
  const p4Values = levels.map((level) => level.classSharesMean[topIndex] ?? 0);
  const p4Range = Math.max(...p4Values) - Math.min(...p4Values);
  const byParameter = new Map<string, GateBLevel[]>();
  for (const level of levels) {
    const bucket = byParameter.get(level.parameter) ?? [];
    bucket.push(level);
    byParameter.set(level.parameter, bucket);
  }
  const distinctPairs: GateBPair[] = [];
  for (const [parameter, bucket] of byParameter) {
    const sorted = [...bucket].sort((a, b) => a.levelIndex - b.levelIndex);
    for (let i = 1; i < sorted.length; i += 1) {
      // sorted 只含本桶元素，i-1/i 必在界内（noUncheckedIndexedAccess 需要显式断言）。
      const from = sorted[i - 1] as GateBLevel;
      const to = sorted[i] as GateBLevel;
      const l1Distance = l1(from.classSharesMean, to.classSharesMean);
      if (l1Distance >= criteria.pL1PairMin) {
        distinctPairs.push({
          parameter,
          fromLevel: from.levelIndex,
          toLevel: to.levelIndex,
          l1: l1Distance,
        });
      }
    }
  }
  const passed = distinctPairs.length >= criteria.minDistinctPairs;
  return {
    gate: 'B',
    passed,
    p4Range,
    distinctPairs,
    criteria,
    detail: `P4 极差=${round(p4Range)}，‖ΔP‖₁≥0.10 的相邻档位对 ${distinctPairs.length} 个`,
  };
}

export interface GateDComparison {
  readonly seed: string;
  readonly equal: boolean;
  /** 首个不一致路径；equal 为 true 时为 null。 */
  readonly firstDifference: string | null;
  readonly refIncomeHeldInitial: boolean;
}

export interface GateDResult {
  readonly gate: 'D';
  readonly passed: boolean;
  readonly comparisons: readonly GateDComparison[];
  readonly classRoundTrip: boolean;
  readonly detail: string;
}

/**
 * G-D：own 模式与 rules-v5 **逐位一致**（语义状态全字段）。
 *
 * 对照口径（changes/0008 §G-D 实现说明）：state-v2/config-v3 增补字段与
 * paramsHash 注册表增长使序列化信封不可跨版本比较，因此比较**语义状态**：
 * agents 全字段 + society 除 refIncome 外全部字段（含 flowWindow），
 * 浮点按 Object.is 逐位比较；refIncome 另行断言保持初始值。
 */
export function compareSemanticState(
  // 双侧都是结构化 plain object：actual 通常为 encodeSimState(state).society，
  // reference 为任意版本 fixture JSON 的 society 段（v5 形状无 refIncome）。
  // 比较只看语义字段，故不绑定具体 schema 类型。
  actual: Record<string, unknown>,
  reference: Record<string, unknown>,
): { readonly equal: boolean; readonly firstDifference: string | null } {
  const actualWithoutRef: Record<string, unknown> = { ...actual };
  delete actualWithoutRef['refIncome'];
  return deepCompare(actualWithoutRef, reference, '$');
}

export function evaluateGateD(
  comparisons: readonly GateDComparison[],
  classRoundTrip: boolean,
): GateDResult {
  const allEqual = comparisons.every((comparison) => comparison.equal) && classRoundTrip;
  const firstBad = comparisons.find((comparison) => !comparison.equal);
  return {
    gate: 'D',
    passed: allEqual,
    comparisons,
    classRoundTrip,
    detail:
      firstBad === undefined
        ? 'own 模式全部种子逐位一致'
        : `首个不一致: ${firstBad.seed} @ ${String(firstBad.firstDifference)}`,
  };
}

function deepCompare(
  actual: unknown,
  reference: unknown,
  path: string,
): { readonly equal: boolean; readonly firstDifference: string | null } {
  if (actual === reference) {
    return { equal: true, firstDifference: null };
  }
  if (typeof actual === 'number' && typeof reference === 'number') {
    // NaN 视为相等（本比较只关心数值路径是否被扰动）；其余按位比较。
    if (Number.isNaN(actual) && Number.isNaN(reference)) {
      return { equal: true, firstDifference: null };
    }
    return {
      equal: false,
      firstDifference: `${path} (${String(actual)} !== ${String(reference)})`,
    };
  }
  if (Array.isArray(actual) && Array.isArray(reference)) {
    if (actual.length !== reference.length) {
      return {
        equal: false,
        firstDifference: `${path}.length (${actual.length} !== ${reference.length})`,
      };
    }
    for (let i = 0; i < actual.length; i += 1) {
      const result = deepCompare(actual[i], reference[i], `${path}[${i}]`);
      if (!result.equal) {
        return result;
      }
    }
    return { equal: true, firstDifference: null };
  }
  if (isPlainObject(actual) && isPlainObject(reference)) {
    const actualKeys = Object.keys(actual).sort();
    const referenceKeys = Object.keys(reference).sort();
    if (actualKeys.length !== referenceKeys.length) {
      return {
        equal: false,
        firstDifference: `${path}.keys (${actualKeys.join(',')} !== ${referenceKeys.join(',')})`,
      };
    }
    for (const key of actualKeys) {
      if (!(key in reference)) {
        return { equal: false, firstDifference: `${path}.${key} (missing in reference)` };
      }
      const result = deepCompare(actual[key], reference[key], `${path}.${key}`);
      if (!result.equal) {
        return result;
      }
    }
    return { equal: true, firstDifference: null };
  }
  return {
    equal: false,
    firstDifference: `${path} (${JSON.stringify(actual)} !== ${JSON.stringify(reference)})`,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mean(values: readonly number[]): number {
  // 调用方必须保证非空（evaluateGateA/C 先行过滤并对空集提前返回）。
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function l1(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`L1 输入长度不一致: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return sum;
}

function round(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : String(value);
}

import { computeConfigHash, computeParamsHash } from '../core/config/hash.js';
import { errorCodes, StratifyError } from '../core/control/errors.js';
import { asSeed, type Seed } from '../core/control/ids.js';
import { ENGINE_VERSION } from '../core/control/versions.js';
import { computeAuthoritativeStateHash } from '../core/hash/state-hash.js';
import { cloneSimState } from '../core/model/serialize.js';
import type { SimState } from '../core/model/state.js';
import { captureSnapshot, restoreSnapshot } from '../core/replay/snapshot.js';
import type { RunConfig } from '../core/config/types.js';
import type { TickStats } from '../core/macros/tick-metrics.js';
import { RUN_CONFIG_TOP_LEVEL_KEYS } from './batch.js';
import { runSingle, type RunOptions, type RunOutcome, type RunWindowReport } from './run-cell.js';

/**
 * P5-04：微扰任务生成与配对执行入口（01 §8.1、07 §7）。
 *
 * - 配对种子/共同随机数：baseline 与 treatment 同 seed、同检查点克隆，
 *   RNG 为 `R(seed,tick,agentId,tag,counter)` 无状态寻址，除声明变量外所有输入一致；
 * - 「实验只改变声明变量」由审计强制：param 扰动用叶子路径 diff 证明配置只改了
 *   声明字段；wealth 扰动只给存活者 `value` 加绝对 ΔValue；
 * - 07 §7.4：扰动小于序列化精度（round-trip 后 hash 不变）→ `applied=false`，
 *   标记 invalid，不得报告为「无敏感性」；
 * - 首次偏离：逐 tick 对比两侧 stats 行，`firstDivergenceTick` 是第一条不同的
 *   stats 行的 tick（null = 全程一致）；事件级翻转分析属 P6-03 实验层。
 */

/** 07 §7 微扰声明：param 为配置字段相对扰动（value ×(1+δ)）；wealth_absolute 为全员绝对 ΔValue。 */
export type DeclaredPerturbation =
  | { readonly kind: 'param'; readonly field: string; readonly delta: number }
  | { readonly kind: 'wealth_absolute'; readonly delta: number };

export interface PerturbationPairOptions {
  readonly policy: 'mock-weighted-v1' | 'random-uniform-v1';
  /** 预注册检查点 tick（07 §7.1 默认 burn-in 后 365；此处必须显式声明）。 */
  readonly checkpointTick: number;
  readonly declared: DeclaredPerturbation;
  /** 单段护栏（透传 `runSingle.maxTicks`）。 */
  readonly maxTicks?: number;
}

export interface PerturbationSideReport {
  readonly finalStateHash: string;
  readonly aliveAtEnd: number;
  readonly report: RunWindowReport;
}

export interface PerturbationPairOutcome {
  readonly seed: Seed;
  readonly checkpointTick: number;
  /** 克隆前的权威状态哈希；两侧都从此状态克隆（07 §7.2）。 */
  readonly checkpointStateHash: string;
  readonly declared: DeclaredPerturbation;
  readonly baseline: PerturbationSideReport;
  /** `null` = 扰动未生效（07 §7.4 invalid），不产出 treatment 侧结论。 */
  readonly treatment: PerturbationSideReport | null;
  /** 第一条不同的 stats 行的 tick；两侧全程一致为 null。 */
  readonly firstDivergenceTick: number | null;
  /** 07 §7.4：true = 扰动被序列化精度吸收，该对无效。 */
  readonly invalid: boolean;
  readonly invalidReason: string | null;
}

/** 叶子路径 diff：返回两棵纯 JSON 树中所有不同的点路径（数组按 `[i]` 展开）。 */
export function diffLeafPaths(baseline: unknown, treatment: unknown, prefix = ''): string[] {
  if (Array.isArray(baseline) && Array.isArray(treatment)) {
    const paths: string[] = [];
    if (baseline.length !== treatment.length) {
      return [prefix || '(root)'];
    }
    for (let index = 0; index < baseline.length; index += 1) {
      paths.push(...diffLeafPaths(baseline[index], treatment[index], `${prefix}[${index}]`));
    }
    return paths;
  }
  if (
    baseline !== null &&
    treatment !== null &&
    typeof baseline === 'object' &&
    typeof treatment === 'object'
  ) {
    const paths: string[] = [];
    const keys = new Set([
      ...Object.keys(baseline as Record<string, unknown>),
      ...Object.keys(treatment as Record<string, unknown>),
    ]);
    for (const key of keys) {
      paths.push(
        ...diffLeafPaths(
          (baseline as Record<string, unknown>)[key],
          (treatment as Record<string, unknown>)[key],
          prefix.length === 0 ? key : `${prefix}.${key}`,
        ),
      );
    }
    return paths;
  }
  if (Object.is(baseline, treatment)) {
    return [];
  }
  return [prefix || '(root)'];
}

function resolveNumericField(config: RunConfig, field: string): number {
  const segments = field.split('.');
  if (segments.length < 2) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `param 扰动 field 必须为「顶层键.子路径」形式: ${field}`,
    );
  }
  const topKey = segments[0] as string;
  if (!RUN_CONFIG_TOP_LEVEL_KEYS.has(topKey)) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `param 扰动 field 含未登记的 RunConfig 顶层键: ${field}`,
    );
  }
  if (topKey === 'population') {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `param 扰动不得指向 population.*（该段只有初始化语义，对检查点之后的续跑无效果）: ${field}`,
    );
  }
  let cursor: unknown = config;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') {
      throw new StratifyError(errorCodes.CONFIG_INVALID, `param 扰动 field 路径不存在: ${field}`);
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor !== 'number' || !Number.isFinite(cursor)) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `param 扰动 field 必须指向有限数字: ${field}`,
    );
  }
  return cursor;
}

/** 叶子值替换：按 diffLeafPaths 的同一路径约定写回纯对象树。 */
function setLeafPath(target: Record<string, unknown>, path: string, value: number): void {
  const segments = path.split('.');
  let cursor: unknown = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const match = /^\[(\d+)\]$/.exec(segment);
    if (match !== null) {
      cursor = (cursor as unknown[])[Number(match[1])];
      continue;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  const last = segments[segments.length - 1] as string;
  const lastMatch = /^\[(\d+)\]$/.exec(last);
  if (lastMatch !== null) {
    (cursor as unknown[])[Number(lastMatch[1])] = value;
    return;
  }
  (cursor as Record<string, unknown>)[last] = value;
}

export interface ParamPerturbationResult {
  readonly treatment: RunConfig;
  readonly baselineValue: number;
  readonly treatmentValue: number;
  /** 07 §7.4：round-trip 后 configHash 未变化 = 扰动未生效。 */
  readonly applied: boolean;
  /** 审计：实际变化的叶子路径（应恰为声明 field）。 */
  readonly changedPaths: readonly string[];
}

/** 参数相对扰动：`value × (1+δ)`（07 §7.3）；δ 直接给定，由预注册层冻结。 */
export function applyParamPerturbation(
  config: RunConfig,
  field: string,
  delta: number,
): ParamPerturbationResult {
  if (!Number.isFinite(delta) || delta === 0) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'param 扰动 delta 必须为非零有限数');
  }
  const baselineValue = resolveNumericField(config, field);
  const treatmentValue = baselineValue * (1 + delta);
  const treatment = structuredClone(config) as RunConfig;
  setLeafPath(treatment as unknown as Record<string, unknown>, field, treatmentValue);
  const changedPaths = diffLeafPaths(config, treatment);
  return {
    treatment,
    baselineValue,
    treatmentValue,
    applied: computeConfigHash(config) !== computeConfigHash(treatment),
    changedPaths,
  };
}

export interface WealthPerturbationResult {
  readonly treatment: SimState;
  /** 07 §7.4：round-trip 后权威哈希未变化 = 扰动被精度吸收。 */
  readonly applied: boolean;
  /** 审计：受影响的存活者人数。 */
  readonly affectedAgents: number;
}

/** 财富绝对扰动：每个存活者 `value += ΔValue`（Value=0 也加，07 §7.3）。 */
export function applyWealthPerturbation(state: SimState, delta: number): WealthPerturbationResult {
  if (!Number.isFinite(delta) || delta === 0) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      'wealth_absolute 扰动 delta 必须为非零有限数',
    );
  }
  const treatment = cloneSimState(state);
  let affectedAgents = 0;
  for (const agent of treatment.society.agents) {
    if (!agent.alive) {
      continue;
    }
    agent.value += delta;
    affectedAgents += 1;
  }
  const applied = computeAuthoritativeStateHash(treatment) !== computeAuthoritativeStateHash(state);
  return { treatment, applied, affectedAgents };
}

function firstDivergenceTick(
  baselineStats: readonly TickStats[],
  treatmentStats: readonly TickStats[],
): number | null {
  const limit = Math.min(baselineStats.length, treatmentStats.length);
  for (let index = 0; index < limit; index += 1) {
    const baselineRow = JSON.stringify(baselineStats[index]);
    const treatmentRow = JSON.stringify(treatmentStats[index]);
    if (baselineRow !== treatmentRow) {
      return baselineStats[index]?.tick ?? null;
    }
  }
  return null;
}

function sideReport(outcome: RunOutcome): PerturbationSideReport {
  return {
    finalStateHash: outcome.report.finalStateHash,
    aliveAtEnd: outcome.report.aliveAtEnd,
    report: outcome.report,
  };
}

/**
 * 运行一对微扰对照（07 §7.1–7.4）：
 * 1. baseline 跑到检查点 tick，取权威快照与哈希；
 * 2. 两侧从同一快照克隆（hash 一致性由构造保证：同一 `restoreSnapshot` 结果）；
 * 3. treatment 仅施加声明扰动（param 换配置树；wealth 加 ΔValue）；
 * 4. 两侧各自续跑到结束，产出配对报告与首次偏离 tick。
 */
export function runPerturbationPair(
  config: RunConfig,
  seed: string,
  options: PerturbationPairOptions,
): PerturbationPairOutcome {
  const validatedSeed = asSeed(seed);
  const { checkpointTick } = options;
  if (
    !Number.isInteger(checkpointTick) ||
    checkpointTick < 1 ||
    checkpointTick >= config.schedule.totalTicks
  ) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `checkpointTick 必须为 [1, totalTicks-1] 内的整数，收到 ${checkpointTick}`,
    );
  }
  const runOptions: RunOptions = {
    policy: options.policy,
    ...(options.maxTicks !== undefined ? { maxTicks: options.maxTicks } : {}),
  };

  const checkpointOutcome = runSingle(config, validatedSeed, {
    ...runOptions,
    maxTicks: checkpointTick,
  });
  const checkpointState = checkpointOutcome.finalState;
  const checkpointStateHash = computeAuthoritativeStateHash(checkpointState);
  const snapshot = captureSnapshot(checkpointState);

  const baselineOutcome = runSingle(config, validatedSeed, {
    ...runOptions,
    initialState: restoreSnapshot(snapshot),
  });

  // treatment 侧准备：只施加声明扰动；未生效（07 §7.4）则标记 invalid 并跳过 treatment。
  const prepareTreatment = ():
    { state: SimState; config: RunConfig } | { invalid: true; reason: string } => {
    if (options.declared.kind === 'param') {
      const result = applyParamPerturbation(config, options.declared.field, options.declared.delta);
      if (result.changedPaths.length !== 1 || result.changedPaths[0] !== options.declared.field) {
        throw new StratifyError(
          errorCodes.INVARIANT_VIOLATED,
          `param 扰动实际改变了 ${result.changedPaths.length} 个叶子路径（${result.changedPaths.join(', ')}），与声明 ${options.declared.field} 不符`,
        );
      }
      if (!result.applied) {
        return {
          invalid: true,
          reason: 'param 扰动被序列化精度吸收（round-trip 后 configHash 不变，07 §7.4）',
        };
      }
      const treatmentConfig = result.treatment;
      const restored = restoreSnapshot(snapshot);
      const state: SimState = {
        ...restored,
        config: treatmentConfig,
        configHash: computeConfigHash(treatmentConfig),
        paramsHash: computeParamsHash(treatmentConfig),
      };
      return { state, config: treatmentConfig };
    }
    const result = applyWealthPerturbation(restoreSnapshot(snapshot), options.declared.delta);
    if (!result.applied) {
      return {
        invalid: true,
        reason: 'wealth_absolute 扰动被序列化精度吸收（round-trip 后权威哈希不变，07 §7.4）',
      };
    }
    return { state: result.treatment, config };
  };

  const prepared = prepareTreatment();
  if ('invalid' in prepared) {
    return {
      seed: validatedSeed,
      checkpointTick,
      checkpointStateHash,
      declared: options.declared,
      baseline: sideReport(baselineOutcome),
      treatment: null,
      firstDivergenceTick: null,
      invalid: true,
      invalidReason: prepared.reason,
    };
  }

  const treatmentOutcome = runSingle(prepared.config, validatedSeed, {
    ...runOptions,
    initialState: prepared.state,
  });

  return {
    seed: validatedSeed,
    checkpointTick,
    checkpointStateHash,
    declared: options.declared,
    baseline: sideReport(baselineOutcome),
    treatment: sideReport(treatmentOutcome),
    firstDivergenceTick: firstDivergenceTick(baselineOutcome.stats, treatmentOutcome.stats),
    invalid: false,
    invalidReason: null,
  };
}

export interface PerturbationTaskSpec {
  readonly seed: string;
  readonly declared: DeclaredPerturbation;
}

export interface PerturbationBatchSummary {
  readonly schemaVersion: 'perturbation-summary-v1';
  readonly rulesVersion: string;
  readonly engineVersion: string;
  readonly policy: 'mock-weighted-v1' | 'random-uniform-v1';
  readonly checkpointTick: number;
  readonly tasks: readonly PerturbationTaskSpec[];
  readonly pairs: readonly PerturbationPairOutcome[];
  readonly totals: {
    readonly due: number;
    readonly ok: number;
    readonly invalid: number;
  };
}

/** 机器可读摘要的批处理入口：任务列表 → 配对结果（实验只改变声明变量，逐对可审计）。 */
export function runPerturbationBatch(
  config: RunConfig,
  tasks: readonly PerturbationTaskSpec[],
  options: {
    policy: 'mock-weighted-v1' | 'random-uniform-v1';
    checkpointTick: number;
    maxTicks?: number;
  },
): PerturbationBatchSummary {
  if (tasks.length === 0) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, '微扰任务列表不得为空');
  }
  const pairs = tasks.map((task) => {
    const pairOptions: PerturbationPairOptions = {
      policy: options.policy,
      checkpointTick: options.checkpointTick,
      declared: task.declared,
      ...(options.maxTicks !== undefined ? { maxTicks: options.maxTicks } : {}),
    };
    return runPerturbationPair(config, task.seed, pairOptions);
  });
  return {
    schemaVersion: 'perturbation-summary-v1',
    rulesVersion: config.rulesVersion,
    engineVersion: ENGINE_VERSION,
    policy: options.policy,
    checkpointTick: options.checkpointTick,
    tasks,
    pairs,
    totals: {
      due: tasks.length,
      ok: pairs.filter((pair) => !pair.invalid).length,
      invalid: pairs.filter((pair) => pair.invalid).length,
    },
  };
}

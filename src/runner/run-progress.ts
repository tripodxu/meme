import { errorCodes, StratifyError } from '../core/control/errors.js';
import type { TickStats } from '../core/macros/tick-metrics.js';
import { captureSnapshot, restoreSnapshot, type Snapshot } from '../core/replay/snapshot.js';
import type { SimState } from '../core/model/state.js';
import type { RunConfig } from '../core/config/types.js';
import { computeConfigHash } from '../core/config/hash.js';
import type { SyncCheckpointHost } from './checkpoint.js';

/**
 * P5-03：run 内进度检查点（`run-progress-v1`）。
 *
 * 与 `checkpoint-v1`（纯状态快照，P5a-03 基础件）的区别：除引擎状态外还携带
 * 部分窗口累计器（全分辨率 stats、逐 tick 转移矩阵、逐 tick 决策计数），
 * 使 kill 后恢复的 run 能产出与不中断运行**逐字一致**的窗口聚合与标签
 * （07 §5 唯一算法依赖全程 tick 数据，只有快照无法重算前段窗口）。
 *
 * 语义：
 * - 原子性与 `CheckpointHost` 相同：临时文件 + rename，`.tmp` 残留不是有效点；
 * - `meta` 校验 cellKey/seed/configHash，跨 run 污染一律拒绝；
 * - **损坏的进度检查点按不存在处理**（调用方从 tick 0 重跑即可，确定性保证结果一致），
 *   它只是 kill 恢复的加速件，不是事实来源；事实来源是重跑本身。
 */

export interface RunProgressMeta {
  readonly cellKey: string;
  readonly seed: string;
  readonly configHash: string;
  readonly tickCompleted: number;
  readonly savedAtSequence: number;
}

export interface RunProgressPayload {
  readonly schemaVersion: 'run-progress-v1';
  readonly meta: RunProgressMeta;
  readonly snapshot: Snapshot;
  readonly progress: {
    readonly stats: readonly TickStats[];
    readonly flows: readonly {
      readonly tick: number;
      readonly matrix: readonly (readonly number[])[];
    }[];
    readonly decisions: readonly {
      readonly tick: number;
      readonly due: number;
      readonly fallbacks: number;
    }[];
  };
}

export interface RunProgressExpectation {
  readonly cellKey?: string;
  readonly seed?: string;
  readonly configHash?: string;
  readonly minTickCompleted?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildRunProgressPayload(
  meta: RunProgressMeta,
  state: SimState,
  progress: RunProgressPayload['progress'],
): RunProgressPayload {
  return {
    schemaVersion: 'run-progress-v1',
    meta,
    snapshot: captureSnapshot(state),
    progress,
  };
}

/**
 * 原子写进度检查点：先写 `<path>.tmp` 再 promote；写临时文件失败不影响主点。
 */
export function saveRunProgress(
  host: SyncCheckpointHost,
  path: string,
  payload: RunProgressPayload,
): void {
  const tempPath = `${path}.tmp`;
  host.writeTemp(tempPath, JSON.stringify(payload));
  host.promote(tempPath, path);
}

function parseProgress(
  value: unknown,
  tickCompleted: number,
  path: string,
): RunProgressPayload['progress'] {
  if (!isPlainObject(value)) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, `进度检查点 progress 必须是对象: ${path}`);
  }
  const stats = value['stats'];
  const flows = value['flows'];
  const decisions = value['decisions'];
  if (!Array.isArray(stats) || !Array.isArray(flows) || !Array.isArray(decisions)) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, `进度检查点 progress 字段不完整: ${path}`);
  }
  // 覆盖校验：三组累计器都必须恰好覆盖 0..tickCompleted-1。只校验形状会让
  // 截断的检查点（例如 5000 tick 只带 10 行 stats）静默恢复，窗口均值与不中断运行不一致。
  const assertExactTicks = (label: string, entries: readonly unknown[]): void => {
    if (entries.length !== tickCompleted) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `进度检查点 ${label} 条数(${entries.length})必须等于 tickCompleted(${tickCompleted}): ${path}`,
      );
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!isPlainObject(entry) || entry['tick'] !== index) {
        throw new StratifyError(
          errorCodes.CONFIG_INVALID,
          `进度检查点 ${label}[${index}].tick 必须为 ${index}: ${path}`,
        );
      }
    }
  };
  assertExactTicks('stats', stats);
  for (const [index, row] of stats.entries()) {
    if (!isPlainObject(row)) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `进度检查点 stats[${index}] 必须是对象: ${path}`,
      );
    }
  }
  assertExactTicks('flows', flows);
  for (const [index, entry] of flows.entries()) {
    if (!isPlainObject(entry) || !Array.isArray(entry['matrix'])) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `进度检查点 flows[${index}] 必须是 {tick,matrix} 对象: ${path}`,
      );
    }
  }
  assertExactTicks('decisions', decisions);
  for (const [index, entry] of decisions.entries()) {
    if (!isPlainObject(entry)) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `进度检查点 decisions[${index}] 必须是对象: ${path}`,
      );
    }
    if (typeof entry['due'] !== 'number' || typeof entry['fallbacks'] !== 'number') {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `进度检查点 decisions[${index}] 的 due/fallbacks 必须是数字: ${path}`,
      );
    }
  }
  return value as unknown as RunProgressPayload['progress'];
}

/** 解析与结构校验；只抛「损坏」类错误（期望不匹配在 loadRunProgress 单独判定）。 */
function parseRunProgressValue(
  value: unknown,
  path: string,
): {
  meta: RunProgressMeta;
  state: SimState;
  progress: RunProgressPayload['progress'];
} {
  if (!isPlainObject(value) || value['schemaVersion'] !== 'run-progress-v1') {
    throw new StratifyError(errorCodes.CONFIG_PATH, `未知进度检查点版本: ${path}`);
  }
  const metaValue = value['meta'];
  if (!isPlainObject(metaValue)) {
    throw new StratifyError(errorCodes.CONFIG_PATH, `进度检查点 meta 缺失: ${path}`);
  }
  const tickCompleted = metaValue['tickCompleted'];
  if (typeof tickCompleted !== 'number' || !Number.isInteger(tickCompleted) || tickCompleted < 0) {
    throw new StratifyError(errorCodes.CONFIG_PATH, `进度检查点 meta.tickCompleted 非法: ${path}`);
  }
  const state = restoreSnapshot(value['snapshot']);
  if (state.society.tick !== tickCompleted) {
    throw new StratifyError(
      errorCodes.CONFIG_PATH,
      `进度检查点 tickCompleted(${tickCompleted}) 与快照 tick(${state.society.tick}) 不一致: ${path}`,
    );
  }
  return {
    meta: {
      cellKey: String(metaValue['cellKey'] ?? ''),
      seed: String(metaValue['seed'] ?? ''),
      configHash: String(metaValue['configHash'] ?? ''),
      tickCompleted,
      savedAtSequence:
        typeof metaValue['savedAtSequence'] === 'number' ? metaValue['savedAtSequence'] : 0,
    },
    state,
    progress: parseProgress(value['progress'], tickCompleted, path),
  };
}

function parseRunProgress(
  raw: string,
  path: string,
): {
  meta: RunProgressMeta;
  state: SimState;
  progress: RunProgressPayload['progress'];
} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new StratifyError(errorCodes.CONFIG_PATH, `进度检查点 JSON 损坏: ${path}`);
  }
  return parseRunProgressValue(value, path);
}

function assertProgressExpectation(
  meta: RunProgressMeta,
  expectation: RunProgressExpectation,
  path: string,
): void {
  if (expectation.cellKey !== undefined && meta.cellKey !== expectation.cellKey) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `进度检查点 cellKey 不匹配: 期望 ${expectation.cellKey}，实际 ${meta.cellKey}（${path}）`,
    );
  }
  if (expectation.seed !== undefined && meta.seed !== expectation.seed) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `进度检查点 seed 不匹配: 期望 ${expectation.seed}，实际 ${meta.seed}（${path}）`,
    );
  }
  if (expectation.configHash !== undefined && meta.configHash !== expectation.configHash) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `进度检查点 configHash 不匹配: 期望 ${expectation.configHash}，实际 ${meta.configHash}（${path}）`,
    );
  }
  if (
    expectation.minTickCompleted !== undefined &&
    meta.tickCompleted < expectation.minTickCompleted
  ) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `进度检查点 tickCompleted 不足: 期望 >=${expectation.minTickCompleted}，实际 ${meta.tickCompleted}（${path}）`,
    );
  }
}

/**
 * 加载进度检查点。
 *
 * - 不存在 → `null`（正常路径，无检查点即从头跑）；
 * - 损坏/版本未知/结构不完整 → `null`（确定性重跑是事实来源，见模块头注释）；
 * - **meta 与期望不匹配 → 抛错**：跨 run 污染是调用方布置错误，必须显式失败，
 *   不得静默换起点。
 */
export function loadRunProgress(
  host: SyncCheckpointHost,
  path: string,
  expectation: RunProgressExpectation,
): { meta: RunProgressMeta; state: SimState; progress: RunProgressPayload['progress'] } | null {
  if (!host.exists(path)) {
    return null;
  }
  const parsed = (() => {
    try {
      return parseRunProgress(host.read(path), path);
    } catch {
      // 损坏（JSON/schema/快照/progress 结构）：按不存在处理，从 tick 0 重跑。
      return null;
    }
  })();
  if (parsed === null) {
    return null;
  }
  assertProgressExpectation(parsed.meta, expectation, path);
  return parsed;
}

/** run 正常完成后移除进度检查点（ledger 才是完成事实）。 */
export function removeRunProgress(host: SyncCheckpointHost, path: string): void {
  host.remove(path);
}

/** 期望值构造：runSingle 调用方统一口径，避免各处手拼 configHash。 */
export function runProgressExpectation(
  cellKey: string,
  seed: string,
  config: RunConfig,
): RunProgressExpectation {
  return { cellKey, seed, configHash: computeConfigHash(config) };
}

import type { TickEvent } from '../core/events.js';
import type { DecisionRecord } from '../decision/types.js';
import type { CheckpointHost } from './checkpoint.js';

/** P2-06：live 决策日志随进度检查点保存（异步路径）；mock 批跑可为空数组。 */
export interface RunProgressPayloadWithDecisions extends RunProgressPayload {
  readonly decisionRecords?: readonly DecisionRecord[];
  /** 决策状态哈希链的 recentEvents（最后 ≤50 条事件）；缺省 = 空起点（mock 语义）。 */
  readonly recentEvents?: readonly TickEvent[];
}

/**
 * 异步变体（P6-04 前置）：`runSingleWithPolicy` 的循环是异步的，可直接 await 宿主写。
 * 语义与同步版完全一致：临时文件 + rename 原子；损坏按不存在处理（确定性重跑）；
 * meta 三元组不匹配抛错（防跨 run 污染）。
 */
export async function saveRunProgressAsync(
  host: CheckpointHost,
  path: string,
  payload: RunProgressPayloadWithDecisions,
): Promise<void> {
  const tempPath = `${path}.tmp`;
  await host.writeTemp(tempPath, JSON.stringify(payload));
  await host.promote(tempPath, path);
}

export async function loadRunProgressAsync(
  host: CheckpointHost,
  path: string,
  expectation: RunProgressExpectation,
): Promise<{
  meta: RunProgressMeta;
  state: SimState;
  progress: RunProgressPayload['progress'];
  decisionRecords: readonly DecisionRecord[];
  recentEvents: readonly TickEvent[];
} | null> {
  if (!(await host.exists(path))) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await host.read(path));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || parsed['schemaVersion'] !== 'run-progress-v1') {
    return null;
  }
  try {
    const result = parseRunProgressValue(parsed, path);
    const decisionRecords = Array.isArray(parsed['decisionRecords'])
      ? (parsed['decisionRecords'] as readonly DecisionRecord[])
      : [];
    const recentEvents = Array.isArray(parsed['recentEvents'])
      ? (parsed['recentEvents'] as readonly TickEvent[])
      : [];
    assertProgressExpectation(result.meta, expectation, path);
    return { ...result, decisionRecords, recentEvents };
  } catch (error) {
    if (
      error instanceof StratifyError &&
      (error.code === errorCodes.CONFIG_INVALID || error.code === errorCodes.CONFIG_UNKNOWN_VERSION)
    ) {
      throw error;
    }
    return null;
  }
}

export async function removeRunProgressAsync(host: CheckpointHost, path: string): Promise<void> {
  await host.remove(path);
}

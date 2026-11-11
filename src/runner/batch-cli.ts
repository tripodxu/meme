import { performance } from 'node:perf_hooks';

import type { RunConfig } from '../core/config/types.js';
import { computeConfigHash } from '../core/config/hash.js';
import { errorCodes, StratifyError } from '../core/control/errors.js';
import { HASH_DOMAINS } from '../core/hash/domains.js';
import { hashValue } from '../core/hash/hash.js';
import { buildBatchTasks, resolveBatchBaseConfig, type BatchManifest } from './batch.js';
import type { CheckpointHost, SyncCheckpointHost } from './checkpoint.js';
import {
  runSingle,
  type RunCheckpointOptions,
  type RunOptions,
  type RunWindowReport,
} from './run-cell.js';

/**
 * P5-01：批量执行器与机器可读摘要（01 §8.1）。
 *
 * - 单实验/矩阵/消融共用同一 manifest 语义（cells × seeds 笛卡尔），校验在 `batch.ts`；
 * - mock/random 批跑不依赖 P2：只走 `runSingle` 同步路径，本模块不 import 决策 HTTP 层；
 * - stdout 与报告分离：本模块只产出数据与进度回调；stdout 输出与报告文件由 CLI 层（`bin/stratify-batch.mjs`）负责；
 * - 断点续跑（G5a）：原子 ledger 逐任务落盘（writeTemp + rename，复用 `CheckpointHost` 语义），
 *   成功 run 与失败事件都即时持久化；kill 后按 `manifestHash` 匹配跳过已完成 run，
 *   恢复后的最终摘要与不中断运行的 `finalStateHash/configHash/paramsHash` 逐字一致
 *   （确定性引擎保证；耗时与 resumed 计数除外）。
 * - 失败保留（07 §3「技术失败必须保留失败原因和次数」）：`failures` 是跨 resume 累积的
 *   全部技术失败事件（`attempt` 为该任务第几次失败，含已被后续重试成功者）；
 *   最终仍未完成的任务数是 `totals.due - totals.ok`，退出码语义以它为准。
 * - 已知取舍：ledger 是单文件全量重写（每次成功/失败后原子替换），I/O 为 O(N²)；
 *   在 P6 Stage B 规模（30 run 级）可忽略；更大规模如成为瓶颈再改追加式 journal（P5-02）。
 * - 单写者假设：同一输出目录不得并发运行两个批跑进程（并发/共享预算属 P5-02）。
 */

export interface BatchProvenance {
  readonly requestedModel: string;
  readonly promptStyle: 'neutral' | 'survival_hint';
  readonly policyVersion: string;
}

export interface BatchRunRecord {
  readonly cellKey: string;
  readonly seed: string;
  readonly configHash: string;
  readonly paramsHash: string;
  readonly report: RunWindowReport;
  readonly elapsedMs: number;
  /** live 批跑的实际策略/模型来源；mock 批跑记录为 mock。旧 ledger 无此字段。 */
  readonly provenance?: BatchProvenance;
}

export interface BatchFailure {
  readonly cellKey: string;
  readonly seed: string;
  readonly code: string;
  readonly error: string;
  /** 该 (cellKey, seed) 第几次技术失败（跨 resume 累计，从 1 起）。 */
  readonly attempt: number;
}

export interface BatchSummary {
  readonly schemaVersion: 'batch-summary-v1';
  readonly manifestHash: string;
  readonly rulesVersion: string;
  readonly engineVersion: string;
  readonly policy: 'mock-weighted-v1' | 'mock-weighted-v2' | 'random-uniform-v1';
  readonly populationSize: number;
  readonly totalTicks: number;
  readonly runs: readonly BatchRunRecord[];
  readonly failures: readonly BatchFailure[];
  readonly totals: {
    readonly due: number;
    readonly ok: number;
    readonly failed: number;
    readonly resumed: number;
    /** 已执行 run 的耗时之和（resumed run 计 0）；不是整批 wall time。 */
    readonly elapsedMs: number;
  };
  /** live 批跑的实际模型/策略来源；mock 批跑缺省无此字段。 */
  readonly liveProvenance?: {
    readonly requestedModel: string;
    readonly promptStyle: 'neutral' | 'survival_hint';
    readonly policyVersions: readonly string[];
  };
  /**
   * P5-02：live 批跑（`runBatchWithPolicy`）且提供共享预算时的用量快照；
   * mock 批跑缺省无此字段。批结束时 `tokensReserved` 必须为 0。
   */
  readonly budgetUsage?: {
    readonly maxCalls: number;
    readonly maxInputTokens: number;
    readonly callsUsed: number;
    readonly tokensSpent: number;
    readonly tokensReserved: number;
    readonly overageDetected: boolean;
    readonly exhausted: boolean;
  };
}

export interface BatchProgress {
  readonly cellKey: string;
  readonly seed: string;
  readonly index: number;
  readonly total: number;
  readonly ok: boolean;
  /** true = 从 ledger 复用的已完成 run（未重算）。 */
  readonly resumed: boolean;
  readonly elapsedMs: number;
}

export interface BatchLedgerOptions {
  /** 原子写宿主与 ledger 路径；提供即启用断点续跑。 */
  readonly host: CheckpointHost;
  readonly path: string;
}

export interface BatchRunCheckpointOptions {
  readonly host: SyncCheckpointHost;
  /** 进度检查点目录（非空）；任务 i 的检查点为 `<dir>/run-<i>.progress.json`。 */
  readonly dir: string;
  /** 每 N 个已完成 tick 落一次；>=1。 */
  readonly everyTicks: number;
}

export interface BatchRunOptions {
  /** 逐 run 完成回调（CLI 层写 stderr；嵌入方可静默）。 */
  readonly onProgress?: (progress: BatchProgress) => void;
  /** 断点续跑 ledger；缺省不落盘（进程内一次性批跑）。 */
  readonly ledger?: BatchLedgerOptions;
  /** 单 run 护栏：单 run 最大 tick 数（透传 `runSingle.maxTicks`）。 */
  readonly maxTicksPerRun?: number;
  /** 故障注入缺口（G5a：kill/磁盘失败后恢复对照）；缺省 `runSingle`。 */
  readonly runSingleImpl?: typeof runSingle;
  /** P5-03：run 内进度检查点（kill 后从 tick 级完整点恢复，窗口聚合逐字一致）。 */
  readonly runCheckpoints?: BatchRunCheckpointOptions;
  /** P6-01：实验级 base config（人口规模校验基准）；缺省 DEFAULT_RUN_CONFIG。 */
  readonly baseConfig?: RunConfig;
}

export interface BatchLedger {
  readonly schemaVersion: 'batch-ledger-v1';
  readonly manifestHash: string;
  /**
   * baseConfig 哈希（P6-01 后的新 ledger 写入）。
   * 旧版 ledger 无此字段时按 legacy 接受；有字段时必须与本次 baseConfig 一致。
   */
  readonly baseConfigHash?: string;
  readonly runs: readonly BatchRunRecord[];
  /** 跨 resume 累积的技术失败事件（07 §3）；旧版无此字段时按 [] 处理。 */
  readonly failures: readonly BatchFailure[];
}

const LEDGER_SCHEMA_VERSION = 'batch-ledger-v1';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** manifestHash 的唯一口径：对已校验 manifest 做 JCS + 域分隔哈希。 */
export function computeBatchManifestHash(manifest: BatchManifest): string {
  return hashValue(HASH_DOMAINS.batchManifest, manifest);
}

function assertRunRecord(value: unknown, index: number): BatchRunRecord {
  if (!isPlainObject(value)) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, `ledger.runs[${index}] 必须是对象`);
  }
  for (const key of ['cellKey', 'seed', 'configHash', 'paramsHash'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `ledger.runs[${index}].${key} 必须为非空字符串`,
      );
    }
  }
  const report = value['report'];
  if (!isPlainObject(report)) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, `ledger.runs[${index}].report 必须是对象`);
  }
  // 深校验摘要消费的字段：只有结构合法、哈希存在的 report 才能作为已完成 run 复用。
  if (typeof report['finalStateHash'] !== 'string' || report['finalStateHash'].length === 0) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `ledger.runs[${index}].report.finalStateHash 必须为非空字符串`,
    );
  }
  for (const key of ['extinct', 'cancelled'] as const) {
    if (typeof report[key] !== 'boolean') {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `ledger.runs[${index}].report.${key} 必须为布尔值`,
      );
    }
  }
  for (const key of ['endTick', 'aliveAtEnd'] as const) {
    const field = report[key];
    if (typeof field !== 'number' || !Number.isFinite(field) || field < 0) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `ledger.runs[${index}].report.${key} 必须为非负有限数字`,
      );
    }
  }
  if (report['endReason'] !== null && typeof report['endReason'] !== 'string') {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `ledger.runs[${index}].report.endReason 必须为字符串或 null`,
    );
  }
  if (!Array.isArray(report['windows'])) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `ledger.runs[${index}].report.windows 必须为数组`,
    );
  }
  if (report['windows'].length === 0) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `ledger.runs[${index}].report.windows 不得为空；完成 run 必须有窗口摘要`,
    );
  }
  for (const [windowIndex, window] of report['windows'].entries()) {
    if (!isPlainObject(window)) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `ledger.runs[${index}].report.windows[${windowIndex}] 必须是对象`,
      );
    }
    if (typeof window['label'] !== 'string' || window['label'].length === 0) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `ledger.runs[${index}].report.windows[${windowIndex}].label 必须为非空字符串`,
      );
    }
    for (const key of ['start', 'end', 'observedTicks', 'missingTicks'] as const) {
      const value = window[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new StratifyError(
          errorCodes.CONFIG_INVALID,
          `ledger.runs[${index}].report.windows[${windowIndex}].${key} 必须为非负有限数字`,
        );
      }
    }
    const classShares = window['classShares'];
    if (
      !Array.isArray(classShares) ||
      classShares.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `ledger.runs[${index}].report.windows[${windowIndex}].classShares 必须为有限数字数组`,
      );
    }
  }
  if (!isPlainObject(report['labelsByWindow'])) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `ledger.runs[${index}].report.labelsByWindow 必须是对象`,
    );
  }
  for (const [label, value] of Object.entries(report['labelsByWindow'])) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `ledger.runs[${index}].report.labelsByWindow.${label} 必须为字符串数组`,
      );
    }
  }
  const provenance = value['provenance'];
  if (provenance !== undefined) {
    if (!isPlainObject(provenance)) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `ledger.runs[${index}].provenance 必须是对象`,
      );
    }
    for (const key of ['requestedModel', 'policyVersion'] as const) {
      if (typeof provenance[key] !== 'string' || provenance[key].length === 0) {
        throw new StratifyError(
          errorCodes.CONFIG_INVALID,
          `ledger.runs[${index}].provenance.${key} 必须为非空字符串`,
        );
      }
    }
    if (provenance['promptStyle'] !== 'neutral' && provenance['promptStyle'] !== 'survival_hint') {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `ledger.runs[${index}].provenance.promptStyle 非法`,
      );
    }
  }
  if (typeof value['elapsedMs'] !== 'number' || !Number.isFinite(value['elapsedMs'])) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `ledger.runs[${index}].elapsedMs 必须为有限数字`,
    );
  }
  return value as unknown as BatchRunRecord;
}

function assertFailure(value: unknown, index: number): BatchFailure {
  if (!isPlainObject(value)) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, `ledger.failures[${index}] 必须是对象`);
  }
  for (const key of ['cellKey', 'seed', 'code', 'error'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        `ledger.failures[${index}].${key} 必须为非空字符串`,
      );
    }
  }
  // 旧版 ledger 无 attempt 字段：按第 1 次失败处理。
  const attempt = value['attempt'] === undefined ? 1 : value['attempt'];
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `ledger.failures[${index}].attempt 必须为正整数`,
    );
  }
  return { ...(value as unknown as Omit<BatchFailure, 'attempt'>), attempt };
}

export function parseLedger(
  text: string,
  manifestHash: string,
  expectedBaseConfigHash?: string,
): BatchLedger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      'ledger JSON 损坏；不得当作有效恢复点，请人工处置后重试',
    );
  }
  if (!isPlainObject(parsed) || parsed['schemaVersion'] !== LEDGER_SCHEMA_VERSION) {
    throw new StratifyError(errorCodes.CONFIG_UNKNOWN_VERSION, '未知 ledger 版本');
  }
  if (parsed['manifestHash'] !== manifestHash) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `ledger.manifestHash 与本次 manifest 不一致（${String(parsed['manifestHash'])} ≠ ${manifestHash}）；换实验请换输出目录`,
    );
  }
  if (
    expectedBaseConfigHash !== undefined &&
    parsed['baseConfigHash'] !== undefined &&
    parsed['baseConfigHash'] !== expectedBaseConfigHash
  ) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `ledger.baseConfigHash 与本次 baseConfig 不一致（${String(parsed['baseConfigHash'])} ≠ ${expectedBaseConfigHash}）；换 baseConfig 请换输出目录`,
    );
  }
  if (!Array.isArray(parsed['runs'])) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'ledger.runs 必须为数组');
  }
  const rawFailures = parsed['failures'] === undefined ? [] : parsed['failures'];
  if (!Array.isArray(rawFailures)) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'ledger.failures 必须为数组');
  }
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    manifestHash,
    ...(typeof parsed['baseConfigHash'] === 'string'
      ? { baseConfigHash: parsed['baseConfigHash'] }
      : {}),
    runs: parsed['runs'].map(assertRunRecord),
    failures: rawFailures.map(assertFailure),
  };
}

export async function writeLedger(
  host: CheckpointHost,
  path: string,
  ledger: BatchLedger,
): Promise<void> {
  const tempPath = `${path}.tmp`;
  await host.writeTemp(tempPath, JSON.stringify(ledger));
  await host.promote(tempPath, path);
}

export function taskKey(cellKey: string, seed: string): string {
  return JSON.stringify([cellKey, seed]);
}

/**
 * 顺序执行 manifest 的全部任务（cells × seeds）。
 *
 * - 单任务失败记录进 `failures`（跨 resume 累积，含 attempt）并继续后续任务；
 *   失败任务不进 `runs`，resume 时自动重试（07 §3：保留失败原因和次数）；
 * - `resumed` 计入 ledger 中直接复用的 run 数，其记录逐字保留；
 * - `totals.failed` 是本次调用后仍未完成的任务数（due - ok），
 *   已被重试成功的历史失败保留在 `failures` 中但不计入 failed；
 * - 不抛出任务级错误：批跑的失败通过 `failures`/`totals.failed` 与 CLI 退出码表达。
 */
export async function runBatch(
  manifest: BatchManifest,
  options: BatchRunOptions = {},
): Promise<BatchSummary> {
  const manifestHash = computeBatchManifestHash(manifest);
  const baseConfig = resolveBatchBaseConfig(options.baseConfig);
  const baseConfigHash = computeConfigHash(baseConfig);
  const tasks = buildBatchTasks(manifest, baseConfig);
  const runCheckpoints = options.runCheckpoints;
  if (runCheckpoints !== undefined) {
    if (runCheckpoints.dir.length === 0) {
      throw new StratifyError(errorCodes.CONFIG_INVALID, 'runCheckpoints.dir 必须为非空目录');
    }
    if (!Number.isInteger(runCheckpoints.everyTicks) || runCheckpoints.everyTicks < 1) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        'runCheckpoints.everyTicks 必须为 >=1 的整数',
      );
    }
  }

  const ledgerOptions = options.ledger;
  const completed = new Map<string, BatchRunRecord>();
  let ledgerFailures: BatchFailure[] = [];
  if (ledgerOptions !== undefined) {
    const host = ledgerOptions.host;
    if (await host.exists(ledgerOptions.path)) {
      const ledger = parseLedger(await host.read(ledgerOptions.path), manifestHash, baseConfigHash);
      for (const record of ledger.runs) {
        completed.set(taskKey(record.cellKey, record.seed), record);
      }
      ledgerFailures = [...ledger.failures];
    }
  }

  const attemptCounts = new Map<string, number>();
  for (const failure of ledgerFailures) {
    const key = taskKey(failure.cellKey, failure.seed);
    attemptCounts.set(key, Math.max(attemptCounts.get(key) ?? 0, failure.attempt));
  }

  const runs: BatchRunRecord[] = [];
  // ledger 的持久化集合从已有 completed 起步：resume 时即使前面的任务再次失败，
  // 也不会在 persistLedger 时把后续已完成 run 从磁盘上抹掉（summary 的 runs 仍按任务顺序）。
  const ledgerRuns = new Map<string, BatchRunRecord>(completed);
  const failures: BatchFailure[] = [...ledgerFailures];
  let resumed = 0;

  // 成功与失败都即时原子落盘：kill 在任意点都留下至多缺最后一个事件的完整 ledger。
  const persistLedger = async (): Promise<void> => {
    if (ledgerOptions === undefined) {
      return;
    }
    const ledger: BatchLedger = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      manifestHash,
      baseConfigHash,
      runs: [...ledgerRuns.values()],
      failures: [...failures],
    };
    await writeLedger(ledgerOptions.host, ledgerOptions.path, ledger);
  };

  for (const [index, task] of tasks.entries()) {
    const key = taskKey(task.cellKey, task.seed);
    const reuse = completed.get(key);
    if (reuse !== undefined) {
      if (reuse.configHash !== task.configHash || reuse.paramsHash !== task.paramsHash) {
        throw new StratifyError(
          errorCodes.CONFIG_INVALID,
          `ledger run ${task.cellKey}/${task.seed} 的 configHash/paramsHash 与当前任务不一致；不得复用`,
        );
      }
      runs.push(reuse);
      resumed += 1;
      options.onProgress?.({
        cellKey: task.cellKey,
        seed: task.seed,
        index,
        total: tasks.length,
        ok: true,
        resumed: true,
        elapsedMs: 0,
      });
      continue;
    }

    let record: BatchRunRecord;
    try {
      const startedAt = performance.now();
      const runImpl = options.runSingleImpl ?? runSingle;
      const runCheckpoint: RunCheckpointOptions | undefined =
        runCheckpoints === undefined
          ? undefined
          : {
              host: runCheckpoints.host,
              path: `${runCheckpoints.dir}/run-${index}.progress.json`,
              everyTicks: runCheckpoints.everyTicks,
              cellKey: task.cellKey,
            };
      const runOptions: RunOptions = {
        policy: manifest.policy,
        ...(options.maxTicksPerRun !== undefined ? { maxTicks: options.maxTicksPerRun } : {}),
        ...(runCheckpoint !== undefined ? { runCheckpoint } : {}),
      };
      const outcome = runImpl(task.config, task.seed, runOptions);
      const elapsedMs = performance.now() - startedAt;
      record = {
        cellKey: task.cellKey,
        seed: task.seed,
        configHash: outcome.configHash,
        paramsHash: outcome.paramsHash,
        report: outcome.report,
        elapsedMs,
        provenance: {
          requestedModel: 'mock',
          promptStyle: 'neutral',
          policyVersion: manifest.policy,
        },
      };
    } catch (error) {
      const code = error instanceof StratifyError ? error.code : errorCodes.INVARIANT_VIOLATED;
      const message = error instanceof Error ? error.message : String(error);
      const attempt = (attemptCounts.get(key) ?? 0) + 1;
      attemptCounts.set(key, attempt);
      failures.push({ cellKey: task.cellKey, seed: task.seed, code, error: message, attempt });
      await persistLedger();
      options.onProgress?.({
        cellKey: task.cellKey,
        seed: task.seed,
        index,
        total: tasks.length,
        ok: false,
        resumed: false,
        elapsedMs: 0,
      });
      continue;
    }

    runs.push(record);
    ledgerRuns.set(key, record);
    await persistLedger();
    options.onProgress?.({
      cellKey: task.cellKey,
      seed: task.seed,
      index,
      total: tasks.length,
      ok: true,
      resumed: false,
      elapsedMs: record.elapsedMs,
    });
  }

  // 收尾再写一次：即使用户 kill 在最后一个任务之后、返回之前，ledger 也包含全部
  // 已完成 run（resume 时 completed 集合已并入 ledgerRuns）。
  await persistLedger();

  // resumed 记录保留其原始耗时；本指标是「已产出的全部 run 的耗时之和」。
  const totalElapsedMs = runs.reduce((sum, run) => sum + run.elapsedMs, 0);
  return {
    schemaVersion: 'batch-summary-v1',
    manifestHash,
    rulesVersion: manifest.rulesVersion,
    engineVersion: manifest.engineVersion,
    policy: manifest.policy,
    populationSize: manifest.populationSize,
    totalTicks: manifest.totalTicks,
    runs,
    failures,
    totals: {
      due: tasks.length,
      ok: runs.length,
      failed: tasks.length - runs.length,
      resumed,
      elapsedMs: totalElapsedMs,
    },
  };
}

import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { computeConfigHash } from '../core/config/hash.js';
import { errorCodes, StratifyError } from '../core/control/errors.js';
import { asLocalRunId } from '../core/control/ids.js';
import type { RunConfig } from '../core/config/types.js';
import type { DecisionPolicy } from '../decision/policy.js';
import type { JevBudget } from '../decision/jev-client.js';
import {
  buildBatchTasks,
  resolveBatchBaseConfig,
  type BatchManifest,
  type BatchTask,
} from './batch.js';
import type { CheckpointHost } from './checkpoint.js';
import {
  computeBatchManifestHash,
  parseLedger,
  taskKey,
  writeLedger,
  type BatchFailure,
  type BatchLedger,
  type BatchLedgerOptions,
  type BatchProgress,
  type BatchRunRecord,
  type BatchSummary,
} from './batch-cli.js';
import { SharedBatchBudget } from './budget.js';
import { runSingleWithPolicy } from './run-cell.js';

/** Crockford base32（ULID 字母表；不含 I/L/O/U）。 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 离线 runId（`local-<ULID>`，core/ids 校验口径）。尾部熵用 `Math.random`：
 * 这是**标识符**，不是仿真随机流（AGENTS #3 约束的是结算用随机性）；
 * 与 `scripts/smoke-live.mjs` 的生成口径一致。
 */
function newLocalRunId(): string {
  let time = Date.now();
  let head = '';
  for (let index = 0; index < 10; index += 1) {
    head = (CROCKFORD[time % 32] ?? '0') + head;
    time = Math.floor(time / 32);
  }
  // 标识符熵源用 node:crypto（ESLint 禁 Math.random；ULID 尾部是 ID 熵，非仿真随机流）。
  const entropy = randomBytes(16);
  let tail = '';
  for (let index = 0; index < 16; index += 1) {
    tail += CROCKFORD[(entropy[index] ?? 0) % 32] ?? '0';
  }
  return `local-${head}${tail}`;
}

/**
 * P5-02：live/replay 批跑执行器（01 §8.1「全局队列、并发、限流和共享预算」）。
 *
 * 与 `runBatch`（P5-01，同步 mock/random）的区别：
 * - 策略经 `policyFactory` 注入（live `JevLivePolicy`/replay `ReplayPolicy` 或测试替身），
 *   走 `runSingleWithPolicy` 异步管线；**密钥只进 factory 闭包，不落参数/日志/摘要**；
 * - `concurrency` 个 worker 从同一任务队列拉取（进程内并发；跨进程调度/budget.sqlite
 *   不在 MVP，docs/09 §6）；
 * - `budget`（`SharedBatchBudget`）为批内所有 run 共享：耗尽即停止发起新 run
 *   （G5a「预算耗尽」故障注入口径），剩余任务按同因失败记录，不冒充完成；
 * - 认证/熔断/回退率等**批级致命**失败（04 §5/§6）停止整个批次，剩余任务按同因记录；
 * - 取消：`signal` 取消后不再发起新 run，在途 run 经 `runSingleWithPolicy` 的
 *   signal 语义尽快返回（cancelled 报告计入 failures，不冒充完成）；
 * - ledger 与 mock 批跑同一格式（`batch-ledger-v1`），写入经队列串行化；
 *   **确定性边界**：live run 的结果不可种子复现（真实模型），resume 只保证
 *   「已完成的 run 不重算」，恢复后的新 run 是新的真实调用（04 §4）。
 */

/** 批级致命失败码：出现即停止发起新 run（04 §5/§6；G5a 预算耗尽同口径）。 */
const BATCH_FATAL_CODES: ReadonlySet<string> = new Set([
  errorCodes.JEV_AUTH_FAILED,
  errorCodes.JEV_CIRCUIT_OPEN,
  errorCodes.JEV_FALLBACK_RATE_EXCEEDED,
  errorCodes.JEV_BUDGET_EXHAUSTED,
]);

export interface BatchWithPolicyOptions {
  readonly manifest: BatchManifest;
  /** 每任务构造策略实现；live 的 API Key 只允许出现在 factory 闭包内。 */
  readonly policyFactory: (task: BatchTask, index: number, signal: AbortSignal) => DecisionPolicy;
  /** 并发 worker 数；>=1，缺省 1（顺序）。 */
  readonly concurrency?: number;
  /** 取消信号：取消后不发起新 run，在途 run 尽快返回。 */
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BatchProgress) => void;
  /** 断点续跑 ledger（与 mock 批跑同一格式）。 */
  readonly ledger?: BatchLedgerOptions;
  readonly maxTicksPerRun?: number;
  /** 批内共享预算（live 默认必须提供；仅 `requireBudget=false` 可显式关闭）。 */
  readonly budget?: JevBudget;
  readonly requestedModel?: string;
  /** 预期策略版本；提供时续跑 ledger 的 provenance 必须一致。 */
  readonly policyVersion?: string;
  readonly promptStyle?: 'neutral' | 'survival_hint';
  /** 默认 true：缺预算拒绝启动；仅显式 false 可关闭。 */
  readonly requireBudget?: boolean;
  /** P6-04 前置：live run 内进度检查点（异步宿主）。 */
  readonly runCheckpoint?: {
    readonly host: CheckpointHost;
    readonly dir: string;
    readonly everyTicks: number;
  };
  /** P6-01：实验级 base config（人口规模校验基准）；缺省 DEFAULT_RUN_CONFIG。 */
  readonly baseConfig?: RunConfig;
}

const STOP_CAUSE_CANCELLED = 'cancelled';
const STOP_CAUSE_BUDGET_EXHAUSTED = errorCodes.JEV_BUDGET_EXHAUSTED;

export async function runBatchWithPolicy(options: BatchWithPolicyOptions): Promise<BatchSummary> {
  const { manifest } = options;
  const manifestHash = computeBatchManifestHash(manifest);
  const baseConfig = resolveBatchBaseConfig(options.baseConfig);
  const baseConfigHash = computeConfigHash(baseConfig);
  const tasks = buildBatchTasks(manifest, baseConfig);
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'concurrency 必须为 >=1 的整数');
  }
  const runCheckpoints = options.runCheckpoint;
  if (runCheckpoints !== undefined) {
    if (runCheckpoints.dir.length === 0) {
      throw new StratifyError(errorCodes.CONFIG_INVALID, 'runCheckpoint.dir 必须为非空目录');
    }
    if (!Number.isInteger(runCheckpoints.everyTicks) || runCheckpoints.everyTicks < 1) {
      throw new StratifyError(
        errorCodes.CONFIG_INVALID,
        'runCheckpoint.everyTicks 必须为 >=1 的整数',
      );
    }
  }
  if (options.requireBudget !== false && options.budget === undefined) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      'live 批跑默认必须提供批内共享预算；如确需关闭请显式 requireBudget=false（04 §7）',
    );
  }

  const completed = new Map<string, BatchRunRecord>();
  let ledgerFailures: BatchFailure[] = [];
  const ledgerOptions = options.ledger;
  if (ledgerOptions !== undefined) {
    if (await ledgerOptions.host.exists(ledgerOptions.path)) {
      const ledger = parseLedger(
        await ledgerOptions.host.read(ledgerOptions.path),
        manifestHash,
        baseConfigHash,
      );
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
  const failures: BatchFailure[] = [...ledgerFailures];
  let resumed = 0;
  // 批级停止：致命失败/预算耗尽/取消后不再发起新 run；剩余任务按同因记录。
  let stopCause: string | null = null;

  // ledger 写入串行化：并发 worker 共享一个写链，保持原子性与单写者语义。
  let ledgerChain: Promise<void> = Promise.resolve();
  const persistLedger = (): void => {
    if (ledgerOptions === undefined) {
      return;
    }
    const ledger: BatchLedger = {
      schemaVersion: 'batch-ledger-v1',
      manifestHash,
      baseConfigHash,
      runs: [...runs],
      failures: [...failures],
    };
    ledgerChain = ledgerChain.then(() =>
      writeLedger(ledgerOptions.host, ledgerOptions.path, ledger),
    );
  };

  const recordFailure = (task: BatchTask, code: string, error: string): void => {
    const key = taskKey(task.cellKey, task.seed);
    const attempt = (attemptCounts.get(key) ?? 0) + 1;
    attemptCounts.set(key, attempt);
    failures.push({ cellKey: task.cellKey, seed: task.seed, code, error, attempt });
    persistLedger();
  };

  const queue = tasks.map((task, index) => ({ task, index }));
  let queueCursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopCause !== null) {
        return;
      }
      if (options.signal?.aborted) {
        return;
      }
      if (options.budget?.exhausted) {
        stopCause = STOP_CAUSE_BUDGET_EXHAUSTED;
        return;
      }
      if (queueCursor >= queue.length) {
        return;
      }
      const next = queue[queueCursor];
      queueCursor += 1;
      if (next === undefined) {
        return;
      }
      const { task, index } = next;
      const key = taskKey(task.cellKey, task.seed);
      const reuse = completed.get(key);
      if (reuse !== undefined) {
        if (reuse.configHash !== task.configHash || reuse.paramsHash !== task.paramsHash) {
          throw new StratifyError(
            errorCodes.CONFIG_INVALID,
            `ledger run ${task.cellKey}/${task.seed} 的 configHash/paramsHash 与当前任务不一致；不得复用`,
          );
        }
        if (reuse.provenance === undefined) {
          throw new StratifyError(
            errorCodes.CONFIG_INVALID,
            `ledger run ${task.cellKey}/${task.seed} 缺少 provenance，不能用于 live 续跑；请换输出目录重跑`,
          );
        }
        const expectedModel = options.requestedModel ?? 'unknown';
        const expectedPrompt = options.promptStyle ?? 'neutral';
        if (
          reuse.provenance.requestedModel !== expectedModel ||
          reuse.provenance.promptStyle !== expectedPrompt
        ) {
          throw new StratifyError(
            errorCodes.CONFIG_INVALID,
            `ledger run 的模型/prompt 与本次调用不一致（${reuse.provenance.requestedModel}/${reuse.provenance.promptStyle} ≠ ${expectedModel}/${expectedPrompt}）；不得复用`,
          );
        }
        if (
          options.policyVersion !== undefined &&
          reuse.provenance.policyVersion !== options.policyVersion
        ) {
          throw new StratifyError(
            errorCodes.CONFIG_INVALID,
            `ledger run 的 policyVersion 与本次调用不一致（${reuse.provenance.policyVersion} ≠ ${options.policyVersion}）；不得复用`,
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
        const runSignal = options.signal ?? new AbortController().signal;
        const policy = options.policyFactory(task, index, runSignal);
        const outcome = await runSingleWithPolicy(task.config, task.seed, {
          policy,
          runId: asLocalRunId(newLocalRunId()),
          requestedModel: options.requestedModel ?? 'unknown',
          promptStyle: options.promptStyle ?? 'neutral',
          ...(options.maxTicksPerRun !== undefined ? { maxTicks: options.maxTicksPerRun } : {}),
          signal: runSignal,
          ...(runCheckpoints !== undefined
            ? {
                runCheckpoint: {
                  host: runCheckpoints.host,
                  path: `${runCheckpoints.dir}/run-${index}.progress.json`,
                  everyTicks: runCheckpoints.everyTicks,
                  cellKey: task.cellKey,
                },
              }
            : {}),
        });
        const elapsedMs = performance.now() - startedAt;
        if (outcome.report.cancelled) {
          stopCause = stopCause ?? STOP_CAUSE_CANCELLED;
          recordFailure(task, 'cancelled', 'run 被 signal 取消，未完成');
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
        record = {
          cellKey: task.cellKey,
          seed: task.seed,
          configHash: outcome.configHash,
          paramsHash: outcome.paramsHash,
          report: outcome.report,
          elapsedMs,
          provenance: {
            requestedModel: options.requestedModel ?? 'unknown',
            promptStyle: options.promptStyle ?? 'neutral',
            policyVersion: policy.policyVersion,
          },
        };
      } catch (error) {
        const code = error instanceof StratifyError ? error.code : errorCodes.INVARIANT_VIOLATED;
        const message = error instanceof Error ? error.message : String(error);
        recordFailure(task, code, message);
        if (BATCH_FATAL_CODES.has(code)) {
          stopCause = code;
        }
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
      persistLedger();
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
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  await ledgerChain;

  // 批级停止后的剩余未处理任务：按同因记录失败，不冒充完成。
  const processedKeys = new Set<string>([
    ...runs.map((run) => taskKey(run.cellKey, run.seed)),
    ...failures.map((failure) => taskKey(failure.cellKey, failure.seed)),
  ]);
  const remainingCause =
    stopCause === STOP_CAUSE_CANCELLED
      ? 'signal 已取消，批次停止，任务未启动'
      : stopCause !== null
        ? `批次已因 ${stopCause} 停止，任务未启动`
        : null;
  if (remainingCause !== null) {
    const causeCode =
      stopCause === STOP_CAUSE_CANCELLED ? 'cancelled' : (stopCause ?? 'batch_stopped');
    for (const [index, task] of tasks.entries()) {
      if (processedKeys.has(taskKey(task.cellKey, task.seed))) {
        continue;
      }
      const key = taskKey(task.cellKey, task.seed);
      const attempt = (attemptCounts.get(key) ?? 0) + 1;
      attemptCounts.set(key, attempt);
      failures.push({
        cellKey: task.cellKey,
        seed: task.seed,
        code: causeCode,
        error: remainingCause,
        attempt,
      });
      options.onProgress?.({
        cellKey: task.cellKey,
        seed: task.seed,
        index,
        total: tasks.length,
        ok: false,
        resumed: false,
        elapsedMs: 0,
      });
    }
    persistLedger();
    await ledgerChain;
  }

  const totalElapsedMs = runs.reduce((sum, run) => sum + run.elapsedMs, 0);
  const budgetUsage =
    options.budget instanceof SharedBatchBudget ? { ...options.budget.usage() } : undefined;
  const policyVersions = [
    ...new Set(
      runs
        .map((run) => run.provenance?.policyVersion)
        .filter((version): version is string => typeof version === 'string'),
    ),
  ];
  const summary: BatchSummary = {
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
    liveProvenance: {
      requestedModel: options.requestedModel ?? 'unknown',
      promptStyle: options.promptStyle ?? 'neutral',
      policyVersions,
    },
    ...(budgetUsage !== undefined ? { budgetUsage } : {}),
  };
  return summary;
}

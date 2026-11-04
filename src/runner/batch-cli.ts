import { performance } from 'node:perf_hooks';

import { errorCodes, StratifyError } from '../core/control/errors.js';
import { HASH_DOMAINS } from '../core/hash/domains.js';
import { hashValue } from '../core/hash/hash.js';
import { buildBatchTasks, type BatchManifest } from './batch.js';
import type { CheckpointHost } from './checkpoint.js';
import { runSingle, type RunOptions, type RunWindowReport } from './run-cell.js';

/**
 * P5-01：批量执行器与机器可读摘要（01 §8.1）。
 *
 * - 单实验/矩阵/消融共用同一 manifest 语义（cells × seeds 笛卡尔），校验在 `batch.ts`；
 * - mock/random 批跑不依赖 P2：只走 `runSingle` 同步路径，本模块不 import 决策 HTTP 层；
 * - stdout 与报告分离：本模块只产出数据与进度回调；stdout 输出与报告文件由 CLI 层（`bin/stratify-batch.mjs`）负责；
 * - 断点续跑（G5a）：原子 ledger 逐 run 落盘（writeTemp + rename，复用 `CheckpointHost` 语义）；
 *   kill 后按 `manifestHash` 匹配跳过已完成 run，恢复后的最终摘要与不中断运行的
 *   `finalStateHash/configHash/paramsHash` 逐字一致（确定性引擎保证；耗时与 resumed 计数除外）。
 */

export interface BatchRunRecord {
  readonly cellKey: string;
  readonly seed: string;
  readonly configHash: string;
  readonly paramsHash: string;
  readonly report: RunWindowReport;
  readonly elapsedMs: number;
}

export interface BatchFailure {
  readonly cellKey: string;
  readonly seed: string;
  readonly code: string;
  readonly error: string;
}

export interface BatchSummary {
  readonly schemaVersion: 'batch-summary-v1';
  readonly manifestHash: string;
  readonly rulesVersion: string;
  readonly engineVersion: string;
  readonly policy: 'mock-weighted-v1' | 'random-uniform-v1';
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

export interface BatchRunOptions {
  /** 逐 run 完成回调（CLI 层写 stderr；嵌入方可静默）。 */
  readonly onProgress?: (progress: BatchProgress) => void;
  /** 断点续跑 ledger；缺省不落盘（进程内一次性批跑）。 */
  readonly ledger?: BatchLedgerOptions;
  /** 单 run 护栏：单 run 最大 tick 数（透传 `runSingle.maxTicks`）。 */
  readonly maxTicksPerRun?: number;
  /** 故障注入缺口（G5a：kill/磁盘失败后恢复对照）；缺省 `runSingle`。 */
  readonly runSingleImpl?: typeof runSingle;
}

export interface BatchLedger {
  readonly schemaVersion: 'batch-ledger-v1';
  readonly manifestHash: string;
  readonly runs: readonly BatchRunRecord[];
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
  if (!isPlainObject(value['report'])) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, `ledger.runs[${index}].report 必须是对象`);
  }
  if (typeof value['elapsedMs'] !== 'number' || !Number.isFinite(value['elapsedMs'])) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `ledger.runs[${index}].elapsedMs 必须为有限数字`,
    );
  }
  return value as unknown as BatchRunRecord;
}

function parseLedger(text: string, manifestHash: string): BatchLedger {
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
  if (!Array.isArray(parsed['runs'])) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'ledger.runs 必须为数组');
  }
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    manifestHash,
    runs: parsed['runs'].map(assertRunRecord),
  };
}

async function writeLedger(host: CheckpointHost, path: string, ledger: BatchLedger): Promise<void> {
  const tempPath = `${path}.tmp`;
  await host.writeTemp(tempPath, JSON.stringify(ledger));
  await host.promote(tempPath, path);
}

function taskKey(cellKey: string, seed: string): string {
  return JSON.stringify([cellKey, seed]);
}

/**
 * 顺序执行 manifest 的全部任务（cells × seeds）。
 *
 * - 单任务失败记录进 `failures` 并继续后续任务（技术失败不冒充完成，07 §3）；
 *   ledger 只写成功 run，失败任务在 resume 时自动重试；
 * - `resumed` 计入 ledger 中直接复用的 run 数，其记录逐字保留；
 * - 不抛出任务级错误：批跑的失败通过 `failures` 与 CLI 退出码表达。
 */
export async function runBatch(
  manifest: BatchManifest,
  options: BatchRunOptions = {},
): Promise<BatchSummary> {
  const manifestHash = computeBatchManifestHash(manifest);
  const tasks = buildBatchTasks(manifest);

  const ledgerOptions = options.ledger;
  const completed = new Map<string, BatchRunRecord>();
  if (ledgerOptions !== undefined) {
    const host = ledgerOptions.host;
    if (await host.exists(ledgerOptions.path)) {
      const ledger = parseLedger(await host.read(ledgerOptions.path), manifestHash);
      for (const record of ledger.runs) {
        completed.set(taskKey(record.cellKey, record.seed), record);
      }
    }
  }

  const runs: BatchRunRecord[] = [];
  const failures: BatchFailure[] = [];
  let resumed = 0;

  for (const [index, task] of tasks.entries()) {
    const key = taskKey(task.cellKey, task.seed);
    const reuse = completed.get(key);
    if (reuse !== undefined) {
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
      const runOptions: RunOptions = {
        policy: manifest.policy,
        ...(options.maxTicksPerRun !== undefined ? { maxTicks: options.maxTicksPerRun } : {}),
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
      };
    } catch (error) {
      const code = error instanceof StratifyError ? error.code : errorCodes.INVARIANT_VIOLATED;
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ cellKey: task.cellKey, seed: task.seed, code, error: message });
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
    if (ledgerOptions !== undefined) {
      const ledger: BatchLedger = {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        manifestHash,
        runs: [...runs],
      };
      // 逐 run 原子落盘：kill 在任意点都会留下至多缺最后一个 run 的完整 ledger。
      await writeLedger(ledgerOptions.host, ledgerOptions.path, ledger);
    }
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
      failed: failures.length,
      resumed,
      elapsedMs: totalElapsedMs,
    },
  };
}

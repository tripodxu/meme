import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG } from '../../../src/core/config/defaults.js';
import { ENGINE_VERSION, RULES_VERSION } from '../../../src/core/control/versions.js';
import { errorCodes, StratifyError } from '../../../src/core/control/errors.js';
import {
  computeBatchManifestHash,
  runBatch,
  type BatchLedger,
  type BatchRunRecord,
} from '../../../src/runner/batch-cli.js';
import { validateBatchManifest, type BatchManifest } from '../../../src/runner/batch.js';
import { memoryCheckpointHost } from '../../../src/runner/checkpoint.js';
import { runSingle, type RunOptions, type RunOutcome } from '../../../src/runner/run-cell.js';

const BASE_POPULATION = DEFAULT_RUN_CONFIG.population.initialPopulation;

function manifestRecord(): Record<string, unknown> {
  return {
    schemaVersion: 'batch-v1',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    populationSize: BASE_POPULATION,
    totalTicks: 12,
    policy: 'mock-weighted-v1',
    seeds: ['s1', 's2'],
    cells: [
      { cellKey: 'baseline', overrides: {} },
      { cellKey: 'threshold=0.9', overrides: { need: { threshold: 0.9 } } },
    ],
  };
}

function smallManifest(): BatchManifest {
  return validateBatchManifest(manifestRecord());
}

function fingerprint(record: BatchRunRecord): string {
  return JSON.stringify({
    cellKey: record.cellKey,
    seed: record.seed,
    configHash: record.configHash,
    paramsHash: record.paramsHash,
    report: record.report,
  });
}

describe('批量执行器与机器可读摘要（P5-01）', () => {
  it('摘要结构完整且任务全成功', async () => {
    const manifest = smallManifest();
    const summary = await runBatch(manifest);
    expect(summary.schemaVersion).toBe('batch-summary-v1');
    expect(summary.manifestHash).toBe(computeBatchManifestHash(manifest));
    expect(summary.rulesVersion).toBe(RULES_VERSION);
    expect(summary.engineVersion).toBe(ENGINE_VERSION);
    expect(summary.policy).toBe('mock-weighted-v1');
    expect(summary.populationSize).toBe(BASE_POPULATION);
    expect(summary.totalTicks).toBe(12);
    expect(summary.totals).toEqual({
      due: 4,
      ok: 4,
      failed: 0,
      resumed: 0,
      elapsedMs: expect.any(Number),
    });
    expect(summary.failures).toEqual([]);
    expect(summary.runs).toHaveLength(4);
    for (const run of summary.runs) {
      expect(run.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(run.paramsHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(run.report.finalStateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(run.report.cancelled).toBe(false);
      expect(run.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('同一 manifest 重复执行产出逐字一致的确定性指纹', async () => {
    const first = await runBatch(smallManifest());
    const second = await runBatch(smallManifest());
    expect(second.runs.map(fingerprint)).toEqual(first.runs.map(fingerprint));
    expect(second.manifestHash).toBe(first.manifestHash);
  });

  it('progress 回调逐 run 报告且不改变结果', async () => {
    const progress: string[] = [];
    const summary = await runBatch(smallManifest(), {
      onProgress: (p) => progress.push(`${p.index}/${p.total}:${p.cellKey}:${p.seed}:${p.ok}`),
    });
    expect(progress).toHaveLength(4);
    expect(progress[0]).toBe('0/4:baseline:s1:true');
    expect(progress[3]).toBe('3/4:threshold=0.9:s2:true');
    expect(summary.totals.ok).toBe(4);
  });

  it('单任务失败记录 failures 并继续后续任务', async () => {
    const manifest = smallManifest();
    const realRun = (
      config: Parameters<typeof runSingle>[0],
      seed: Parameters<typeof runSingle>[1],
      options: RunOptions,
    ): RunOutcome => {
      if (seed === 's2') {
        throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '注入故障');
      }
      return runSingle(config, seed, options);
    };
    const summary = await runBatch(manifest, { runSingleImpl: realRun });
    expect(summary.totals).toMatchObject({ due: 4, ok: 2, failed: 2, resumed: 0 });
    expect(summary.failures).toHaveLength(2);
    expect(summary.failures[0]).toMatchObject({
      cellKey: 'baseline',
      seed: 's2',
      code: errorCodes.INVARIANT_VIOLATED,
      error: '注入故障',
    });
    // 失败不冒充完成：失败 run 不进 runs。
    expect(summary.runs.every((run) => run.seed !== 's2')).toBe(true);
  });

  it('非 StratifyError 的意外异常也按 invariant 记录', async () => {
    const manifest = validateBatchManifest({
      ...manifestRecord(),
      seeds: ['boom'],
      cells: [{ cellKey: 'baseline', overrides: {} }],
    });
    const summary = await runBatch(manifest, {
      runSingleImpl: () => {
        throw new Error('unexpected');
      },
    });
    expect(summary.failures[0]).toMatchObject({
      cellKey: 'baseline',
      seed: 'boom',
      code: errorCodes.INVARIANT_VIOLATED,
      error: 'unexpected',
    });
    expect(summary.totals.failed).toBe(1);
  });
});

describe('批量 ledger 断点续跑（G5a）', () => {
  it('kill 后从 ledger 恢复，最终指纹与不中断对照一致', async () => {
    const manifest = smallManifest();
    const manifestHash = computeBatchManifestHash(manifest);
    const host = memoryCheckpointHost();
    const ledgerPath = 'ledger.json';

    // 第一段：完成第一个任务后注入故障，模拟 kill -9 留下的半程 ledger。
    const killAfterFirst = (
      config: Parameters<typeof runSingle>[0],
      seed: Parameters<typeof runSingle>[1],
      options: RunOptions,
    ): RunOutcome => {
      if (seed === 's2') {
        throw new StratifyError(errorCodes.INVARIANT_VIOLATED, 'kill');
      }
      return runSingle(config, seed, options);
    };
    const interrupted = await runBatch(manifest, {
      ledger: { host, path: ledgerPath },
      runSingleImpl: killAfterFirst,
    });
    expect(interrupted.totals.ok).toBe(2);
    expect(host.files.get(ledgerPath)).toBeDefined();
    const storedLedger = JSON.parse(host.files.get(ledgerPath) as string) as BatchLedger;
    expect(storedLedger.schemaVersion).toBe('batch-ledger-v1');
    expect(storedLedger.manifestHash).toBe(manifestHash);
    expect(storedLedger.runs).toHaveLength(2);

    // 第二段：恢复，重试失败任务并复用已完成任务。
    const resumed = await runBatch(manifest, { ledger: { host, path: ledgerPath } });
    expect(resumed.totals).toMatchObject({ due: 4, ok: 4, failed: 0, resumed: 2 });
    expect(resumed.manifestHash).toBe(manifestHash);

    // 对照：无 ledger 的一次性完整运行。
    const control = await runBatch(manifest);
    expect(resumed.runs.map(fingerprint)).toEqual(control.runs.map(fingerprint));
    // 复用记录逐字保留（不重算）。
    expect(resumed.runs[0]).toEqual(interrupted.runs[0]);
  });

  it('ledger 缺失时全新执行并原子落盘', async () => {
    const manifest = smallManifest();
    const host = memoryCheckpointHost();
    const summary = await runBatch(manifest, { ledger: { host, path: 'ledger.json' } });
    expect(summary.totals.resumed).toBe(0);
    const stored = JSON.parse(host.files.get('ledger.json') as string) as BatchLedger;
    expect(stored.runs).toHaveLength(4);
    expect(stored.manifestHash).toBe(computeBatchManifestHash(manifest));
  });

  it('损坏的 ledger 拒绝恢复，不得静默覆盖', async () => {
    const manifest = smallManifest();
    const host = memoryCheckpointHost();
    host.files.set('ledger.json', '{not-json');
    await expect(
      runBatch(manifest, { ledger: { host, path: 'ledger.json' } }),
    ).rejects.toThrowError(expect.objectContaining({ code: errorCodes.CONFIG_INVALID }));
    expect(host.files.get('ledger.json')).toBe('{not-json');
  });

  it('manifestHash 不一致的 ledger 拒绝恢复', async () => {
    const manifest = smallManifest();
    const host = memoryCheckpointHost();
    const other = validateBatchManifest({ ...manifestRecord(), seeds: ['other'] });
    host.files.set(
      'ledger.json',
      JSON.stringify({
        schemaVersion: 'batch-ledger-v1',
        manifestHash: computeBatchManifestHash(other),
        runs: [],
      }),
    );
    await expect(
      runBatch(manifest, { ledger: { host, path: 'ledger.json' } }),
    ).rejects.toThrowError(/manifestHash 与本次 manifest 不一致/);
  });

  it('未知 ledger 版本与畸形记录拒绝', async () => {
    const manifest = smallManifest();
    const manifestHash = computeBatchManifestHash(manifest);
    const host = memoryCheckpointHost();
    host.files.set(
      'ledger.json',
      JSON.stringify({ schemaVersion: 'batch-ledger-v9', manifestHash, runs: [] }),
    );
    await expect(
      runBatch(manifest, { ledger: { host, path: 'ledger.json' } }),
    ).rejects.toThrowError(expect.objectContaining({ code: errorCodes.CONFIG_UNKNOWN_VERSION }));

    host.files.set(
      'ledger2.json',
      JSON.stringify({
        schemaVersion: 'batch-ledger-v1',
        manifestHash,
        runs: [{ cellKey: 'baseline', seed: '', configHash: 'sha256:0'.padEnd(71, '0') }],
      }),
    );
    await expect(
      runBatch(manifest, { ledger: { host, path: 'ledger2.json' } }),
    ).rejects.toThrowError(/ledger\.runs\[0\]\.seed/);
  });
});

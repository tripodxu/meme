import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { errorCodes, StratifyError } from '../../../src/core/control/errors.js';
import {
  memoryCheckpointHostSync,
  type SyncCheckpointHost,
} from '../../../src/runner/checkpoint.js';
import { runSingle } from '../../../src/runner/run-cell.js';
import {
  buildRunProgressPayload,
  loadRunProgress,
  runProgressExpectation,
} from '../../../src/runner/run-progress.js';
import { runBatch } from '../../../src/runner/batch-cli.js';
import { validateBatchManifest, type BatchManifest } from '../../../src/runner/batch.js';
import { ENGINE_VERSION, RULES_VERSION } from '../../../src/core/control/versions.js';

const CONFIG = createDemoConfig({ schedule: { totalTicks: 40 } });
const SEED = asSeed('ckpt-seed');

function checkpointOptions(
  host: SyncCheckpointHost,
  path: string,
  everyTicks = 10,
): {
  host: SyncCheckpointHost;
  path: string;
  everyTicks: number;
  cellKey: string;
} {
  return { host, path, everyTicks, cellKey: 'baseline' };
}

describe('run 内进度检查点（P5-03，runSingle）', () => {
  it('kill 后从 tick 级完整点恢复，报告与不中断对照逐字一致', () => {
    const control = runSingle(CONFIG, SEED, { policy: 'mock-weighted-v1' });

    const host = memoryCheckpointHostSync();
    const path = 'run.progress.json';
    // 第一段：maxTicks=25 护栏停止（检查点落在 tick 10、20）。
    const first = runSingle(CONFIG, SEED, {
      policy: 'mock-weighted-v1',
      maxTicks: 25,
      runCheckpoint: checkpointOptions(host, path),
    });
    expect(first.report.endTick).toBe(24);
    expect(host.files.has(path)).toBe(true);
    const stored = JSON.parse(host.files.get(path) as string) as {
      meta: { tickCompleted: number; savedAtSequence: number };
    };
    expect(stored.meta.tickCompleted).toBe(20);
    expect(stored.meta.savedAtSequence).toBe(2);

    // 第二段：同路径恢复，跑完剩余 tick；无 `.tmp` 残留。
    const resumed = runSingle(CONFIG, SEED, {
      policy: 'mock-weighted-v1',
      runCheckpoint: checkpointOptions(host, path),
    });
    expect(host.files.has(path)).toBe(false);
    expect(host.files.has(`${path}.tmp`)).toBe(false);

    // 窗口聚合/标签/终态逐字一致（G5a 口径）。
    expect(JSON.stringify(resumed.report)).toBe(JSON.stringify(control.report));
    expect(resumed.report.endTick).toBe(39);
    // 恢复路径的 stats/flows/decisionsByTick 也与对照一致。
    expect(resumed.stats.length).toBe(control.stats.length);
    expect(JSON.stringify(resumed.stats)).toBe(JSON.stringify(control.stats));
    expect(JSON.stringify([...resumed.flowsByTick])).toBe(JSON.stringify([...control.flowsByTick]));
    expect(JSON.stringify([...resumed.decisionsByTick])).toBe(
      JSON.stringify([...control.decisionsByTick]),
    );
  });

  it('run 正常结束后移除检查点；护栏停止则保留', () => {
    const host = memoryCheckpointHostSync();
    const path = 'run.progress.json';
    runSingle(CONFIG, SEED, {
      policy: 'mock-weighted-v1',
      runCheckpoint: checkpointOptions(host, path, 5),
    });
    expect(host.files.has(path)).toBe(false);

    runSingle(CONFIG, SEED, {
      policy: 'mock-weighted-v1',
      maxTicks: 8,
      runCheckpoint: checkpointOptions(host, path, 5),
    });
    expect(host.files.has(path)).toBe(true);
  });

  it('损坏的检查点按不存在处理，从 tick 0 重跑且结果一致', () => {
    const control = runSingle(CONFIG, SEED, { policy: 'mock-weighted-v1' });
    const host = memoryCheckpointHostSync();
    host.files.set('run.progress.json', '{"schemaVersion":"run-progress-v1","meta":{');
    const resumed = runSingle(CONFIG, SEED, {
      policy: 'mock-weighted-v1',
      runCheckpoint: checkpointOptions(host, 'run.progress.json'),
    });
    expect(JSON.stringify(resumed.report)).toBe(JSON.stringify(control.report));
    expect(host.files.has('run.progress.json')).toBe(false);
  });

  it('meta 与期望不匹配时抛错（防跨 run 污染）', () => {
    const host = memoryCheckpointHostSync();
    const payload = buildRunProgressPayload(
      {
        cellKey: 'other-cell',
        seed: SEED,
        configHash: runProgressExpectation('baseline', SEED, CONFIG).configHash as string,
        tickCompleted: 10,
        savedAtSequence: 1,
      },
      // 快照来自同一 config/seed 的合法状态，只有 cellKey 伪造。
      runSingle(CONFIG, SEED, { policy: 'mock-weighted-v1', maxTicks: 10 }).finalState,
      { stats: [], flows: [], decisions: [] },
    );
    host.writeTemp('run.progress.json', JSON.stringify(payload));
    host.promote('run.progress.json', 'run.progress.json');
    expect(() =>
      runSingle(CONFIG, SEED, {
        policy: 'mock-weighted-v1',
        runCheckpoint: checkpointOptions(host, 'run.progress.json'),
      }),
    ).toThrowError(/cellKey 不匹配/);
  });

  it('initialState 与 runCheckpoint 不得同时给出', () => {
    const host = memoryCheckpointHostSync();
    const state = runSingle(CONFIG, SEED, { policy: 'mock-weighted-v1', maxTicks: 5 }).finalState;
    expect(() =>
      runSingle(CONFIG, SEED, {
        policy: 'mock-weighted-v1',
        initialState: state,
        runCheckpoint: checkpointOptions(host, 'run.progress.json'),
      }),
    ).toThrowError(/起点歧义/);
  });

  it('G5a 磁盘写失败注入：第二次落盘失败即响亮报错，恢复后与对照一致', () => {
    const control = runSingle(CONFIG, SEED, { policy: 'mock-weighted-v1' });

    const memory = memoryCheckpointHostSync();
    let writeCalls = 0;
    const failing: SyncCheckpointHost = {
      writeTemp(path, payload) {
        writeCalls += 1;
        if (writeCalls === 2) {
          throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '注入磁盘写失败');
        }
        memory.writeTemp(path, payload);
      },
      promote: (tempPath, path) => memory.promote(tempPath, path),
      read: (path) => memory.read(path),
      exists: (path) => memory.exists(path),
      remove: (path) => memory.remove(path),
    };

    expect(() =>
      runSingle(CONFIG, SEED, {
        policy: 'mock-weighted-v1',
        runCheckpoint: checkpointOptions(failing, 'run.progress.json'),
      }),
    ).toThrowError(/磁盘写失败/);
    // 第一次落盘（tick 10）成功保留。
    expect(memory.exists('run.progress.json')).toBe(true);

    const resumed = runSingle(CONFIG, SEED, {
      policy: 'mock-weighted-v1',
      runCheckpoint: checkpointOptions(memory, 'run.progress.json'),
    });
    expect(JSON.stringify(resumed.report)).toBe(JSON.stringify(control.report));
    expect(memory.exists('run.progress.json')).toBe(false);
  });
});

describe('run-progress 模块（P5-03）', () => {
  it('build/load 往返与期望校验', () => {
    const host = memoryCheckpointHostSync();
    const state = runSingle(CONFIG, SEED, { policy: 'mock-weighted-v1', maxTicks: 10 }).finalState;
    const payload = buildRunProgressPayload(
      { cellKey: 'baseline', seed: SEED, configHash: '', tickCompleted: 10, savedAtSequence: 3 },
      state,
      {
        stats: [],
        flows: [{ tick: 0, matrix: [[0]] }],
        decisions: [{ tick: 0, due: 40, fallbacks: 0 }],
      },
    );
    host.writeTemp('p.json', JSON.stringify(payload));
    host.promote('p.json', 'p.json');
    const loaded = loadRunProgress(host, 'p.json', { cellKey: 'baseline', seed: SEED });
    expect(loaded).not.toBeNull();
    expect(loaded?.meta.savedAtSequence).toBe(3);
    expect(loaded?.progress.decisions[0]).toEqual({ tick: 0, due: 40, fallbacks: 0 });
    expect(loadRunProgress(host, 'missing.json', {})).toBeNull();
  });

  it('configHash 不匹配与 tickCompleted 非法拒绝', () => {
    const host = memoryCheckpointHostSync();
    const state = runSingle(CONFIG, SEED, { policy: 'mock-weighted-v1', maxTicks: 10 }).finalState;
    const payload = buildRunProgressPayload(
      {
        cellKey: 'baseline',
        seed: SEED,
        configHash: 'sha256:other',
        tickCompleted: 10,
        savedAtSequence: 1,
      },
      state,
      { stats: [], flows: [], decisions: [] },
    );
    host.writeTemp('p.json', JSON.stringify(payload));
    host.promote('p.json', 'p.json');
    expect(() => loadRunProgress(host, 'p.json', { configHash: 'sha256:expected' })).toThrowError(
      /configHash 不匹配/,
    );

    const bad = { ...payload, meta: { ...payload.meta, tickCompleted: -1 } };
    host.writeTemp('bad.json', JSON.stringify(bad));
    host.promote('bad.json', 'bad.json');
    // tickCompleted 非法属损坏类：按不存在处理（返回 null）。
    expect(loadRunProgress(host, 'bad.json', {})).toBeNull();
  });
});

describe('runBatch 集成 run 内检查点（P5-03）', () => {
  const manifest: BatchManifest = validateBatchManifest({
    schemaVersion: 'batch-v1',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    populationSize: 40,
    totalTicks: 40,
    policy: 'mock-weighted-v1',
    seeds: ['s1', 's2'],
    cells: [{ cellKey: 'baseline', overrides: {} }],
  });

  it('全部任务完成后进度检查点目录清空', async () => {
    const host = memoryCheckpointHostSync();
    const summary = await runBatch(manifest, {
      runCheckpoints: { host, dir: 'ckpt', everyTicks: 10 },
    });
    expect(summary.totals).toMatchObject({ due: 2, ok: 2, failed: 0 });
    expect([...host.files.keys()].filter((key) => key.startsWith('ckpt/'))).toEqual([]);
  });

  it('非法 everyTicks/dir 拒绝', async () => {
    const host = memoryCheckpointHostSync();
    await expect(
      runBatch(manifest, { runCheckpoints: { host, dir: 'ckpt', everyTicks: 0 } }),
    ).rejects.toThrowError(/everyTicks/);
    await expect(
      runBatch(manifest, { runCheckpoints: { host, dir: '', everyTicks: 10 } }),
    ).rejects.toThrowError(/dir/);
  });
});

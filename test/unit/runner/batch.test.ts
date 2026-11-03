import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { step } from '../../../src/core/engine/engine.js';
import {
  buildBatchTasks,
  buildPerturbationTasks,
  defaultPairedSeeds,
  validateBatchManifest,
} from '../../../src/runner/batch.js';
import {
  buildCheckpointPayload,
  loadCheckpoint,
  loadCheckpointWithFallback,
  memoryCheckpointHost,
  saveCheckpoint,
  saveCheckpointWithHistory,
} from '../../../src/runner/checkpoint.js';

describe('批量 manifest 与任务生成（P5a-01/04）', () => {
  const manifest = validateBatchManifest({
    schemaVersion: 'batch-v1',
    rulesVersion: 'rules-v5',
    engineVersion: 'engine-v0.2.0',
    populationSize: 6,
    totalTicks: 40,
    policy: 'mock-weighted-v1',
    seeds: ['s1', 's2'],
    cells: [
      { cellKey: 'baseline', overrides: {} },
      { cellKey: 'threshold=0.9', overrides: { need: { threshold: 0.9 } } },
    ],
  });

  it('manifest 校验与任务笛卡尔展开', () => {
    const tasks = buildBatchTasks(manifest);
    expect(tasks).toHaveLength(4);
    expect(tasks[0]?.cellKey).toBe('baseline');
    expect(tasks[1]?.seed).toBe('s2');
    expect(tasks[2]?.cellKey).toBe('threshold=0.9');
    expect(tasks[0]?.configHash).toBe(tasks[1]?.configHash);
    expect(tasks[2]?.configHash).not.toBe(tasks[0]?.configHash);
  });

  it('非法 manifest 拒绝', () => {
    expect(() => validateBatchManifest({ schemaVersion: 'batch-v9' })).toThrowError(/版本/);
    expect(() => validateBatchManifest({ ...manifest, seeds: [] })).toThrowError(/seeds/);
    expect(() => validateBatchManifest({ ...manifest, policy: 'jev_live' })).toThrowError(/policy/);
    expect(() =>
      buildBatchTasks(
        validateBatchManifest({
          ...manifest,
          cells: [{ cellKey: 'bad', overrides: { need: { threshold: 99 } } }],
        }),
      ),
    ).toThrowError();
  });

  it('配对种子与微扰任务生成', () => {
    expect(defaultPairedSeeds(3)).toEqual(['p15-seed-001', 'p15-seed-002', 'p15-seed-003']);
    expect(() => defaultPairedSeeds(999)).toThrowError(/上限/);
    const tasks = buildPerturbationTasks(
      'baseline',
      ['s1'],
      'population.initialValue',
      [1e-4, 1e-2],
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.delta).toBe(1e-4);
  });
});

describe('原子本地检查点（P5a-03）', () => {
  it('保存后可恢复且临时文件被提升', async () => {
    const host = memoryCheckpointHost();
    const config = createDemoConfig({ population: { initialPopulation: 4 } });
    let state = createSimulation(config, asSeed('ckpt-seed'));
    const decisions = new Map(
      state.society.agents
        .filter((agent) => agent.alive)
        .map((agent) => [agent.id, { selectedAction: 'accumulate' }]),
    );
    state = step(state, decisions, { runId: 'ckpt' }).state;
    const payload = buildCheckpointPayload(
      { cellKey: 'baseline', seed: 'ckpt-seed', tickCompleted: 0, savedAtSequence: 1 },
      state,
    );
    await saveCheckpoint(host, '/ckpt/baseline-ckpt-seed.json', payload);
    expect(host.files.has('/ckpt/baseline-ckpt-seed.json.tmp')).toBe(false);
    const loaded = await loadCheckpoint(host, '/ckpt/baseline-ckpt-seed.json');
    expect(loaded.state.society.tick).toBe(1);
    expect(loaded.payload.meta.cellKey).toBe('baseline');
  });

  it('损坏检查点被拒绝且回退上一完整点', async () => {
    const host = memoryCheckpointHost();
    const config = createDemoConfig({ population: { initialPopulation: 4 } });
    let state = createSimulation(config, asSeed('ckpt-seed'));
    const decisions = new Map(
      state.society.agents
        .filter((agent) => agent.alive)
        .map((agent) => [agent.id, { selectedAction: 'accumulate' }]),
    );
    state = step(state, decisions, { runId: 'ckpt' }).state;
    const payload = buildCheckpointPayload(
      { cellKey: 'baseline', seed: 'ckpt-seed', tickCompleted: 0, savedAtSequence: 1 },
      state,
    );
    // 第 1 次保存（历史点）
    await saveCheckpointWithHistory(host, '/ckpt/a.json', payload);
    // 第 2 次保存（主点更新；历史点保留第 1 次）
    await saveCheckpointWithHistory(host, '/ckpt/a.json', payload);
    // 破坏主点
    await host.writeTemp('/ckpt/a.json', '{"schemaVersion":"checkpoint-v1","meta":{}}');
    await host.promote('/ckpt/a.json', '/ckpt/a.json');
    const recovered = await loadCheckpointWithFallback(host, '/ckpt/a.json');
    expect(recovered.fromFallback).toBe(true);
    expect(recovered.state.society.tick).toBe(1);
    // 无历史点时抛原始错误
    const host2 = memoryCheckpointHost();
    await expect(loadCheckpointWithFallback(host2, '/none.json')).rejects.toThrowError(/不存在/);
  });
});

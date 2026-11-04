import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG, createDemoConfig } from '../../../src/core/config/defaults.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { ENGINE_VERSION, RULES_VERSION } from '../../../src/core/control/versions.js';
import { errorCodes } from '../../../src/core/control/errors.js';
import { step } from '../../../src/core/engine/engine.js';
import {
  buildBatchTasks,
  buildPerturbationTasks,
  defaultPairedSeeds,
  validateBatchManifest,
  type BatchManifest,
} from '../../../src/runner/batch.js';
import {
  buildCheckpointPayload,
  loadCheckpoint,
  loadCheckpointWithFallback,
  memoryCheckpointHost,
  saveCheckpoint,
  saveCheckpointWithHistory,
} from '../../../src/runner/checkpoint.js';

const BASE_POPULATION = DEFAULT_RUN_CONFIG.population.initialPopulation;

function validManifestRecord(): Record<string, unknown> {
  return {
    schemaVersion: 'batch-v1',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    populationSize: BASE_POPULATION,
    totalTicks: 40,
    policy: 'mock-weighted-v1',
    seeds: ['s1', 's2'],
    cells: [
      { cellKey: 'baseline', overrides: {} },
      { cellKey: 'threshold=0.9', overrides: { need: { threshold: 0.9 } } },
    ],
  };
}

function withCell(cell: Record<string, unknown>): Record<string, unknown> {
  return { ...validManifestRecord(), cells: [cell] };
}

describe('批量 manifest 与任务生成（P5a-01/04）', () => {
  const manifest = validateBatchManifest(validManifestRecord());

  it('manifest 校验与任务笛卡尔展开', () => {
    const tasks = buildBatchTasks(manifest);
    expect(tasks).toHaveLength(4);
    expect(tasks[0]?.cellKey).toBe('baseline');
    expect(tasks[1]?.seed).toBe('s2');
    expect(tasks[2]?.cellKey).toBe('threshold=0.9');
    expect(tasks[0]?.configHash).toBe(tasks[1]?.configHash);
    expect(tasks[2]?.configHash).not.toBe(tasks[0]?.configHash);
    expect(tasks[0]?.config.population.initialPopulation).toBe(BASE_POPULATION);
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

  it('rulesVersion 为空或与构建不一致时拒绝', () => {
    expect(() =>
      validateBatchManifest({ ...validManifestRecord(), rulesVersion: '' }),
    ).toThrowError(expect.objectContaining({ code: errorCodes.CONFIG_INVALID }));
    expect(() =>
      validateBatchManifest({ ...validManifestRecord(), rulesVersion: 'rules-v999' }),
    ).toThrowError(expect.objectContaining({ code: errorCodes.CONFIG_UNKNOWN_VERSION }));
    expect(() => validateBatchManifest({ ...validManifestRecord(), rulesVersion: 5 })).toThrowError(
      expect.objectContaining({ code: errorCodes.CONFIG_INVALID }),
    );
  });

  it('engineVersion 为空或与构建不一致时拒绝', () => {
    expect(() =>
      validateBatchManifest({ ...validManifestRecord(), engineVersion: '' }),
    ).toThrowError(expect.objectContaining({ code: errorCodes.CONFIG_INVALID }));
    expect(() =>
      validateBatchManifest({ ...validManifestRecord(), engineVersion: 'engine-v9' }),
    ).toThrowError(expect.objectContaining({ code: errorCodes.CONFIG_UNKNOWN_VERSION }));
  });

  it('buildBatchTasks 拒绝伪造版本的 manifest', () => {
    const lying = {
      ...manifest,
      rulesVersion: 'rules-v999',
    } as unknown as BatchManifest;
    expect(() => buildBatchTasks(lying)).toThrowError(
      expect.objectContaining({ code: errorCodes.CONFIG_UNKNOWN_VERSION }),
    );
    const lyingEngine = {
      ...manifest,
      engineVersion: 'engine-v9',
    } as unknown as BatchManifest;
    expect(() => buildBatchTasks(lyingEngine)).toThrowError(
      expect.objectContaining({ code: errorCodes.CONFIG_UNKNOWN_VERSION }),
    );
  });

  it('cellKey 必须非空且唯一', () => {
    expect(() => validateBatchManifest(withCell({ cellKey: '', overrides: {} }))).toThrowError(
      /cellKey/,
    );
    expect(() => validateBatchManifest(withCell({ overrides: {} }))).toThrowError(/cellKey/);
    expect(() =>
      validateBatchManifest({
        ...validManifestRecord(),
        cells: [
          { cellKey: 'dup', overrides: {} },
          { cellKey: 'dup', overrides: {} },
        ],
      }),
    ).toThrowError(/重复/);
  });

  it('overrides 必须是纯对象且只含 RunConfig 顶层键', () => {
    expect(() => validateBatchManifest(withCell({ cellKey: 'a', overrides: [] }))).toThrowError(
      /overrides/,
    );
    expect(() => validateBatchManifest(withCell({ cellKey: 'a', overrides: null }))).toThrowError(
      /overrides/,
    );
    expect(() =>
      validateBatchManifest(withCell({ cellKey: 'a', overrides: { unknownSection: {} } })),
    ).toThrowError(/未登记/);
  });

  it('populationSize 必须等于 base config 人口，cell 不得覆盖人口', () => {
    expect(() =>
      validateBatchManifest({ ...validManifestRecord(), populationSize: BASE_POPULATION + 1 }),
    ).toThrowError(/initialPopulation/);
    expect(() =>
      validateBatchManifest(
        withCell({ cellKey: 'pop', overrides: { population: { initialPopulation: 200 } } }),
      ),
    ).toThrowError(/initialPopulation/);
  });

  it('非法 seed 在生成任务时抛错', () => {
    const withEmptySeed = validateBatchManifest({ ...validManifestRecord(), seeds: [''] });
    expect(() => buildBatchTasks(withEmptySeed)).toThrowError(
      expect.objectContaining({ code: errorCodes.ID_INVALID }),
    );
    expect(() => validateBatchManifest({ ...validManifestRecord(), seeds: [42] })).toThrowError(
      /seeds/,
    );
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
  function makePayload(sequence: number) {
    const config = createDemoConfig({ population: { initialPopulation: 4 } });
    let state = createSimulation(config, asSeed('ckpt-seed'));
    const decisions = new Map(
      state.society.agents
        .filter((agent) => agent.alive)
        .map((agent) => [agent.id, { selectedAction: 'accumulate' }]),
    );
    state = step(state, decisions, { runId: 'ckpt' }).state;
    return buildCheckpointPayload(
      { cellKey: 'baseline', seed: 'ckpt-seed', tickCompleted: 0, savedAtSequence: sequence },
      state,
    );
  }

  it('保存后可恢复且临时文件被提升', async () => {
    const host = memoryCheckpointHost();
    const payload = makePayload(1);
    await saveCheckpoint(host, '/ckpt/baseline-ckpt-seed.json', payload);
    expect(host.files.has('/ckpt/baseline-ckpt-seed.json.tmp')).toBe(false);
    const loaded = await loadCheckpoint(host, '/ckpt/baseline-ckpt-seed.json');
    expect(loaded.state.society.tick).toBe(1);
    expect(loaded.payload.meta.cellKey).toBe('baseline');
  });

  it('损坏检查点被拒绝且回退上一完整点', async () => {
    const host = memoryCheckpointHost();
    await saveCheckpointWithHistory(host, '/ckpt/a.json', makePayload(1));
    await saveCheckpointWithHistory(host, '/ckpt/a.json', makePayload(2));
    await host.writeTemp('/ckpt/a.json', '{"schemaVersion":"checkpoint-v1","meta":{}}');
    await host.promote('/ckpt/a.json', '/ckpt/a.json');
    const recovered = await loadCheckpointWithFallback(host, '/ckpt/a.json');
    expect(recovered.fromFallback).toBe(true);
    expect(recovered.state.society.tick).toBe(1);
    expect(recovered.payload.meta.savedAtSequence).toBe(1);
    const host2 = memoryCheckpointHost();
    await expect(loadCheckpointWithFallback(host2, '/none.json')).rejects.toThrowError(/不存在/);
  });
});

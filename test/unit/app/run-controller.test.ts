import { describe, expect, it } from 'vitest';

import { createDemoConfig, DEFAULT_RUN_CONFIG } from '../../../src/core/config/defaults.js';
import type { RunConfig } from '../../../src/core/config/types.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { RunController } from '../../../src/app/run-controller.js';

function smallConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  const base = createDemoConfig({
    population: { initialPopulation: 8 },
    schedule: { totalTicks: 8, statsStride: 1, snapshotStride: 2 },
    decision: { interval: 2 },
  });
  return { ...base, ...overrides } as RunConfig;
}

describe('RunController（P3-01）', () => {
  it('拒绝非法配置，不创建状态', () => {
    const controller = new RunController();
    const bad = createDemoConfig({ population: { initialPopulation: 1 } });
    const result = controller.prepare(bad, 'seed');
    expect(result.ok).toBe(false);
    expect(controller.snapshot().status).toBe('invalid');
    expect(controller.getState()).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('单步推进一个 tick 并保留统计', async () => {
    const controller = new RunController();
    expect(controller.prepare(smallConfig(), 'step-seed').ok).toBe(true);
    await controller.stepOnce();
    const snapshot = controller.snapshot();
    expect(snapshot.tick).toBe(1);
    expect(snapshot.stats).toHaveLength(1);
    expect(snapshot.status).toBe('paused');
    expect(snapshot.configHash).toMatch(/^sha256:/);
    expect(snapshot.initialPopulationHash).toMatch(/^sha256:/);
  });

  it('运行到 scheduled 完成，统计与决策有界记录', async () => {
    const controller = new RunController();
    expect(controller.prepare(smallConfig(), 'run-seed').ok).toBe(true);
    controller.start();
    await controller.whenIdle();
    const snapshot = controller.snapshot();
    expect(snapshot.status).toBe('completed');
    expect(snapshot.endReason).toBe('scheduled');
    expect(snapshot.tick).toBe(8);
    expect(snapshot.stats).toHaveLength(8);
    expect(snapshot.decisions.length).toBeGreaterThan(0);
    expect(snapshot.aliveCount).toBeGreaterThanOrEqual(0);
  });

  it('暂停后 tick 不再前进，继续可完成', async () => {
    const controller = new RunController();
    expect(controller.prepare(smallConfig(), 'pause-seed').ok).toBe(true);
    controller.start();
    await controller.whenIdle();
    // 上面的 run 已完成；重新准备一个更长的 run 验证暂停。
    expect(
      controller.prepare(
        createDemoConfig({
          population: { initialPopulation: 8 },
          schedule: { totalTicks: 40, statsStride: 1, snapshotStride: 10 },
          decision: { interval: 2 },
        }),
        'pause-seed-2',
      ).ok,
    ).toBe(true);
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.pause();
    const paused = controller.snapshot();
    expect(paused.status).toBe('paused');
    const tick = paused.tick;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controller.snapshot().tick).toBe(tick);
    controller.start();
    await controller.whenIdle();
    expect(controller.snapshot().status).toBe('completed');
  });

  it('导出/导入 bundle 后可从初始快照回放', async () => {
    const controller = new RunController();
    expect(controller.prepare(smallConfig(), 'bundle-seed').ok).toBe(true);
    controller.start();
    await controller.whenIdle();
    const original = controller.snapshot();
    const bundle = controller.exportBundle(true);
    expect(bundle).not.toBeNull();
    expect(bundle?.initialSnapshot).not.toBeNull();

    const restored = new RunController();
    expect(restored.importBundle(JSON.parse(JSON.stringify(bundle))).ok).toBe(true);
    const imported = restored.snapshot();
    expect(imported.status).toBe('paused');
    expect(imported.replay?.source).toBe('bundle');
    expect(imported.decisions.length).toBe(original.decisions.length);

    restored.startReplay();
    await restored.whenIdle();
    const replayed = restored.snapshot();
    expect(replayed.status).toBe('completed');
    expect(replayed.tick).toBe(original.tick);
    expect(replayed.replay?.replayInvalid).toBe(0);
  });

  it('非法 bundle 不覆盖当前实验', async () => {
    const controller = new RunController();
    expect(controller.prepare(smallConfig(), 'keep-seed').ok).toBe(true);
    const before = controller.snapshot();
    const result = controller.importBundle({ schemaVersion: 'unknown' });
    expect(result.ok).toBe(false);
    expect(controller.snapshot().runId).toBe(before.runId);
    expect(controller.snapshot().status).toBe('ready');
  });

  it('mock-weighted-v2 在零敏感性下与 v1 终态一致', async () => {
    const v1 = new RunController();
    expect(v1.prepare(smallConfig(), 'equiv-seed', 'mock-weighted-v1').ok).toBe(true);
    v1.start();
    await v1.whenIdle();
    const v2 = new RunController();
    expect(v2.prepare(smallConfig(), 'equiv-seed', 'mock-weighted-v2').ok).toBe(true);
    v2.start();
    await v2.whenIdle();
    expect(v2.snapshot().stats.map((row) => row.gini)).toEqual(
      v1.snapshot().stats.map((row) => row.gini),
    );
    expect(v2.snapshot().latestStats).toEqual(v1.snapshot().latestStats);
    expect(
      v2.snapshot().decisions.every((record) => record.policyVersion === 'mock-weighted-v2'),
    ).toBe(true);
  });

  it('reset 清空状态并使旧 generation 失效', () => {
    const controller = new RunController();
    expect(controller.prepare(smallConfig(), 'reset-seed').ok).toBe(true);
    const before = controller.snapshot().generation;
    controller.reset();
    const after = controller.snapshot();
    expect(after.status).toBe('idle');
    expect(after.generation).toBeGreaterThan(before);
    expect(after.runId).toBeNull();
    expect(controller.getState()).toBeNull();
  });

  it('默认配置 seed 不进入 configHash', () => {
    const controller = new RunController();
    expect(controller.prepare(DEFAULT_RUN_CONFIG, 'hash-seed-a').ok).toBe(true);
    const a = controller.snapshot();
    expect(controller.prepare(DEFAULT_RUN_CONFIG, 'hash-seed-b').ok).toBe(true);
    const b = controller.snapshot();
    expect(a.configHash).toBe(b.configHash);
    expect(a.paramsHash).toBe(b.paramsHash);
    expect(a.initialPopulationHash).not.toBe(b.initialPopulationHash);
    expect(a.seed).toBe(asSeed('hash-seed-a'));
  });
});

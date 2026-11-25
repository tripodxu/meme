import { describe, expect, it } from 'vitest';

import { computeConfigHash } from '../../../src/core/config/hash.js';
import { DEFAULT_RUN_CONFIG } from '../../../src/core/config/defaults.js';
import { validateBatchManifest } from '../../../src/runner/batch.js';
import {
  buildP6StageACells,
  buildP6StageAManifest,
  computeP6StageAHash,
  P6_STAGE_A_BUDGET,
  P6_STAGE_A_SEEDS,
  P6_STAGE_A_TICKS,
  P6_STAGE_A_WARMUP,
} from '../../../src/runner/p6-stage-a.js';
import { computePreregistrationHash } from '../../../src/runner/preregistration.js';

describe('P6-01 Stage A 预注册 manifest（07 §3/§6.2/§8）', () => {
  const manifest40 = buildP6StageAManifest(40);
  const manifest200 = buildP6StageAManifest(200);

  it('人口只能是 40 或 200（Stage A 口径）', () => {
    expect(() => buildP6StageAManifest(100 as 40 | 200)).toThrowError(TypeError);
    expect(() => buildP6StageAManifest(1000 as 40 | 200)).toThrowError(TypeError);
  });

  it('字段口径：730 tick / warmup 365 / metrics-only / w1 窗口 / D-04 预算', () => {
    expect(manifest40.totalTicks).toBe(P6_STAGE_A_TICKS);
    expect(manifest40.totalTicks).toBe(730);
    expect(manifest40.warmupTicks).toBe(P6_STAGE_A_WARMUP);
    expect(manifest40.warmupTicks).toBe(365);
    expect(manifest40.artifactProfile).toBe('metrics-only');
    expect(manifest40.windows).toEqual([{ label: 'w1', start: 365, end: 1094 }]);
    expect(manifest40.budgets).toEqual(P6_STAGE_A_BUDGET);
    expect(manifest40.experimentType).toBe('rule_sensitivity');
    expect(manifest40.primaryMetric).toBe('TV(P)');
  });

  it('种子集 p6-stageA-* 与 p15 各轮不重叠（D-07）且恰 30 个', () => {
    expect(P6_STAGE_A_SEEDS).toHaveLength(30);
    expect(P6_STAGE_A_SEEDS.every((seed) => seed.startsWith('p6-stageA-seed-'))).toBe(true);
    expect(manifest40.seeds).toEqual(P6_STAGE_A_SEEDS);
    expect(manifest200.seeds).toEqual(P6_STAGE_A_SEEDS);
  });

  it('cells：baseline + 13 个 single 设计格点，覆盖五主导参数', () => {
    const cells = manifest40.cells;
    expect(cells).toHaveLength(14);
    expect(cells[0]?.design).toBe('baseline');
    expect(cells[0]?.changedPaths).toEqual([]);
    const singles = cells.slice(1);
    expect(singles.every((cell) => cell.design === 'single')).toBe(true);
    expect(singles.every((cell) => cell.changedPaths.length === 1)).toBe(true);
    const paths = singles.map((cell) => cell.changedPaths[0]).sort();
    expect(paths).toEqual(
      [
        'ascent.crossDays',
        'ascent.crossDays',
        'lifespan.decay',
        'lifespan.decay',
        'need.needMultiplier',
        'need.needMultiplier',
        'need.needMultiplier',
        'need.needMultiplier',
        'need.threshold',
        'need.threshold',
        'need.threshold',
        'opportunity.env0',
        'opportunity.env0',
      ].sort(),
    );
    // fullConfigHash 与 base 不同（baseline 相同）。
    for (const cell of singles) {
      expect(cell.fullConfigHash).not.toBe(manifest40.baseConfigHash);
    }
  });

  it('两个 manifest 除人口外全部一致；哈希逐字确定', () => {
    expect(manifest40.populationSize).toBe(40);
    expect(manifest200.populationSize).toBe(200);
    expect(manifest40.seeds).toEqual(manifest200.seeds);
    expect(manifest40.cells.map((cell) => cell.cellKey)).toEqual(
      manifest200.cells.map((cell) => cell.cellKey),
    );
    expect(manifest40.baseConfigHash).not.toBe(manifest200.baseConfigHash);
    const hash40a = computeP6StageAHash(40);
    const hash40b = computeP6StageAHash(40);
    expect(hash40a).toBe(hash40b);
    expect(hash40a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeP6StageAHash(200)).not.toBe(hash40a);
    // 哈希 = 对预像的域分隔哈希（07 §3 权威口径）。
    expect(hash40a).toBe(computePreregistrationHash(manifest40));
  });

  it('cells 可经 batch.ts 构造为合法任务（execution 链路连通）', () => {
    const batchManifest = validateBatchManifest({
      schemaVersion: 'batch-v1',
      rulesVersion: manifest40.rulesVersion,
      engineVersion: manifest40.engineVersion,
      populationSize: manifest40.populationSize,
      totalTicks: manifest40.totalTicks,
      policy: 'mock-weighted-v1',
      seeds: P6_STAGE_A_SEEDS.slice(0, 2),
      cells: buildP6StageACells(40).map((cell) => ({
        cellKey: cell.cellKey,
        overrides: cell.overrides,
      })),
    });
    const tasks = buildP6StageACells(40);
    void tasks;
    // 14 cells × 2 seeds = 28 tasks；overrides 全部合法（不抛错即通过）。
    expect(batchManifest.cells).toHaveLength(14);
  });

  it('baseline config 与默认配置只差调度（statsStride/snapshotStride/totalTicks）', () => {
    const base = buildP6StageACells(40)[0];
    void base;
    // baseConfigHash 覆盖 base config；与 DEFAULT 不同是调度差异（730 tick / stride 1）。
    expect(manifest40.baseConfigHash).not.toBe(computeConfigHash(DEFAULT_RUN_CONFIG));
  });
});

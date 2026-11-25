import { describe, expect, it } from 'vitest';

import {
  buildP6StageBManifest,
  computeP6StageBHash,
  isP6StageBCandidate,
  P6_STAGE_B_BUDGET,
  P6_STAGE_B_CANDIDATES,
  P6_STAGE_B_POPULATION,
  P6_STAGE_B_SEEDS,
  P6_STAGE_B_TICKS,
  P6_STAGE_B_WARMUP,
} from '../../../src/runner/p6-stage-b.js';
import { P6_STAGE_A_SEEDS } from '../../../src/runner/p6-stage-a.js';

describe('P6-01 Stage B 确认 manifest（07 §8）', () => {
  it('候选集合与识别函数一致（6 个 Stage A 候选）', () => {
    expect(P6_STAGE_B_CANDIDATES).toHaveLength(6);
    for (const candidate of P6_STAGE_B_CANDIDATES) {
      expect(isP6StageBCandidate(candidate.cellKey)).toBe(true);
    }
    expect(isP6StageBCandidate('baseline')).toBe(false);
    expect(isP6StageBCandidate('unknown=1')).toBe(false);
  });

  it('每个候选 manifest 只含 baseline + 该候选，且 changedPaths 与声明轴一致', () => {
    const expectedPaths: Record<string, string> = {
      'env0=expanded': 'opportunity.env0',
      'env0=compressed': 'opportunity.env0',
      'crossDays=half': 'ascent.crossDays',
      'crossDays=double': 'ascent.crossDays',
      'psi=1': 'need.needMultiplier',
      'needThreshold=0.9': 'need.threshold',
    };
    for (const candidate of P6_STAGE_B_CANDIDATES) {
      const manifest = buildP6StageBManifest(candidate.cellKey);
      expect(manifest.cells).toHaveLength(2);
      expect(manifest.cells[0]).toMatchObject({
        cellKey: 'baseline',
        design: 'baseline',
        changedPaths: [],
      });
      expect(manifest.cells[1]).toMatchObject({
        cellKey: candidate.cellKey,
        design: 'single',
        changedPaths: [expectedPaths[candidate.cellKey]],
      });
    }
  });

  it('人口、视野、种子与预算按冻结口径进入 manifest', () => {
    const manifest = buildP6StageBManifest('needThreshold=0.9');
    expect(manifest.populationSize).toBe(P6_STAGE_B_POPULATION);
    expect(manifest.totalTicks).toBe(P6_STAGE_B_TICKS);
    expect(manifest.warmupTicks).toBe(P6_STAGE_B_WARMUP);
    expect(manifest.seeds).toEqual(P6_STAGE_B_SEEDS);
    expect(manifest.seeds).toHaveLength(30);
    expect(manifest.budgets).toEqual(P6_STAGE_B_BUDGET);
    expect(manifest.primaryMetric).toBe('TV(P)');
    // D-07：确认种子不得复用 Stage A 筛查种子。
    expect(P6_STAGE_B_SEEDS.some((seed) => P6_STAGE_A_SEEDS.includes(seed))).toBe(false);
  });

  it('未知候选响亮报错', () => {
    expect(() => buildP6StageBManifest('needThreshold=0.99')).toThrowError(
      /未知 Stage B 候选 cell/,
    );
  });

  it('每个候选的预注册哈希确定且互不相同', () => {
    const hashes = P6_STAGE_B_CANDIDATES.map((candidate) => computeP6StageBHash(candidate.cellKey));
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(hashes.every((hash) => /^sha256:[0-9a-f]{64}$/.test(hash))).toBe(true);
    expect(computeP6StageBHash('needThreshold=0.9')).toBe(computeP6StageBHash('needThreshold=0.9'));
  });
});

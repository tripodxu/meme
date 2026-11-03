import { describe, expect, it } from 'vitest';

import {
  adjustedRandIndex,
  wardCluster,
  wardClusterReference,
  wardClusterReferenceWithCosts,
  wardClusterWithCosts,
} from '../../../src/runner/cluster.js';

/**
 * W0-1 验收（`2026-11-03-p15-w0-w1-handoff.md` §2）：
 * 1. 无并列数据集上 `ARI(新, 参考) = 1.0`（数据刻意留出 >1e-6 的合并代价间隔）；
 * 2. 合并代价序列逐项相对误差 <= 1e-12；
 * 3. 1680 点 × k∈[2,5] 单次 < 60 s。
 * 两个数学等价的 Ward 实现在合并代价接近 1 ulp 时**允许**给出不同划分
 * （07 §8.1 实现敏感性），所以验收不是"划分逐位一致"。
 */

/** 确定性 LCG（仅测试数据生成用；非仿真 RNG）。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * 无并列数据集一：指数间隔 1 维点。
 * 相邻间隔按 2 的幂增长，任何合并的 SSE 增量都远大于其余候选（间隔 >> 1e-6）。
 */
function exponentialPoints(count: number): number[][] {
  return Array.from({ length: count }, (_, i) => [2 ** i]);
}

/**
 * 无并列数据集二：3 团 × 20 点的确定性抖动数据。
 * 团间距 100，团内抖动 <=1；跨团候选代价 >= 数千，团内候选 <=2，
 * 代价间隔远大于 1e-6；LCG 使坐标各不相同，避免并列。
 */
function blobPoints(): number[][] {
  const next = lcg(20261103);
  const centers: readonly (readonly [number, number])[] = [
    [0, 0],
    [100, 0],
    [0, 100],
  ];
  const points: number[][] = [];
  for (const [cx, cy] of centers) {
    for (let i = 0; i < 20; i += 1) {
      points.push([cx + next() * 2 - 1, cy + next() * 2 - 1]);
    }
  }
  return points;
}

/** 逐项相对误差（0/0 视为一致）。 */
function maxRelativeError(a: readonly number[], b: readonly number[]): number {
  expect(a).toHaveLength(b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x === 0 && y === 0) {
      continue;
    }
    const scale = Math.max(Math.abs(x), Math.abs(y));
    const error = Math.abs(x - y) / scale;
    if (error > worst) {
      worst = error;
    }
  }
  return worst;
}

describe('Ward Lance–Williams 与朴素参考实现的等价性（W0-1）', () => {
  const datasets = [
    { name: '指数间隔 1 维', points: exponentialPoints(12) },
    { name: '3 团确定性抖动', points: blobPoints() },
  ];

  for (const dataset of datasets) {
    for (const k of [2, 3, 4, 5] as const) {
      it(`${dataset.name}: k=${k} 无并列数据上 ARI(新, 参考)=1.0 且代价序列一致`, () => {
        const lw = wardClusterWithCosts(dataset.points, k);
        const reference = wardClusterReferenceWithCosts(dataset.points, k);
        expect(adjustedRandIndex(lw.assignment, reference.assignment)).toBe(1);
        expect(maxRelativeError(lw.mergeCosts, reference.mergeCosts)).toBeLessThanOrEqual(1e-12);
        // 同一实现的代价序列必须与划分自洽：代价单调不减（Ward 聚合性质）。
        for (let i = 1; i < lw.mergeCosts.length; i += 1) {
          expect(lw.mergeCosts[i]).toBeGreaterThanOrEqual((lw.mergeCosts[i - 1] ?? 0) - 1e-9);
        }
      });
    }
  }

  it('两个实现的划分在近并列数据上允许分歧，但代价序列仍逐项一致（07 §8.1 已知现象）', () => {
    // 07 §8.1 记录的现象：60 点 3 团数据在 k=4 时两实现可因 1 ulp 近并列分歧。
    // 本用例只要求代价序列等价与结构性性质，不要求划分一致。
    const next = lcg(20261104);
    const points: number[][] = [];
    const centers: readonly (readonly [number, number])[] = [
      [0, 0],
      [50, 0],
      [0, 50],
    ];
    for (const [cx, cy] of centers) {
      for (let i = 0; i < 20; i += 1) {
        points.push([cx + next() * 2 - 1, cy + next() * 2 - 1]);
      }
    }
    const lw = wardClusterWithCosts(points, 4);
    const reference = wardClusterReferenceWithCosts(points, 4);
    expect(lw.mergeCosts).toHaveLength(reference.mergeCosts.length);
    expect(maxRelativeError(lw.mergeCosts, reference.mergeCosts)).toBeLessThanOrEqual(1e-9);
  });

  it('k 与 n 参数校验与参考实现一致', () => {
    const points = [[0], [1], [2]];
    expect(() => wardCluster(points, 0)).toThrowError(/k 必须位于/);
    expect(() => wardCluster(points, 4)).toThrowError(/k 必须位于/);
    expect(() => wardClusterReference(points, 0)).toThrowError(/k 必须位于/);
    expect(() => wardClusterReference(points, 4)).toThrowError(/k 必须位于/);
  });

  it('边界：k=1 全并入一簇，k=n 各自成簇，单点输入合法', () => {
    const points = blobPoints();
    expect(new Set(wardCluster(points, 1)).size).toBe(1);
    const perPoint = wardCluster(points, points.length);
    expect(new Set(perPoint).size).toBe(points.length);
    expect(wardCluster([[1]], 1)).toEqual([0]);
    expect(wardClusterWithCosts([[1]], 1).mergeCosts).toEqual([]);
    expect(wardClusterReference(points, 1).length).toBe(points.length);
  });
});

describe('Ward Lance–Williams 性能（W0-1 验收 3）', () => {
  // 1680 点 = P1.5 全量网格的特征点规模（28 cell × 30 seed × 2 窗口）。
  function largePoints(count: number): number[][] {
    const next = lcg(20261105);
    const dims = 9; // featureVector 维度（P×5 + G + top10 + Mup + S...）
    return Array.from({ length: count }, () => Array.from({ length: dims }, () => next()));
  }

  it('1680 点 × k=2 与 k=5 单次 < 60 s', { timeout: 150_000 }, async () => {
    const { performance } = await import('node:perf_hooks');
    const points = largePoints(1680);
    for (const k of [2, 5] as const) {
      const start = performance.now();
      const assignment = wardCluster(points, k);
      const elapsedMs = performance.now() - start;
      console.log(`[ward-lw] n=1680 k=${k}: ${Math.round(elapsedMs)}ms`);
      expect(assignment).toHaveLength(1680);
      expect(elapsedMs).toBeLessThan(60_000);
    }
  });
});

import { describe, expect, it } from 'vitest';

import {
  clusterCentroids,
  clusterComposition,
  clusterSizes,
  evaluateP6ClusterVerdict,
  minimumCentroidDistance,
  structuralFeatureVector,
  temporalSameClusterRate,
} from '../../../src/runner/p6-cluster-summary.js';
import type { WindowSummary } from '../../../src/runner/window-stats.js';

const window: WindowSummary = {
  label: 'w3',
  start: 10585,
  end: 10949,
  tickCount: 365,
  missingTicks: 0,
  observedTicks: 365,
  deadTicks: 0,
  classShares: [0.55, 0.35, 0.09, 0.01, 0],
  gini: 0.47,
  topWealthShare: 0.4,
  mUp: 0.5,
  mDown: 0.48,
  segregation: 0.06,
  openness: 0.62,
  eByClass: [1, 1, 1, 1, 1],
  medianValue: 10,
  aliveTickAverage: 39,
  deathRate: 0.001,
  competitionLossRate: 0.01,
  fallbackRate: 0,
  flowCounts: [],
  flowRowRates: [],
  networkEmpty: false,
  edgeCountAverage: 100,
  crossClassEdgeShare: 0.3,
  avgDegree: 5,
  connectedComponents: 1,
  blocks30d: [],
  partialBlockMerged: false,
};

describe('structuralFeatureVector', () => {
  it('按 07 §8.1 顺序返回 11 维特征', () => {
    expect(structuralFeatureVector(window)).toEqual([
      0.55, 0.35, 0.09, 0.01, 0, 0.47, 0.4, 0.5, 0.48, 0.06, 0.62,
    ]);
  });
});

describe('clusterComposition', () => {
  it('按簇统计各 cell 的 run 数', () => {
    const composition = clusterComposition([0, 0, 1, 1, 2], ['A', 'B', 'A', 'C', 'B'], 3);
    expect(composition[0]).toEqual({ cluster: 0, total: 2, cells: { A: 1, B: 1 } });
    expect(composition[1]).toEqual({ cluster: 1, total: 2, cells: { A: 1, C: 1 } });
    expect(composition[2]).toEqual({ cluster: 2, total: 1, cells: { B: 1 } });
  });

  it('长度不一致时抛错', () => {
    expect(() => clusterComposition([0], ['A', 'B'], 2)).toThrow(TypeError);
  });
});

describe('clusterSizes', () => {
  it('统计每簇大小并忽略越界分配', () => {
    expect(clusterSizes([0, 0, 1, 2, 5], 3)).toEqual([2, 1, 1]);
  });
});

describe('clusterCentroids', () => {
  it('按簇求原始特征质心', () => {
    const centroids = clusterCentroids(
      [
        [0, 2],
        [2, 4],
        [10, 10],
      ],
      [0, 0, 1],
      2,
    );
    expect(centroids).toEqual([
      [1, 3],
      [10, 10],
    ]);
  });
});

describe('minimumCentroidDistance', () => {
  it('返回两两最小欧氏距离', () => {
    expect(
      minimumCentroidDistance([
        [0, 0],
        [3, 4],
        [10, 0],
      ]),
    ).toBeCloseTo(5, 12);
  });
});

describe('temporalSameClusterRate', () => {
  it('统计同簇比例', () => {
    expect(temporalSameClusterRate([0, 1, 2], [0, 1, 1])).toBeCloseTo(2 / 3, 12);
  });

  it('长度不一致时抛错', () => {
    expect(() => temporalSameClusterRate([0], [0, 1])).toThrow(TypeError);
  });
});

describe('evaluateP6ClusterVerdict', () => {
  const base = {
    k: 3,
    ariMedian: 0.9,
    ariMin: 0.8,
    silhouette: 0.5,
    sizes: [10, 10, 10],
    composition: [
      { cluster: 0, total: 10, cells: { A: 5, B: 5 } },
      { cluster: 1, total: 10, cells: { C: 5, D: 5 } },
      { cluster: 2, total: 10, cells: { E: 5, F: 5 } },
    ],
    temporalRate: 0.9,
    extinctRate: 0,
    minClusterRuns: 5,
    minAri: 0.7,
    minSilhouette: 0.35,
    minTemporalRate: 0.8,
  };

  it('全部满足时通过', () => {
    const verdict = evaluateP6ClusterVerdict(base);
    expect(verdict.passes).toBe(true);
    expect(verdict.antiPreset).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it('三簇与三个 cell 一一对应时拒绝', () => {
    const verdict = evaluateP6ClusterVerdict({
      ...base,
      composition: [
        { cluster: 0, total: 10, cells: { A: 10 } },
        { cluster: 1, total: 10, cells: { B: 10 } },
        { cluster: 2, total: 10, cells: { C: 10 } },
      ],
    });
    expect(verdict.passes).toBe(false);
    expect(verdict.antiPreset).toBe(false);
  });

  it('ARI、轮廓、时序、灭绝率不达标时逐条报告', () => {
    const verdict = evaluateP6ClusterVerdict({
      ...base,
      ariMedian: 0.5,
      silhouette: 0.2,
      temporalRate: 0.5,
      extinctRate: 0.2,
    });
    expect(verdict.passes).toBe(false);
    expect(verdict.reasons).toHaveLength(4);
  });

  it('簇过小时拒绝', () => {
    const verdict = evaluateP6ClusterVerdict({ ...base, sizes: [10, 10, 4] });
    expect(verdict.passes).toBe(false);
    expect(verdict.reasons.some((reason) => reason.includes('簇大小'))).toBe(true);
  });
});

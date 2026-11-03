import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import type { TickStats } from '../../../src/core/macros/tick-metrics.js';
import { summarizeWindow } from '../../../src/runner/window-stats.js';
import { evaluateLabels } from '../../../src/runner/labels.js';
import {
  structuralDistance,
  totalVariation,
  meetsInitialDifference,
} from '../../../src/runner/distance.js';
import {
  adjustedRandIndex,
  bisectStability,
  chooseKBySilhouette,
  fitStandardizer,
  meetsMinClusterSize,
  minClusterSize,
  seededShuffle,
  silhouetteScore,
  standardizeWith,
  wardCluster,
  zScoreMatrix,
} from '../../../src/runner/cluster.js';
import { deriveExtinct, runSingle } from '../../../src/runner/run-cell.js';
import { ANALYSIS_WINDOWS, type WindowSummary } from '../../../src/runner/window-stats.js';

const SEED = asSeed('runner-seed');

function makeStatsRow(tick: number, overrides: Partial<TickStats> = {}): TickStats {
  return {
    tick,
    aliveCount: 10,
    classCounts: [5, 3, 2, 0, 0],
    gini: 0.3,
    medianValue: 1,
    topWealthShare: 0.2,
    mUp: 0.1,
    mDown: 0.05,
    segregation: 0.2,
    edgeCount: 12,
    openness: 0.5,
    deathCount: 0,
    competitionLoss: 0,
    competitionGain: 0,
    fallbackRate: null,
    eByClass: [1, 1.5, 2.2, 3.2, 4.5],
    crossClassEdgeShare: 0.4,
    avgDegree: 2.4,
    connectedComponents: 1,
    flowMatrix: [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ],
    ...overrides,
  };
}

function makeWindow(overrides: Partial<WindowSummary> = {}): WindowSummary {
  return {
    label: 'w1',
    start: 365,
    end: 1094,
    tickCount: 730,
    missingTicks: 0,
    observedTicks: 730,
    deadTicks: 0,
    classShares: [0.5, 0.25, 0.15, 0.08, 0.02],
    gini: 0.35,
    topWealthShare: 0.3,
    mUp: 0.1,
    mDown: 0.08,
    segregation: 0.3,
    openness: 0.5,
    eByClass: [1, 1.5, 2.2, 3.2, 4.5],
    medianValue: 2,
    aliveTickAverage: 40,
    deathRate: 0.02,
    competitionLossRate: 0.1,
    fallbackRate: null,
    flowCounts: [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ],
    flowRowRates: [
      [null, 0, 0, 0, 0],
      [0, null, 0, 0, 0],
      [0, 0, null, 0, 0],
      [0, 0, 0, null, 0],
      [0, 0, 0, 0, null],
    ],
    networkEmpty: false,
    edgeCountAverage: 50,
    crossClassEdgeShare: 0.4,
    avgDegree: 2.5,
    connectedComponents: 1,
    blocks30d: [],
    partialBlockMerged: false,
    ...overrides,
  };
}

describe('窗口聚合（07 §5）', () => {
  it('窗口日均值与缺失日计数正确', () => {
    const config = createDemoConfig();
    const stats = [
      makeStatsRow(364, { gini: 0.2, classCounts: [8, 2, 0, 0, 0] }),
      makeStatsRow(365, { gini: 0.3 }),
      makeStatsRow(366, { gini: 0.5 }),
    ];
    const summary = summarizeWindow(
      { config, stats, flowsByTick: new Map(), decisionsByTick: new Map() },
      'w1',
      365,
      366,
    );
    expect(summary.tickCount).toBe(2);
    expect(summary.gini).toBeCloseTo(0.4, 12);
    expect(summary.classShares[0]).toBeCloseTo(0.5, 12);
    // 期初暴露：tick 365 用 tick 364 的行（8 人 class0）>0，无转移 → 行率 0（非 null）
    expect(summary.flowRowRates[0]?.[1]).toBe(0);
  });

  it('行暴露量为 0 时转移率为 null 而非 0', () => {
    const config = createDemoConfig();
    const stats = [
      makeStatsRow(364, { aliveCount: 0, classCounts: [0, 0, 0, 0, 0] }),
      makeStatsRow(365),
    ];
    const flows = new Map([
      [
        365,
        [
          [0, 1, 0, 0, 0],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
        ],
      ],
    ]);
    const summary = summarizeWindow(
      { config, stats, flowsByTick: flows, decisionsByTick: new Map() },
      'w1',
      365,
      365,
    );
    // tick 364 全死亡 → tick 365 期初行人数全 0 → 行率 null
    expect(summary.flowRowRates[0]?.[1]).toBeNull();
    expect(summary.missingTicks).toBe(0);
  });

  it('30 日块末尾残块并入前一块并标记 partialBlockMerged', () => {
    const config = createDemoConfig();
    const stats: TickStats[] = [];
    for (let tick = 364; tick <= 400; tick += 1) {
      stats.push(makeStatsRow(tick));
    }
    // 窗口 365..400 = 36 日 → 30 日块 + 6 日残块 → 并入前一块
    const summary = summarizeWindow(
      { config, stats, flowsByTick: new Map(), decisionsByTick: new Map() },
      'w1',
      365,
      400,
    );
    expect(summary.partialBlockMerged).toBe(true);
    expect(summary.blocks30d).toHaveLength(1);
    expect(summary.blocks30d[0]?.start).toBe(365);
  });

  it('全死亡 tick 不补入结构均值，计入 missingTicks/deadTicks（07 §5）', () => {
    const config = createDemoConfig();
    const stats = [
      makeStatsRow(364),
      makeStatsRow(365, { classCounts: [5, 5, 0, 0, 0] }),
      makeStatsRow(366, { classCounts: [5, 5, 0, 0, 0] }),
      // 末 tick 才全死亡：行存在但 aliveCount=0，P=0 不得补入均值
      makeStatsRow(367, { aliveCount: 0, classCounts: [0, 0, 0, 0, 0], deathCount: 10 }),
    ];
    const summary = summarizeWindow(
      { config, stats, flowsByTick: new Map(), decisionsByTick: new Map() },
      'w1',
      365,
      367,
    );
    expect(summary.observedTicks).toBe(3);
    expect(summary.deadTicks).toBe(1);
    expect(summary.missingTicks).toBe(1);
    expect(summary.tickCount).toBe(2);
    // 若把全死亡日当 P=0 计入，class0 会变成 0.333；正确值是 0.5
    expect(summary.classShares[0]).toBeCloseTo(0.5, 12);
    expect(summary.classShares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('窗口内全死亡时返回不可用摘要（missingTicks 覆盖整窗）', () => {
    const config = createDemoConfig();
    const stats = [makeStatsRow(365, { aliveCount: 0, classCounts: [0, 0, 0, 0, 0] })];
    const summary = summarizeWindow(
      { config, stats, flowsByTick: new Map(), decisionsByTick: new Map() },
      'w1',
      365,
      366,
    );
    expect(summary.tickCount).toBe(0);
    expect(summary.missingTicks).toBe(2);
    expect(summary.deadTicks).toBe(1);
  });

  it('networkEmpty 按整窗判定，不被末行掩护', () => {
    const config = createDemoConfig();
    const stats = [makeStatsRow(365, { edgeCount: 20 }), makeStatsRow(366, { edgeCount: 0 })];
    const summary = summarizeWindow(
      { config, stats, flowsByTick: new Map(), decisionsByTick: new Map() },
      'w1',
      365,
      366,
    );
    // 末行 edgeCount=0 但整窗有边 → 不是空网络
    expect(summary.networkEmpty).toBe(false);
  });

  it('全窗口无边才标 networkEmpty', () => {
    const config = createDemoConfig();
    const stats = [makeStatsRow(365, { edgeCount: 0 }), makeStatsRow(366, { edgeCount: 0 })];
    const summary = summarizeWindow(
      { config, stats, flowsByTick: new Map(), decisionsByTick: new Map() },
      'w1',
      365,
      366,
    );
    expect(summary.networkEmpty).toBe(true);
  });
});

describe('结构标签（07 §10）', () => {
  it('金字塔形态命中 pyramid', () => {
    const window = makeWindow({ classShares: [0.45, 0.28, 0.17, 0.08, 0.02], gini: 0.35 });
    const result = evaluateLabels(window);
    expect(result.labels).toContain('pyramid');
  });

  it('橄榄形态命中 olive', () => {
    const window = makeWindow({ classShares: [0.15, 0.3, 0.35, 0.15, 0.05], gini: 0.3 });
    const result = evaluateLabels(window);
    expect(result.labels).toContain('olive');
  });

  it('两极化命中 bipolar', () => {
    const window = makeWindow({ classShares: [0.45, 0.08, 0.08, 0.08, 0.31], gini: 0.5 });
    const result = evaluateLabels(window);
    expect(result.labels).toContain('bipolar');
  });

  it('封闭分层命中 closedStratified（块支持 >=0.8）', () => {
    const block = {
      start: 365,
      gini: 0.3,
      openness: 0.1,
      mUp: 0.02,
      segregation: 0.8,
      edgeCountAverage: 50,
      classShares: [0.6, 0.2, 0.1, 0.08, 0.02],
    };
    const window = makeWindow({
      classShares: [0.6, 0.2, 0.1, 0.08, 0.02],
      openness: 0.1,
      mUp: 0.02,
      segregation: 0.8,
      edgeCountAverage: 50,
      blocks30d: Array.from({ length: 5 }, (_, i) => ({ ...block, start: 365 + i * 30 })),
    });
    const result = evaluateLabels(window);
    expect(result.labels).toContain('closedStratified');
  });

  it('封闭分层按块内三指标判定，整窗均值不能替代（07 §10）', () => {
    // 整窗 Mup 很低（0.02），但 10 个块里有 3 个块 Mup 超标 → 块支持率 0.70 < 0.80。
    // 旧实现用整窗 Mup 判定，会让这 3 个块也「成立」，误判为 closedStratified。
    const blocks = Array.from({ length: 10 }, (_, i) => ({
      start: 365 + i * 30,
      gini: 0.3,
      openness: 0.1,
      mUp: i < 3 ? 0.3 : 0.02,
      segregation: 0.8,
      edgeCountAverage: 50,
      classShares: [0.6, 0.2, 0.1, 0.08, 0.02],
    }));
    const window = makeWindow({
      classShares: [0.6, 0.2, 0.1, 0.08, 0.02],
      openness: 0.1,
      mUp: 0.02,
      segregation: 0.8,
      edgeCountAverage: 50,
      blocks30d: blocks,
    });
    const result = evaluateLabels(window);
    expect(result.labels).not.toContain('closedStratified');
    expect(result.evidence['closedStratified']).toContain('blockSupport=0.70');
  });

  it('networkEmpty 窗口不参与依赖 S 的标签', () => {
    const block = {
      start: 365,
      gini: 0.3,
      openness: 0.1,
      mUp: 0.02,
      segregation: 0.8,
      edgeCountAverage: 0,
      classShares: [0.6, 0.2, 0.1, 0.08, 0.02],
    };
    const window = makeWindow({
      classShares: [0.6, 0.2, 0.1, 0.08, 0.02],
      openness: 0.1,
      mUp: 0.02,
      segregation: 0.8,
      edgeCountAverage: 0,
      networkEmpty: true,
      blocks30d: Array.from({ length: 5 }, (_, i) => ({ ...block, start: 365 + i * 30 })),
    });
    const result = evaluateLabels(window);
    expect(result.labels).not.toContain('closedStratified');
    expect(result.evidence['networkEmpty']).toContain('edgeCount=0');
  });

  it('高流动网络命中 highFlowNetwork', () => {
    const window = makeWindow({
      mUp: 0.3,
      openness: 0.8,
      segregation: -0.1,
      crossClassEdgeShare: 0.5,
    });
    const result = evaluateLabels(window);
    expect(result.labels).toContain('highFlowNetwork');
  });

  it('顶层过重命中 topHeavy 且不算 pyramid/olive', () => {
    const window = makeWindow({ classShares: [0.2, 0.1, 0.1, 0.1, 0.5], gini: 0.55 });
    const result = evaluateLabels(window);
    expect(result.labels).toContain('topHeavy');
    expect(result.labels).not.toContain('pyramid');
    expect(result.labels).not.toContain('olive');
  });

  it('无命中为未归类；缺失窗口不参与判异', () => {
    const mid = makeWindow({
      classShares: [0.3, 0.25, 0.2, 0.15, 0.1],
      gini: 0.33,
      mUp: 0.12,
      openness: 0.5,
      segregation: 0.25,
      crossClassEdgeShare: 0.3,
    });
    expect(evaluateLabels(mid).unclassified).toBe(true);
    const missing = makeWindow({ missingTicks: 10 });
    const result = evaluateLabels(missing);
    expect(result.unclassified).toBe(true);
    expect(result.labels).toEqual([]);
  });
});

describe('结构距离与门槛（07 §8）', () => {
  it('D 公式与 TV(P) 逐项一致', () => {
    const a = makeWindow({});
    const b = makeWindow({
      gini: 0.4,
      classShares: [0.4, 0.3, 0.15, 0.1, 0.05],
      mUp: 0.15,
      segregation: 0.2,
      openness: 0.55,
    });
    const tv = totalVariation(a.classShares, b.classShares);
    const expected = 0.3 * 0.05 + 0.25 * tv + 0.2 * 0.05 + 0.15 * 0.1 + 0.1 * 0.05;
    expect(structuralDistance(a, b)).toBeCloseTo(expected, 12);
  });

  it('TV(P) 阶级数不同抛错；门槛判定可用', () => {
    expect(() => totalVariation([0.5, 0.5], [1])).toThrowError();
    const a = makeWindow({});
    const same = makeWindow({});
    expect(meetsInitialDifference(a, same).met).toBe(false);
    const far = makeWindow({ gini: 0.6 });
    expect(meetsInitialDifference(a, far).met).toBe(true);
  });
});

describe('聚类协议（07 §8.1，D-03 默认建议）', () => {
  const groupA = [
    [0, 0],
    [0.1, 0],
    [0, 0.1],
    [0.1, 0.1],
  ];
  const groupB = [
    [5, 5],
    [5.1, 5],
    [5, 5.1],
    [5.1, 5.1],
  ];

  it('两组分离数据 k=2 且轮廓系数高', () => {
    const points = [...groupA, ...groupB];
    const z = zScoreMatrix(points);
    const choice = chooseKBySilhouette(z);
    expect(choice.k).toBe(2);
    expect(choice.score).toBeGreaterThan(0.5);
    const clusters = new Set(choice.assignment);
    expect(clusters.size).toBe(2);
  });

  it('ARI 完全一致为 1、随机为低值', () => {
    expect(adjustedRandIndex([0, 0, 1, 1], [1, 1, 0, 0])).toBe(1);
    expect(adjustedRandIndex([0, 0, 1, 1], [0, 1, 0, 1])).toBeLessThan(0.5);
  });

  it('分离数据的二分稳定性 ARI 高', () => {
    const points = [...groupA, ...groupB];
    const order = seededShuffle(points.length, 42);
    const result = bisectStability(points, 2, [order]);
    expect(result.stable).toBe(true);
    expect(result.ari).toBeGreaterThan(0.7);
  });

  it('单一连通块不成两簇（轮廓系数低）', () => {
    const line = [[0], [0.1], [0.2], [0.3], [0.4], [0.5], [0.6], [0.7]];
    const assignment = wardCluster(line, 2);
    expect(silhouetteScore(line, assignment)).toBeLessThan(0.7);
  });
});

describe('runSingle 冒烟（P1.5-01 契约字段）', () => {
  it('末 tick 全死亡时 scheduled 也算 extinct（07 §5）', () => {
    expect(deriveExtinct('extinct', 0)).toBe(true);
    expect(deriveExtinct('scheduled', 0)).toBe(true);
    expect(deriveExtinct('scheduled', 12)).toBe(false);
    expect(deriveExtinct(null, 40)).toBe(false);
  });
  it('短运行产出全部契约字段', () => {
    const config = createDemoConfig({
      population: { initialPopulation: 6 },
      schedule: { totalTicks: 40, statsStride: 1, snapshotStride: 100 },
    });
    const outcome = runSingle(config, SEED, { policy: 'mock-weighted-v1' });
    expect(outcome.configHash).toMatch(/^sha256:/);
    expect(outcome.paramsHash).toMatch(/^sha256:/);
    expect(outcome.stats.length).toBe(40);
    expect(outcome.report.aliveAtEnd).toBeGreaterThan(0);
    expect(outcome.report.extinct).toBe(false);
    expect(outcome.report.windows.length).toBe(ANALYSIS_WINDOWS.length);
    for (const window of outcome.report.windows) {
      expect(window.missingTicks).toBeGreaterThan(0); // 40 tick 不足以覆盖预注册窗口
    }
    expect(outcome.report.finalStateHash).toMatch(/^sha256:/);
  });

  it('报告包含 v5 预注册窗口 w2b（1825–2554）且正常 run 可用', () => {
    const config = createDemoConfig({
      population: { initialPopulation: 8 },
      schedule: { totalTicks: 2555, statsStride: 1, snapshotStride: 2555 },
    });
    const outcome = runSingle(config, SEED, { policy: 'mock-weighted-v1' });
    const w2b = outcome.report.windows.find((window) => window.label === 'w2b');
    expect(w2b).toBeDefined();
    expect(w2b?.start).toBe(1825);
    expect(w2b?.end).toBe(2554);
    expect(w2b?.tickCount).toBe(730);
    expect(w2b?.missingTicks).toBe(0);
    expect(outcome.report.extinct).toBe(false);
    expect(outcome.report.labelsByWindow['w2b']).toBeDefined();
  });
});

describe('聚类标尺与最小簇（复用同一 z-score）', () => {
  it('standardizeWith 与 zScoreMatrix 对训练矩阵逐行一致', () => {
    const train = [
      [0, 10],
      [1, 20],
      [2, 30],
    ];
    const z = zScoreMatrix(train);
    for (const row of train) {
      expect(standardizeWith(train, row)).toEqual(z[train.indexOf(row)]);
    }
  });

  it('外部向量按训练集均值/标准差标准化，而非自身重算', () => {
    const train = [[0], [2]];
    const { means, sigmas } = fitStandardizer(train);
    expect(means[0]).toBe(1);
    expect(sigmas[0]).toBe(1);
    // 外部向量 [4]：用训练标尺 → (4-1)/1 = 3，不是 0。
    expect(standardizeWith(train, [4])).toEqual([3]);
  });

  it('零方差维度保持 0，空输入不抛错', () => {
    expect(
      standardizeWith(
        [
          [5, 1],
          [5, 3],
        ],
        [5, 5],
      ),
    ).toEqual([0, 3]);
    expect(standardizeWith([], [1, 2])).toEqual([1, 2]);
    expect(zScoreMatrix([])).toEqual([]);
  });

  it('minClusterSize 与 minClusterMet 判定', () => {
    expect(minClusterSize([])).toBe(0);
    expect(minClusterSize([0, 0, 1, 1, 1])).toBe(2);
    expect(meetsMinClusterSize([0, 0, 1, 1, 1], 2)).toBe(true);
    expect(meetsMinClusterSize([0, 0, 1, 1, 1], 3)).toBe(false);
  });
});

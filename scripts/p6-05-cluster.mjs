#!/usr/bin/env node
/**
 * P6-05：全特征结构指纹聚类（07 §8.1、rule 57）。
 *
 * 设计先冻结，再运行：6 个参数区域 × 30 个全新 seed × 10950 tick（40 人），
 * 终端窗口 [10585,10949] 取 P0..P4、G、top10、Mup、Mdown、S、O 共 11 维特征；
 * 每 cell 前 10 个 seed 续跑到 14600 tick，用 10950 的 scaler/质心检验同簇率。
 *
 * k=3、Ward-LW、z-score(pooled)、20 次二分稳定性；验收要求每簇 >=5 run、
 * ARI median >=0.70、silhouette >=0.35、时序同簇率 >=0.80，且至少一个簇
 * 包含 >=2 个 cell（排除“三组预设”）。
 *
 * 结果只说明 mock 策略在 40 人 × 10950 tick 内的结构指纹聚类，不是校准、
 * 现实因果或 rules-v11 的结构涌现声明。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { asSeed } from '../dist/core/control/ids.js';
import { hashValue } from '../dist/core/hash/hash.js';
import { HASH_DOMAINS } from '../dist/core/hash/domains.js';
import { buildCellConfig, assertFrozenVersions } from '../dist/runner/preregistration.js';
import { readNdjsonTolerant } from '../dist/runner/ndjson.js';
import { median } from '../dist/runner/p6-analysis.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { summarizeWindow } from '../dist/runner/window-stats.js';
import {
  bisectStability,
  fitStandardizer,
  seededShuffle,
  silhouetteScore,
  wardCluster,
} from '../dist/runner/cluster.js';
import {
  clusterCentroids,
  clusterComposition,
  clusterSizes,
  evaluateP6ClusterVerdict,
  evaluateP6TwoRegimeVerdict,
  minimumCentroidDistance,
  structuralFeatureVector,
  temporalSameClusterRate,
} from '../dist/runner/p6-cluster-summary.js';

const PREREG_SCHEMA = 'p6-05-cluster-prereg-v1';
const DEFAULTS = {
  prereg: 'out/p6-05-cluster-prereg.json',
  dir: 'out/p6-05-cluster',
  analysisOut: 'out/p6-05-cluster-analysis.json',
  population: 40,
  horizon: 10950,
  followupHorizon: 14600,
  seedCount: 30,
  followupSeedsPerCell: 10,
};
const CELLS = [
  { cellKey: 'A-share100-w0', overrides: {} },
  {
    cellKey: 'B-share50-w15',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 15 } },
  },
  {
    cellKey: 'C-share50-w60',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 60 } },
  },
  {
    cellKey: 'D-share50-w30',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 30 } },
  },
  {
    cellKey: 'E-share70-w15',
    overrides: { ascent: { displacementShare: 0.7, scarcityWeight: 15 } },
  },
  {
    cellKey: 'F-share30-w60',
    overrides: { ascent: { displacementShare: 0.3, scarcityWeight: 60 } },
  },
];
const SEEDS = Array.from(
  { length: DEFAULTS.seedCount },
  (_, index) => `p6-05-seed-${String(index + 1).padStart(3, '0')}`,
);
const SEEDS_05B = Array.from(
  { length: DEFAULTS.seedCount },
  (_, index) => `p6-05b-seed-${String(index + 1).padStart(3, '0')}`,
);
const CELLS_05B = [0, 180].flatMap((memory) =>
  [4, 8, 12].map((segregationWeight) => ({
    cellKey: `thetaS${segregationWeight}-H${memory}`,
    overrides: {
      ascent: {
        displacementShare: 0.5,
        scarcityWeight: 15,
        occupancyMemoryDays: memory,
      },
      openness: { segregationWeight },
    },
  })),
);
const SEEDS_05C = Array.from(
  { length: DEFAULTS.seedCount },
  (_, index) => `p6-05c-seed-${String(index + 1).padStart(3, '0')}`,
);
const CELLS_05C = [0, 6, 10, 14].map((selfReinforcement) => ({
  cellKey: `thetaH${selfReinforcement}`,
  overrides: {
    ascent: { displacementShare: 0.5, scarcityWeight: 15 },
    openness: { selfReinforcement },
  },
}));

const SEEDS_05D = Array.from(
  { length: DEFAULTS.seedCount },
  (_, index) => `p6-05d-seed-${String(index + 1).padStart(3, '0')}`,
);
const REGIME_THRESHOLDS = {
  regimeEnterOpenMobility: 0.25,
  regimeExitOpenMobility: 0.15,
  regimeEnterOpenSegregation: 0.2,
  regimeExitOpenSegregation: 0.3,
};
const CELLS_05D = [
  {
    cellKey: 'continuous-control',
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 15 },
      openness: { regimeMode: 'continuous', regimeBias: 0, ...REGIME_THRESHOLDS },
    },
  },
  ...[4, 8, 12].map((regimeBias) => ({
    cellKey: `thetaR${regimeBias}`,
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 15 },
      openness: { regimeMode: 'hysteresis', regimeBias, ...REGIME_THRESHOLDS },
    },
  })),
];

const SEEDS_05E = Array.from(
  { length: DEFAULTS.seedCount },
  (_, index) => `p6-05e-seed-${String(index + 1).padStart(3, '0')}`,
);
// D3 测量充分性：不改规则，只把人口从 40 扩到 200/1000，检验第三簇是否只是小样本噪声。
const CELLS_05E = [200, 1000].map((populationSize) => ({
  cellKey: `pop${populationSize}`,
  population: populationSize,
  overrides: {
    ascent: { displacementShare: 0.5, scarcityWeight: 15 },
    openness: { regimeMode: 'continuous', regimeBias: 0 },
  },
}));

const SEEDS_06 = Array.from(
  { length: DEFAULTS.seedCount },
  (_, index) => `p6-06-seed-${String(index + 1).padStart(3, '0')}`,
);
// P6-06：D1 目标修订确认轮，沿用 P6-05 的 6 个参数区域，k=2 验收。
const CELLS_06 = CELLS.map((cell) => ({
  cellKey: cell.cellKey,
  overrides: cell.overrides,
}));

function parseArgs(argv) {
  const options = { ...DEFAULTS, mode: null, design: 'p6-05' };
  let preregSet = false;
  let dirSet = false;
  let outSet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} 缺少取值`);
      index += 1;
      return value;
    };
    if (flag === '--freeze') options.mode = 'freeze';
    else if (flag === '--run') options.mode = 'run';
    else if (flag === '--analyze') options.mode = 'analyze';
    else if (flag === '--design') options.design = next();
    else if (flag === '--prereg') {
      options.prereg = next();
      preregSet = true;
    } else if (flag === '--dir') {
      options.dir = next();
      dirSet = true;
    } else if (flag === '--out') {
      options.analysisOut = next();
      outSet = true;
    } else if (flag === '--cell') {
      options.cell = next();
    } else if (flag === '--shard') {
      options.shard = next();
    } else if (flag === '--force') options.force = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        [
          '用法：',
          '  node scripts/p6-05-cluster.mjs --freeze [--design p6-05|p6-05b|p6-05c|p6-05d|p6-05e|p6-06] [--force]',
          '  node scripts/p6-05-cluster.mjs --run [--prereg ...] [--dir ...] [--cell <cellKey>] [--shard i/n]',
          '  node scripts/p6-05-cluster.mjs --analyze [--out ...]',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${flag}`);
    }
  }
  if (options.mode === null) throw new Error('必须指定 --freeze、--run 或 --analyze');
  if (
    options.design !== 'p6-05' &&
    options.design !== 'p6-05b' &&
    options.design !== 'p6-05c' &&
    options.design !== 'p6-05d' &&
    options.design !== 'p6-05e' &&
    options.design !== 'p6-06'
  ) {
    throw new Error('--design 只能为 p6-05、p6-05b、p6-05c、p6-05d、p6-05e 或 p6-06');
  }
  if (options.design === 'p6-05b') {
    if (!preregSet) options.prereg = 'out/p6-05b-scan-prereg.json';
    if (!dirSet) options.dir = 'out/p6-05b-scan';
    if (!outSet) options.analysisOut = 'out/p6-05b-scan-analysis.json';
  }
  if (options.design === 'p6-05c') {
    if (!preregSet) options.prereg = 'out/p6-05c-prereg.json';
    if (!dirSet) options.dir = 'out/p6-05c';
    if (!outSet) options.analysisOut = 'out/p6-05c-analysis.json';
  }
  if (options.design === 'p6-05d') {
    if (!preregSet) options.prereg = 'out/p6-05d-prereg.json';
    if (!dirSet) options.dir = 'out/p6-05d';
    if (!outSet) options.analysisOut = 'out/p6-05d-analysis.json';
  }
  if (options.design === 'p6-05e') {
    if (!preregSet) options.prereg = 'out/p6-05e-prereg.json';
    if (!dirSet) options.dir = 'out/p6-05e';
    if (!outSet) options.analysisOut = 'out/p6-05e-analysis.json';
  }
  if (options.design === 'p6-06') {
    if (!preregSet) options.prereg = 'out/p6-06-prereg.json';
    if (!dirSet) options.dir = 'out/p6-06';
    if (!outSet) options.analysisOut = 'out/p6-06-analysis.json';
  }
  return options;
}

function buildDesign() {
  return {
    schemaVersion: PREREG_SCHEMA,
    hypothesis:
      'P6-05：在 rules-v11、mock-weighted-v1、40 人、10950 tick 的终端窗口上，' +
      '用 07 §8.1 的全特征向量（P0..P4、G、top10、Mup、Mdown、S、O）对 6 个参数区域 ' +
      '× 30 个全新 seed 做 k=3 聚类。若三个簇均 >=5 run、ARI median >=0.70、' +
      'silhouette >=0.35、14600 同簇率 >=0.80，且至少一个簇包含 >=2 个 cell，' +
      '才判定“至少三类可复现结构指纹聚类”；否则记录失败并回到规则评审。' +
      '该判定只针对 mock 与 40 人视野，不是校准、现实因果或结构已涌现。',
    rulesVersion: 'rules-v11',
    policy: 'mock-weighted-v1',
    population: DEFAULTS.population,
    horizon: DEFAULTS.horizon,
    terminalWindow: { start: 10585, end: 10949, days: 365 },
    followupHorizon: DEFAULTS.followupHorizon,
    followupWindow: { start: 14235, end: 14599, days: 365 },
    followupSeedsPerCell: DEFAULTS.followupSeedsPerCell,
    seeds: SEEDS,
    cells: CELLS,
    features: ['P0', 'P1', 'P2', 'P3', 'P4', 'G', 'top10', 'Mup', 'Mdown', 'S', 'O'],
    clustering: {
      algorithm: 'ward-lw-v1',
      distance: 'euclidean',
      standardization: 'z-score(pooled)',
      k: 3,
      stabilityShuffles: 20,
      stabilitySeed: 20261105,
      ariMedianMin: 0.7,
      silhouetteMin: 0.35,
      minClusterRuns: 5,
    },
    temporal: { minSameClusterRate: 0.8 },
    antiPreset: { minCellsInAnyCluster: 2 },
    exclusion: { excludeExtinct: true, maxExtinctRate: 0.1 },
    budgets: { runs: 240, wallMinutes: 120 },
    confirmationStatus: 'P6-05 candidate only; not calibration',
  };
}

function buildDesign05b() {
  return {
    schemaVersion: 'p6-05b-scan-prereg-v1',
    hypothesis:
      'P6-05b：P6-05 的三簇失败被诊断为非 A 体制内沿 S/O 的相位漂移（changes/0057、' +
      'docs/reviews/2026-11-05-p6-05-rule-review.md）。本轮检验两个机制假设：' +
      'H1 开放度–网络迟滞（提高 openness.segregationWeight θS，使 O 出现两个稳定区间）与 ' +
      'H2 占用记忆锁定（ascent.occupancyMemoryDays H>0 提供迟滞）。' +
      '固定 displacementShare=0.5、scarcityWeight=15，θS∈{4,8,12} × H∈{0,180} 共 6 cell，' +
      '30 个全新 seed × 10950 tick（40 人），终端 11 维全特征、k=3、同一稳定性/时序判据。' +
      '若 6 个 cell 均无稳定第三簇，则停止调参、转 rules-v12 ADR；' +
      '即使通过也只是 mock 候选，不是校准或结构涌现声明。',
    rulesVersion: 'rules-v11',
    policy: 'mock-weighted-v1',
    population: DEFAULTS.population,
    horizon: DEFAULTS.horizon,
    terminalWindow: { start: 10585, end: 10949, days: 365 },
    followupHorizon: DEFAULTS.followupHorizon,
    followupWindow: { start: 14235, end: 14599, days: 365 },
    followupSeedsPerCell: DEFAULTS.followupSeedsPerCell,
    seeds: SEEDS_05B,
    cells: CELLS_05B,
    fixed: { displacementShare: 0.5, scarcityWeight: 15 },
    axes: { segregationWeight: [4, 8, 12], occupancyMemoryDays: [0, 180] },
    features: ['P0', 'P1', 'P2', 'P3', 'P4', 'G', 'top10', 'Mup', 'Mdown', 'S', 'O'],
    clustering: {
      algorithm: 'ward-lw-v1',
      distance: 'euclidean',
      standardization: 'z-score(pooled)',
      k: 3,
      stabilityShuffles: 20,
      stabilitySeed: 20261105,
      ariMedianMin: 0.7,
      silhouetteMin: 0.35,
      minClusterRuns: 5,
    },
    temporal: { minSameClusterRate: 0.8 },
    antiPreset: { minCellsInAnyCluster: 2 },
    exclusion: { excludeExtinct: true, maxExtinctRate: 0.1 },
    budgets: { runs: 240, wallMinutes: 120 },
    prediction:
      'H1：θS 越高，非 A 区域的 S/O 双峰越清晰，第三簇 14600 同簇率 >=0.80；' +
      'H2：H=180 的同簇率显著高于 H=0。若两者都不成立，停止参数扫描。',
    confirmationStatus: 'P6-05b scan only; not calibration',
  };
}

function buildDesign05c() {
  return {
    schemaVersion: 'p6-05c-prereg-v1',
    hypothesis:
      'P6-05c（ADR 0004 / rules-v12）：在开放度目标加入自反馈项 θH×(O_prev−0.5) 后，' +
      '检验 θH 是否能产生稳定第三簇。固定 share=0.5、w=15，θH∈{0,6,10,14} 四 cell，' +
      '30 个全新 seed × 10950 tick（40 人）+ 每 cell 前 10 seed × 14600；' +
      '全特征 k=3、沿用 P6-05 的 ARI/silhouette/同簇率/反预设验收。' +
      'θH=0 是 rules-v12 下的 v11 等价对照；若 θH>0 仍无稳定第三簇，A 方案判失败，' +
      '按 ADR 0004 转方案 B。结果仅 mock 候选，不是校准或结构涌现声明。',
    rulesVersion: 'rules-v12',
    policy: 'mock-weighted-v1',
    population: DEFAULTS.population,
    horizon: DEFAULTS.horizon,
    terminalWindow: { start: 10585, end: 10949, days: 365 },
    followupHorizon: DEFAULTS.followupHorizon,
    followupWindow: { start: 14235, end: 14599, days: 365 },
    followupSeedsPerCell: DEFAULTS.followupSeedsPerCell,
    seeds: SEEDS_05C,
    cells: CELLS_05C,
    fixed: { displacementShare: 0.5, scarcityWeight: 15 },
    axis: { selfReinforcement: [0, 6, 10, 14] },
    features: ['P0', 'P1', 'P2', 'P3', 'P4', 'G', 'top10', 'Mup', 'Mdown', 'S', 'O'],
    clustering: {
      algorithm: 'ward-lw-v1',
      distance: 'euclidean',
      standardization: 'z-score(pooled)',
      k: 3,
      stabilityShuffles: 20,
      stabilitySeed: 20261105,
      ariMedianMin: 0.7,
      silhouetteMin: 0.35,
      minClusterRuns: 5,
    },
    temporal: { minSameClusterRate: 0.8 },
    antiPreset: { minCellsInAnyCluster: 2 },
    exclusion: { excludeExtinct: true, maxExtinctRate: 0.1 },
    budgets: { runs: 160, wallMinutes: 90 },
    prediction:
      'θH=0 应保持 P6-05b 的二簇/弱三簇；θH∈{6,10,14} 若产生两个 O 稳定区间，' +
      '应出现 14600 同簇率 >=0.80 的第三簇（高 S/低 O 或低 S/高 O）。' +
      '若四个 cell 都无稳定第三簇，A 方案失败，转方案 B。',
    confirmationStatus: 'P6-05c candidate only; not calibration',
  };
}

function buildDesign05d() {
  return {
    schemaVersion: 'p6-05d-prereg-v1',
    hypothesis:
      'P6-05d（ADR 0005 / rules-v13）：显式制度状态机把连续的 O 拆成 closed/open 两个离散制度，' +
      '并以滞回带阻止边界抖动；O_target 在 v12 公式上增加 ±θR 偏置。' +
      '固定 share=0.5、w=15，设 continuous 对照 + θR∈{4,8,12} 共 4 cell，' +
      '30 个全新 seed × 10950 tick（40 人）+ 每 cell 前 10 seed × 14600；' +
      '全特征 k=3、沿用 P6-05 的 ARI/silhouette/同簇率/反预设验收。' +
      '若 θR>0 仍无稳定第三簇，方案 B 判失败，停止继续给制度机加可调旋钮，转规则设计评审；' +
      '结果仅 mock 候选，不是校准或结构涌现声明。',
    rulesVersion: 'rules-v13',
    policy: 'mock-weighted-v1',
    population: DEFAULTS.population,
    horizon: DEFAULTS.horizon,
    terminalWindow: { start: 10585, end: 10949, days: 365 },
    followupHorizon: DEFAULTS.followupHorizon,
    followupWindow: { start: 14235, end: 14599, days: 365 },
    followupSeedsPerCell: DEFAULTS.followupSeedsPerCell,
    seeds: SEEDS_05D,
    cells: CELLS_05D,
    fixed: { displacementShare: 0.5, scarcityWeight: 15 },
    regimeThresholds: REGIME_THRESHOLDS,
    axis: { regimeMode: ['continuous', 'hysteresis'], regimeBias: [0, 4, 8, 12] },
    features: ['P0', 'P1', 'P2', 'P3', 'P4', 'G', 'top10', 'Mup', 'Mdown', 'S', 'O'],
    clustering: {
      algorithm: 'ward-lw-v1',
      distance: 'euclidean',
      standardization: 'z-score(pooled)',
      k: 3,
      stabilityShuffles: 20,
      stabilitySeed: 20261105,
      ariMedianMin: 0.7,
      silhouetteMin: 0.35,
      minClusterRuns: 5,
    },
    temporal: { minSameClusterRate: 0.8 },
    antiPreset: { minCellsInAnyCluster: 2 },
    exclusion: { excludeExtinct: true, maxExtinctRate: 0.1 },
    budgets: { runs: 160, wallMinutes: 90 },
    prediction:
      'continuous 对照应复现 P6-05c 的弱三簇；θR>0 若把轨迹锁进 closed/open 两制度，' +
      '应出现 14600 同簇率 >=0.80 的稳定第三簇，且该簇的 O 分布呈双峰。' +
      '若四个 cell 都无稳定第三簇，方案 B 失败，停止制度机调参。',
    confirmationStatus: 'P6-05d candidate only; not calibration',
  };
}

function buildDesign05e() {
  return {
    schemaVersion: 'p6-05e-prereg-v1',
    hypothesis:
      'P6-05e（D3 测量充分性检查，规则不变）：P6-05/05b/搜索/05c/05d 的第三簇最小规模始终只有 3–9 个 run，' +
      '无法区分真实第三类结构与 40 人小样本噪声。本轮不改任何规则，固定 continuous 对照、share=0.5、w=15，' +
      '把人口扩到 200 与 1000，各 30 个全新 seed × 10950 tick + 每 cell 前 10 seed × 14600，' +
      '用同一 11 维全特征与 k=3 口径只看 k=2/3 稳定性与簇规模。' +
      '若 200/1000 人仍无稳定第三簇，则支持“单吸引域/目标修订”判断；若出现稳定三簇，' +
      '说明此前是测量视野问题，必须用全新确认 seed 另立预注册，不能直接引用本轮作为 G6 证据。',
    rulesVersion: 'rules-v13',
    policy: 'mock-weighted-v1',
    population: 200,
    populations: [200, 1000],
    horizon: DEFAULTS.horizon,
    terminalWindow: { start: 10585, end: 10949, days: 365 },
    followupHorizon: DEFAULTS.followupHorizon,
    followupWindow: { start: 14235, end: 14599, days: 365 },
    followupSeedsPerCell: DEFAULTS.followupSeedsPerCell,
    seeds: SEEDS_05E,
    cells: CELLS_05E,
    fixed: { displacementShare: 0.5, scarcityWeight: 15 },
    axis: { population: [200, 1000] },
    features: ['P0', 'P1', 'P2', 'P3', 'P4', 'G', 'top10', 'Mup', 'Mdown', 'S', 'O'],
    clustering: {
      algorithm: 'ward-lw-v1',
      distance: 'euclidean',
      standardization: 'z-score(pooled)',
      k: 3,
      stabilityShuffles: 20,
      stabilitySeed: 20261105,
      ariMedianMin: 0.7,
      silhouetteMin: 0.35,
      minClusterRuns: 5,
    },
    temporal: { minSameClusterRate: 0.8 },
    antiPreset: { minCellsInAnyCluster: 2 },
    exclusion: { excludeExtinct: true, maxExtinctRate: 0.1 },
    budgets: { runs: 80, wallMinutes: 420 },
    prediction:
      '若第三簇是 40 人小样本噪声：200/1000 人的 k=3 最小簇仍接近 5 或更小、ARI/silhouette 仍低，k=2 继续更稳。' +
      '若存在真实第三类：更大人口的簇规模应随 n 增长且 14600 同簇率提升。' +
      '本轮只作测量充分性诊断，不通过也不失败任何机制；不构成 G6 确认。',
    confirmationStatus: 'P6-05e measurement-adequacy only; not G6 confirmation',
  };
}

function buildDesign06() {
  return {
    schemaVersion: 'p6-06-prereg-v1',
    hypothesis:
      'P6-06（D1 / ADR 0006）：G6 结构目标已改为“2 体制 + 连续统”。沿用 P6-05 的 6 个参数区域、' +
      '11 维全特征、终端窗口与 14600 followup，使用 30 个全新 seed × 40 人 × 10950 tick，' +
      '以 k=2 聚类验收：两簇各 >=5、ARI median >=0.70、silhouette >=0.35、同簇率 >=0.80、' +
      '至少一个簇含 >=2 个参数区域、序参量 |ΔO|/|ΔS|/TV(P) 至少一项 >=0.10；' +
      '同时要求 k=3 不形成稳定第三簇。旧 k=3 结果不得追认；本轮不通过则 G6 仍未通过。',
    rulesVersion: 'rules-v13',
    policy: 'mock-weighted-v1',
    population: DEFAULTS.population,
    horizon: DEFAULTS.horizon,
    terminalWindow: { start: 10585, end: 10949, days: 365 },
    followupHorizon: DEFAULTS.followupHorizon,
    followupWindow: { start: 14235, end: 14599, days: 365 },
    followupSeedsPerCell: DEFAULTS.followupSeedsPerCell,
    seeds: SEEDS_06,
    cells: CELLS_06,
    features: ['P0', 'P1', 'P2', 'P3', 'P4', 'G', 'top10', 'Mup', 'Mdown', 'S', 'O'],
    clustering: {
      algorithm: 'ward-lw-v1',
      distance: 'euclidean',
      standardization: 'z-score(pooled)',
      k: 2,
      stabilityShuffles: 20,
      stabilitySeed: 20261105,
      ariMedianMin: 0.7,
      silhouetteMin: 0.35,
      minClusterRuns: 5,
    },
    temporal: { minSameClusterRate: 0.8 },
    antiPreset: { minCellsInAnyCluster: 2 },
    exclusion: { excludeExtinct: true, maxExtinctRate: 0.1 },
    regimeDifference: { minOrderParameterDifference: 0.1 },
    noStableThirdCluster: { minAri: 0.7, minTemporalRate: 0.8 },
    budgets: { runs: 240, wallMinutes: 120 },
    prediction:
      '若规则族只支持 2 体制 + 连续统：k=2 应稳定，两簇在 O/S/TV(P) 上有 >=0.10 差异，' +
      'k=3 不应同时达到 ARI/同簇率/最小簇门槛。若 k=2 也不稳定，G6 仍未通过，下一步讨论 D2。',
    confirmationStatus: 'P6-06 G6 confirmation under 2-regime target; not calibration',
  };
}

function validateDesignCells(design) {
  for (const cell of design.cells) {
    for (const horizon of [design.horizon, design.followupHorizon]) {
      // 冻结前用当前代码实际构造每个 cell：非法参数域/覆盖冲突必须在此暴露，
      // 不能等到 VPS 跑完一半才失败（P6-05d θR=12 事故）。
      buildCellConfig(
        { cellKey: `${cell.cellKey}@${horizon}`, overrides: cell.overrides },
        cell.population ?? design.population,
        horizon,
      );
    }
  }
}

function freeze(options) {
  const design =
    options.design === 'p6-06'
      ? buildDesign06()
      : options.design === 'p6-05e'
        ? buildDesign05e()
        : options.design === 'p6-05d'
          ? buildDesign05d()
          : options.design === 'p6-05c'
            ? buildDesign05c()
            : options.design === 'p6-05b'
              ? buildDesign05b()
              : buildDesign();
  validateDesignCells(design);
  const designHash = hashValue(HASH_DOMAINS.preregistration, design);
  if (existsSync(options.prereg) && !options.force) {
    throw new Error(`${options.prereg} 已存在；预注册不得覆盖（确需重冻结用 --force）`);
  }
  const artifact = {
    schemaVersion: design.schemaVersion,
    experimentId: `${options.design}-${designHash.slice('sha256:'.length, 'sha256:'.length + 8)}`,
    createdAt: new Date().toISOString(),
    hashDomain: HASH_DOMAINS.preregistration,
    hashPreimage: 'JCS(design)',
    designHash,
    design,
  };
  mkdirSync(dirname(options.prereg), { recursive: true });
  writeFileSync(options.prereg, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        frozen: true,
        prereg: options.prereg,
        experimentId: artifact.experimentId,
        designHash,
        runs: design.cells.length * design.seeds.length,
        followupRuns: design.cells.length * design.followupSeedsPerCell,
      },
      null,
      2,
    ),
  );
}

function loadPrereg(options) {
  if (!existsSync(options.prereg)) {
    throw new Error(`缺少预注册文件 ${options.prereg}；先执行 --freeze`);
  }
  const artifact = JSON.parse(readFileSync(options.prereg, 'utf8'));
  const recomputed = hashValue(HASH_DOMAINS.preregistration, artifact.design);
  if (recomputed !== artifact.designHash) {
    throw new Error(`预注册哈希不匹配：文件 ${artifact.designHash}，重算 ${recomputed}`);
  }
  return artifact;
}

function runOne(design, cell, seed, horizon, window) {
  const config = buildCellConfig(
    { cellKey: `${cell.cellKey}@${horizon}`, overrides: cell.overrides },
    cell.population ?? design.population,
    horizon,
  );
  const outcome = runSingle(config, asSeed(seed), {
    policy: design.policy,
    maxTicks: horizon,
  });
  // 终端窗口用 w3 的 label 只为满足内部类型；start/end 显式记录在产物里。
  const summary = summarizeWindow(
    {
      config,
      stats: outcome.stats,
      flowsByTick: outcome.flowsByTick,
      decisionsByTick: outcome.decisionsByTick,
    },
    'w3',
    window.start,
    window.end,
  );
  return {
    schemaVersion: 'p6-05-cluster-run-v1',
    runKey: `${cell.cellKey}:${horizon}:${seed}`,
    cellKey: cell.cellKey,
    seed,
    horizon,
    configHash: outcome.configHash,
    extinct: outcome.report.extinct,
    aliveAtEnd: outcome.report.aliveAtEnd,
    endTick: outcome.report.endTick,
    window: {
      start: summary.start,
      end: summary.end,
      days: window.days,
      tickCount: summary.tickCount,
      observedTicks: summary.observedTicks,
      missingTicks: summary.missingTicks,
    },
    features: structuralFeatureVector(summary),
    metrics: {
      classShares: summary.classShares,
      gini: summary.gini,
      topWealthShare: summary.topWealthShare,
      mUp: summary.mUp,
      mDown: summary.mDown,
      segregation: summary.segregation,
      openness: summary.openness,
    },
  };
}

function readLedger(path) {
  const { records, repairedTail } = readNdjsonTolerant(path, { repairTail: true });
  if (repairedTail) {
    process.stderr.write(`[ledger] 已截断末尾半行: ${path}\n`);
  }
  const map = new Map();
  for (const record of records) {
    if (record.status === 'ok') map.set(record.runKey, record);
  }
  return map;
}

function parseShard(raw) {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(raw);
  if (match === null) throw new Error('--shard 必须为 i/n（1-based，如 1/4）');
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index > count) throw new Error('--shard 的 i 必须 <= n');
  return { index, count };
}

function run(options) {
  const artifact = loadPrereg(options);
  const design = artifact.design;
  const cells =
    options.cell === undefined
      ? design.cells
      : design.cells.filter((cell) => cell.cellKey === options.cell);
  if (cells.length === 0) {
    throw new Error(`--cell ${options.cell} 不在预注册 cells 中`);
  }
  const seedShard = options.shard === undefined ? null : parseShard(options.shard);
  const seeds =
    seedShard === null
      ? design.seeds
      : design.seeds.filter((_, index) => index % seedShard.count === seedShard.index - 1);
  if (seeds.length === 0) throw new Error('--shard 未分到任何 seed');
  // 续跑只针对全局前 N 个 seed；分片时各 shard 只跑落在自己分片的那部分。
  const followupSeeds = design.seeds
    .slice(0, design.followupSeedsPerCell)
    .filter((seed) => seeds.includes(seed));
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          experimentId: artifact.experimentId,
          runs: cells.length * (seeds.length + followupSeeds.length),
          cell: options.cell ?? null,
          shard: options.shard ?? null,
          populations: design.populations ?? [design.population],
          horizon: design.horizon,
        },
        null,
        2,
      ),
    );
    return;
  }
  assertFrozenVersions(design);
  mkdirSync(options.dir, { recursive: true });
  const ledgerPath = join(options.dir, 'runs.ndjson');
  const ledger = readLedger(ledgerPath);
  let done = 0;
  const total = cells.length * (seeds.length + followupSeeds.length);
  for (const cell of cells) {
    for (const seed of seeds) {
      const runKey = `${cell.cellKey}:${design.horizon}:${seed}`;
      if (!ledger.has(runKey)) {
        const record = runOne(design, cell, seed, design.horizon, design.terminalWindow);
        appendFileSync(ledgerPath, `${JSON.stringify({ ...record, status: 'ok' })}\n`, 'utf8');
        ledger.set(runKey, record);
      }
      done += 1;
      process.stderr.write(`[p6-05] ${done}/${total} ${runKey}\n`);
    }
    for (const seed of followupSeeds) {
      const runKey = `${cell.cellKey}:${design.followupHorizon}:${seed}`;
      if (!ledger.has(runKey)) {
        const record = runOne(design, cell, seed, design.followupHorizon, design.followupWindow);
        appendFileSync(ledgerPath, `${JSON.stringify({ ...record, status: 'ok' })}\n`, 'utf8');
        ledger.set(runKey, record);
      }
      done += 1;
      process.stderr.write(`[p6-05] ${done}/${total} ${runKey}\n`);
    }
  }
  console.error(`[p6-05] 完成 ${ledger.size}/${total} 个 run`);
}

function nearestCentroid(point, centroids) {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let cluster = 0; cluster < centroids.length; cluster += 1) {
    let distance = 0;
    const centroid = centroids[cluster];
    for (let index = 0; index < point.length; index += 1) {
      const delta = (point[index] ?? 0) - (centroid[index] ?? 0);
      distance += delta * delta;
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      best = cluster;
    }
  }
  return best;
}

function analyze(options) {
  const artifact = loadPrereg(options);
  const design = artifact.design;
  const ledgerPath = join(options.dir, 'runs.ndjson');
  if (!existsSync(ledgerPath)) throw new Error(`缺少 ledger ${ledgerPath}`);
  const { records: ledgerRecords, repairedTail } = readNdjsonTolerant(ledgerPath, {
    repairTail: true,
  });
  if (repairedTail) {
    process.stderr.write(`[analyze] 已截断末尾半行: ${ledgerPath}\n`);
  }
  const all = ledgerRecords.filter((record) => record.status === 'ok');
  const baseRows = all.filter((record) => record.horizon === design.horizon);
  const followRows = all.filter((record) => record.horizon === design.followupHorizon);
  const usable = baseRows.filter(
    (record) =>
      !record.extinct &&
      record.window !== undefined &&
      record.window.observedTicks >= record.window.days &&
      record.window.missingTicks === 0,
  );
  const excluded = baseRows
    .filter((record) => !usable.includes(record))
    .map((record) => ({
      runKey: record.runKey,
      extinct: record.extinct,
      observedTicks: record.window?.observedTicks ?? null,
      missingTicks: record.window?.missingTicks ?? null,
    }));
  if (usable.length < design.clustering.k * design.clustering.minClusterRuns) {
    throw new Error(`可用 run 只有 ${usable.length}，不足以做 k=3 聚类`);
  }
  const points = usable.map((record) => record.features);
  const scaler = fitStandardizer(points);
  const matrix = points.map((point) => scaler.standardize(point));
  const assignments = wardCluster(matrix, design.clustering.k);
  const sizes = clusterSizes(assignments, design.clustering.k);
  const composition = clusterComposition(
    assignments,
    usable.map((record) => record.cellKey),
    design.clustering.k,
  );
  const silhouette = silhouetteScore(matrix, assignments);
  const n = matrix.length;
  const aris = [];
  for (let iteration = 0; iteration < design.clustering.stabilityShuffles; iteration += 1) {
    const shuffle = seededShuffle(n, design.clustering.stabilitySeed + iteration);
    const result = bisectStability(
      matrix,
      design.clustering.k,
      [shuffle],
      design.clustering.ariMedianMin,
    );
    aris.push(result.ari);
  }
  aris.sort((left, right) => left - right);
  const ariMedian = median(aris);
  const ariMin = aris[0];
  const standardizedCentroids = clusterCentroids(matrix, assignments, design.clustering.k);
  const rawCentroids = clusterCentroids(points, assignments, design.clustering.k);

  const baseByKey = new Map(usable.map((record) => [`${record.cellKey}:${record.seed}`, record]));
  const baseAssignments = [];
  const followAssignments = [];
  for (const record of followRows) {
    const key = `${record.cellKey}:${record.seed}`;
    const base = baseByKey.get(key);
    if (base === undefined || record.extinct || record.window?.missingTicks !== 0) continue;
    const position = usable.indexOf(base);
    if (position < 0) continue;
    const standardized = scaler.standardize(record.features);
    baseAssignments.push(assignments[position]);
    followAssignments.push(nearestCentroid(standardized, standardizedCentroids));
  }
  const temporalRate = temporalSameClusterRate(baseAssignments, followAssignments);
  const extinctRate =
    baseRows.length === 0
      ? 0
      : baseRows.filter((record) => record.extinct).length / baseRows.length;

  const isTwoRegime = design.clustering.k === 2;
  let twoRegime = null;
  if (isTwoRegime) {
    // k=2 目标下必须同时报告 k=3，检查是否存在稳定第三簇。
    const assignments3 = wardCluster(matrix, 3);
    const sizes3 = clusterSizes(assignments3, 3);
    const centroids3 = clusterCentroids(matrix, assignments3, 3);
    const aris3 = [];
    for (let iteration = 0; iteration < design.clustering.stabilityShuffles; iteration += 1) {
      const shuffle = seededShuffle(n, design.clustering.stabilitySeed + iteration);
      const result = bisectStability(matrix, 3, [shuffle], design.clustering.ariMedianMin);
      aris3.push(result.ari);
    }
    aris3.sort((left, right) => left - right);
    const k3AriMedian = median(aris3);
    const baseA3 = [];
    const followA3 = [];
    for (const record of followRows) {
      const key = `${record.cellKey}:${record.seed}`;
      const base = baseByKey.get(key);
      if (base === undefined || record.extinct || record.window?.missingTicks !== 0) continue;
      const position = usable.indexOf(base);
      if (position < 0) continue;
      const standardized = scaler.standardize(record.features);
      baseA3.push(assignments3[position]);
      followA3.push(nearestCentroid(standardized, centroids3));
    }
    const k3TemporalRate = temporalSameClusterRate(baseA3, followA3);
    const deltaP =
      0.5 *
      [0, 1, 2, 3, 4].reduce(
        (sum, index) =>
          sum + Math.abs((rawCentroids[0][index] ?? 0) - (rawCentroids[1][index] ?? 0)),
        0,
      );
    const deltaO = Math.abs((rawCentroids[0][10] ?? 0) - (rawCentroids[1][10] ?? 0));
    const deltaS = Math.abs((rawCentroids[0][9] ?? 0) - (rawCentroids[1][9] ?? 0));
    twoRegime = {
      regimeDifference: Math.max(deltaP, deltaO, deltaS),
      orderParameter: { deltaO, deltaS, tvP: deltaP },
      k3: {
        sizes: sizes3,
        ariMedian: k3AriMedian,
        temporalRate: k3TemporalRate,
        silhouette: silhouetteScore(matrix, assignments3),
      },
    };
  }

  const verdict = isTwoRegime
    ? evaluateP6TwoRegimeVerdict({
        ariMedian,
        silhouette,
        sizes,
        composition,
        temporalRate,
        extinctRate,
        minClusterRuns: design.clustering.minClusterRuns,
        minAri: design.clustering.ariMedianMin,
        minSilhouette: design.clustering.silhouetteMin,
        minTemporalRate: design.temporal.minSameClusterRate,
        regimeDifference: twoRegime.regimeDifference,
        k3: {
          sizes: twoRegime.k3.sizes,
          ariMedian: twoRegime.k3.ariMedian,
          temporalRate: twoRegime.k3.temporalRate,
        },
        k3MinAri: design.noStableThirdCluster?.minAri ?? design.clustering.ariMedianMin,
        k3MinTemporalRate:
          design.noStableThirdCluster?.minTemporalRate ?? design.temporal.minSameClusterRate,
      })
    : evaluateP6ClusterVerdict({
        k: design.clustering.k,
        ariMedian,
        ariMin,
        silhouette,
        sizes,
        composition,
        temporalRate,
        extinctRate,
        minClusterRuns: design.clustering.minClusterRuns,
        minAri: design.clustering.ariMedianMin,
        minSilhouette: design.clustering.silhouetteMin,
        minTemporalRate: design.temporal.minSameClusterRate,
      });

  const diagnostics = {};
  for (const k of [2, 3, 4, 5]) {
    if (k === design.clustering.k) continue;
    const assignment = wardCluster(matrix, k);
    diagnostics[`k=${k}`] = {
      sizes: clusterSizes(assignment, k),
      silhouette: silhouetteScore(matrix, assignment),
    };
  }

  const output = {
    schemaVersion: 'p6-05-cluster-analysis-v1',
    isExperimentalEvidence: false,
    experimentId: artifact.experimentId,
    preregistration: {
      path: options.prereg,
      designHash: artifact.designHash,
      createdAt: artifact.createdAt,
    },
    runs: {
      total: all.length,
      base: baseRows.length,
      usable: usable.length,
      excluded,
      followup: followRows.length,
      temporalPairs: baseAssignments.length,
    },
    features: design.features,
    clustering: {
      k: design.clustering.k,
      sizes,
      composition,
      silhouette,
      ariMedian,
      ariMin,
      stabilityAris: aris,
      minimumCentroidDistance: minimumCentroidDistance(standardizedCentroids),
      rawCentroids,
      diagnostics,
    },
    ...(isTwoRegime ? { twoRegime } : {}),
    temporal: {
      sameClusterRate: temporalRate,
      pairs: baseAssignments.length,
      minRate: design.temporal.minSameClusterRate,
    },
    extinctRate,
    verdict: {
      passes: verdict.passes,
      antiPreset: verdict.antiPreset,
      reasons: verdict.reasons,
      status: verdict.passes
        ? isTwoRegime
          ? 'two-regime-candidate'
          : 'three-cluster-candidate'
        : 'not-accepted-return-to-rule-review',
    },
    notes: [
      `P6-05 只判定 mock 策略在 ${(design.populations ?? [design.population]).join('/')} 人 × 10950 tick 的终端全特征聚类（${design.rulesVersion}）；不是校准、现实因果或结构涌现声明。`,
      isTwoRegime
        ? 'k=2 为预注册目标；k=3 用于检查是否形成稳定第三簇，不得用 k=3 的有利结果替代 k=2 验收。'
        : 'k=3 为预注册目标；k=2/4/5 仅作诊断，不得用来替代 k=3 的验收。',
      '簇编号任意，语义由 rawCentroids 的 P/G/Mup/Mdown/S/O 描述，不映射现实阶级结构。',
    ],
  };
  mkdirSync(dirname(options.analysisOut), { recursive: true });
  writeFileSync(options.analysisOut, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(output, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'freeze') return freeze(options);
  if (options.mode === 'run') return run(options);
  if (options.mode === 'analyze') return analyze(options);
  throw new Error(`未知模式 ${options.mode}`);
}

main().catch((error) => {
  console.error(`p6-05-cluster 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

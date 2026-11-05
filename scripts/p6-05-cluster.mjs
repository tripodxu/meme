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
import { buildCellConfig } from '../dist/runner/preregistration.js';
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
    } else if (flag === '--force') options.force = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        [
          '用法：',
          '  node scripts/p6-05-cluster.mjs --freeze [--design p6-05|p6-05b] [--force]',
          '  node scripts/p6-05-cluster.mjs --run [--prereg ...] [--dir ...]',
          '  node scripts/p6-05-cluster.mjs --analyze [--out ...]',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${flag}`);
    }
  }
  if (options.mode === null) throw new Error('必须指定 --freeze、--run 或 --analyze');
  if (options.design !== 'p6-05' && options.design !== 'p6-05b' && options.design !== 'p6-05c') {
    throw new Error('--design 只能为 p6-05、p6-05b 或 p6-05c');
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

function freeze(options) {
  const design =
    options.design === 'p6-05c'
      ? buildDesign05c()
      : options.design === 'p6-05b'
        ? buildDesign05b()
        : buildDesign();
  const designHash = hashValue(HASH_DOMAINS.preregistration, design);
  if (existsSync(options.prereg) && !options.force) {
    throw new Error(`${options.prereg} 已存在；预注册不得覆盖（确需重冻结用 --force）`);
  }
  const artifact = {
    schemaVersion: design.schemaVersion,
    experimentId: `${
      options.design === 'p6-05c' ? 'p6-05c' : options.design === 'p6-05b' ? 'p6-05b' : 'p6-05'
    }-${designHash.slice('sha256:'.length, 'sha256:'.length + 8)}`,
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
    design.population,
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
  if (!existsSync(path)) return new Map();
  const map = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line);
    if (record.status === 'ok') map.set(record.runKey, record);
  }
  return map;
}

function run(options) {
  const artifact = loadPrereg(options);
  const design = artifact.design;
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          experimentId: artifact.experimentId,
          runs: design.cells.length * design.seeds.length,
          followupRuns: design.cells.length * design.followupSeedsPerCell,
          population: design.population,
          horizon: design.horizon,
        },
        null,
        2,
      ),
    );
    return;
  }
  mkdirSync(options.dir, { recursive: true });
  const ledgerPath = join(options.dir, 'runs.ndjson');
  const ledger = readLedger(ledgerPath);
  let done = 0;
  const total =
    design.cells.length * design.seeds.length + design.cells.length * design.followupSeedsPerCell;
  for (const cell of design.cells) {
    for (const seed of design.seeds) {
      const runKey = `${cell.cellKey}:${design.horizon}:${seed}`;
      if (!ledger.has(runKey)) {
        const record = runOne(design, cell, seed, design.horizon, design.terminalWindow);
        appendFileSync(ledgerPath, `${JSON.stringify({ ...record, status: 'ok' })}\n`, 'utf8');
        ledger.set(runKey, record);
      }
      done += 1;
      process.stderr.write(`[p6-05] ${done}/${total} ${runKey}\n`);
    }
    const followupSeeds = design.seeds.slice(0, design.followupSeedsPerCell);
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
  const all = readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((record) => record.status === 'ok');
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
  const ariMedian = aris[Math.floor(aris.length / 2)];
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

  const verdict = evaluateP6ClusterVerdict({
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
  for (const k of [2, 4, 5]) {
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
      status: verdict.passes ? 'three-cluster-candidate' : 'not-accepted-return-to-rule-review',
    },
    notes: [
      'P6-05 只判定 mock 策略在 40 人 × 10950 tick 的终端全特征聚类；不是校准、现实因果或 rules-v11 结构涌现声明。',
      'k=3 为预注册目标；k=2/4/5 仅作诊断，不得用来替代 k=3 的验收。',
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

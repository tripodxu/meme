#!/usr/bin/env node
/**
 * P1.5-01/03 批量网格运行（headless，无 UI/网络）。
 *
 * 用法：
 *   node scripts/p15-grid.mjs --stage screen   # 预检：每 cell 1 种子 × 短 tick，筛查崩溃/爆炸
 *   node scripts/p15-grid.mjs --stage full     # 正式：按预注册 manifest 跑全部 cell × 30 种子
 *
 * 输出（机器可读 JSON，stdout 纯 JSON；进度走 stderr）：
 *   { preregistrationHash, cells: [{cellKey, seeds: [{seed, window metrics, labels, aliveAtEnd, finalStateHash, elapsedMs}]}] }
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';

import {
  buildPreregManifest,
  computePreregistrationHash,
  buildCellConfig,
} from '../dist/core/../runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { asSeed } from '../dist/core/control/ids.js';
import {
  euclidean,
  fitStandardizer,
  chooseKBySilhouette,
  bisectStability,
  minClusterSize,
  seededShuffle,
} from '../dist/runner/cluster.js';

const args = process.argv.slice(2);
const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : 'screen';

function log(message) {
  process.stderr.write(`[p15] ${message}\n`);
}

/** 聚类特征向量（07 §8.1）：窗口均值 P[c]、G、top10、Mup、Mdown、S、O。 */
function featureVector(window) {
  return [
    ...window.classShares,
    window.gini,
    window.topWealthShare,
    window.mUp,
    window.mDown,
    window.segregation,
    window.openness,
  ];
}

const STABILITY_SEED_OFFSETS = [20261103, 20261104, 20261105];

const manifest = buildPreregManifest();
const preregistrationHash = computePreregistrationHash(manifest);
log(`preregistrationHash=${preregistrationHash}`);
log(`stage=${stage} cells=${manifest.cells.length} seeds=${manifest.seeds.length}`);

const seedsForStage = stage === 'screen' ? manifest.seeds.slice(0, 1) : manifest.seeds;
const ticksForStage = stage === 'screen' ? 400 : manifest.totalTicks;

const cellResults = [];
let runCount = 0;
const startedAt = performance.now();
for (const cell of manifest.cells) {
  const config = buildCellConfig(cell, manifest.populationSize, ticksForStage);
  const seedResults = [];
  for (const seed of seedsForStage) {
    const runStart = performance.now();
    const outcome = runSingle(config, asSeed(seed), { policy: 'mock-weighted-v1' });
    const elapsedMs = Math.round(performance.now() - runStart);
    const w1 = outcome.report.windows.find((window) => window.label === 'w1');
    const w3 = outcome.report.windows.find((window) => window.label === 'w3');
    const w2b = outcome.report.windows.find((window) => window.label === 'w2b');
    const windowPayload = (window) =>
      window === undefined
        ? null
        : {
            label: window.label,
            available: window.missingTicks === 0,
            missingTicks: window.missingTicks,
            classShares: window.classShares,
            gini: window.gini,
            topWealthShare: window.topWealthShare,
            mUp: window.mUp,
            mDown: window.mDown,
            segregation: window.segregation,
            openness: window.openness,
            edgeCountAverage: window.edgeCountAverage,
            crossClassEdgeShare: window.crossClassEdgeShare,
            deathRate: window.deathRate,
            networkEmpty: window.networkEmpty,
            labels: outcome.report.labelsByWindow[window.label] ?? [],
            evidence: outcome.report.labelsEvidenceByWindow[window.label] ?? {},
          };
    runCount += 1;
    seedResults.push({
      seed,
      elapsedMs,
      extinct: outcome.report.extinct,
      endReason: outcome.report.endReason,
      endTick: outcome.report.endTick,
      aliveAtEnd: outcome.report.aliveAtEnd,
      finalStateHash: outcome.report.finalStateHash,
      configHash: outcome.configHash,
      paramsHash: outcome.paramsHash,
      w1: windowPayload(w1),
      w3: windowPayload(w3),
      w2b: windowPayload(w2b),
    });
  }
  log(`cell=${cell.cellKey} done (${seedResults.length} seeds)`);
  cellResults.push({ cellKey: cell.cellKey, hypothesis: cell.hypothesis, seeds: seedResults });
}

// 聚类（仅 full 阶段）：预注册全部特征窗口（默认 w3）特征点 → z-score → Ward k∈[2,5]；
// 同 run 的 w2b 特征点用同一标尺标准化后按最近质心分配，与 w3 簇比较得到吸引子一致性。
let clustering = null;
if (stage === 'full') {
  const featureWindows = manifest.clustering.featureWindows;
  const points = [];
  const pointMeta = [];
  for (const cell of cellResults) {
    for (const seedResult of cell.seeds) {
      for (const key of featureWindows) {
        const w = seedResult[key];
        if (w !== null && w.available) {
          points.push(featureVector(w));
          pointMeta.push({ cell: cell.cellKey, seed: seedResult.seed, window: key });
        }
      }
    }
  }
  log(`clustering points=${points.length} windows=${featureWindows.join(',')}`);
  if (points.length >= 8) {
    // z-score 标尺只在 pooled 特征矩阵上拟合一次；w2b 复用同一标尺，禁止原始值混入。
    const scaler = fitStandardizer(points);
    const z = points.map((row) => scaler.standardize(row));
    const choice = chooseKBySilhouette(z);
    const stabilityRuns = STABILITY_SEED_OFFSETS.map((seed) =>
      bisectStability(
        z,
        choice.k,
        [seededShuffle(z.length, seed)],
        manifest.clustering.stabilityMinAri,
      ),
    );
    const stabilityAri = Math.max(...stabilityRuns.map((run) => run.ari));
    const minAri = Math.min(...stabilityRuns.map((run) => run.ari));
    const meanAri = stabilityRuns.reduce((sum, run) => sum + run.ari, 0) / stabilityRuns.length;
    const clusterSizes = new Map();
    for (const a of choice.assignment) {
      clusterSizes.set(a, (clusterSizes.get(a) ?? 0) + 1);
    }
    const smallestCluster = minClusterSize(choice.assignment);
    const minClusterMet = smallestCluster >= manifest.clustering.minClusterRuns;
    // 吸引子稳定性诊断（预注册 warmupDiagnostic）：每 run 的 w2b 特征点按
    // w3 聚类质心最近分配，与该 run 的 w3 簇比较一致率。
    let temporalConsistency = null;
    {
      const centroidAcc = new Map();
      const centroidCount = new Map();
      for (let index = 0; index < pointMeta.length; index += 1) {
        const cluster = choice.assignment[index];
        const vector = z[index];
        const bucket = (centroidAcc.get(cluster) ?? new Array(vector.length).fill(0)).map((v) => v);
        for (let j = 0; j < vector.length; j += 1) bucket[j] += vector[j];
        centroidAcc.set(cluster, bucket);
        centroidCount.set(cluster, (centroidCount.get(cluster) ?? 0) + 1);
      }
      const centroids = new Map();
      for (const [cluster, sum] of centroidAcc) {
        centroids.set(
          cluster,
          sum.map((v) => v / (centroidCount.get(cluster) ?? 1)),
        );
      }
      const w3ByKey = new Map();
      for (let index = 0; index < pointMeta.length; index += 1) {
        w3ByKey.set(pointMeta[index].cell + '|' + pointMeta[index].seed, choice.assignment[index]);
      }
      let same = 0;
      let total = 0;
      for (const cell of cellResults) {
        for (const seedResult of cell.seeds) {
          const alt = seedResult.w2b;
          const w3Assign = w3ByKey.get(cell.cellKey + '|' + seedResult.seed);
          if (!alt || !alt.available || w3Assign === undefined) continue;
          const vector = scaler.standardize(featureVector(alt));
          let best = null;
          let bestDistance = Number.POSITIVE_INFINITY;
          for (const [cluster, centroid] of centroids) {
            const d = euclidean(vector, centroid);
            if (d < bestDistance) {
              bestDistance = d;
              best = cluster;
            }
          }
          total += 1;
          if (best === w3Assign) same += 1;
        }
      }
      temporalConsistency =
        total === 0
          ? null
          : {
              window: 'w2b',
              sameClusterRate: Math.round((same / total) * 1000) / 1000,
              total,
            };
    }
    clustering = {
      k: choice.k,
      silhouette: Math.round(choice.score * 1000) / 1000,
      stabilityAri: Math.round(stabilityAri * 1000) / 1000,
      stabilityAriMin: Math.round(minAri * 1000) / 1000,
      stabilityAriMean: Math.round(meanAri * 1000) / 1000,
      stabilityMinAri: manifest.clustering.stabilityMinAri,
      stabilityShuffles: STABILITY_SEED_OFFSETS.length,
      stabilityStable: minClusterMet && minAri >= manifest.clustering.stabilityMinAri,
      minClusterSize: smallestCluster,
      minClusterRuns: manifest.clustering.minClusterRuns,
      minClusterMet,
      temporalConsistency,
      clusterSizes: Object.fromEntries([...clusterSizes.entries()].map(([k, v]) => [`c${k}`, v])),
      assignment: choice.assignment.map((cluster, index) => ({
        ...pointMeta[index],
        cluster: `c${cluster}`,
      })),
    };
  }
}

const wallMinutes = Math.round((performance.now() - startedAt) / 60000);
const output = {
  schemaVersion: 'p15-grid-v1',
  stage,
  preregistrationHash,
  runCount,
  wallMinutes,
  manifest: {
    populationSize: manifest.populationSize,
    totalTicks: ticksForStage,
    seeds: seedsForStage,
    labelThresholdVersion: manifest.labelThresholdVersion,
    labelThresholdsHash: manifest.labelThresholdsHash,
  },
  clustering,
  cells: cellResults,
};
mkdirSync('out', { recursive: true });
writeFileSync(`out/p15-${stage}.json`, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(output)}\n`);
log(`written out/p15-${stage}.json (${runCount} runs, ${wallMinutes}min)`);

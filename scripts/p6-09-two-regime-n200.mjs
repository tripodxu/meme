#!/usr/bin/env node
/**
 * P6-09（阶段 R1 / ADR 0010）：N=200 “2 体制 + 连续统”独立确认轮。
 *
 * - rules-v16（默认 generationalMode='none'），沿用 P6-05/06 的 6 个参数区域（A–F）；
 * - N=200 人 × 30 个全新 seed（p6-09-seed-001..030）× 10950 tick，每 cell 前 10 续跑 14600 tick（共 240 run）；
 * - 11 维全特征 Ward-LW + z-score(pooled) + 20 次二分洗牌；
 * - 按 docs/07 §8.2（ADR 0010 修订口径）判定，并同时报告旧条件 4 口径对照。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { DEFAULT_RUN_CONFIG, mergeConfig } from '../dist/core/config/defaults.js';
import { computeConfigHash } from '../dist/core/config/hash.js';
import { asSeed } from '../dist/core/control/ids.js';
import { HASH_DOMAINS } from '../dist/core/hash/domains.js';
import { hashValue } from '../dist/core/hash/hash.js';
import { runSingle } from '../dist/runner/run-cell.js';
import {
  bisectStability,
  euclidean,
  fitStandardizer,
  seededShuffle,
  silhouetteScore,
  wardCluster,
} from '../dist/runner/cluster.js';

const SEEDS = Array.from({ length: 30 }, (_, i) => `p6-09-seed-${String(i + 1).padStart(3, '0')}`);
const FOLLOWUP_SEEDS = SEEDS.slice(0, 10);

const CELLS = [
  {
    cellKey: 'A-share100-w0',
    overrides: { ascent: { displacementShare: 1.0, scarcityWeight: 0 } },
  },
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

function windowFeatures(stats, startTick, endTick) {
  const rows = stats.filter((s) => s.tick >= startTick && s.tick <= endTick && s.aliveCount > 0);
  if (rows.length !== endTick - startTick + 1) return null;
  const vec = new Array(11).fill(0);
  for (const s of rows) {
    for (let c = 0; c < 5; c += 1) vec[c] += (s.classCounts[c] ?? 0) / s.aliveCount;
    vec[5] += s.gini;
    vec[6] += s.topWealthShare;
    vec[7] += s.mUp;
    vec[8] += s.mDown;
    vec[9] += s.segregation;
    vec[10] += s.openness;
  }
  return vec.map((v) => v / rows.length);
}

if (!isMainThread) {
  const tasks = workerData;
  const results = [];
  for (const task of tasks) {
    const cfg = mergeConfig(DEFAULT_RUN_CONFIG, {
      ...task.overrides,
      population: { initialPopulation: 200 },
      schedule: { totalTicks: task.totalTicks, statsStride: 1, snapshotStride: task.totalTicks },
    });
    const out = runSingle(cfg, asSeed(task.seed), {});
    const [wStart, wEnd] = task.totalTicks === 10950 ? [10585, 10949] : [14235, 14599];
    results.push({
      kind: task.kind,
      cellKey: task.cellKey,
      seed: task.seed,
      extinct: out.report.extinct,
      feat: windowFeatures(out.stats, wStart, wEnd),
    });
  }
  parentPort.postMessage(results);
} else {
  const nearestCentroid = (point, centroids) => {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < centroids.length; i += 1) {
      const d = euclidean(point, centroids[i]);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  };

  const evaluateK = (k, matrix, zBase, baseRuns, followupRaw, std) => {
    const labels = wardCluster(zBase, k);
    const sil = silhouetteScore(zBase, labels);
    const ariSamples = [];
    for (let s = 0; s < 20; s += 1) {
      const order = seededShuffle(zBase.length, 20261119 + k * 997 + s * 7919);
      ariSamples.push(bisectStability(zBase, k, [order], 0.7).ari);
    }
    ariSamples.sort((a, b) => a - b);
    const ariMin = ariSamples[0];
    const ariMedian = (ariSamples[9] + ariSamples[10]) / 2;
    const ariMax = ariSamples[ariSamples.length - 1];
    const sizes = Array.from({ length: k }, (_, c) => labels.filter((l) => l === c).length);
    const comp = Array.from({ length: k }, (_, c) => {
      const counts = {};
      baseRuns.forEach((r, idx) => {
        if (labels[idx] === c) counts[r.cellKey] = (counts[r.cellKey] ?? 0) + 1;
      });
      return counts;
    });
    const centroidsZ = Array.from({ length: k }, (_, c) => {
      const pts = zBase.filter((_, idx) => labels[idx] === c);
      return Array.from(
        { length: pts[0].length },
        (_, j) => pts.reduce((s, p) => s + p[j], 0) / pts.length,
      );
    });
    const centroidsRaw = Array.from({ length: k }, (_, c) => {
      const pts = matrix.filter((_, idx) => labels[idx] === c);
      return Array.from({ length: pts[0].length }, (_, j) =>
        Number((pts.reduce((s, p) => s + p[j], 0) / pts.length).toFixed(4)),
      );
    });
    const baseLabelMap = new Map(
      baseRuns.map((r, idx) => [`${r.cellKey}::${r.seed}`, labels[idx]]),
    );
    let same = 0;
    let total = 0;
    for (const r of followupRaw) {
      if (r.feat === null) continue;
      const assigned = nearestCentroid(std.standardize(r.feat), centroidsZ);
      if (assigned === baseLabelMap.get(`${r.cellKey}::${r.seed}`)) same += 1;
      total += 1;
    }
    return {
      clusterSizes: sizes,
      clusterComposition: comp,
      centroidsRaw,
      ariMedian: Number(ariMedian.toFixed(4)),
      ariMin: Number(ariMin.toFixed(4)),
      ariMax: Number(ariMax.toFixed(4)),
      silhouette: Number(sil.toFixed(4)),
      temporalConsistency: Number((total > 0 ? same / total : 0).toFixed(4)),
      antiPreset: comp.some((c) => Object.keys(c).length >= 2),
    };
  };

  const prereg = {
    experimentType: 'p6-09-two-regime-continuum-n200',
    rulesVersion: DEFAULT_RUN_CONFIG.rulesVersion,
    baseConfigHash: computeConfigHash(DEFAULT_RUN_CONFIG),
    population: 200,
    cells: CELLS,
    seeds: SEEDS,
    followupSeeds: FOLLOWUP_SEEDS,
    baseTicks: 10950,
    followupTicks: 14600,
    clustering: { algorithm: 'ward-lw-v1', standardization: 'z-score-pooled', shuffles: 20 },
  };
  const preregistrationHash = hashValue(HASH_DOMAINS.preregistration, prereg);
  const experimentId = `p6-09-${preregistrationHash.slice(7, 15)}`;

  const tasks = [];
  for (const cell of CELLS) {
    for (const seed of SEEDS)
      tasks.push({
        kind: 'base',
        cellKey: cell.cellKey,
        overrides: cell.overrides,
        seed,
        totalTicks: 10950,
      });
    for (const seed of FOLLOWUP_SEEDS)
      tasks.push({
        kind: 'followup',
        cellKey: cell.cellKey,
        overrides: cell.overrides,
        seed,
        totalTicks: 14600,
      });
  }

  const workersCount = Math.min(availableParallelism(), 8);
  const buckets = Array.from({ length: workersCount }, () => []);
  tasks.forEach((task, idx) => buckets[idx % workersCount].push(task));

  const rawCachePath = 'out/p6-09-raw.json';
  let flat;
  if (existsSync(rawCachePath)) {
    const cached = JSON.parse(readFileSync(rawCachePath, 'utf8'));
    if (cached.preregistrationHash === preregistrationHash && Array.isArray(cached.runs)) {
      flat = cached.runs;
    }
  }
  const t0 = Date.now();
  if (flat === undefined) {
    process.stderr.write(
      `Running P6-09 (${experimentId}) N=200 across ${workersCount} workers: 240 runs...\n`,
    );
    const selfPath = fileURLToPath(import.meta.url);
    const parts = await Promise.all(
      buckets.map(
        (chunk) =>
          new Promise((resolve, reject) => {
            const w = new Worker(selfPath, { workerData: chunk });
            w.on('message', resolve);
            w.on('error', reject);
          }),
      ),
    );
    flat = parts.flat();
    mkdirSync('out', { recursive: true });
    writeFileSync(
      rawCachePath,
      JSON.stringify({ experimentId, preregistrationHash, runs: flat }),
      'utf8',
    );
  }

  const baseRaw = flat.filter((r) => r.kind === 'base');
  const followupRaw = flat.filter((r) => r.kind === 'followup');
  let excluded = 0;
  let extinctCount = 0;
  const baseRuns = [];
  for (const r of baseRaw) {
    if (r.extinct) extinctCount += 1;
    if (r.feat === null) {
      excluded += 1;
      continue;
    }
    baseRuns.push(r);
  }
  for (const r of followupRaw) if (r.extinct) extinctCount += 1;
  baseRuns.sort((a, b) => (a.cellKey + a.seed).localeCompare(b.cellKey + b.seed));

  const matrix = baseRuns.map((r) => r.feat);
  const std = fitStandardizer(matrix);
  const zBase = matrix.map((v) => std.standardize(v));
  const k2 = evaluateK(2, matrix, zBase, baseRuns, followupRaw, std);
  const k3 = evaluateK(3, matrix, zBase, baseRuns, followupRaw, std);

  const tvP =
    0.5 *
    [0, 1, 2, 3, 4].reduce(
      (s, idx) => s + Math.abs(k2.centroidsRaw[0][idx] - k2.centroidsRaw[1][idx]),
      0,
    );
  const deltaS = Math.abs(k2.centroidsRaw[0][9] - k2.centroidsRaw[1][9]);
  const deltaO = Math.abs(k2.centroidsRaw[0][10] - k2.centroidsRaw[1][10]);

  const k2Stable =
    k2.clusterSizes.every((s) => s >= 5) &&
    k2.ariMedian >= 0.7 &&
    k2.silhouette >= 0.35 &&
    k2.temporalConsistency >= 0.8 &&
    k2.antiPreset &&
    Math.max(tvP, deltaS, deltaO) >= 0.1;

  const hasDiscreteThirdClusterLegacy =
    k3.clusterSizes.every((s) => s >= 5) && k3.ariMedian >= 0.7 && k3.temporalConsistency >= 0.8;
  const hasDiscreteThirdClusterAdr0010 =
    hasDiscreteThirdClusterLegacy && k3.silhouette >= 0.35 && k3.silhouette >= k2.silhouette;

  const passes =
    k2Stable && !hasDiscreteThirdClusterAdr0010 && excluded === 0 && extinctCount === 0;
  const result = {
    experimentId,
    preregistrationHash,
    wallSeconds: Number(((Date.now() - t0) / 1000).toFixed(2)),
    runs: { base: baseRuns.length, followup: followupRaw.length, excluded, extinctCount },
    k2,
    k3,
    regimeDiff: {
      tvP: Number(tvP.toFixed(4)),
      deltaS: Number(deltaS.toFixed(4)),
      deltaO: Number(deltaO.toFixed(4)),
    },
    checks: {
      k2Stable,
      hasDiscreteThirdClusterLegacy,
      hasDiscreteThirdClusterAdr0010,
    },
    verdict: passes ? 'two-regime-candidate' : 'not-accepted',
    passes,
  };
  writeFileSync('out/p6-09-two-regime-result.json', `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

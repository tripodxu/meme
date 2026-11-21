#!/usr/bin/env node
/**
 * P6-10（阶段 R2-A / ADR 0011 / rules-v17）：阶级结构性容量上限 k=3 正式确认轮。
 *
 * - 6 个参数单元（3 类体制各含 2 个单元满足反预设）× 30 全新 seed（p6-10-seed-001..030）；
 * - 40 人 × 10950 tick，每 cell 前 10 续跑 14600 tick（共 240 run）；
 * - 11 维全特征 Ward-LW + z-score(pooled) + 20 次二分洗牌；
 * - 按 docs/07 §8.1 严格口径判定 k=3。
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

const SEEDS = Array.from({ length: 30 }, (_, i) => `p6-10-seed-${String(i + 1).padStart(3, '0')}`);
const FOLLOWUP_SEEDS = SEEDS.slice(0, 10);

const CELLS = [
  {
    cellKey: 'A1_pyramid_share1_w0',
    overrides: {
      ascent: { displacementShare: 1.0, scarcityWeight: 0, classCapacity: [1, 1, 1, 1, 1] },
    },
  },
  {
    cellKey: 'A2_pyramid_share1_w15',
    overrides: {
      ascent: { displacementShare: 1.0, scarcityWeight: 15, classCapacity: [1, 1, 1, 1, 1] },
    },
  },
  {
    cellKey: 'B1_top_open_share0',
    overrides: {
      ascent: { displacementShare: 0.0, scarcityWeight: 0, classCapacity: [1, 1, 1, 1, 1] },
    },
  },
  {
    cellKey: 'B2_top_open_share01',
    overrides: {
      ascent: { displacementShare: 0.1, scarcityWeight: 0, classCapacity: [1, 1, 1, 1, 1] },
    },
  },
  {
    cellKey: 'C1_olive_capped_A',
    overrides: {
      ascent: {
        displacementShare: 0.0,
        scarcityWeight: 0,
        classCapacity: [1, 0.35, 0.35, 0.15, 0.05],
      },
    },
  },
  {
    cellKey: 'C2_olive_capped_B',
    overrides: {
      ascent: {
        displacementShare: 0.0,
        scarcityWeight: 0,
        classCapacity: [1, 0.3, 0.4, 0.15, 0.05],
      },
    },
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
      population: { initialPopulation: 40 },
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

  const prereg = {
    experimentType: 'p6-10-k3-class-capacity-confirmation',
    rulesVersion: DEFAULT_RUN_CONFIG.rulesVersion,
    baseConfigHash: computeConfigHash(DEFAULT_RUN_CONFIG),
    cells: CELLS,
    seeds: SEEDS,
    followupSeeds: FOLLOWUP_SEEDS,
    baseTicks: 10950,
    followupTicks: 14600,
    clustering: { algorithm: 'ward-lw-v1', standardization: 'z-score-pooled', k: 3, shuffles: 20 },
  };
  const preregistrationHash = hashValue(HASH_DOMAINS.preregistration, prereg);
  const experimentId = `p6-10-${preregistrationHash.slice(7, 15)}`;

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

  const rawCachePath = 'out/p6-10-raw.json';
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
      `Running P6-10 (${experimentId}) across ${workersCount} workers: 240 runs...\n`,
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
  const labels = wardCluster(zBase, 3);
  const sil = silhouetteScore(zBase, labels);
  const ariSamples = [];
  for (let s = 0; s < 20; s += 1) {
    const order = seededShuffle(zBase.length, 20261120 + s * 7919);
    ariSamples.push(bisectStability(zBase, 3, [order], 0.7).ari);
  }
  ariSamples.sort((a, b) => a - b);
  const ariMin = ariSamples[0];
  const ariMedian = (ariSamples[9] + ariSamples[10]) / 2;
  const ariMax = ariSamples[ariSamples.length - 1];

  const clusterSizes = [0, 1, 2].map((k) => labels.filter((l) => l === k).length);
  const clusterComposition = [0, 1, 2].map((k) => {
    const counts = {};
    baseRuns.forEach((r, idx) => {
      if (labels[idx] === k) counts[r.cellKey] = (counts[r.cellKey] ?? 0) + 1;
    });
    return counts;
  });
  const antiPreset = clusterComposition.some((c) => Object.keys(c).length >= 2);
  const centroidsZ = [0, 1, 2].map((k) => {
    const pts = zBase.filter((_, idx) => labels[idx] === k);
    return Array.from(
      { length: pts[0].length },
      (_, j) => pts.reduce((s, p) => s + p[j], 0) / pts.length,
    );
  });
  const centroidsRaw = [0, 1, 2].map((k) => {
    const pts = matrix.filter((_, idx) => labels[idx] === k);
    return Array.from({ length: pts[0].length }, (_, j) =>
      Number((pts.reduce((s, p) => s + p[j], 0) / pts.length).toFixed(4)),
    );
  });
  const baseLabelMap = new Map(baseRuns.map((r, idx) => [`${r.cellKey}::${r.seed}`, labels[idx]]));
  let same = 0;
  let followupTotal = 0;
  for (const r of followupRaw) {
    if (r.feat === null) continue;
    const assigned = nearestCentroid(std.standardize(r.feat), centroidsZ);
    if (assigned === baseLabelMap.get(`${r.cellKey}::${r.seed}`)) same += 1;
    followupTotal += 1;
  }
  const temporalConsistency = followupTotal > 0 ? same / followupTotal : 0;

  const passes =
    clusterSizes.every((s) => s >= 5) &&
    ariMedian >= 0.7 &&
    sil >= 0.35 &&
    temporalConsistency >= 0.8 &&
    antiPreset &&
    extinctCount / 240 <= 0.1 &&
    excluded === 0;

  const result = {
    experimentId,
    preregistrationHash,
    wallSeconds: Number(((Date.now() - t0) / 1000).toFixed(2)),
    runs: { base: baseRuns.length, followup: followupTotal, excluded, extinctCount },
    k3: {
      clusterSizes,
      clusterComposition,
      centroidsRaw,
      ariMedian: Number(ariMedian.toFixed(4)),
      ariMin: Number(ariMin.toFixed(4)),
      ariMax: Number(ariMax.toFixed(4)),
      silhouette: Number(sil.toFixed(4)),
      temporalConsistency: Number(temporalConsistency.toFixed(4)),
      antiPreset,
    },
    verdict: passes ? 'three-cluster-candidate' : 'not-accepted-return-to-rule-review',
    passes,
  };
  writeFileSync(
    'out/p6-10-class-capacity-result.json',
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

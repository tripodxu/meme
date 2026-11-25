#!/usr/bin/env node
/**
 * 阶段 R2-B 30-run 探索探针（rules-v18 / population.talentInheritanceWeight）：
 * - 6 个参数单元 × 5 探索 seed（explore-r2b-seed-001..005）× 40 人 × 10950 tick；
 * - 11 维全特征 Ward-LW + z-score(pooled) + 20 次二分洗牌；
 * - 探索达标门槛（roadmap §3）：k=3 ARI >= 0.85 且 silhouette >= 0.45。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { DEFAULT_RUN_CONFIG, mergeConfig } from '../dist/core/config/defaults.js';
import { asSeed } from '../dist/core/control/ids.js';
import { runSingle } from '../dist/runner/run-cell.js';
import {
  bisectStability,
  fitStandardizer,
  seededShuffle,
  silhouetteScore,
  wardCluster,
} from '../dist/runner/cluster.js';

const SEEDS = Array.from(
  { length: 5 },
  (_, i) => `explore-r2b-seed-${String(i + 1).padStart(3, '0')}`,
);

const CELLS = [
  {
    cellKey: 'A1_pyramid_bequest0',
    overrides: {
      population: {
        generationalMode: 'replace',
        bequestRate: 0,
        classInheritanceRate: 0,
        talentInheritanceWeight: 0,
      },
      ascent: { displacementShare: 1.0, scarcityWeight: 0 },
    },
  },
  {
    cellKey: 'A2_pyramid_bequest50',
    overrides: {
      population: {
        generationalMode: 'replace',
        bequestRate: 0.5,
        classInheritanceRate: 0,
        talentInheritanceWeight: 0,
      },
      ascent: { displacementShare: 1.0, scarcityWeight: 0 },
    },
  },
  {
    cellKey: 'B1_open_fresh',
    overrides: {
      population: {
        generationalMode: 'replace',
        bequestRate: 0,
        classInheritanceRate: 0,
        talentInheritanceWeight: 0,
      },
      ascent: { displacementShare: 0.0, scarcityWeight: 0 },
    },
  },
  {
    cellKey: 'B2_open_talent1',
    overrides: {
      population: {
        generationalMode: 'replace',
        bequestRate: 0.5,
        classInheritanceRate: 0.5,
        talentInheritanceWeight: 1.0,
      },
      ascent: { displacementShare: 0.0, scarcityWeight: 0 },
    },
  },
  {
    cellKey: 'C1_locked_w30_talent15',
    overrides: {
      population: {
        generationalMode: 'replace',
        bequestRate: 0.8,
        classInheritanceRate: 1.0,
        talentInheritanceWeight: 1.5,
      },
      ascent: { displacementShare: 0.5, scarcityWeight: 30 },
    },
  },
  {
    cellKey: 'C2_locked_w60_talent20',
    overrides: {
      population: {
        generationalMode: 'replace',
        bequestRate: 0.8,
        classInheritanceRate: 1.0,
        talentInheritanceWeight: 2.0,
      },
      ascent: { displacementShare: 0.5, scarcityWeight: 60 },
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
  for (let d = 0; d < 11; d += 1) vec[d] /= rows.length;
  return vec;
}

if (!isMainThread) {
  const { task } = workerData;
  const config = mergeConfig(DEFAULT_RUN_CONFIG, {
    population: { initialPopulation: 40, ...task.overrides.population },
    ascent: { ...task.overrides.ascent },
    schedule: { totalTicks: 10950, statsStride: 1, snapshotStride: 10950 },
  });
  const t0 = Date.now();
  const res = runSingle(config, asSeed(task.seed), { policy: 'mock-weighted-v1' });
  const f10950 = windowFeatures(res.stats, 10585, 10949);
  parentPort.postMessage({
    cellKey: task.cellKey,
    seed: task.seed,
    extinct: res.report.extinct,
    f10950,
    elapsedMs: Date.now() - t0,
  });
  process.exit(0);
}

async function runPool(tasks, concurrency) {
  const results = [];
  let nextIdx = 0;
  const selfPath = fileURLToPath(import.meta.url);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (nextIdx < tasks.length) {
        const idx = nextIdx;
        nextIdx += 1;
        const task = tasks[idx];
        const r = await new Promise((resolve, reject) => {
          const w = new Worker(selfPath, { workerData: { task } });
          w.on('message', resolve);
          w.on('error', reject);
        });
        results.push(r);
      }
    }),
  );
  return results;
}

async function main() {
  const tStart = Date.now();
  const tasks = [];
  for (const cell of CELLS) {
    for (const seed of SEEDS) {
      tasks.push({ cellKey: cell.cellKey, overrides: cell.overrides, seed });
    }
  }
  const concurrency = Math.max(1, Math.min(8, availableParallelism()));
  console.error(`[explore-r2b] running ${tasks.length} tasks (concurrency=${concurrency})...`);
  const results = await runPool(tasks, concurrency);

  const valid = results.filter((r) => !r.extinct && r.f10950 !== null);
  console.error(
    `[explore-r2b] done in ${((Date.now() - tStart) / 1000).toFixed(2)}s; valid=${valid.length}/${results.length}`,
  );

  const rawPoints = valid.map((r) => r.f10950);
  const std = fitStandardizer(rawPoints);
  const points = rawPoints.map((v) => std.standardize(v));

  const summary = {
    experiment: 'explore-r2b-talent',
    totalRuns: results.length,
    validRuns: valid.length,
    extinctRuns: results.filter((r) => r.extinct).length,
    cells: {},
    clustering: {},
  };

  for (const cell of CELLS) {
    const rows = valid.filter((r) => r.cellKey === cell.cellKey);
    const mean = new Array(11).fill(0);
    for (const r of rows) for (let d = 0; d < 11; d += 1) mean[d] += r.f10950[d] / rows.length;
    summary.cells[cell.cellKey] = {
      n: rows.length,
      P: mean.slice(0, 5).map((v) => Number(v.toFixed(4))),
      G: Number(mean[5].toFixed(4)),
      topWealth: Number(mean[6].toFixed(4)),
      Mup: Number(mean[7].toFixed(4)),
      Mdown: Number(mean[8].toFixed(4)),
      S: Number(mean[9].toFixed(4)),
      O: Number(mean[10].toFixed(4)),
    };
  }

  for (const k of [2, 3]) {
    const assignments = wardCluster(points, k);
    const clusterSizes = Array.from(
      { length: k },
      (_, c) => assignments.filter((l) => l === c).length,
    );
    const sil = silhouetteScore(points, assignments);
    const ariSamples = [];
    for (let s = 0; s < 20; s += 1) {
      const order = seededShuffle(points.length, 20261121 + s * 7919);
      ariSamples.push(bisectStability(points, k, [order], 0.7).ari);
    }
    ariSamples.sort((a, b) => a - b);
    const ariMin = ariSamples[0];
    const ariMedian = (ariSamples[9] + ariSamples[10]) / 2;
    const clusterCells = Array.from({ length: k }, () => ({}));
    valid.forEach((r, idx) => {
      const c = assignments[idx];
      clusterCells[c][r.cellKey] = (clusterCells[c][r.cellKey] ?? 0) + 1;
    });
    summary.clustering[`k${k}`] = {
      clusterSizes,
      ariMedian: Number(ariMedian.toFixed(4)),
      ariMin: Number(ariMin.toFixed(4)),
      silhouette: Number(sil.toFixed(4)),
      clusterCells,
    };
  }

  summary.passesProbeGate =
    summary.clustering.k3.ariMedian >= 0.85 && summary.clustering.k3.silhouette >= 0.45;

  mkdirSync('out', { recursive: true });
  writeFileSync('out/explore-r2b-talent-result.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

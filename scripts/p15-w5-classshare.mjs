#!/usr/bin/env node
/**
 * W5：rules-v10 的 class-share 三类候选确认（探索层确认候选）。
 *
 * 设计先于运行冻结：docs/research/2026-11-04-p15-w5-classshare.design.json。
 * 假设来自 W4 的特征子空间分析（changes/0024），不是 W4 的预注册假设。
 *
 * 输出：out/p15-w5-classshare.json
 */
import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { buildV10ConfirmationManifest, buildCellConfig } from '../dist/runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { asSeed } from '../dist/core/control/ids.js';
import {
  fitStandardizer,
  wardCluster,
  silhouetteScore,
  bisectStability,
  seededShuffle,
  euclidean,
  minClusterRunCount,
} from '../dist/runner/cluster.js';

const DESIGN_PATH = 'docs/research/2026-11-04-p15-w5-classshare.design.json';
const OUTPUT_PATH = 'out/p15-w5-classshare.json';
const designBytes = readFileSync(DESIGN_PATH);
const designHash = createHash('sha256').update(designBytes).digest('hex');
const design = JSON.parse(designBytes.toString('utf8'));
const args = process.argv.slice(2);
const seedLimit = args.includes('--seeds')
  ? Number(args[args.indexOf('--seeds') + 1])
  : design.seeds.length;
const seeds = design.seeds.slice(0, seedLimit);
const convergenceLimit = args.includes('--convergence')
  ? Number(args[args.indexOf('--convergence') + 1])
  : design.convergence.seedsPerCell;
if (seeds.length === 0 || !Number.isInteger(convergenceLimit) || convergenceLimit < 0) {
  throw new Error('W5 seed/convergence 参数非法');
}
const manifest = buildV10ConfirmationManifest();
const cells = design.cells.map((key) => {
  const cell = manifest.cells.find((candidate) => candidate.cellKey === key);
  if (cell === undefined) throw new Error(`W5 design 引用了未知 cell: ${key}`);
  return cell;
});

function log(message) {
  process.stderr.write(`[w5] ${message}\n`);
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const nearest = (row, centroids) => {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  centroids.forEach((centroid, index) => {
    const distance = euclidean(row, centroid);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
};

function finalShares(state) {
  const alive = state.society.agents.filter((agent) => agent.alive);
  if (alive.length === 0) return null;
  const counts = new Array(5).fill(0);
  for (const agent of alive) counts[agent.classIndex] += 1;
  return counts.map((count) => count / alive.length);
}

const startedAt = performance.now();
const rows = [];
const indexByKey = new Map();
let runCount = 0;
for (const cell of cells) {
  const config = buildCellConfig(cell, design.populationSize, design.horizon);
  for (const seed of seeds) {
    const outcome = runSingle(config, asSeed(seed), {
      policy: design.policy,
      maxTicks: design.horizon,
    });
    runCount += 1;
    const w2b = outcome.report.windows.find((window) => window.label === 'w2b');
    const w3 = outcome.report.windows.find((window) => window.label === 'w3');
    if (outcome.report.extinct || w2b === undefined || w3 === undefined || w3.missingTicks !== 0) {
      log(`excluded ${cell.cellKey} ${seed} (extinct/unavailable)`);
      continue;
    }
    const row = {
      cellKey: cell.cellKey,
      seed,
      w2bShares: [...w2b.classShares],
      w3Shares: [...w3.classShares],
    };
    indexByKey.set(`${cell.cellKey}|${seed}`, rows.length);
    rows.push(row);
  }
  log(`${cell.cellKey} done`);
}

const points = rows.map((row) => row.w3Shares);
const scaler = fitStandardizer(points);
const z = points.map((row) => scaler.standardize(row));
const assignment = wardCluster(z, design.clustering.k);
const k = design.clustering.k;
const silhouette = Math.round(silhouetteScore(z, assignment) * 1000) / 1000;
const aris = Array.from(
  { length: design.clustering.stabilityShuffles },
  (_, offset) => bisectStability(z, k, [seededShuffle(z.length, 20261103 + offset)], 0.7).ari,
);
const ariMedian = Math.round(mean(aris) * 1000) / 1000;
const ariMin = Math.round(Math.min(...aris) * 1000) / 1000;

const dims = z[0]?.length ?? 0;
const centroids = Array.from({ length: k }, (_, cluster) => {
  const members = rows.map((_, index) => index).filter((index) => assignment[index] === cluster);
  const centroid = new Array(dims).fill(0);
  for (const index of members) {
    const row = z[index];
    for (let dimension = 0; dimension < dims; dimension += 1) {
      centroid[dimension] += row[dimension] ?? 0;
    }
  }
  return members.length === 0 ? centroid : centroid.map((value) => value / members.length);
});

const clusterSizes = {};
const clusterCells = {};
assignment.forEach((cluster, index) => {
  clusterSizes[cluster] = (clusterSizes[cluster] ?? 0) + 1;
  const cell = rows[index].cellKey;
  clusterCells[cluster] = clusterCells[cluster] ?? {};
  clusterCells[cluster][cell] = (clusterCells[cluster][cell] ?? 0) + 1;
});
const minRuns = minClusterRunCount(
  assignment,
  rows.map((row) => `${row.cellKey}|${row.seed}`),
);

const temporalMatches = rows.filter((row, index) => {
  const w2bCluster = nearest(scaler.standardize(row.w2bShares), centroids);
  return w2bCluster === assignment[index];
}).length;
const temporalRate = rows.length === 0 ? 0 : temporalMatches / rows.length;

const cellMeans = cells.map((cell) => {
  const group = rows.filter((row) => row.cellKey === cell.cellKey);
  const shares = Array.from({ length: 5 }, (_, index) =>
    mean(group.map((row) => row.w3Shares[index])),
  );
  return { cellKey: cell.cellKey, shares };
});
const directional = cellMeans.map((entry) => {
  const [p0, p1, p2] = entry.shares;
  const rule = entry.cellKey.startsWith('A-')
    ? { group: 'A', met: p0 >= 0.4 }
    : entry.cellKey.startsWith('B-')
      ? { group: 'B', met: p0 <= 0.02 && p2 >= 0.4 }
      : { group: 'C', met: p0 >= 0.05 && p1 >= 0.35 && p2 <= 0.35 };
  return { ...entry, ...rule };
});
const directionalMet = directional.every((entry) => entry.met);

const convergenceRows = [];
for (const cell of cells) {
  const config = buildCellConfig(cell, design.populationSize, design.convergence.horizon);
  for (const seed of seeds.slice(0, convergenceLimit)) {
    const outcome = runSingle(config, asSeed(seed), {
      policy: design.policy,
      maxTicks: design.convergence.horizon,
    });
    const mainIndex = indexByKey.get(`${cell.cellKey}|${seed}`);
    const shares = outcome.report.extinct ? null : finalShares(outcome.finalState);
    const same =
      mainIndex !== undefined &&
      shares !== null &&
      nearest(scaler.standardize(shares), centroids) === assignment[mainIndex];
    convergenceRows.push({ cellKey: cell.cellKey, seed, same });
  }
  log(`${cell.cellKey} convergence done`);
}
const convergenceRate =
  convergenceRows.length === 0
    ? 0
    : convergenceRows.filter((row) => row.same).length / convergenceRows.length;

const gates = {
  ariMedian: {
    observed: ariMedian,
    threshold: design.clustering.ariMedianMin,
    met: ariMedian >= design.clustering.ariMedianMin,
  },
  ariMin: {
    observed: ariMin,
    threshold: design.clustering.ariMinMin,
    met: ariMin >= design.clustering.ariMinMin,
  },
  temporalConsistency: {
    observed: Math.round(temporalRate * 1000) / 1000,
    threshold: design.clustering.temporalConsistencyMinRate,
    met: temporalRate >= design.clustering.temporalConsistencyMinRate,
  },
  minClusterRuns: {
    observed: minRuns,
    threshold: design.clustering.minClusterRuns,
    met: minRuns >= design.clustering.minClusterRuns,
  },
  directional: {
    observed: directional,
    met: directionalMet,
  },
  convergence: {
    observed: Math.round(convergenceRate * 1000) / 1000,
    threshold: design.convergence.sameClusterRateMin,
    met: convergenceRate >= design.convergence.sameClusterRateMin,
  },
};
const passed = Object.values(gates).every((gate) => gate.met);
const failed = Object.entries(gates)
  .filter(([, gate]) => !gate.met)
  .map(([name]) => name);

const wallMinutes = Math.round((performance.now() - startedAt) / 60000);
const output = {
  schemaVersion: 'p15-w5-classshare-v1',
  confirmationCandidate: true,
  postHocHypothesis: true,
  design: DESIGN_PATH,
  designHash: `sha256:${designHash}`,
  note: 'W5 探索层确认候选：假设来自 W4 特征子空间分析；即使通过也不构成校准或“结构已涌现”。',
  execution: { runCount, wallMinutes, cells: design.cells, seeds },
  featureSet: design.featureSet,
  k,
  silhouette,
  stability: { ariMedian, ariMin, shuffles: design.clustering.stabilityShuffles },
  clusterSizes,
  clusterCells,
  minClusterRuns: minRuns,
  temporalConsistency: { matches: temporalMatches, total: rows.length, rate: temporalRate },
  cellMeans,
  directional,
  convergence: {
    horizon: design.convergence.horizon,
    seedsPerCell: convergenceLimit,
    rate: convergenceRate,
    rows: convergenceRows,
  },
  gates,
  passed,
  verdict: passed
    ? 'W5 三类候选通过全部预注册 gate（仍非校准/涌现声明）'
    : `W5 三类候选未通过：${failed.join('、')}`,
  rows,
};
mkdirSync('out', { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(
  `${JSON.stringify({
    designHash: output.designHash,
    runCount,
    wallMinutes,
    k,
    silhouette,
    ariMedian,
    ariMin,
    temporalRate,
    minRuns,
    convergenceRate,
    passed,
    verdict: output.verdict,
    cells: clusterCells,
    directional,
  })}\n`,
);
log(`written ${OUTPUT_PATH} (${runCount} + ${convergenceRows.length} runs, ${wallMinutes}min)`);

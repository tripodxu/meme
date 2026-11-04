#!/usr/bin/env node
/**
 * W6：长视野 class-share 三类候选确认（10950 tick 终态）。
 *
 * 设计先于运行冻结：docs/research/2026-11-04-p15-w6-longhorizon.design.json。
 * 假设来自 W5 3650 失败后的长视野探索；本脚本使用全新 p15r6 种子。
 * 输出：out/p15-w6-longhorizon.json
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { buildCellConfig } from '../dist/runner/preregistration.js';
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

const DESIGN_PATH = 'docs/research/2026-11-04-p15-w6-longhorizon.design.json';
const OUTPUT_PATH = 'out/p15-w6-longhorizon.json';
const designBytes = readFileSync(DESIGN_PATH);
const designHash = createHash('sha256').update(designBytes).digest('hex');
const design = JSON.parse(designBytes.toString('utf8'));
const POPULATION = design.populationSize;
const HORIZON = design.horizon;
const SEEDS = design.seeds;

const CELLS = [
  { cellKey: 'A-share1-H0', overrides: {} },
  {
    cellKey: 'B-share50-w15-H0',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 15 } },
  },
  {
    cellKey: 'C-share50-w60-H0',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 60 } },
  },
];

const mean = (values) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
const l1 = (a, b) => a.reduce((sum, value, index) => sum + Math.abs(value - (b[index] ?? 0)), 0);

function finalShares(state) {
  const alive = state.society.agents.filter((agent) => agent.alive);
  if (alive.length === 0) return null;
  const counts = new Array(5).fill(0);
  for (const agent of alive) counts[agent.classIndex] += 1;
  return counts.map((count) => count / alive.length);
}

function runCell(cell, horizon, seed) {
  const config = buildCellConfig(
    { cellKey: `${cell.cellKey}@${horizon}`, overrides: cell.overrides },
    POPULATION,
    horizon,
  );
  const outcome = runSingle(config, asSeed(seed), {
    policy: design.policy,
    maxTicks: horizon,
  });
  return {
    cellKey: cell.cellKey,
    horizon,
    seed,
    extinct: outcome.report.extinct,
    shares: outcome.report.extinct ? null : finalShares(outcome.finalState),
    alive: outcome.report.aliveAtEnd,
  };
}

const startedAt = performance.now();
const rows = [];
for (const cell of CELLS) {
  for (const seed of SEEDS) {
    rows.push(runCell(cell, HORIZON, seed));
  }
  process.stderr.write(`[w6] ${cell.cellKey} @${HORIZON} done\n`);
}

const usable = rows.filter((row) => row.shares !== null);
const points = usable.map((row) => row.shares);
const scaler = fitStandardizer(points);
const z = points.map((point) => scaler.standardize(point));
const k = design.clustering.k;
const assignment = wardCluster(z, k);
const silhouette = Math.round(silhouetteScore(z, assignment) * 1000) / 1000;
const aris = Array.from(
  { length: design.clustering.stabilityShuffles },
  (_, offset) => bisectStability(z, k, [seededShuffle(z.length, 20261106 + offset)], 0.7).ari,
);
const ariMedian = Math.round(mean(aris) * 1000) / 1000;
const ariMin = Math.round(Math.min(...aris) * 1000) / 1000;
const minRuns = minClusterRunCount(
  assignment,
  usable.map((row) => `${row.cellKey}|${row.seed}`),
);

const sizes = {};
const cells = {};
const membership = {};
usable.forEach((row, index) => {
  const cluster = assignment[index];
  sizes[cluster] = (sizes[cluster] ?? 0) + 1;
  cells[cluster] = cells[cluster] ?? {};
  cells[cluster][row.cellKey] = (cells[cluster][row.cellKey] ?? 0) + 1;
  membership[`${row.cellKey}|${row.seed}`] = cluster;
});

// 每个簇的多数 cell 与每个 cell 的多数簇（簇编号任意，用 cell 锚定语义）。
const clusterCell = {};
for (const [cluster, counts] of Object.entries(cells)) {
  clusterCell[cluster] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
const cellMajority = {};
for (const cell of CELLS) {
  const counts = {};
  for (const row of usable) {
    if (row.cellKey !== cell.cellKey) continue;
    const cluster = membership[`${row.cellKey}|${row.seed}`];
    counts[cluster] = (counts[cluster] ?? 0) + 1;
  }
  const [cluster, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  cellMajority[cell.cellKey] = { cluster: cluster === null ? null : Number(cluster), count };
}
const cellClusters = new Set(Object.values(cellMajority).map((entry) => entry.cluster));
const cellPurityOk =
  cellClusters.size === CELLS.length &&
  CELLS.every(
    (cell) => cellMajority[cell.cellKey].count >= design.cellPurity.majorityClusterMinRuns,
  );

// 原始 class-share 空间的簇质心，用于 B/C 分离与 14600 分配。
const centroidsRaw = Array.from({ length: k }, (_, cluster) => {
  const members = usable.filter((_, index) => assignment[index] === cluster);
  return Array.from({ length: 5 }, (_, dimension) =>
    mean(members.map((row) => row.shares[dimension])),
  );
});
const clusterByCell = {};
for (const cluster of Object.keys(clusterCell)) {
  if (clusterCell[cluster] !== null) clusterByCell[clusterCell[cluster]] = Number(cluster);
}
const bCluster = clusterByCell['B-share50-w15-H0'];
const cCluster = clusterByCell['C-share50-w60-H0'];
const bMinusCL1 =
  bCluster === undefined || cCluster === undefined
    ? null
    : l1(centroidsRaw[bCluster], centroidsRaw[cCluster]);

const directional = {};
for (const cell of CELLS) {
  const subset = usable.filter((row) => row.cellKey === cell.cellKey);
  directional[cell.cellKey] = {
    meanShares: Array.from({ length: 5 }, (_, index) =>
      mean(subset.map((row) => row.shares[index])),
    ),
    runs: subset.length,
  };
}
const directionalOk = {
  A: (directional['A-share1-H0']?.meanShares[0] ?? 0) >= 0.4,
  B:
    (directional['B-share50-w15-H0']?.meanShares[0] ?? 1) <= 0.02 &&
    (directional['B-share50-w15-H0']?.meanShares[2] ?? 0) >= 0.3 &&
    (directional['B-share50-w15-H0']?.meanShares[3] ?? 0) >= 0.3,
  C:
    (directional['C-share50-w60-H0']?.meanShares[0] ?? 1) <= 0.02 &&
    (directional['C-share50-w60-H0']?.meanShares[1] ?? 0) >= 0.2 &&
    (directional['C-share50-w60-H0']?.meanShares[2] ?? 0) >= 0.3 &&
    (directional['C-share50-w60-H0']?.meanShares[3] ?? 1) <= 0.3,
};

// 14600 收敛子集：同一 seed 的终态分配到 10950 的最近质心。
const centroidZ = centroidsRaw.map((centroid) => scaler.standardize(centroid));
const convergenceRows = [];
for (const cell of CELLS) {
  for (const seed of SEEDS.slice(0, design.convergence.seedsPerCell)) {
    const row = runCell(cell, design.convergence.horizon, seed);
    if (row.shares === null) {
      convergenceRows.push({ ...row, same: false });
      continue;
    }
    const standardized = scaler.standardize(row.shares);
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    centroidZ.forEach((centroid, cluster) => {
      const distance = euclidean(standardized, centroid);
      if (distance < best) {
        best = distance;
        nearest = cluster;
      }
    });
    const base = membership[`${cell.cellKey}|${seed}`];
    convergenceRows.push({
      cellKey: cell.cellKey,
      seed,
      horizon: design.convergence.horizon,
      cluster14600: nearest,
      cluster10950: base ?? null,
      same: base !== undefined && base === nearest,
    });
  }
  process.stderr.write(`[w6] ${cell.cellKey} convergence done\n`);
}
const convergenceMatches = convergenceRows.filter((row) => row.same).length;
const convergenceRate =
  convergenceRows.length === 0 ? 0 : convergenceMatches / convergenceRows.length;
const convergenceByCell = {};
for (const row of convergenceRows) {
  convergenceByCell[row.cellKey] = convergenceByCell[row.cellKey] ?? { total: 0, same: 0 };
  convergenceByCell[row.cellKey].total += 1;
  if (row.same) convergenceByCell[row.cellKey].same += 1;
}

const failures = [];
if (!(ariMedian >= design.clustering.ariMedianMin)) failures.push('ARI median');
if (!(ariMin >= design.clustering.ariMinMin)) failures.push('ARI min');
if (!(minRuns >= design.clustering.minClusterRuns)) failures.push('minClusterRuns');
if (!(silhouette >= design.clustering.silhouetteMin)) failures.push('silhouette');
if (!cellPurityOk) failures.push('cellPurity');
if (bMinusCL1 === null || bMinusCL1 < design.centroidSeparation.bMinusCL1Min) {
  failures.push('B/C centroid separation');
}
if (!(convergenceRate >= design.convergence.sameClusterRateMin)) {
  failures.push('14600 convergence');
}
if (!Object.values(directionalOk).every(Boolean)) failures.push('directional');

const output = {
  schemaVersion: 'p15-w6-longhorizon-v1',
  confirmationCandidate: true,
  designPath: DESIGN_PATH,
  designHash,
  note: 'W6 长视野三类候选确认；即使通过也只是 P6-05 候选，不构成校准或结构已涌现。',
  execution: {
    runCount: rows.length + convergenceRows.length,
    wallMinutes: Math.round((performance.now() - startedAt) / 60000),
    seeds: SEEDS,
    policy: design.policy,
    horizon: HORIZON,
  },
  clustering: {
    k,
    silhouette,
    ariMedian,
    ariMin,
    shuffles: design.clustering.stabilityShuffles,
    minClusterRuns: minRuns,
    sizes,
    cells,
  },
  cellMajority,
  clusterCell,
  centroidSeparation: { bMinusCL1 },
  directional,
  directionalOk,
  convergence: {
    rate: convergenceRate,
    matches: convergenceMatches,
    total: convergenceRows.length,
    byCell: convergenceByCell,
  },
  verdict:
    failures.length === 0
      ? 'W6 三类候选通过（非 P6-05/校准声明）'
      : `W6 未通过：${failures.join(', ')}`,
  failures,
  rows,
  convergenceRows,
};
mkdirSync('out', { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(
  `${JSON.stringify(
    {
      designHash,
      verdict: output.verdict,
      clustering: output.clustering,
      cellMajority,
      bMinusCL1,
      convergence: output.convergence,
      directionalOk,
    },
    null,
    2,
  )}\n`,
);

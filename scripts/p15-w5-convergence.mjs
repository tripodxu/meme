#!/usr/bin/env node
/**
 * W5 后续收敛探针（探索层）：B-w15 与 C-w60 在 10950 tick 是否回到 W5 的 3650 簇？
 *
 * 只读 W5 产物重建 3650 的 scaler/centroids，再跑两个边界 cell × 30 seeds × 10950 tick。
 * 不改变 W5 预注册判定；只用于判断“边界是否随时间收敛”。
 */
import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import { buildV10ConfirmationManifest, buildCellConfig } from '../dist/runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { asSeed } from '../dist/core/control/ids.js';
import { fitStandardizer, wardCluster, euclidean } from '../dist/runner/cluster.js';

const W5_PATH = 'out/p15-w5-classshare.json';
const args = process.argv.slice(2);
const OUTPUT_PATH = args.includes('--out')
  ? args[args.indexOf('--out') + 1]
  : 'out/p15-w5-convergence-10950.json';
const HORIZON = args.includes('--horizon') ? Number(args[args.indexOf('--horizon') + 1]) : 10950;
const CELL_KEYS = args.includes('--cells')
  ? args[args.indexOf('--cells') + 1].split(',')
  : ['B-share50-w15', 'C-share50-w60'];
const SEED_COUNT = args.includes('--seeds') ? Number(args[args.indexOf('--seeds') + 1]) : 30;

const w5 = JSON.parse(readFileSync(W5_PATH, 'utf8'));
const manifest = buildV10ConfirmationManifest();
const cells = CELL_KEYS.map((key) => {
  const cell = manifest.cells.find((candidate) => candidate.cellKey === key);
  if (cell === undefined) throw new Error(`未知 cell: ${key}`);
  return cell;
});

const scaler = fitStandardizer(w5.rows.map((row) => row.w3Shares));
const z = w5.rows.map((row) => scaler.standardize(row.w3Shares));
const assignment = wardCluster(z, 3);
const dims = z[0].length;
const centroids = Array.from({ length: 3 }, (_, cluster) => {
  const members = w5.rows.map((_, index) => index).filter((index) => assignment[index] === cluster);
  const centroid = new Array(dims).fill(0);
  for (const index of members) {
    for (let dimension = 0; dimension < dims; dimension += 1) {
      centroid[dimension] += z[index][dimension] ?? 0;
    }
  }
  return members.length === 0 ? centroid : centroid.map((value) => value / members.length);
});
const nearest = (row) => {
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
const w5Cluster = new Map(
  w5.rows.map((row, index) => [`${row.cellKey}|${row.seed}`, assignment[index]]),
);

function finalShares(state) {
  const alive = state.society.agents.filter((agent) => agent.alive);
  if (alive.length === 0) return null;
  const counts = new Array(5).fill(0);
  for (const agent of alive) counts[agent.classIndex] += 1;
  return counts.map((count) => count / alive.length);
}

const startedAt = performance.now();
const rows = [];
for (const cell of cells) {
  const config = buildCellConfig(cell, 40, HORIZON);
  for (const seed of w5.execution.seeds.slice(0, SEED_COUNT)) {
    const outcome = runSingle(config, asSeed(seed), {
      policy: 'mock-weighted-v1',
      maxTicks: HORIZON,
    });
    const shares = outcome.report.extinct ? null : finalShares(outcome.finalState);
    const base = w5Cluster.get(`${cell.cellKey}|${seed}`);
    const cluster = shares === null ? null : nearest(scaler.standardize(shares));
    rows.push({
      cellKey: cell.cellKey,
      seed,
      w5Cluster: base ?? null,
      cluster10950: cluster,
      same: base !== undefined && cluster !== null && base === cluster,
    });
  }
  process.stderr.write(`[w5-conv] ${cell.cellKey} done\n`);
}

const stats = {};
for (const row of rows) {
  stats[row.cellKey] = stats[row.cellKey] ?? { total: 0, same: 0 };
  stats[row.cellKey].total += 1;
  if (row.same) stats[row.cellKey].same += 1;
}
const wallMinutes = Math.round((performance.now() - startedAt) / 60000);
const output = {
  schemaVersion: 'p15-w5-convergence-10950-v1',
  exploratory: true,
  w5Source: W5_PATH,
  horizon: HORIZON,
  note: '探索层：只判断 B/C 边界是否随时间收敛；不改变 W5 预注册判定。',
  execution: { runCount: rows.length, wallMinutes, seeds: w5.execution.seeds.slice(0, SEED_COUNT) },
  stats,
  rows,
};
mkdirSync('out', { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ wallMinutes, stats, rows })}\n`);

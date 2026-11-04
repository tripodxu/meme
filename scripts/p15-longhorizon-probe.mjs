#!/usr/bin/env node
/**
 * 长视野 class-share 探针（探索层，不是确认轮）。
 *
 * 问题：W5 用 3650 的簇映射 10950 终态，把 C 判成“滑回 B”。
 * 本脚本直接在 10950/14600 终态上聚类，检验 A / B / C 是否形成三类。
 *
 * 复用 W5 的 p15r5 种子做探索复核；确认轮必须另取全新种子并预注册。
 * 输出：out/p15-longhorizon-probe.json（exploratory=true）。
 */
import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import { buildCellConfig } from '../dist/runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { asSeed } from '../dist/core/control/ids.js';
import {
  fitStandardizer,
  wardCluster,
  silhouetteScore,
  bisectStability,
  seededShuffle,
  minClusterRunCount,
} from '../dist/runner/cluster.js';

const DESIGN = 'docs/research/2026-11-04-p15-w5-classshare.design.json';
const design = JSON.parse(readFileSync(DESIGN, 'utf8'));
const SEEDS = design.seeds;
const args = process.argv.slice(2);
const SEED_COUNT = args.includes('--seeds')
  ? Number(args[args.indexOf('--seeds') + 1])
  : SEEDS.length;
const HORIZONS = args.includes('--horizons')
  ? args[args.indexOf('--horizons') + 1].split(',').map(Number)
  : [10950];
const CELL_FILTER = args.includes('--cells') ? args[args.indexOf('--cells') + 1].split(',') : null;
const OUTPUT_PATH = args.includes('--out')
  ? args[args.indexOf('--out') + 1]
  : 'out/p15-longhorizon-probe.json';
const POPULATION = 40;

const ALL_CELLS = [
  { cellKey: 'A-share1-H0', overrides: {} },
  {
    cellKey: 'B-share50-w15-H0',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 15 } },
  },
  {
    cellKey: 'C-share50-w60-H0',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 60 } },
  },
  {
    cellKey: 'C-share50-w60-H365',
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 60, occupancyMemoryDays: 365 },
    },
  },
];
const CELLS =
  CELL_FILTER === null ? ALL_CELLS : ALL_CELLS.filter((cell) => CELL_FILTER.includes(cell.cellKey));
if (CELLS.length === 0) throw new Error(`--cells 未匹配任何 cell: ${CELL_FILTER?.join(',')}`);

function finalShares(state) {
  const alive = state.society.agents.filter((agent) => agent.alive);
  if (alive.length === 0) return null;
  const counts = new Array(5).fill(0);
  for (const agent of alive) counts[agent.classIndex] += 1;
  return counts.map((count) => count / alive.length);
}

const seeds = SEEDS.slice(0, SEED_COUNT);
const startedAt = performance.now();
const rows = [];
for (const cell of CELLS) {
  for (const horizon of HORIZONS) {
    const config = buildCellConfig(
      { cellKey: `${cell.cellKey}@${horizon}`, overrides: cell.overrides },
      POPULATION,
      horizon,
    );
    for (const seed of seeds) {
      const outcome = runSingle(config, asSeed(seed), {
        policy: 'mock-weighted-v1',
        maxTicks: horizon,
      });
      rows.push({
        cellKey: cell.cellKey,
        horizon,
        seed,
        extinct: outcome.report.extinct,
        shares: outcome.report.extinct ? null : finalShares(outcome.finalState),
        alive: outcome.report.aliveAtEnd,
      });
    }
    process.stderr.write(`[longhorizon] ${cell.cellKey} @${horizon} done\n`);
  }
}

const analyses = {};
for (const horizon of HORIZONS) {
  const subset = rows.filter((row) => row.horizon === horizon && row.shares !== null);
  const points = subset.map((row) => row.shares);
  if (points.length < 3) {
    analyses[horizon] = { runs: points.length, skipped: true };
    continue;
  }
  const scaler = fitStandardizer(points);
  const z = points.map((point) => scaler.standardize(point));
  const byK = {};
  for (const k of [2, 3, 4]) {
    const assignment = wardCluster(z, k);
    const aris = Array.from(
      { length: 20 },
      (_, offset) => bisectStability(z, k, [seededShuffle(z.length, 20261105 + offset)], 0.7).ari,
    );
    const sizes = {};
    const cells = {};
    assignment.forEach((cluster, index) => {
      sizes[cluster] = (sizes[cluster] ?? 0) + 1;
      const cell = subset[index].cellKey;
      cells[cluster] = cells[cluster] ?? {};
      cells[cluster][cell] = (cells[cluster][cell] ?? 0) + 1;
    });
    byK[k] = {
      silhouette: Math.round(silhouetteScore(z, assignment) * 1000) / 1000,
      ariMedian:
        Math.round((aris.reduce((sum, value) => sum + value, 0) / aris.length) * 1000) / 1000,
      ariMin: Math.round(Math.min(...aris) * 1000) / 1000,
      minClusterRuns: minClusterRunCount(
        assignment,
        subset.map((row) => `${row.cellKey}|${row.seed}`),
      ),
      sizes,
      cells,
    };
  }
  analyses[horizon] = { runs: points.length, byK };
}

const output = {
  schemaVersion: 'p15-longhorizon-probe-v1',
  exploratory: true,
  sourceDesign: DESIGN,
  note: '长视野终态聚类探索；复用 W5 的 p15r5 种子，不得作为 P6-05 确认证据。',
  seeds,
  horizons: HORIZONS,
  runCount: rows.length,
  wallMinutes: Math.round((performance.now() - startedAt) / 60000),
  analyses,
  rows,
};
mkdirSync('out', { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(
  `${JSON.stringify({ runCount: output.runCount, wallMinutes: output.wallMinutes, analyses }, null, 2)}\n`,
);

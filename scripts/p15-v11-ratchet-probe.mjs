#!/usr/bin/env node
/**
 * rules-v11 占用压力记忆探针（探索层，不是确认轮）。
 *
 * 问题：v10 的 C 类只是有限视野瞬态。占用记忆 m_c=max(p_c, e^{-1/H}m_c)
 * 是否能把 C 钉住，还是只把滑回 B 的时间推后？
 *
 * 设计：6 cell（A / B / C-H0 / C-H90 / C-H180 / C-H365）× 5 seeds ×
 * 3650/10950 tick = 60 run；mock 策略；只报终态占比与窗口指标。
 * 输出：out/p15-v11-ratchet-probe.json（exploratory=true）。
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';

import { buildCellConfig, PREREG_SEEDS } from '../dist/runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { asSeed } from '../dist/core/control/ids.js';

const args = process.argv.slice(2);
const SEED_COUNT = args.includes('--seeds') ? Number(args[args.indexOf('--seeds') + 1]) : 5;
const HORIZONS = args.includes('--horizons')
  ? args[args.indexOf('--horizons') + 1].split(',').map(Number)
  : [3650, 10950];
const OUTPUT_PATH = args.includes('--out')
  ? args[args.indexOf('--out') + 1]
  : 'out/p15-v11-ratchet-probe.json';
const POPULATION = 40;

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
  {
    cellKey: 'C-share50-w60-H90',
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 60, occupancyMemoryDays: 90 },
    },
  },
  {
    cellKey: 'C-share50-w60-H180',
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 60, occupancyMemoryDays: 180 },
    },
  },
  {
    cellKey: 'C-share50-w60-H365',
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 60, occupancyMemoryDays: 365 },
    },
  },
];

function finalShares(state) {
  const alive = state.society.agents.filter((agent) => agent.alive);
  if (alive.length === 0) return null;
  const counts = new Array(5).fill(0);
  for (const agent of alive) counts[agent.classIndex] += 1;
  return counts.map((count) => count / alive.length);
}

function l1(a, b) {
  return a.reduce((sum, value, index) => sum + Math.abs(value - (b[index] ?? 0)), 0);
}

const seeds = PREREG_SEEDS.slice(0, SEED_COUNT);
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
      const shares = outcome.report.extinct ? null : finalShares(outcome.finalState);
      const lastStats = outcome.stats.at(-1);
      rows.push({
        cellKey: cell.cellKey,
        horizon,
        seed,
        extinct: outcome.report.extinct,
        alive: outcome.report.aliveAtEnd,
        shares,
        mUp: lastStats?.mUp ?? null,
        mDown: lastStats?.mDown ?? null,
        occupancyPressure: [...outcome.finalState.society.occupancyPressure],
      });
    }
    process.stderr.write(`[v11-ratchet] ${cell.cellKey} @${horizon} done\n`);
  }
}

const mean = (values) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
const stats = {};
for (const cell of CELLS) {
  for (const horizon of HORIZONS) {
    const subset = rows.filter(
      (row) => row.cellKey === cell.cellKey && row.horizon === horizon && row.shares !== null,
    );
    stats[`${cell.cellKey}@${horizon}`] = {
      runs: subset.length,
      extinct: rows.filter(
        (row) => row.cellKey === cell.cellKey && row.horizon === horizon && row.extinct,
      ).length,
      meanShares: Array.from({ length: 5 }, (_, index) =>
        mean(subset.map((row) => row.shares[index])),
      ),
      shareSd: Array.from({ length: 5 }, (_, index) => {
        const values = subset.map((row) => row.shares[index]);
        const mu = mean(values);
        if (mu === null) return null;
        return Math.sqrt(mean(values.map((value) => (value - mu) ** 2)));
      }),
      meanMUp: mean(subset.map((row) => row.mUp)),
      meanMemory: Array.from({ length: 5 }, (_, index) =>
        mean(subset.map((row) => row.occupancyPressure[index])),
      ),
    };
  }
}

const drift = {};
for (const cell of CELLS) {
  const pairs = [];
  for (const seed of seeds) {
    const a = rows.find(
      (row) => row.cellKey === cell.cellKey && row.horizon === 3650 && row.seed === seed,
    );
    const b = rows.find(
      (row) => row.cellKey === cell.cellKey && row.horizon === 10950 && row.seed === seed,
    );
    if (a?.shares && b?.shares) pairs.push(l1(a.shares, b.shares));
  }
  drift[cell.cellKey] = {
    pairs: pairs.length,
    meanL1: mean(pairs),
    maxL1: pairs.length ? Math.max(...pairs) : null,
  };
}

const output = {
  schemaVersion: 'p15-v11-ratchet-probe-v1',
  exploratory: true,
  note: 'rules-v11 占用记忆探针；不构成 G1.5/P6-05 证据。H=0 为 v10 对照。',
  cells: CELLS.map((cell) => cell.cellKey),
  seeds,
  horizons: HORIZONS,
  runCount: rows.length,
  wallMinutes: Math.round((performance.now() - startedAt) / 60000),
  stats,
  drift,
  rows,
};
mkdirSync('out', { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(
  `${JSON.stringify({ runCount: output.runCount, wallMinutes: output.wallMinutes, drift, stats }, null, 2)}\n`,
);

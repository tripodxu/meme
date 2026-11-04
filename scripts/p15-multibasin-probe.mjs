#!/usr/bin/env node
/**
 * P1.5 多吸引域探针（探索层，不是确认轮）。
 *
 * 问题：v10 反馈轴探索显示同一参数下 ic-default 与 ic-middle 终态差异远大于
 * 种子噪声；本脚本检验这是否是稳定多吸引域，并测试第三/第四初始条件与更长视野。
 *
 * 设计：A/B/C 三个参数体制 × 4 个初始阶级分布 × 5 个种子 × 2 个视野
 * （3650 / 7300 tick）= 120 run。只使用 mock 策略，不改规则。
 *
 * 输出：out/p15-multibasin-probe.json（探索层；不得引用为 G1.5/P6 证据）
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';

import { buildCellConfig, PREREG_SEEDS } from '../dist/runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { asSeed } from '../dist/core/control/ids.js';
import {
  fitStandardizer,
  wardCluster,
  silhouetteScore,
  bisectStability,
  seededShuffle,
} from '../dist/runner/cluster.js';

const args = process.argv.slice(2);
const seedCount = args.includes('--seeds') ? Number(args[args.indexOf('--seeds') + 1]) : 5;
const SEEDS = PREREG_SEEDS.slice(0, seedCount);
const HORIZONS = args.includes('--horizons')
  ? args[args.indexOf('--horizons') + 1].split(',').map(Number)
  : [3650, 7300];
const OUTPUT_PATH = args.includes('--out')
  ? args[args.indexOf('--out') + 1]
  : 'out/p15-multibasin-probe.json';
const POPULATION = 40;

const ALL_CELLS = [
  { cellKey: 'A-share1', overrides: {} },
  {
    cellKey: 'B-share50-w10',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 10 } },
  },
  {
    cellKey: 'C-share50-w100',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 100 } },
  },
  {
    cellKey: 'D-open-congestion',
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 10 },
      dynamics: { congestionExponent: 1 },
    },
  },
];
const cellFilter = args.includes('--cells') ? args[args.indexOf('--cells') + 1].split(',') : null;
const CELLS =
  cellFilter === null ? ALL_CELLS : ALL_CELLS.filter((cell) => cellFilter.includes(cell.cellKey));
if (CELLS.length === 0) {
  throw new Error(`--cells 未匹配任何 cell：${cellFilter?.join(',')}`);
}

const ICS = [
  { key: 'ic-default', shares: [0.45, 0.3, 0.15, 0.08, 0.02] },
  { key: 'ic-middle', shares: [0.1, 0.25, 0.35, 0.22, 0.08] },
  { key: 'ic-bottom', shares: [0.6, 0.25, 0.1, 0.04, 0.01] },
  { key: 'ic-top', shares: [0.05, 0.15, 0.3, 0.3, 0.2] },
];

function log(message) {
  process.stderr.write(`[multibasin] ${message}\n`);
}

function finalMetrics(state, outcome) {
  const alive = state.society.agents.filter((agent) => agent.alive);
  const counts = new Array(5).fill(0);
  for (const agent of alive) counts[agent.classIndex] += 1;
  const total = alive.length === 0 ? 1 : alive.length;
  const classShares = counts.map((count) => count / total);
  let up = 0;
  let down = 0;
  for (const matrix of outcome.flowsByTick.values()) {
    for (let from = 0; from < 5; from += 1) {
      for (let to = 0; to < 5; to += 1) {
        if (to === from + 1) up += matrix[from]?.[to] ?? 0;
        if (to === from - 1) down += matrix[from]?.[to] ?? 0;
      }
    }
  }
  return { alive: alive.length, classShares, mUp: up, mDown: down };
}

const rows = [];
let runCount = 0;
const startedAt = performance.now();
for (const cell of CELLS) {
  for (const ic of ICS) {
    for (const horizon of HORIZONS) {
      const config = buildCellConfig(
        {
          cellKey: `${cell.cellKey}@${ic.key}@${horizon}`,
          overrides: {
            ...cell.overrides,
            population: { classShares: ic.shares },
          },
        },
        POPULATION,
        horizon,
      );
      for (const seed of SEEDS) {
        const outcome = runSingle(config, asSeed(seed), {
          policy: 'mock-weighted-v1',
          maxTicks: horizon,
        });
        runCount += 1;
        rows.push({
          cellKey: cell.cellKey,
          ic: ic.key,
          horizon,
          seed,
          extinct: outcome.report.extinct,
          metrics:
            outcome.report.extinct || outcome.finalState.society.agents.every((a) => !a.alive)
              ? null
              : finalMetrics(outcome.finalState, outcome),
        });
      }
      log(`${cell.cellKey} ${ic.key} horizon=${horizon} done`);
    }
  }
}

const mean = (values) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
const l1 = (a, b) => a.reduce((sum, value, index) => sum + Math.abs(value - (b[index] ?? 0)), 0);

const groupRows = (cellKey, ic, horizon) =>
  rows.filter(
    (row) =>
      row.cellKey === cellKey && row.ic === ic && row.horizon === horizon && row.metrics !== null,
  );

const perGroup = [];
for (const cell of CELLS) {
  for (const ic of ICS) {
    for (const horizon of HORIZONS) {
      const group = groupRows(cell.cellKey, ic.key, horizon);
      const shares = [0, 1, 2, 3, 4].map((index) =>
        mean(group.map((row) => row.metrics.classShares[index])),
      );
      perGroup.push({
        cellKey: cell.cellKey,
        ic: ic.key,
        horizon,
        n: group.length,
        extinct: rows.filter(
          (row) =>
            row.cellKey === cell.cellKey &&
            row.ic === ic.key &&
            row.horizon === horizon &&
            row.extinct,
        ).length,
        classShares: shares,
        mUp: mean(group.map((row) => row.metrics.mUp)),
        mDown: mean(group.map((row) => row.metrics.mDown)),
      });
    }
  }
}

// 同一 (cell, horizon) 下各 IC 的终态差异，与同组种子 L1 噪声对比。
const icSeparation = [];
for (const cell of CELLS) {
  for (const horizon of HORIZONS) {
    const groups = ICS.map((ic) => ({
      ic: ic.key,
      rows: groupRows(cell.cellKey, ic.key, horizon),
    }));
    const noise = groups.map(({ ic, rows: group }) => {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          sum += l1(group[i].metrics.classShares, group[j].metrics.classShares);
          count += 1;
        }
      }
      return { ic, noise: count === 0 ? null : sum / count };
    });
    const pairs = [];
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const a = groups[i];
        const b = groups[j];
        const n = Math.min(a.rows.length, b.rows.length);
        let sum = 0;
        for (let index = 0; index < n; index += 1) {
          sum += l1(a.rows[index].metrics.classShares, b.rows[index].metrics.classShares);
        }
        pairs.push({ a: a.ic, b: b.ic, meanL1: n === 0 ? null : sum / n });
      }
    }
    icSeparation.push({ cellKey: cell.cellKey, horizon, noise, pairs });
  }
}

// 池化聚类：每个 run 的终态 P 作为 5 维结构指纹。
const points = [];
const meta = [];
for (const row of rows) {
  if (row.metrics === null) continue;
  points.push(row.metrics.classShares);
  meta.push({ cellKey: row.cellKey, ic: row.ic, horizon: row.horizon, seed: row.seed });
}
const clustering = [];
if (points.length >= 8) {
  const scaler = fitStandardizer(points);
  const z = points.map((point) => scaler.standardize(point));
  for (let k = 2; k <= 5; k += 1) {
    const assignment = wardCluster(z, k);
    const sizes = {};
    const composition = {};
    assignment.forEach((cluster, index) => {
      sizes[cluster] = (sizes[cluster] ?? 0) + 1;
      const key = `${meta[index].cellKey}|${meta[index].ic}|h${meta[index].horizon}`;
      composition[cluster] = composition[cluster] ?? {};
      composition[cluster][key] = (composition[cluster][key] ?? 0) + 1;
    });
    const aris = Array.from(
      { length: 8 },
      (_, offset) => bisectStability(z, k, [seededShuffle(z.length, 20261103 + offset)], 0.7).ari,
    );
    clustering.push({
      k,
      silhouette: Math.round(silhouetteScore(z, assignment) * 1000) / 1000,
      sizes,
      composition,
      ariMedian: Math.round(mean(aris) * 1000) / 1000,
      ariMin: Math.round(Math.min(...aris) * 1000) / 1000,
    });
  }
}

const wallMinutes = Math.round((performance.now() - startedAt) / 60000);
const output = {
  schemaVersion: 'p15-multibasin-probe-v1',
  exploratory: true,
  note: '探索层（07 §6.1）：检验多吸引域与第三/第四初始条件；不构成 G1.5/P6 证据。',
  execution: { runCount, wallMinutes, seeds: SEEDS, horizons: HORIZONS },
  cells: CELLS.map((cell) => cell.cellKey),
  ics: ICS.map((ic) => ({ key: ic.key, shares: ic.shares })),
  perGroup,
  icSeparation,
  clustering,
  rows,
};
mkdirSync('out', { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(
  `${JSON.stringify({ runCount, wallMinutes, perGroup, icSeparation, clustering })}\n`,
);
log(`written ${OUTPUT_PATH} (${runCount} runs, ${wallMinutes}min)`);

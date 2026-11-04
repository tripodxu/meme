#!/usr/bin/env node
/**
 * P1.5 反馈轴探索（探索层，**不是确认轮**；07 §6.1 探索/确认分离）。
 *
 * 背景：W2 确认轮（rules-v8，26 cell）只扫描了 `need.*` 持有标尺轴，
 * 三方反馈（rule.md §28/§56/§58：β 网络机会、η 拥挤、κ 极化、O 制度权重）
 * 全部固定在默认值。本脚本补上缺失轴，并用「同参数 × 不同初始阶级分布」
 * 直接检验多吸引域（双稳态），而不是跨参数池化聚类。
 *
 * 用法：
 *   node scripts/p15-feedback-explore.mjs --stage screen   # 1 cell × 1 IC × 1 seed × 400 tick
 *   node scripts/p15-feedback-explore.mjs --stage full     # 10 cell × 2 IC × 6 seed × 3650 tick
 *
 * 输出：out/p15-feedback-explore.json（不含任何确认轮判定字段；不得引用为 G1.5 证据）
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';

import { buildCellConfig, PREREG_SEEDS } from '../dist/runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { asSeed } from '../dist/core/control/ids.js';
import { featureVector } from '../dist/runner/distance.js';
import { fitStandardizer, bisectStability, seededShuffle } from '../dist/runner/cluster.js';

const args = process.argv.slice(2);
const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : 'screen';
const family = args.includes('--family') ? args[args.indexOf('--family') + 1] : 'feedback';
const OUTPUT_PATH = `out/p15-${family}-explore.json`;

const POPULATION = 40;
const TICKS = stage === 'screen' ? 400 : 3650;
const seedCount = args.includes('--seeds')
  ? Number(args[args.indexOf('--seeds') + 1])
  : stage === 'screen'
    ? 1
    : 6;
const SEEDS = PREREG_SEEDS.slice(0, seedCount);

function log(message) {
  process.stderr.write(`[feedback] ${message}\n`);
}

/** 初始阶级分布：默认/中层/底层/顶层偏重（同一参数、不同初值 → 检验吸引域选择）。 */
const INITIAL_CONDITIONS = [
  { key: 'ic-default', classShares: [0.45, 0.3, 0.15, 0.08, 0.02] },
  { key: 'ic-middle', classShares: [0.1, 0.25, 0.35, 0.22, 0.08] },
  { key: 'ic-bottom', classShares: [0.6, 0.25, 0.1, 0.04, 0.01] },
  { key: 'ic-top', classShares: [0.05, 0.15, 0.3, 0.3, 0.2] },
];

/** 单轴 cell（07 §6.2：一次只变一项；交互轴不在本探索轮）。 */
const FEEDBACK_CELLS = [
  { cellKey: 'baseline', axis: 'baseline', overrides: {} },
  {
    cellKey: 'beta=0',
    axis: 'positive',
    overrides: { networkOpportunity: { beta: 0 } },
  },
  {
    cellKey: 'beta=2+max2',
    axis: 'positive',
    overrides: { networkOpportunity: { beta: 2.0, max: 2.0 } },
  },
  {
    cellKey: 'classWeight=3+value1.5',
    axis: 'positive',
    overrides: { network: { classWeight: 3.0, valueWeight: 1.5 } },
  },
  {
    cellKey: 'classWeight=0+value0',
    axis: 'positive-ablation',
    overrides: { network: { classWeight: 0, valueWeight: 0 } },
  },
  {
    cellKey: 'rewireProb=0.3',
    axis: 'positive',
    overrides: { network: { rewireProb: 0.3 } },
  },
  {
    cellKey: 'congestionExponent=1',
    axis: 'negative',
    overrides: { dynamics: { congestionExponent: 1.0 } },
  },
  {
    cellKey: 'polarizationExponent=1.5',
    axis: 'negative',
    overrides: { dynamics: { polarizationExponent: 1.5 } },
  },
  {
    cellKey: 'openness-weights=0',
    axis: 'institutional-ablation',
    overrides: { openness: { mobilityWeight: 0, giniWeight: 0, segregationWeight: 0 } },
  },
  {
    cellKey: 'openness-tau=10',
    axis: 'institutional',
    overrides: { openness: { timeConstantDays: 10 } },
  },
  {
    cellKey: 'crossDays×0.5',
    axis: 'mobility-cost',
    overrides: { ascent: { crossDays: [15, 20, 25, 30] } },
  },
];

/**
 * 开放准入体制（share=0.5, w=10）下的反馈轴：检验网络/制度反馈能否在
 * 高流动体制中恢复多吸引域。A 体制（share=1）的反馈轴已由 FEEDBACK_CELLS 覆盖。
 */
const OPEN_FEEDBACK_CELLS = [
  {
    cellKey: 'open-baseline-w10',
    axis: 'open-baseline',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 10 } },
  },
  {
    cellKey: 'open+beta=0',
    axis: 'open-positive',
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 10 },
      networkOpportunity: { beta: 0 },
    },
  },
  {
    cellKey: 'open+beta=2+max2',
    axis: 'open-positive',
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 10 },
      networkOpportunity: { beta: 2.0, max: 2.0 },
    },
  },
  {
    cellKey: 'open+classWeight=3+value1.5',
    axis: 'open-positive',
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 10 },
      network: { classWeight: 3.0, valueWeight: 1.5 },
    },
  },
  {
    cellKey: 'open+rewireProb=0.3',
    axis: 'open-positive',
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 10 },
      network: { rewireProb: 0.3 },
    },
  },
  {
    cellKey: 'open+congestionExponent=1',
    axis: 'open-negative',
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 10 },
      dynamics: { congestionExponent: 1.0 },
    },
  },
  {
    cellKey: 'open+polarizationExponent=1.5',
    axis: 'open-negative',
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 10 },
      dynamics: { polarizationExponent: 1.5 },
    },
  },
  {
    cellKey: 'open+openness-weights=0',
    axis: 'open-institutional-ablation',
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 10 },
      openness: { mobilityWeight: 0, giniWeight: 0, segregationWeight: 0 },
    },
  },
  {
    cellKey: 'open+openness-tau=10',
    axis: 'open-institutional',
    overrides: {
      ascent: { displacementShare: 0.5, scarcityWeight: 10 },
      openness: { timeConstantDays: 10 },
    },
  },
];

/** rules-v9 位移份额单轴（changes/0012）：1=v8 完全位移，0=完全开放准入。 */
const DISPLACEMENT_CELLS = [1, 0.75, 0.5, 0.25, 0].map((share) => ({
  cellKey: `displacementShare=${share}`,
  axis: 'displacement-share',
  overrides: { ascent: { displacementShare: share } },
}));

/** 位移份额 × 拥挤负反馈的交互：检验强负反馈能否托住底层（changes/0012 §探索）。 */
const BALANCE_CELLS = [0.75, 0.5].flatMap((share) =>
  [1, 2, 3].flatMap((eta) =>
    [0.2, 0.05].map((min) => ({
      cellKey: `share=${share}+eta=${eta}+min=${min}`,
      axis: 'displacement-balance',
      overrides: {
        ascent: { displacementShare: share },
        dynamics: { congestionExponent: eta, congestionMin: min },
      },
    })),
  ),
);

/** rules-v10 占用锚定 × 位移份额：检验位置稀缺能否托住底层并让参数选择结构。 */
const SCARCITY_CELLS = [1, 0.75, 0.5].flatMap((share) =>
  [0, 0.5, 1, 2, 4].map((weight) => ({
    cellKey: `share=${share}+scarcity=${weight}`,
    axis: 'occupancy-anchor',
    overrides: { ascent: { displacementShare: share, scarcityWeight: weight } },
  })),
);

/** 高强度占用锚定：values 远高于 crossBase 时，小权重不足以形成壁垒。 */
const SCARCITY_HIGH_CELLS = [0.75, 0.5].flatMap((share) =>
  [5, 10, 20, 50].map((weight) => ({
    cellKey: `share=${share}+scarcity=${weight}`,
    axis: 'occupancy-anchor-high',
    overrides: { ascent: { displacementShare: share, scarcityWeight: weight } },
  })),
);

/** 过渡带：定位 P0 恢复的阈值，并检验同参数不同初值是否仍选择同一结构。 */
const SCARCITY_TRANSITION_CELLS = [10, 15, 20, 25, 30, 40, 50].map((weight) => ({
  cellKey: `share=0.5+scarcity=${weight}`,
  axis: 'occupancy-transition',
  overrides: { ascent: { displacementShare: 0.5, scarcityWeight: weight } },
}));

/** 高权重尾部：检查 P0 是否随权重继续恢复（参数域上限 100）。 */
const SCARCITY_MAX_CELLS = [60, 80, 100].map((weight) => ({
  cellKey: `share=0.5+scarcity=${weight}`,
  axis: 'occupancy-max',
  overrides: { ascent: { displacementShare: 0.5, scarcityWeight: weight } },
}));

/** 平台区域（排除过渡带 w=20–30）：检验 A/B/C 是否形成可复现聚类。 */
const PLATEAU_CELLS = [
  { cellKey: 'A-share1', axis: 'plateau-A', overrides: {} },
  {
    cellKey: 'B-share50-w10',
    axis: 'plateau-B',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 10 } },
  },
  {
    cellKey: 'B-share50-w15',
    axis: 'plateau-B',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 15 } },
  },
  {
    cellKey: 'C-share50-w60',
    axis: 'plateau-C',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 60 } },
  },
  {
    cellKey: 'C-share50-w80',
    axis: 'plateau-C',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 80 } },
  },
  {
    cellKey: 'C-share50-w100',
    axis: 'plateau-C',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 100 } },
  },
];

const CELLS =
  family === 'displacement'
    ? DISPLACEMENT_CELLS
    : family === 'balance'
      ? BALANCE_CELLS
      : family === 'scarcity'
        ? SCARCITY_CELLS
        : family === 'scarcity-high'
          ? SCARCITY_HIGH_CELLS
          : family === 'scarcity-transition'
            ? SCARCITY_TRANSITION_CELLS
            : family === 'scarcity-max'
              ? SCARCITY_MAX_CELLS
              : family === 'plateau'
                ? PLATEAU_CELLS
                : family === 'open-feedback'
                  ? OPEN_FEEDBACK_CELLS
                  : FEEDBACK_CELLS;

const cellsForStage = stage === 'screen' ? CELLS.slice(0, 2) : CELLS;
const icCount = args.includes('--ics')
  ? Number(args[args.indexOf('--ics') + 1])
  : stage === 'screen'
    ? 1
    : INITIAL_CONDITIONS.length;
const icsForStage = INITIAL_CONDITIONS.slice(0, icCount);

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function tv(a, b) {
  let sum = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return sum; // P 是分布，TV = 0.5·L1；这里保留 L1 以便与 G-C 同口径比较
}

const startedAt = performance.now();
const results = [];
let runCount = 0;

for (const cell of cellsForStage) {
  for (const ic of icsForStage) {
    const config = buildCellConfig(
      {
        cellKey: `${cell.cellKey}@${ic.key}`,
        overrides: {
          ...cell.overrides,
          population: { classShares: ic.classShares },
        },
      },
      POPULATION,
      TICKS,
    );
    const seedResults = [];
    for (const seed of SEEDS) {
      const outcome = runSingle(config, asSeed(seed), { policy: 'mock-weighted-v1' });
      const pick = (label) => outcome.report.windows.find((window) => window.label === label);
      const payload = (window) =>
        window === undefined
          ? null
          : {
              label: window.label,
              available: window.missingTicks === 0,
              classShares: window.classShares,
              gini: window.gini,
              topWealthShare: window.topWealthShare,
              mUp: window.mUp,
              mDown: window.mDown,
              segregation: window.segregation,
              openness: window.openness,
              edgeCountAverage: window.edgeCountAverage,
              networkEmpty: window.networkEmpty,
              labels: outcome.report.labelsByWindow[window.label] ?? [],
            };
      runCount += 1;
      const up = new Array(5).fill(0);
      const down = new Array(5).fill(0);
      for (const matrix of outcome.flowsByTick.values()) {
        for (let from = 0; from < 5; from += 1) {
          for (let to = 0; to < 5; to += 1) {
            if (to === from + 1) up[from] += matrix[from][to];
            if (to === from - 1) down[from] += matrix[from][to];
          }
        }
      }
      seedResults.push({
        seed,
        extinct: outcome.report.extinct,
        aliveAtEnd: outcome.report.aliveAtEnd,
        finalStateHash: outcome.report.finalStateHash,
        transitions: { up, down },
        w2b: payload(pick('w2b')),
        w3: payload(pick('w3')),
      });
    }
    log(`cell=${cell.cellKey} ${ic.key} done (${seedResults.length} seeds)`);
    results.push({
      ...cell,
      initialCondition: ic.key,
      classShares: ic.classShares,
      seeds: seedResults,
    });
  }
}

// ---- 描述性分析 ---------------------------------------------------------
const usable = (entry) => entry.w3 !== null && entry.w3.available;
const meanOf = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

const perCell = [];
for (const cell of CELLS.filter((candidate) =>
  results.some((entry) => entry.cellKey === candidate.cellKey),
)) {
  const byIc = {};
  for (const entry of results.filter((row) => row.cellKey === cell.cellKey)) {
    const rows = entry.seeds.filter(usable);
    byIc[entry.initialCondition] = rows;
  }
  const keys = Object.keys(byIc);
  const fingerprint = (rows) => ({
    classShares: Array.from({ length: 5 }, (_, c) =>
      meanOf(rows.map((row) => row.w3.classShares[c] ?? 0)),
    ),
    gini: meanOf(rows.map((row) => row.w3.gini)),
    topWealthShare: meanOf(rows.map((row) => row.w3.topWealthShare)),
    mUp: meanOf(rows.map((row) => row.w3.mUp)),
    mDown: meanOf(rows.map((row) => row.w3.mDown)),
    segregation: meanOf(rows.map((row) => row.w3.segregation)),
    openness: meanOf(rows.map((row) => row.w3.openness)),
  });
  const fps = Object.fromEntries(keys.map((key) => [key, fingerprint(byIc[key])]));

  // 噪声带：同一 (cell, ic) 内不同种子的指纹离散度（以 run 对 run 的 L1 均值计）。
  const withinNoise = keys.map((key) => {
    const rows = byIc[key];
    if (rows.length < 2) return 0;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        sum += tv(rows[i].w3.classShares, rows[j].w3.classShares);
        count += 1;
      }
    }
    return count === 0 ? 0 : sum / count;
  });

  // 吸引域检验：同一参数、不同初始条件 → 终态差异。
  let betweenIc = null;
  if (keys.length >= 2) {
    const [a, b] = keys;
    const n = Math.min(byIc[a].length, byIc[b].length);
    let l1 = 0;
    let dG = 0;
    let dMup = 0;
    let dS = 0;
    for (let i = 0; i < n; i += 1) {
      l1 += tv(byIc[a][i].w3.classShares, byIc[b][i].w3.classShares);
      dG += Math.abs(byIc[a][i].w3.gini - byIc[b][i].w3.gini);
      dMup += Math.abs(byIc[a][i].w3.mUp - byIc[b][i].w3.mUp);
      dS += Math.abs(byIc[a][i].w3.segregation - byIc[b][i].w3.segregation);
    }
    betweenIc = { pairedRuns: n, l1: l1 / n, gini: dG / n, mUp: dMup / n, segregation: dS / n };
  }

  perCell.push({
    cellKey: cell.cellKey,
    axis: cell.axis,
    fingerprints: fps,
    withinInitialConditionSeedL1: withinNoise,
    betweenInitialCondition: betweenIc,
    initialConditionDependent:
      betweenIc !== null && betweenIc.l1 > Math.max(0.05, 2 * Math.max(...withinNoise)),
  });
}

// ---- 池化聚类（描述性；编码同 07 §8.1，但不构成 G1.5 判定）----------------
const points = [];
const meta = [];
for (const entry of results) {
  for (const seedResult of entry.seeds) {
    for (const key of ['w2b', 'w3']) {
      const window = seedResult[key];
      if (window !== null && window.available) {
        points.push(featureVector(window));
        meta.push({
          cell: entry.cellKey,
          ic: entry.initialCondition,
          seed: seedResult.seed,
          window: key,
        });
      }
    }
  }
}
let clustering = null;
if (points.length >= 8) {
  const scaler = fitStandardizer(points);
  const z = points.map((row) => scaler.standardize(row));
  const k2 = [20261103, 20261104, 20261105, 20261106, 20261107, 20261108, 20261109, 20261110].map(
    (seed) => bisectStability(z, 2, [seededShuffle(z.length, seed)], 0.7).ari,
  );
  clustering = {
    points: points.length,
    k2AriMedian: Math.round(medianOf(k2) * 1000) / 1000,
    k2AriMin: Math.round(Math.min(...k2) * 1000) / 1000,
    note: '描述性；探索层产物，不构成 G1.5 判定，不得写入确认轮证据',
  };
}

const wallMinutes = Math.round((performance.now() - startedAt) / 60000);
const output = {
  schemaVersion: 'p15-feedback-explore-v1',
  stage,
  family,
  exploratory: true,
  note:
    '探索层（07 §6.1）：只用于提出下一轮假设，不得引用为 G1.5 确认证据；' +
    '确认轮种子 p15r3-* 与产物均未触碰。',
  execution: { totalTicks: TICKS, seeds: SEEDS, runCount, wallMinutes },
  cells: results,
  perCell,
  clustering,
};
mkdirSync('out', { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ runCount, wallMinutes, perCell, clustering })}\n`);
log(`written ${OUTPUT_PATH} (${runCount} runs, ${wallMinutes}min)`);

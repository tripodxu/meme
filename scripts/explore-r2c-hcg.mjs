#!/usr/bin/env node
/**
 * 阶段 R2-C / ADR 0014 的 30-run 探索探针（rules-v19：岗位容量硬门槛 + 代际出身折损）。
 *
 * - 6 个参数单元沿用 P6-05 A–F；每个单元 5 个全新 seed（explore-r2c-seed-001..005）
 *   × 40 人 × 10950 tick；全部单元开启 generationalMode='replace'（否则出身折损无对象），
 *   遗产与出身继承保持 0，以隔离 HCG 机制。
 * - 机制参数在预注册中冻结：g=2（域 [0,4] 中点）、d=0.4（域 [0,0.8] 中点）。
 * - 同时跑两个单参数消融各 30 run：g=0（保留 d=0.4）与 d=0（保留 g=2）。
 * - 探索门槛（仅筛选，不构成 G6 结论）：
 *     1) k=2 ARI median >= 0.85 且 silhouette >= 0.45；
 *     2) 至少一个消融的 median TV(P) >= 0.10（按 cell+seed 配对，末 365 天平均 P）。
 * - 预注册写入 out/explore-r2c-prereg.json；已存在且内容不一致时拒绝运行。
 * - 必须在上海 VPS 执行（AGENTS.md 强制约束 11）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { DEFAULT_RUN_CONFIG, mergeConfig } from '../dist/core/config/defaults.js';
import { computeConfigHash } from '../dist/core/config/hash.js';
import { asSeed } from '../dist/core/control/ids.js';
import { runSingle } from '../dist/runner/run-cell.js';
import {
  bisectStability,
  fitStandardizer,
  seededShuffle,
  silhouetteScore,
  wardCluster,
} from '../dist/runner/cluster.js';

const EXPERIMENT = 'explore-r2c-hcg';
const G_MAIN = 2;
const D_MAIN = 0.4;
const SEEDS = Array.from(
  { length: 5 },
  (_, i) => `explore-r2c-seed-${String(i + 1).padStart(3, '0')}`,
);

/** P6-05 A–F 区域；rules-v19 探针只在其上叠加 HCG 与 replace。 */
const CELLS = [
  { cellKey: 'A-share100-w0', ascent: { displacementShare: 1.0, scarcityWeight: 0 } },
  { cellKey: 'B-share50-w15', ascent: { displacementShare: 0.5, scarcityWeight: 15 } },
  { cellKey: 'C-share50-w60', ascent: { displacementShare: 0.5, scarcityWeight: 60 } },
  { cellKey: 'D-share50-w30', ascent: { displacementShare: 0.5, scarcityWeight: 30 } },
  { cellKey: 'E-share70-w15', ascent: { displacementShare: 0.7, scarcityWeight: 15 } },
  { cellKey: 'F-share30-w60', ascent: { displacementShare: 0.3, scarcityWeight: 60 } },
];

const VARIANTS = [
  { variant: 'main', g: G_MAIN, d: D_MAIN },
  { variant: 'ablate_g0', g: 0, d: D_MAIN },
  { variant: 'ablate_d0', g: G_MAIN, d: 0 },
];

const GATE = { ariMedianK2: 0.85, silhouetteK2: 0.45, ablationTvMedian: 0.1 };
const TOTAL_TICKS = 10950;
const POPULATION = 40;

function cellConfig(cell, variant) {
  return mergeConfig(DEFAULT_RUN_CONFIG, {
    population: {
      initialPopulation: POPULATION,
      generationalMode: 'replace',
      bequestRate: 0,
      classInheritanceRate: 0,
      talentInheritanceWeight: 0,
      lineageDiscount: variant.d,
    },
    ascent: { ...cell.ascent, hardGateStrength: variant.g },
    schedule: { totalTicks: TOTAL_TICKS, statsStride: 1, snapshotStride: TOTAL_TICKS },
  });
}

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
  const { task } = workerData;
  const config = cellConfig(task.cell, task.variant);
  const t0 = Date.now();
  const res = runSingle(config, asSeed(task.seed), {});
  const feat = windowFeatures(res.stats, TOTAL_TICKS - 365, TOTAL_TICKS - 1);
  parentPort.postMessage({
    variant: task.variant.variant,
    cellKey: task.cell.cellKey,
    seed: task.seed,
    extinct: res.report.extinct,
    feat,
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
        console.error(
          `[${EXPERIMENT}] ${results.length}/${tasks.length} ${r.variant}/${r.cellKey}/${r.seed} ` +
            `${r.extinct ? 'extinct' : 'ok'} ${(r.elapsedMs / 1000).toFixed(1)}s`,
        );
      }
    }),
  );
  return results;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function buildPrereg() {
  const cells = CELLS.map((cell) => ({
    cellKey: cell.cellKey,
    ascent: cell.ascent,
    configHash: computeConfigHash(cellConfig(cell, VARIANTS[0])),
  }));
  const body = {
    experiment: EXPERIMENT,
    rulesVersion: DEFAULT_RUN_CONFIG.rulesVersion,
    mechanism: `ascent.hardGateStrength=${G_MAIN}, population.lineageDiscount=${D_MAIN}`,
    gMain: G_MAIN,
    dMain: D_MAIN,
    population: POPULATION,
    totalTicks: TOTAL_TICKS,
    windowTicks: [TOTAL_TICKS - 365, TOTAL_TICKS - 1],
    seeds: SEEDS,
    cells,
    variants: VARIANTS,
    gate: GATE,
    note: '6 cell × 5 新 seed；主 30 run + 两个单参数消融各 30 run；门槛仅筛选，不构成 G6 结论。',
  };
  return { ...body, bodyHash: sha256(body) };
}

function freezePrereg() {
  mkdirSync('out', { recursive: true });
  const prereg = buildPrereg();
  const path = 'out/explore-r2c-prereg.json';
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8'));
    if (existing.bodyHash !== prereg.bodyHash) {
      throw new Error(
        `预注册已存在且与当前脚本不一致（${path}）；不得在看到结果后改写，须人工审查`,
      );
    }
    console.error(`[${EXPERIMENT}] prereg 已冻结：${path}`);
    return prereg;
  }
  writeFileSync(path, `${JSON.stringify(prereg, null, 2)}\n`);
  console.error(`[${EXPERIMENT}] 写入预注册：${path}`);
  return prereg;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function tvDistance(p, q) {
  let sum = 0;
  for (let c = 0; c < 5; c += 1) sum += Math.abs((p[c] ?? 0) - (q[c] ?? 0));
  return sum / 2;
}

async function main() {
  const prereg = freezePrereg();
  if (process.argv.includes('--prereg-only')) {
    console.log(JSON.stringify(prereg, null, 2));
    return;
  }
  const tStart = Date.now();
  const tasks = [];
  for (const variant of VARIANTS) {
    for (const cell of CELLS) {
      for (const seed of SEEDS) tasks.push({ variant, cell, seed });
    }
  }
  const requested = Number(process.env['STRATIFY_R2C_CONCURRENCY'] ?? '');
  const concurrency =
    Number.isFinite(requested) && requested >= 1
      ? Math.floor(requested)
      : Math.max(1, Math.min(8, availableParallelism()));
  console.error(`[${EXPERIMENT}] running ${tasks.length} tasks (concurrency=${concurrency})...`);
  const results = await runPool(tasks, concurrency);

  const valid = results.filter((r) => !r.extinct && r.feat !== null);
  const mainRuns = valid.filter((r) => r.variant === 'main');
  const summary = {
    experiment: EXPERIMENT,
    preregHash: prereg.bodyHash,
    totalRuns: results.length,
    validRuns: valid.length,
    extinctRuns: results.filter((r) => r.extinct).length,
    elapsedSec: Number(((Date.now() - tStart) / 1000).toFixed(1)),
    cells: {},
    clustering: {},
    ablations: {},
  };

  for (const cell of CELLS) {
    const rows = mainRuns.filter((r) => r.cellKey === cell.cellKey);
    if (rows.length === 0) continue;
    const mean = new Array(11).fill(0);
    for (const r of rows) for (let d = 0; d < 11; d += 1) mean[d] += r.feat[d] / rows.length;
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

  const rawPoints = mainRuns.map((r) => r.feat);
  const std = fitStandardizer(rawPoints);
  const points = rawPoints.map((v) => std.standardize(v));
  for (const k of [2, 3]) {
    if (points.length < k) continue;
    const assignments = wardCluster(points, k);
    const clusterSizes = Array.from(
      { length: k },
      (_, c) => assignments.filter((l) => l === c).length,
    );
    const sil = silhouetteScore(points, assignments);
    const ariSamples = [];
    for (let s = 0; s < 20; s += 1) {
      const order = seededShuffle(points.length, 20261120 + k * 7919 + s * 104729);
      ariSamples.push(bisectStability(points, k, [order], 0.7).ari);
    }
    ariSamples.sort((a, b) => a - b);
    const ariMedian =
      ariSamples.length % 2 === 0
        ? (ariSamples[ariSamples.length / 2 - 1] + ariSamples[ariSamples.length / 2]) / 2
        : ariSamples[Math.floor(ariSamples.length / 2)];
    const clusterCells = Array.from({ length: k }, () => ({}));
    mainRuns.forEach((r, idx) => {
      const c = assignments[idx];
      clusterCells[c][r.cellKey] = (clusterCells[c][r.cellKey] ?? 0) + 1;
    });
    summary.clustering[`k${k}`] = {
      clusterSizes,
      ariMedian: Number(ariMedian.toFixed(4)),
      ariMin: Number(ariSamples[0].toFixed(4)),
      silhouette: Number(sil.toFixed(4)),
      clusterCells,
    };
  }

  for (const variant of VARIANTS.filter((v) => v.variant !== 'main')) {
    const paired = [];
    for (const run of valid.filter((r) => r.variant === variant.variant)) {
      const base = mainRuns.find((r) => r.cellKey === run.cellKey && r.seed === run.seed);
      if (base === undefined) continue;
      paired.push({
        cellKey: run.cellKey,
        seed: run.seed,
        tv: tvDistance(base.feat, run.feat),
      });
    }
    const tvs = paired.map((p) => p.tv);
    summary.ablations[variant.variant] = {
      n: paired.length,
      medianTv: median(tvs) === null ? null : Number(median(tvs).toFixed(4)),
      maxTv: tvs.length === 0 ? null : Number(Math.max(...tvs).toFixed(4)),
      passesStructuralGate: median(tvs) !== null && median(tvs) >= GATE.ablationTvMedian,
    };
  }

  const k2 = summary.clustering.k2 ?? { ariMedian: 0, silhouette: 0 };
  summary.passesProbeGate = k2.ariMedian >= GATE.ariMedianK2 && k2.silhouette >= GATE.silhouetteK2;
  summary.passesAblationGate = Object.values(summary.ablations).some((v) => v.passesStructuralGate);
  summary.verdict =
    summary.passesProbeGate && summary.passesAblationGate ? 'proceed-to-240-run' : 'stop-mechanism';

  mkdirSync('out', { recursive: true });
  const path = `out/${EXPERIMENT}-result.json`;
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(
    `out/${EXPERIMENT}-runs.ndjson`,
    `${valid.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

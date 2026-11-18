#!/usr/bin/env node
/**
 * 阶段 R4（07 §11–§12）：P6-09 两体制（N=200）的微扰吸收与五消融收口脚本。
 *
 * - Part A（微扰吸收）：Regime I (share=1, w=0) 与 Regime II (share=0.5, w=15)，N=200，
 *   30 全新种子（p6-r4-pert-001..030），tick 365 检查点注入 wealth_absolute ΔValue=1e-4，
 *   运行至 3650 tick（w3=[2555, 3284]），检验 TV(P)/D 是否落入 baseline 30-seed D95 内；
 * - Part B（五消融）：在 Regime I 与 Regime II 上分别运行 baseline + β=0 / O=fixed / η=0 / κ=0 / ψ=1，
 *   30 全新种子（p6-r4-abl-001..030），N=200，3650 tick（w3=[2555, 3284]），报告 TV(P)/D/分项与 D95。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { DEFAULT_RUN_CONFIG, mergeConfig } from '../dist/core/config/defaults.js';
import { asSeed } from '../dist/core/control/ids.js';
import { runPerturbationPair } from '../dist/runner/perturbation.js';
import { runSingle } from '../dist/runner/run-cell.js';

const PERT_SEEDS = Array.from(
  { length: 30 },
  (_, i) => `p6-r4-pert-${String(i + 1).padStart(3, '0')}`,
);
const ABL_SEEDS = Array.from(
  { length: 30 },
  (_, i) => `p6-r4-abl-${String(i + 1).padStart(3, '0')}`,
);

const REGIMES = [
  { key: 'R1_A_share100_w0', overrides: { ascent: { displacementShare: 1.0, scarcityWeight: 0 } } },
  {
    key: 'R2_B_share50_w15',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 15 } },
  },
];

const ABLATIONS = [
  { key: 'baseline', patch: {} },
  { key: 'beta_0', patch: { networkOpportunity: { beta: 0 } } },
  { key: 'openness_fixed', patch: { openness: { updateMode: 'fixed' } } },
  { key: 'eta_0', patch: { dynamics: { congestionExponent: 0 } } },
  { key: 'kappa_0', patch: { dynamics: { polarizationExponent: 0 } } },
  { key: 'psi_1', patch: { need: { needMultiplier: [1, 1, 1, 1, 1] } } },
];

function extractW3(report) {
  const w3 =
    report.windows.find((w) => w.label === 'w3') ?? report.windows[report.windows.length - 1];
  if (!w3 || w3.classShares.length === 0) return null;
  return {
    P: w3.classShares,
    G: w3.gini,
    Mup: w3.mUp,
    S: w3.segregation,
    O: w3.openness,
  };
}

function structDiff(a, b) {
  const tvP = 0.5 * a.P.reduce((s, v, i) => s + Math.abs(v - b.P[i]), 0);
  const dG = Math.abs(a.G - b.G);
  const dMup = Math.abs(a.Mup - b.Mup);
  const dS = Math.abs(a.S - b.S);
  const dO = Math.abs(a.O - b.O);
  const D = 0.3 * dG + 0.25 * tvP + 0.2 * dMup + 0.15 * dS + 0.1 * dO;
  return { tvP, dG, dMup, dS, dO, D };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base] + rest * ((sorted[base + 1] ?? sorted[base]) - sorted[base]);
}

function pairwiseD95(vecs) {
  const ds = [];
  for (let i = 0; i < vecs.length; i += 1) {
    for (let j = i + 1; j < vecs.length; j += 1) {
      ds.push(structDiff(vecs[i], vecs[j]).D);
    }
  }
  ds.sort((a, b) => a - b);
  return quantile(ds, 0.95);
}

if (!isMainThread) {
  const tasks = workerData;
  const results = [];
  for (const task of tasks) {
    if (task.kind === 'pert') {
      const cfg = mergeConfig(DEFAULT_RUN_CONFIG, {
        ...task.regimeOverrides,
        population: { initialPopulation: 200 },
        schedule: { totalTicks: 3650, statsStride: 1, snapshotStride: 3650 },
      });
      const pair = runPerturbationPair(cfg, asSeed(task.seed), {
        policy: 'mock-weighted-v1',
        checkpointTick: 365,
        declared: { kind: 'wealth_absolute', delta: 1e-4 },
      });
      results.push({
        kind: 'pert',
        regimeKey: task.regimeKey,
        seed: task.seed,
        invalid: pair.invalid,
        firstDivergenceTick: pair.firstDivergenceTick,
        base: extractW3(pair.baseline.report),
        treat: pair.treatment ? extractW3(pair.treatment.report) : null,
      });
    } else {
      const cfg = mergeConfig(DEFAULT_RUN_CONFIG, {
        ...task.regimeOverrides,
        ...task.ablationPatch,
        population: { initialPopulation: 200 },
        schedule: { totalTicks: 3650, statsStride: 1, snapshotStride: 3650 },
      });
      const out = runSingle(cfg, asSeed(task.seed), {});
      results.push({
        kind: 'abl',
        regimeKey: task.regimeKey,
        ablationKey: task.ablationKey,
        seed: task.seed,
        extinct: out.report.extinct,
        w3: extractW3(out.report),
      });
    }
  }
  parentPort.postMessage(results);
} else {
  const tasks = [];
  for (const regime of REGIMES) {
    for (const seed of PERT_SEEDS) {
      tasks.push({ kind: 'pert', regimeKey: regime.key, regimeOverrides: regime.overrides, seed });
    }
    for (const abl of ABLATIONS) {
      for (const seed of ABL_SEEDS) {
        tasks.push({
          kind: 'abl',
          regimeKey: regime.key,
          ablationKey: abl.key,
          regimeOverrides: regime.overrides,
          ablationPatch: abl.patch,
          seed,
        });
      }
    }
  }

  const workersCount = Math.min(availableParallelism(), 8);
  const buckets = Array.from({ length: workersCount }, () => []);
  tasks.forEach((task, idx) => buckets[idx % workersCount].push(task));

  const cachePath = 'out/p6-r4-raw.json';
  let flat;
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (Array.isArray(cached.runs) && cached.runs.length === tasks.length) {
      flat = cached.runs;
    }
  }
  const t0 = Date.now();
  if (flat === undefined) {
    process.stderr.write(
      `Running Stage R4 across ${workersCount} workers: ${tasks.length} tasks (60 pert pairs + 360 abl runs)...\n`,
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
    writeFileSync(cachePath, JSON.stringify({ runs: flat }), 'utf8');
  }

  const pertSummary = {};
  for (const regime of REGIMES) {
    const rows = flat.filter((r) => r.kind === 'pert' && r.regimeKey === regime.key);
    const valid = rows.filter((r) => !r.invalid && r.base && r.treat);
    const baseVecs = valid.map((r) => r.base);
    const d95 = pairwiseD95(baseVecs);
    const diffs = valid.map((r) => structDiff(r.base, r.treat));
    const ds = diffs.map((d) => d.D).sort((a, b) => a - b);
    const tvs = diffs.map((d) => d.tvP).sort((a, b) => a - b);
    const absorbedCount = diffs.filter((d) => d.D <= d95 && d.tvP < 0.1).length;
    const divergedCount = valid.filter((r) => r.firstDivergenceTick !== null).length;
    pertSummary[regime.key] = {
      pairs: rows.length,
      valid: valid.length,
      divergedTrajectories: divergedCount,
      baselineD95: Number(d95.toFixed(4)),
      medianD: Number(quantile(ds, 0.5).toFixed(4)),
      maxD: Number((ds[ds.length - 1] ?? 0).toFixed(4)),
      medianTvP: Number(quantile(tvs, 0.5).toFixed(4)),
      maxTvP: Number((tvs[tvs.length - 1] ?? 0).toFixed(4)),
      absorbedCount,
      absorbedRate: Number((absorbedCount / valid.length).toFixed(4)),
    };
  }

  const ablSummary = {};
  for (const regime of REGIMES) {
    const baseRows = flat.filter(
      (r) => r.kind === 'abl' && r.regimeKey === regime.key && r.ablationKey === 'baseline' && r.w3,
    );
    const baseBySeed = new Map(baseRows.map((r) => [r.seed, r.w3]));
    const d95 = pairwiseD95(baseRows.map((r) => r.w3));
    const items = {};
    for (const abl of ABLATIONS.filter((a) => a.key !== 'baseline')) {
      const treatRows = flat.filter(
        (r) => r.kind === 'abl' && r.regimeKey === regime.key && r.ablationKey === abl.key && r.w3,
      );
      const diffs = [];
      for (const tr of treatRows) {
        const br = baseBySeed.get(tr.seed);
        if (br) diffs.push(structDiff(br, tr.w3));
      }
      const sortNum = (arr) => [...arr].sort((a, b) => a - b);
      const med = (arr) => Number(quantile(sortNum(arr), 0.5).toFixed(4));
      items[abl.key] = {
        pairs: diffs.length,
        medianTvP: med(diffs.map((d) => d.tvP)),
        medianDG: med(diffs.map((d) => d.dG)),
        medianDMup: med(diffs.map((d) => d.dMup)),
        medianDS: med(diffs.map((d) => d.dS)),
        medianDO: med(diffs.map((d) => d.dO)),
        medianD: med(diffs.map((d) => d.D)),
        overD95Rate: Number((diffs.filter((d) => d.D > d95).length / diffs.length).toFixed(4)),
        mechanismExplained:
          med(diffs.map((d) => d.tvP)) >= 0.1 ||
          med(diffs.map((d) => d.dG)) >= 0.03 ||
          med(diffs.map((d) => d.dMup)) >= 0.05 ||
          med(diffs.map((d) => d.dS)) >= 0.05 ||
          med(diffs.map((d) => d.dO)) >= 0.05,
      };
    }
    ablSummary[regime.key] = { baselineD95: Number(d95.toFixed(4)), ablations: items };
  }

  const output = {
    wallSeconds: Number(((Date.now() - t0) / 1000).toFixed(2)),
    perturbation: pertSummary,
    ablations: ablSummary,
  };
  writeFileSync('out/p6-r4-closure-result.json', `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

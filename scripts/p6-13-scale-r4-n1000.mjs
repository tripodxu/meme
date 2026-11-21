#!/usr/bin/env node
/**
 * 阶段 R4 规模化复现（07 §11–§12）：P6-12 两体制（N=1000）的微扰吸收与五消融收口脚本。
 *
 * - Part A（微扰吸收）：Regime I (share=1, w=0) 与 Regime II (share=0.5, w=15)，N=200，
 *   30 全新种子（p6-r4n1k-pert-001..030），tick 365 检查点注入 wealth_absolute ΔValue=1e-4，
 *   运行至 3650 tick（w3=[2555, 3284]），检验 TV(P)/D 是否落入 baseline 30-seed D95 内；
 * - Part B（五消融）：在 Regime I 与 Regime II 上分别运行 baseline + β=0 / O=fixed / η=0 / κ=0 / ψ=1，
 *   30 全新种子（p6-r4n1k-abl-001..030），N=1000，3650 tick（w3=[2555, 3284]），报告 TV(P)/D/分项与 D95。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { DEFAULT_RUN_CONFIG, mergeConfig } from '../dist/core/config/defaults.js';
import { computeConfigHash } from '../dist/core/config/hash.js';
import { HASH_DOMAINS } from '../dist/core/hash/domains.js';
import { hashValue } from '../dist/core/hash/hash.js';
import { asSeed } from '../dist/core/control/ids.js';
import { runPerturbationPair } from '../dist/runner/perturbation.js';
import { runSingle } from '../dist/runner/run-cell.js';

/**
 * N=1000 × 10950 tick 时单 run 会产生 ~1.1M 条 DecisionRecord；批次分析只需要 stats，
 * 用流式 sink 丢弃逐决策日志，避免 3 个 worker 把内存推到数 GB（共享主机会 OOM）。
 * sink 不影响仿真状态与结果，只影响日志是否驻留。
 */
const NOOP_ARTIFACT_SINK = {
  onInitialSnapshot() {},
  onTickSettled() {},
  onFinalState() {},
};

/**
 * 任务级增量落盘：每个 task 完成后立即写一个独立分片（tmp + rename 原子替换），
 * 进程被 OOM/信号杀死后重启时只重算缺失 task，不再丢失已完成的计算。
 * 分片内容只含 w3 聚合量，不含逐决策日志，大小可忽略。
 */
const PART_DIR = 'out/p6-r4n1k-raw-parts';

function taskKey(task) {
  return `${task.kind}|${task.regimeKey}|${task.ablationKey ?? ''}|${task.seed}`;
}

function partPath(task) {
  return `${PART_DIR}/${taskKey(task).replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

function persistTaskResult(result) {
  mkdirSync(PART_DIR, { recursive: true });
  const target = partPath(result);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(result), 'utf8');
  renameSync(tmp, target);
}

function loadPartResults() {
  const map = new Map();
  if (!existsSync(PART_DIR)) return map;
  for (const name of readdirSync(PART_DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const result = JSON.parse(readFileSync(`${PART_DIR}/${name}`, 'utf8'));
      if (result && typeof result.kind === 'string' && typeof result.seed === 'string') {
        map.set(taskKey(result), result);
      }
    } catch {
      // 半写入/损坏分片忽略，本轮重算该 task。
    }
  }
  return map;
}

const PERT_SEEDS = Array.from(
  { length: 30 },
  (_, i) => `p6-r4n1k-pert-${String(i + 1).padStart(3, '0')}`,
);
const ABL_SEEDS = Array.from(
  { length: 30 },
  (_, i) => `p6-r4n1k-abl-${String(i + 1).padStart(3, '0')}`,
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
        population: { initialPopulation: 1000 },
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
        population: { initialPopulation: 1000 },
        schedule: { totalTicks: 3650, statsStride: 1, snapshotStride: 3650 },
      });
      const out = runSingle(cfg, asSeed(task.seed), { artifactSink: NOOP_ARTIFACT_SINK });
      results.push({
        kind: 'abl',
        regimeKey: task.regimeKey,
        ablationKey: task.ablationKey,
        seed: task.seed,
        extinct: out.report.extinct,
        w3: extractW3(out.report),
      });
    }
    persistTaskResult(results[results.length - 1]);
    process.stderr.write(`[p6-13] ${results.length}/${tasks.length} ${taskKey(task)}\n`);
  }
  parentPort.postMessage(results);
} else {
  const prereg = {
    experimentType: 'p6-13-r4-scale-n1000',
    classification: 'exploratory boundary-condition replication（不作为 G6 判定）',
    rulesVersion: DEFAULT_RUN_CONFIG.rulesVersion,
    baseConfigHash: computeConfigHash(DEFAULT_RUN_CONFIG),
    population: 1000,
    ticks: 3650,
    window: 'w3',
    checkpointTick: 365,
    declaredPerturbation: { kind: 'wealth_absolute', delta: 1e-4 },
    regimes: REGIMES.map((regime) => regime.key),
    ablations: ABLATIONS.map((ablation) => ablation.key),
    perturbationSeeds: PERT_SEEDS,
    ablationSeeds: ABL_SEEDS,
    criterion: 'median TV(P) >= 0.10（07 §11 结构退化口径）',
  };
  const preregistrationHash = hashValue(HASH_DOMAINS.preregistration, prereg);
  const experimentId = `p6-13-${preregistrationHash.slice(7, 15)}`;
  const preregPath = 'out/p6-13-prereg.json';

  if (process.argv.includes('--freeze')) {
    mkdirSync('out', { recursive: true });
    writeFileSync(
      preregPath,
      `${JSON.stringify(
        { schemaVersion: 'p6-13-prereg-v1', experimentId, preregistrationHash, prereg },
        null,
        2,
      )}
`,
      'utf8',
    );
    process.stdout.write(`${JSON.stringify({ frozen: true, experimentId, preregistrationHash })}
`);
    process.exit(0);
  }
  if (!process.argv.includes('--run')) {
    throw new Error('用法：--freeze 冻结预注册；--run 执行（需已冻结）');
  }
  if (!existsSync(preregPath)) throw new Error(`缺少 ${preregPath}；先 --freeze`);
  const frozen = JSON.parse(readFileSync(preregPath, 'utf8'));
  if (frozen.preregistrationHash !== preregistrationHash) {
    throw new Error(`预注册哈希不一致：${frozen.preregistrationHash} ≠ ${preregistrationHash}`);
  }

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

  const workerEnv = Number(process.env.P6_WORKERS ?? '');
  const workersCount = Math.max(
    1,
    Math.min(Number.isInteger(workerEnv) && workerEnv > 0 ? workerEnv : availableParallelism(), 8),
  );
  const cachePath = 'out/p6-r4n1k-raw.json';
  let flat;
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (
      cached.preregistrationHash === preregistrationHash &&
      Array.isArray(cached.runs) &&
      cached.runs.length === tasks.length
    ) {
      flat = cached.runs;
    }
  }
  const t0 = Date.now();
  if (flat === undefined) {
    const parts = loadPartResults();
    flat = [...parts.values()];
    const pending = tasks.filter((task) => !parts.has(taskKey(task)));
    process.stderr.write(
      `Loaded ${flat.length}/${tasks.length} task results from ${PART_DIR}; ${pending.length} remaining\n`,
    );
    if (pending.length > 0) {
      process.stderr.write(
        `Running Stage R4 across ${workersCount} workers: ${pending.length}/${tasks.length} tasks remaining...\n`,
      );
      const buckets = Array.from({ length: workersCount }, () => []);
      pending.forEach((task, idx) => buckets[idx % workersCount].push(task));
      const selfPath = fileURLToPath(import.meta.url);
      const parts2 = await Promise.all(
        buckets.map(
          (chunk) =>
            new Promise((resolve, reject) => {
              const w = new Worker(selfPath, { workerData: chunk });
              w.on('message', resolve);
              w.on('error', reject);
            }),
        ),
      );
      flat = flat.concat(parts2.flat());
    }
    if (flat.length !== tasks.length) {
      throw new Error(`任务结果不完整：${flat.length}/${tasks.length}`);
    }
    mkdirSync('out', { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ experimentId, preregistrationHash, runs: flat }),
      'utf8',
    );
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
      // 不做 4/6 位小数截断：吸收后的 D 可能小到 1e-10 量级，
      // 截断会把它写成 0，被误读为「完全逐位相同」。JSON 直接保留原值。
      medianD: quantile(ds, 0.5),
      maxD: ds[ds.length - 1] ?? 0,
      medianTvP: quantile(tvs, 0.5),
      maxTvP: tvs[tvs.length - 1] ?? 0,
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
      const medianTvP = med(diffs.map((d) => d.tvP));
      items[abl.key] = {
        pairs: diffs.length,
        medianTvP,
        medianDG: med(diffs.map((d) => d.dG)),
        medianDMup: med(diffs.map((d) => d.dMup)),
        medianDS: med(diffs.map((d) => d.dS)),
        medianDO: med(diffs.map((d) => d.dO)),
        medianD: med(diffs.map((d) => d.D)),
        overD95Rate: Number((diffs.filter((d) => d.D > d95).length / diffs.length).toFixed(4)),
        // 07 §11：只有消融后**结构特征显著退化**才可说机制有解释力。
        // 结构退化的操作化沿用本项目既有门槛（P6-04a、07 §8）：TV(P) >= 0.10。
        // 不得用单项 ΔO/ΔMup 判「解释」——消融 O 反馈后 ΔO 必然大，属同义反复；
        // 单项差值只作归因描述，不计入判定。
        mechanismExplained: medianTvP >= 0.1,
      };
    }
    ablSummary[regime.key] = { baselineD95: Number(d95.toFixed(4)), ablations: items };
  }

  const output = {
    experimentId,
    preregistrationHash,
    wallSeconds: Number(((Date.now() - t0) / 1000).toFixed(2)),
    perturbation: pertSummary,
    ablations: ablSummary,
  };
  writeFileSync('out/p6-r4n1k-closure-result.json', `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

#!/usr/bin/env node
/**
 * P6-15：真实 mock-weighted-v1 下的 G6 收口套件（N=40 按 07 §8.2 规范，rules-v19 默认配置）。
 *
 * 缘起（changes/0106）：
 * - 审计发现 P6-09/R4/P6-12/P6-13 等脚本因未传 options.policy 静默回落到 RandomPolicy；
 * - 真正运行在 mock-weighted-v1 上的「07 §8.2（ADR 0010 条件 4）两体制聚类 + 07 §7 微扰 + 07 §11 五消融」
 *   此前从未在同套闭环口径下完整执行过。
 *
 * 本脚本使用三套全新独立种子集，严格锁定 policy='mock-weighted-v1' 并在运行期逐决策校验
 * DecisionRecord.policyVersion === 'mock-weighted-v1'（N=40 与 docs/07 §8.2 规范口径一致）：
 * - Part 1（abl，360 task）：两体制（A、B）×（baseline + 五消融）× 30 新种子 × 3650 tick（w3=[2555,3284]）；
 * - Part 2（pert，60 task）：两体制（A、B）× 30 新种子 × 3650 tick（tick 365 wealth_absolute Δ=1e-4）；
 * - Part 3（cluster，240 task）：A–F 六单元 × 30 新种子 × 10950 tick（前 10 续跑 14600 tick）。
 *
 * 用法：
 *   node scripts/p6-15-g6-closure.mjs --freeze                  # 仅冻结 out/p6-15-prereg.json（不跑仿真）
 *   node scripts/p6-15-g6-closure.mjs --run [--stage all|abl|pert|cluster]
 *   node scripts/p6-15-g6-closure.mjs --analyze                 # 离线分析（读取 parts 或 out/p6-15-raw.json）
 *   node scripts/p6-15-g6-closure.mjs --status                  # 查看完成进度
 *
 * 环境变量：
 *   P6_15_WORKERS=2   # 并发 worker 数，默认 min(availableParallelism(), 4)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { DEFAULT_RUN_CONFIG, mergeConfig } from '../dist/core/config/defaults.js';
import { computeConfigHash, computeParamsHash } from '../dist/core/config/hash.js';
import { asSeed } from '../dist/core/control/ids.js';
import {
  DECISION_SCHEMA_VERSION,
  ENGINE_VERSION,
  RULES_VERSION,
} from '../dist/core/control/versions.js';
import { HASH_DOMAINS } from '../dist/core/hash/domains.js';
import { hashValue } from '../dist/core/hash/hash.js';
import {
  computeLabelThresholdsHash,
  LABEL_THRESHOLDS_VERSION,
} from '../dist/core/labels/thresholds.js';
import {
  bisectStability,
  euclidean,
  fitStandardizer,
  seededShuffle,
  silhouetteScore,
  wardCluster,
} from '../dist/runner/cluster.js';
import { bootstrapMedianCi, median, nearestRankPercentile } from '../dist/runner/p6-analysis.js';
import { runPerturbationPair } from '../dist/runner/perturbation.js';
import { runSingle } from '../dist/runner/run-cell.js';

const POLICY = 'mock-weighted-v1';
const POPULATION = 40;
const PREREG_PATH = 'out/p6-15-prereg.json';
const RAW_PATH = 'out/p6-15-raw.json';
const RESULT_PATH = 'out/p6-15-result.json';
const PARTS_DIR = 'out/p6-15-parts';

const CLUSTER_SEEDS = Array.from(
  { length: 30 },
  (_, i) => `p6-15-clu-${String(i + 1).padStart(3, '0')}`,
);
const FOLLOWUP_SEEDS = CLUSTER_SEEDS.slice(0, 10);
const PERT_SEEDS = Array.from(
  { length: 30 },
  (_, i) => `p6-15-pert-${String(i + 1).padStart(3, '0')}`,
);
const ABL_SEEDS = Array.from(
  { length: 30 },
  (_, i) => `p6-15-abl-${String(i + 1).padStart(3, '0')}`,
);

const CLUSTER_CELLS = [
  {
    cellKey: 'A-share100-w0',
    overrides: { ascent: { displacementShare: 1.0, scarcityWeight: 0 } },
  },
  {
    cellKey: 'B-share50-w15',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 15 } },
  },
  {
    cellKey: 'C-share50-w60',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 60 } },
  },
  {
    cellKey: 'D-share50-w30',
    overrides: { ascent: { displacementShare: 0.5, scarcityWeight: 30 } },
  },
  {
    cellKey: 'E-share70-w15',
    overrides: { ascent: { displacementShare: 0.7, scarcityWeight: 15 } },
  },
  {
    cellKey: 'F-share30-w60',
    overrides: { ascent: { displacementShare: 0.3, scarcityWeight: 60 } },
  },
];

const REGIMES = [
  {
    key: 'R1_A_share100_w0',
    cellKey: 'A-share100-w0',
    overrides: { ascent: { displacementShare: 1.0, scarcityWeight: 0 } },
  },
  {
    key: 'R2_B_share50_w15',
    cellKey: 'B-share50-w15',
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

const FEATURE_NAMES = ['P0', 'P1', 'P2', 'P3', 'P4', 'G', 'top10', 'Mup', 'Mdown', 'S', 'O'];

function buildPrereg() {
  const clusterCells = CLUSTER_CELLS.map((cell) => {
    const cfg = mergeConfig(DEFAULT_RUN_CONFIG, {
      ...cell.overrides,
      population: { initialPopulation: POPULATION },
      schedule: { totalTicks: 10950, statsStride: 1, snapshotStride: 10950 },
    });
    return {
      cellKey: cell.cellKey,
      overrides: cell.overrides,
      fullConfigHash: computeConfigHash(cfg),
      paramsHash: computeParamsHash(cfg),
    };
  });

  const regimeConfigs = REGIMES.map((regime) => {
    const cfg = mergeConfig(DEFAULT_RUN_CONFIG, {
      ...regime.overrides,
      population: { initialPopulation: POPULATION },
      schedule: { totalTicks: 3650, statsStride: 1, snapshotStride: 3650 },
    });
    return {
      key: regime.key,
      cellKey: regime.cellKey,
      overrides: regime.overrides,
      fullConfigHash: computeConfigHash(cfg),
      paramsHash: computeParamsHash(cfg),
    };
  });

  const ablationConfigs = REGIMES.flatMap((regime) =>
    ABLATIONS.map((abl) => {
      const cfg = mergeConfig(DEFAULT_RUN_CONFIG, {
        ...regime.overrides,
        ...abl.patch,
        population: { initialPopulation: POPULATION },
        schedule: { totalTicks: 3650, statsStride: 1, snapshotStride: 3650 },
      });
      return {
        regimeKey: regime.key,
        ablationKey: abl.key,
        patch: abl.patch,
        fullConfigHash: computeConfigHash(cfg),
        paramsHash: computeParamsHash(cfg),
      };
    }),
  );

  const manifest = {
    schemaVersion: 'p6-15-g6-closure-prereg-v1',
    experimentType: 'g6_two_regime_closure_true_mock',
    hypothesis:
      '在真实 mock-weighted-v1 策略与 rules-v19 默认配置（generationalMode=none、N=40 按 07 §8.2 规范口径）下：' +
      '(1) A–F 六单元按 07 §8.2（ADR 0010 条件 4，新旧口径同报）在 k=2 上稳定分离为两体制，' +
      '且体制 I（A: share=1, w=0）较体制 II（B–F: share<1）具有更高 P0、更高 Mup、更高 O 与更低 S；' +
      '(2) 两体制代表作（A 与 B）在 tick 365 注入 wealth_absolute Δ=1e-4 后在 w3=[2555,3284] 吸收微扰；' +
      '(3) 五个必跑消融（β=0、O 固定、η=0、κ=0、ψ=1）严格按 07 §11 结构退化门槛（median TV(P) ≥ 0.10、' +
      '10,000 次配对 bootstrap 95% CI > 0、对照 baseline D95）判读机制解释力，ψ=1 另检验 P4 下降方向。',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    policyVersion: POLICY,
    population: POPULATION,
    baseConfigHash: computeConfigHash(DEFAULT_RUN_CONFIG),
    baseParamsHash: computeParamsHash(DEFAULT_RUN_CONFIG),
    labelThresholdVersion: LABEL_THRESHOLDS_VERSION,
    labelThresholdsHash: computeLabelThresholdsHash(),
    clustering: {
      cells: clusterCells,
      seeds: CLUSTER_SEEDS,
      followupSeeds: FOLLOWUP_SEEDS,
      baseTicks: 10950,
      followupTicks: 14600,
      baseWindow: [10585, 10949],
      followupWindow: [14235, 14599],
      algorithm: 'ward-lw-v1',
      distance: 'euclidean',
      standardization: 'z-score(pooled)',
      shuffles: 20,
      shuffleSeedBase: 20261124,
      minClusterRuns: 5,
      minAri: 0.7,
      minSilhouette: 0.35,
      minTemporalRate: 0.8,
      regimeDiffThreshold: 0.1,
      expectedDirection: 'A_higher_P0_Mup_O_lower_S_than_BF',
    },
    perturbation: {
      regimes: regimeConfigs,
      seeds: PERT_SEEDS,
      totalTicks: 3650,
      window: 'w3',
      checkpointTick: 365,
      declared: { kind: 'wealth_absolute', delta: 1e-4 },
      tvThreshold: 0.1,
    },
    ablations: {
      regimes: regimeConfigs,
      items: ablationConfigs,
      seeds: ABL_SEEDS,
      totalTicks: 3650,
      window: 'w3',
      primaryMetric: 'TV(P)',
      tvThreshold: 0.1,
      bootstrapIterations: 10000,
      bootstrapSeedBase: 20261124,
      psi1Prediction: 'classShare4_decrease',
    },
    budgets: {
      totalTasks: 660,
      ablTasks: 360,
      pertTasks: 60,
      clusterTasks: 240,
    },
  };

  const preregistrationHash = hashValue(HASH_DOMAINS.preregistration, manifest);
  const experimentId = `p6-15-${preregistrationHash.slice(7, 15)}`;
  return { experimentId, preregistrationHash, manifest };
}

function buildAllTasks() {
  const tasks = [];
  for (const regime of REGIMES) {
    for (const abl of ABLATIONS) {
      for (const seed of ABL_SEEDS) {
        tasks.push({
          id: `abl__${regime.key}__${abl.key}__${seed}`,
          stage: 'abl',
          regimeKey: regime.key,
          ablationKey: abl.key,
          regimeOverrides: regime.overrides,
          ablationPatch: abl.patch,
          seed,
          totalTicks: 3650,
        });
      }
    }
  }
  for (const regime of REGIMES) {
    for (const seed of PERT_SEEDS) {
      tasks.push({
        id: `pert__${regime.key}__${seed}`,
        stage: 'pert',
        regimeKey: regime.key,
        regimeOverrides: regime.overrides,
        seed,
        totalTicks: 3650,
      });
    }
  }
  for (const cell of CLUSTER_CELLS) {
    for (const seed of CLUSTER_SEEDS) {
      tasks.push({
        id: `cluster__base__${cell.cellKey}__${seed}`,
        stage: 'cluster',
        kind: 'base',
        cellKey: cell.cellKey,
        overrides: cell.overrides,
        seed,
        totalTicks: 10950,
      });
    }
    for (const seed of FOLLOWUP_SEEDS) {
      tasks.push({
        id: `cluster__followup__${cell.cellKey}__${seed}`,
        stage: 'cluster',
        kind: 'followup',
        cellKey: cell.cellKey,
        overrides: cell.overrides,
        seed,
        totalTicks: 14600,
      });
    }
  }
  return tasks;
}

function createPolicyVerifyingSink(expectedPolicy) {
  let observedPolicy = null;
  let dueDecisions = 0;
  let fallbackDecisions = 0;
  return {
    sink: {
      onInitialSnapshot() {},
      onTickSettled({ decisions }) {
        for (const d of decisions) {
          dueDecisions += 1;
          if (d.source === 'fallback') fallbackDecisions += 1;
          if (observedPolicy === null) {
            observedPolicy = d.policyVersion;
          } else if (d.policyVersion !== observedPolicy) {
            throw new Error(`策略漂移：期望 ${observedPolicy}，收到 ${d.policyVersion}`);
          }
          if (d.policyVersion !== expectedPolicy) {
            throw new Error(
              `运行期策略校验失败：期望 ${expectedPolicy}，实际执行 ${d.policyVersion}`,
            );
          }
        }
      },
      onFinalState() {},
    },
    summary() {
      return {
        observedPolicy,
        dueDecisions,
        fallbackDecisions,
        fallbackRate: dueDecisions > 0 ? fallbackDecisions / dueDecisions : 0,
      };
    },
  };
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

function extractW3(report) {
  const w3 = report.windows.find((w) => w.label === 'w3');
  if (!w3 || w3.missingTicks > 0 || w3.tickCount === 0 || w3.classShares.length !== 5) return null;
  return {
    P: [...w3.classShares],
    G: w3.gini,
    top10: w3.topWealthShare,
    Mup: w3.mUp,
    Mdown: w3.mDown,
    S: w3.segregation,
    O: w3.openness,
    labels: [...(report.labelsByWindow.w3 ?? [])],
  };
}

function writeAtomicJson(targetPath, data) {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data)}\n`, 'utf8');
  renameSync(tmpPath, targetPath);
}

function runOneTask(task, preregistrationHash) {
  const t0 = Date.now();
  if (task.stage === 'abl') {
    const cfg = mergeConfig(DEFAULT_RUN_CONFIG, {
      ...task.regimeOverrides,
      ...task.ablationPatch,
      population: { initialPopulation: POPULATION },
      schedule: { totalTicks: task.totalTicks, statsStride: 1, snapshotStride: task.totalTicks },
    });
    const verifier = createPolicyVerifyingSink(POLICY);
    const out = runSingle(cfg, asSeed(task.seed), {
      policy: POLICY,
      artifactSink: verifier.sink,
    });
    const w3 = extractW3(out.report);
    if (!out.report.extinct && w3 === null) {
      throw new Error(`abl 任务 ${task.id} 非灭绝但 w3 窗口为空`);
    }
    return {
      id: task.id,
      stage: 'abl',
      preregistrationHash,
      regimeKey: task.regimeKey,
      ablationKey: task.ablationKey,
      seed: task.seed,
      extinct: out.report.extinct,
      aliveAtEnd: out.report.aliveAtEnd,
      finalStateHash: out.report.finalStateHash,
      w3,
      ...verifier.summary(),
      wallMs: Date.now() - t0,
    };
  }

  if (task.stage === 'pert') {
    const cfg = mergeConfig(DEFAULT_RUN_CONFIG, {
      ...task.regimeOverrides,
      population: { initialPopulation: POPULATION },
      schedule: { totalTicks: task.totalTicks, statsStride: 1, snapshotStride: task.totalTicks },
    });
    const pair = runPerturbationPair(cfg, asSeed(task.seed), {
      policy: POLICY,
      checkpointTick: 365,
      declared: { kind: 'wealth_absolute', delta: 1e-4 },
    });
    const base = extractW3(pair.baseline.report);
    const treat = pair.treatment ? extractW3(pair.treatment.report) : null;
    if (!pair.baseline.report.extinct && base === null) {
      throw new Error(`pert 任务 ${task.id} baseline 非灭绝但 w3 窗口为空`);
    }
    if (!pair.invalid && pair.treatment && !pair.treatment.report.extinct && treat === null) {
      throw new Error(`pert 任务 ${task.id} treatment 非灭绝但 w3 窗口为空`);
    }
    return {
      id: task.id,
      stage: 'pert',
      preregistrationHash,
      regimeKey: task.regimeKey,
      seed: task.seed,
      policyVersion: POLICY,
      invalid: pair.invalid,
      invalidReason: pair.invalidReason,
      firstDivergenceTick: pair.firstDivergenceTick,
      baselineExtinct: pair.baseline.report.extinct,
      treatmentExtinct: pair.treatment ? pair.treatment.report.extinct : null,
      base,
      treat,
      wallMs: Date.now() - t0,
    };
  }

  const cfg = mergeConfig(DEFAULT_RUN_CONFIG, {
    ...task.overrides,
    population: { initialPopulation: POPULATION },
    schedule: { totalTicks: task.totalTicks, statsStride: 1, snapshotStride: task.totalTicks },
  });
  const verifier = createPolicyVerifyingSink(POLICY);
  const out = runSingle(cfg, asSeed(task.seed), {
    policy: POLICY,
    artifactSink: verifier.sink,
  });
  const [wStart, wEnd] = task.totalTicks === 10950 ? [10585, 10949] : [14235, 14599];
  const feat = windowFeatures(out.stats, wStart, wEnd);
  if (!out.report.extinct && feat === null) {
    throw new Error(`cluster 任务 ${task.id} 非灭绝但终端窗口特征为空`);
  }
  return {
    id: task.id,
    stage: 'cluster',
    kind: task.kind,
    preregistrationHash,
    cellKey: task.cellKey,
    seed: task.seed,
    totalTicks: task.totalTicks,
    extinct: out.report.extinct,
    aliveAtEnd: out.report.aliveAtEnd,
    finalStateHash: out.report.finalStateHash,
    feat,
    ...verifier.summary(),
    wallMs: Date.now() - t0,
  };
}

if (!isMainThread) {
  const { tasks, preregistrationHash, partsDir } = workerData;
  let completed = 0;
  for (const task of tasks) {
    const partPath = join(partsDir, `${task.id}.json`);
    if (existsSync(partPath)) {
      try {
        const existing = JSON.parse(readFileSync(partPath, 'utf8'));
        if (existing.preregistrationHash === preregistrationHash && existing.id === task.id) {
          completed += 1;
          parentPort.postMessage({ type: 'skip', id: task.id, stage: task.stage, completed });
          continue;
        }
      } catch {
        // 损坏分片重算
      }
    }
    const record = runOneTask(task, preregistrationHash);
    writeAtomicJson(partPath, record);
    completed += 1;
    parentPort.postMessage({
      type: 'done',
      id: task.id,
      stage: task.stage,
      wallMs: record.wallMs,
      completed,
    });
  }
  parentPort.postMessage({ type: 'finished', completed });
} else {
  const round4 = (v) => Number(v.toFixed(4));
  const round6 = (v) => Number(v.toFixed(6));

  const quantileSorted = (sorted, q) => {
    if (sorted.length === 0) return 0;
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    return sorted[base] + rest * ((sorted[base + 1] ?? sorted[base]) - sorted[base]);
  };

  const structDiff = (a, b) => {
    const tvP = 0.5 * a.P.reduce((s, v, i) => s + Math.abs(v - b.P[i]), 0);
    const dG = Math.abs(a.G - b.G);
    const dMup = Math.abs(a.Mup - b.Mup);
    const dS = Math.abs(a.S - b.S);
    const dO = Math.abs(a.O - b.O);
    const D = 0.3 * dG + 0.25 * tvP + 0.2 * dMup + 0.15 * dS + 0.1 * dO;
    return { tvP, dG, dMup, dS, dO, D };
  };

  const pairwiseD95 = (vecs) => {
    const ds = [];
    for (let i = 0; i < vecs.length; i += 1) {
      for (let j = i + 1; j < vecs.length; j += 1) {
        ds.push(structDiff(vecs[i], vecs[j]).D);
      }
    }
    return nearestRankPercentile(ds, 0.95) ?? 0;
  };

  const nearestCentroid = (point, centroids) => {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < centroids.length; i += 1) {
      const d = euclidean(point, centroids[i]);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  };

  const loadCompletedRecords = (allTasks, expectedHash) => {
    const byId = new Map();
    if (existsSync(RAW_PATH)) {
      try {
        const raw = JSON.parse(readFileSync(RAW_PATH, 'utf8'));
        if (raw.preregistrationHash === expectedHash && Array.isArray(raw.records)) {
          for (const rec of raw.records) {
            if (rec && rec.preregistrationHash === expectedHash && typeof rec.id === 'string') {
              byId.set(rec.id, rec);
            }
          }
        }
      } catch {
        // 忽略损坏 raw，尝试从 parts 恢复
      }
    }
    if (existsSync(PARTS_DIR)) {
      for (const task of allTasks) {
        const partPath = join(PARTS_DIR, `${task.id}.json`);
        if (!existsSync(partPath)) continue;
        try {
          const rec = JSON.parse(readFileSync(partPath, 'utf8'));
          if (rec.preregistrationHash === expectedHash && rec.id === task.id) {
            byId.set(task.id, rec);
          }
        } catch {
          // 跳过损坏分片
        }
      }
    }
    return byId;
  };

  const evaluateK = (k, matrix, zBase, baseRuns, followupRaw, std) => {
    const labels = wardCluster(zBase, k);
    const sil = silhouetteScore(zBase, labels);
    const ariSamples = [];
    for (let s = 0; s < 20; s += 1) {
      const order = seededShuffle(zBase.length, 20261124 + k * 997 + s * 7919);
      ariSamples.push(bisectStability(zBase, k, [order], 0.7).ari);
    }
    ariSamples.sort((a, b) => a - b);
    const ariMin = ariSamples[0];
    const ariMedian = (ariSamples[9] + ariSamples[10]) / 2;
    const ariMax = ariSamples[ariSamples.length - 1];
    const sizes = Array.from({ length: k }, (_, c) => labels.filter((l) => l === c).length);
    const comp = Array.from({ length: k }, (_, c) => {
      const counts = {};
      baseRuns.forEach((r, idx) => {
        if (labels[idx] === c) counts[r.cellKey] = (counts[r.cellKey] ?? 0) + 1;
      });
      return counts;
    });
    const centroidsZ = Array.from({ length: k }, (_, c) => {
      const pts = zBase.filter((_, idx) => labels[idx] === c);
      return Array.from(
        { length: pts[0].length },
        (_, j) => pts.reduce((s, p) => s + p[j], 0) / pts.length,
      );
    });
    const centroidsRaw = Array.from({ length: k }, (_, c) => {
      const pts = matrix.filter((_, idx) => labels[idx] === c);
      return Array.from({ length: pts[0].length }, (_, j) =>
        round4(pts.reduce((s, p) => s + p[j], 0) / pts.length),
      );
    });
    const baseLabelMap = new Map(
      baseRuns.map((r, idx) => [`${r.cellKey}::${r.seed}`, labels[idx]]),
    );
    let same = 0;
    let total = 0;
    for (const r of followupRaw) {
      if (r.feat === null) continue;
      const assigned = nearestCentroid(std.standardize(r.feat), centroidsZ);
      if (assigned === baseLabelMap.get(`${r.cellKey}::${r.seed}`)) same += 1;
      total += 1;
    }
    return {
      clusterSizes: sizes,
      clusterComposition: comp,
      centroidsRaw,
      ariMedian: round4(ariMedian),
      ariMin: round4(ariMin),
      ariMax: round4(ariMax),
      silhouette: round4(sil),
      temporalConsistency: round4(total > 0 ? same / total : 0),
      antiPreset: comp.some((c) => Object.keys(c).length >= 2),
      labels,
      centroidsZ,
    };
  };

  const analyzeClustering = (records) => {
    const baseRaw = records.filter((r) => r.kind === 'base');
    const followupRaw = records.filter((r) => r.kind === 'followup');
    const complete = baseRaw.length === 180 && followupRaw.length === 60;
    if (!complete) {
      return {
        complete: false,
        runs: {
          base: baseRaw.length,
          followup: followupRaw.length,
          expectedBase: 180,
          expectedFollowup: 60,
        },
      };
    }

    let excluded = 0;
    let extinctCount = 0;
    let fallbackDecisions = 0;
    const observedPolicies = new Set();
    const baseRuns = [];
    for (const r of baseRaw) {
      observedPolicies.add(r.observedPolicy);
      fallbackDecisions += r.fallbackDecisions ?? 0;
      if (r.extinct) extinctCount += 1;
      if (r.feat === null) {
        excluded += 1;
        continue;
      }
      baseRuns.push(r);
    }
    for (const r of followupRaw) {
      observedPolicies.add(r.observedPolicy);
      fallbackDecisions += r.fallbackDecisions ?? 0;
      if (r.extinct) extinctCount += 1;
    }
    baseRuns.sort((a, b) => (a.cellKey + a.seed).localeCompare(b.cellKey + b.seed));

    const matrix = baseRuns.map((r) => r.feat);
    const std = fitStandardizer(matrix);
    const zBase = matrix.map((v) => std.standardize(v));
    const k2Full = evaluateK(2, matrix, zBase, baseRuns, followupRaw, std);
    const k3Full = evaluateK(3, matrix, zBase, baseRuns, followupRaw, std);

    const centroidDistanceZ = euclidean(k2Full.centroidsZ[0], k2Full.centroidsZ[1]);
    const centroidDistanceRaw = euclidean(k2Full.centroidsRaw[0], k2Full.centroidsRaw[1]);

    const perCluster = [0, 1].map((cluster) => {
      const members = baseRuns.filter((_, idx) => k2Full.labels[idx] === cluster);
      const featureIqr = FEATURE_NAMES.map((feature, j) => {
        const sorted = members.map((run) => run.feat[j]).sort((a, b) => a - b);
        const q1 = quantileSorted(sorted, 0.25);
        const q3 = quantileSorted(sorted, 0.75);
        return {
          feature,
          q1: round4(q1),
          q3: round4(q3),
          iqr: round4(q3 - q1),
          min: round4(sorted[0] ?? 0),
          max: round4(sorted[sorted.length - 1] ?? 0),
        };
      });
      return {
        cluster,
        size: members.length,
        cells: [...new Set(members.map((run) => run.cellKey))].sort(),
        featureIqr,
      };
    });

    const margins = baseRuns.map((run, idx) => {
      const d0 = euclidean(zBase[idx], k2Full.centroidsZ[0]);
      const d1 = euclidean(zBase[idx], k2Full.centroidsZ[1]);
      return {
        seed: run.seed,
        cellKey: run.cellKey,
        cluster: k2Full.labels[idx],
        margin: Math.abs(d0 - d1),
      };
    });
    const sortedMargins = [...margins].sort((a, b) => a.margin - b.margin);
    const bandSize = Math.ceil(0.1 * sortedMargins.length);
    const intermediate = sortedMargins.slice(0, bandSize);

    const tvP =
      0.5 *
      [0, 1, 2, 3, 4].reduce(
        (s, idx) => s + Math.abs(k2Full.centroidsRaw[0][idx] - k2Full.centroidsRaw[1][idx]),
        0,
      );
    const deltaS = Math.abs(k2Full.centroidsRaw[0][9] - k2Full.centroidsRaw[1][9]);
    const deltaO = Math.abs(k2Full.centroidsRaw[0][10] - k2Full.centroidsRaw[1][10]);

    const clusterAIdx = k2Full.clusterComposition.findIndex((c) => (c['A-share100-w0'] ?? 0) > 0);
    const otherIdx = clusterAIdx === 0 ? 1 : 0;
    const cA = clusterAIdx >= 0 ? k2Full.centroidsRaw[clusterAIdx] : null;
    const cOther = clusterAIdx >= 0 ? k2Full.centroidsRaw[otherIdx] : null;
    const directionMatchesPrereg =
      cA !== null &&
      cOther !== null &&
      cA[0] > cOther[0] &&
      cA[7] > cOther[7] &&
      cA[10] > cOther[10] &&
      cA[9] < cOther[9];

    const perCellMeans = {};
    for (const cell of CLUSTER_CELLS) {
      const rows = baseRuns.filter((r) => r.cellKey === cell.cellKey);
      const meanVec = Array.from({ length: 11 }, (_, j) =>
        round4(rows.reduce((s, r) => s + r.feat[j], 0) / rows.length),
      );
      perCellMeans[cell.cellKey] = Object.fromEntries(
        FEATURE_NAMES.map((name, j) => [name, meanVec[j]]),
      );
    }

    const k2 = {
      clusterSizes: k2Full.clusterSizes,
      clusterComposition: k2Full.clusterComposition,
      centroidsRaw: k2Full.centroidsRaw,
      ariMedian: k2Full.ariMedian,
      ariMin: k2Full.ariMin,
      ariMax: k2Full.ariMax,
      silhouette: k2Full.silhouette,
      temporalConsistency: k2Full.temporalConsistency,
      antiPreset: k2Full.antiPreset,
    };
    const k3 = {
      clusterSizes: k3Full.clusterSizes,
      clusterComposition: k3Full.clusterComposition,
      centroidsRaw: k3Full.centroidsRaw,
      ariMedian: k3Full.ariMedian,
      ariMin: k3Full.ariMin,
      ariMax: k3Full.ariMax,
      silhouette: k3Full.silhouette,
      temporalConsistency: k3Full.temporalConsistency,
      antiPreset: k3Full.antiPreset,
    };

    const policyValid =
      observedPolicies.size === 1 && observedPolicies.has(POLICY) && fallbackDecisions === 0;
    const k2Stable =
      k2.clusterSizes.every((s) => s >= 5) &&
      k2.ariMedian >= 0.7 &&
      k2.silhouette >= 0.35 &&
      k2.temporalConsistency >= 0.8 &&
      k2.antiPreset &&
      Math.max(tvP, deltaS, deltaO) >= 0.1;

    const hasDiscreteThirdClusterLegacy =
      k3.clusterSizes.every((s) => s >= 5) && k3.ariMedian >= 0.7 && k3.temporalConsistency >= 0.8;
    const hasDiscreteThirdClusterAdr0010 =
      hasDiscreteThirdClusterLegacy && k3.silhouette >= 0.35 && k3.silhouette >= k2.silhouette;

    const passesAdr0010 =
      k2Stable &&
      directionMatchesPrereg &&
      !hasDiscreteThirdClusterAdr0010 &&
      excluded === 0 &&
      extinctCount === 0 &&
      policyValid;
    const passesLegacy =
      k2Stable &&
      directionMatchesPrereg &&
      !hasDiscreteThirdClusterLegacy &&
      excluded === 0 &&
      extinctCount === 0 &&
      policyValid;

    return {
      complete: true,
      runs: {
        base: baseRuns.length,
        followup: followupRaw.length,
        excluded,
        extinctCount,
        fallbackDecisions,
        observedPolicies: [...observedPolicies],
      },
      perCellMeans,
      k2,
      k3,
      regimeDiff: {
        tvP: round4(tvP),
        deltaS: round4(deltaS),
        deltaO: round4(deltaO),
        directionMatchesPrereg,
      },
      continuity: {
        note: '07 §8.2 描述性报告：不设阈值、不参与 passes；仅用于描述两体制内部/之间的连续程度。',
        featureNames: FEATURE_NAMES,
        perCluster,
        centroidDistanceZ: round4(centroidDistanceZ),
        centroidDistanceRaw: round4(centroidDistanceRaw),
        assignmentMargin: {
          min: round4(sortedMargins[0]?.margin ?? 0),
          median: round4(
            quantileSorted(
              sortedMargins.map((m) => m.margin),
              0.5,
            ),
          ),
          max: round4(sortedMargins[sortedMargins.length - 1]?.margin ?? 0),
        },
        intermediateBand: {
          definition: '分配裕度 |d0-d1| 最低 10% 的 base run（报告分位，非阈值）',
          count: intermediate.length,
          cells: [...new Set(intermediate.map((m) => m.cellKey))].sort(),
        },
      },
      checks: {
        policyValid,
        k2Stable,
        directionMatchesPrereg,
        hasDiscreteThirdClusterLegacy,
        hasDiscreteThirdClusterAdr0010,
      },
      passesLegacy,
      passesAdr0010,
      verdict: passesAdr0010 ? 'two-regime-candidate' : 'not-accepted',
    };
  };

  const analyzePerturbation = (records) => {
    const complete = records.length === 60;
    if (!complete) {
      return { complete: false, completed: records.length, expected: 60 };
    }
    const summary = {};
    let allPassed = true;
    for (const regime of REGIMES) {
      const rows = records.filter((r) => r.regimeKey === regime.key);
      const valid = rows.filter(
        (r) => !r.invalid && !r.baselineExtinct && !r.treatmentExtinct && r.base && r.treat,
      );
      const extinctCount = rows.filter((r) => r.baselineExtinct || r.treatmentExtinct).length;
      const d95 = pairwiseD95(valid.map((r) => r.base));
      const diffs = valid.map((r) => structDiff(r.base, r.treat));
      const ds = diffs.map((d) => d.D).sort((a, b) => a - b);
      const tvs = diffs.map((d) => d.tvP).sort((a, b) => a - b);
      const absorbedCount = diffs.filter((d) => d.D <= d95 && d.tvP < 0.1).length;
      const divergedCount = valid.filter((r) => r.firstDivergenceTick !== null).length;
      const absorbedRate = valid.length > 0 ? absorbedCount / valid.length : 0;
      const passes =
        rows.length === 30 && valid.length === 30 && extinctCount === 0 && absorbedRate === 1;
      if (!passes) allPassed = false;
      summary[regime.key] = {
        pairs: rows.length,
        valid: valid.length,
        invalid: rows.filter((r) => r.invalid).length,
        extinctCount,
        divergedTrajectories: divergedCount,
        baselineD95: round6(d95),
        medianD: quantileSorted(ds, 0.5),
        maxD: ds[ds.length - 1] ?? 0,
        medianTvP: quantileSorted(tvs, 0.5),
        maxTvP: tvs[tvs.length - 1] ?? 0,
        absorbedCount,
        absorbedRate: round4(absorbedRate),
        passes,
      };
    }
    return { complete: true, passes: allPassed, regimes: summary };
  };

  const analyzeAblations = (records) => {
    const complete = records.length === 360;
    if (!complete) {
      return { complete: false, completed: records.length, expected: 360 };
    }
    const observedPolicies = new Set(records.map((r) => r.observedPolicy));
    const totalFallbacks = records.reduce((s, r) => s + (r.fallbackDecisions ?? 0), 0);
    const totalExtinct = records.filter((r) => r.extinct).length;
    const regimesOut = {};
    let explainedCount = 0;
    let strictExplainedCount = 0;

    REGIMES.forEach((regime, regimeIdx) => {
      const baseRows = records.filter(
        (r) => r.regimeKey === regime.key && r.ablationKey === 'baseline' && r.w3,
      );
      const baseBySeed = new Map(baseRows.map((r) => [r.seed, r.w3]));
      const d95 = pairwiseD95(baseRows.map((r) => r.w3));

      const labelCounts = {};
      for (const r of baseRows) {
        for (const lbl of r.w3.labels ?? []) {
          labelCounts[lbl] = (labelCounts[lbl] ?? 0) + 1;
        }
      }
      const baselineSummary = {
        runs: baseRows.length,
        medianP: [0, 1, 2, 3, 4].map((c) => round4(median(baseRows.map((r) => r.w3.P[c])))),
        medianG: round4(median(baseRows.map((r) => r.w3.G))),
        medianMup: round4(median(baseRows.map((r) => r.w3.Mup))),
        medianS: round4(median(baseRows.map((r) => r.w3.S))),
        medianO: round4(median(baseRows.map((r) => r.w3.O))),
        labelCounts,
        baselineD95: round6(d95),
      };

      const items = {};
      const nonBaseline = ABLATIONS.filter((a) => a.key !== 'baseline');
      nonBaseline.forEach((abl, ablIdx) => {
        const treatRows = records.filter(
          (r) => r.regimeKey === regime.key && r.ablationKey === abl.key && r.w3,
        );
        const extinctInCell = records.filter(
          (r) => r.regimeKey === regime.key && r.ablationKey === abl.key && r.extinct,
        ).length;
        const pairs = [];
        for (const tr of treatRows) {
          const br = baseBySeed.get(tr.seed);
          if (br) pairs.push({ base: br, treat: tr.w3, diff: structDiff(br, tr.w3) });
        }
        const tvPs = pairs.map((p) => p.diff.tvP);
        const ds = pairs.map((p) => p.diff.D);
        const medianTvP = median(tvPs);
        const tvCi = bootstrapMedianCi(tvPs, {
          iterations: 10000,
          seed: 20261124 + regimeIdx * 100 + ablIdx,
        });
        const overD95Rate = pairs.filter((p) => p.diff.D > d95).length / pairs.length;
        const signedDeltas = {
          P: [0, 1, 2, 3, 4].map((c) =>
            round4(median(pairs.map((p) => p.treat.P[c] - p.base.P[c]))),
          ),
          G: round4(median(pairs.map((p) => p.treat.G - p.base.G))),
          Mup: round4(median(pairs.map((p) => p.treat.Mup - p.base.Mup))),
          S: round4(median(pairs.map((p) => p.treat.S - p.base.S))),
          O: round4(median(pairs.map((p) => p.treat.O - p.base.O))),
        };
        const absMedians = {
          dG: round4(median(pairs.map((p) => p.diff.dG))),
          dMup: round4(median(pairs.map((p) => p.diff.dMup))),
          dS: round4(median(pairs.map((p) => p.diff.dS))),
          dO: round4(median(pairs.map((p) => p.diff.dO))),
          D: round4(median(ds)),
        };

        let psi1Check = null;
        if (abl.key === 'psi_1') {
          const p4Deltas = pairs.map((p) => p.treat.P[4] - p.base.P[4]);
          const p4Median = median(p4Deltas);
          const p4DecreaseRate = p4Deltas.filter((d) => d < 0).length / p4Deltas.length;
          psi1Check = {
            p4DeltaMedian: round4(p4Median),
            p4DecreaseRate: round4(p4DecreaseRate),
            predictionHolds: p4Median < 0 && p4DecreaseRate >= 0.9,
          };
        }

        const mechanismExplained =
          pairs.length === 30 && extinctInCell === 0 && medianTvP >= 0.1 && tvCi[0] > 0;
        const passesStrict07 = mechanismExplained && overD95Rate === 1;
        if (mechanismExplained) explainedCount += 1;
        if (passesStrict07) strictExplainedCount += 1;

        items[abl.key] = {
          pairs: pairs.length,
          extinctCount: extinctInCell,
          medianTvP: round4(medianTvP),
          tvCi95: [round4(tvCi[0]), round4(tvCi[1])],
          overD95Rate: round4(overD95Rate),
          absMedians,
          signedDeltas,
          ...(psi1Check ? { psi1Check } : {}),
          mechanismExplained,
          passesStrict07,
        };
      });

      regimesOut[regime.key] = {
        baseline: baselineSummary,
        ablations: items,
      };
    });

    const policyValid =
      observedPolicies.size === 1 && observedPolicies.has(POLICY) && totalFallbacks === 0;
    return {
      complete: true,
      policyValid,
      observedPolicies: [...observedPolicies],
      totalFallbacks,
      totalExtinct,
      explainedCount,
      strictExplainedCount,
      regimes: regimesOut,
    };
  };

  const runAnalyze = (prereg, allTasks, writeRaw = false) => {
    const byId = loadCompletedRecords(allTasks, prereg.preregistrationHash);
    const records = allTasks.map((t) => byId.get(t.id)).filter(Boolean);
    const ablRecords = records.filter((r) => r.stage === 'abl');
    const pertRecords = records.filter((r) => r.stage === 'pert');
    const clusterRecords = records.filter((r) => r.stage === 'cluster');

    const abl = analyzeAblations(ablRecords);
    const pert = analyzePerturbation(pertRecords);
    const cluster = analyzeClustering(clusterRecords);
    const allComplete = abl.complete && pert.complete && cluster.complete;

    if (writeRaw && allComplete) {
      writeAtomicJson(RAW_PATH, {
        experimentId: prereg.experimentId,
        preregistrationHash: prereg.preregistrationHash,
        policyVersion: POLICY,
        rulesVersion: RULES_VERSION,
        records,
      });
    }

    const totalWallSeconds = round4(records.reduce((s, r) => s + (r.wallMs ?? 0), 0) / 1000);

    let overallVerdict = 'incomplete';
    if (allComplete) {
      if (cluster.passesAdr0010 && pert.passes && abl.strictExplainedCount > 0 && abl.policyValid) {
        overallVerdict = 'g6-two-regime-candidate-with-ablation-support';
      } else if (cluster.passesAdr0010 && pert.passes) {
        overallVerdict = 'two-regime-candidate-ablation-failed';
      } else {
        overallVerdict = 'not-accepted';
      }
    }

    const result = {
      experimentId: prereg.experimentId,
      preregistrationHash: prereg.preregistrationHash,
      rulesVersion: RULES_VERSION,
      engineVersion: ENGINE_VERSION,
      policyVersion: POLICY,
      population: POPULATION,
      progress: {
        abl: `${ablRecords.length}/360`,
        pert: `${pertRecords.length}/60`,
        cluster: `${clusterRecords.length}/240`,
        total: `${records.length}/660`,
        allComplete,
      },
      cumulativeTaskCpuSeconds: totalWallSeconds,
      clustering: cluster,
      perturbation: pert,
      ablations: abl,
      overallVerdict,
    };

    mkdirSync('out', { recursive: true });
    writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
  };

  const args = process.argv.slice(2);
  const doFreeze = args.includes('--freeze');
  const doRun = args.includes('--run');
  const doAnalyze = args.includes('--analyze');
  const doStatus = args.includes('--status');
  const stageIdx = args.indexOf('--stage');
  const stageFilter = stageIdx >= 0 ? args[stageIdx + 1] : 'all';

  if (!doFreeze && !doRun && !doAnalyze && !doStatus) {
    process.stderr.write(
      '用法: node scripts/p6-15-g6-closure.mjs [--freeze | --run [--stage all|abl|pert|cluster] | --analyze | --status]\n',
    );
    process.exit(1);
  }

  const prereg = buildPrereg();
  const allTasks = buildAllTasks();

  if (doFreeze) {
    mkdirSync('out', { recursive: true });
    writeFileSync(PREREG_PATH, `${JSON.stringify(prereg, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `Frozen ${PREREG_PATH}\nexperimentId=${prereg.experimentId}\npreregistrationHash=${prereg.preregistrationHash}\n`,
    );
    process.exit(0);
  }

  if (doStatus) {
    const byId = loadCompletedRecords(allTasks, prereg.preregistrationHash);
    const counts = { abl: 0, pert: 0, cluster: 0 };
    for (const t of allTasks) {
      if (byId.has(t.id)) counts[t.stage] += 1;
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          experimentId: prereg.experimentId,
          preregistrationHash: prereg.preregistrationHash,
          abl: `${counts.abl}/360`,
          pert: `${counts.pert}/60`,
          cluster: `${counts.cluster}/240`,
          total: `${counts.abl + counts.pert + counts.cluster}/660`,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(0);
  }

  if (doAnalyze) {
    if (existsSync(PREREG_PATH)) {
      const frozen = JSON.parse(readFileSync(PREREG_PATH, 'utf8'));
      if (frozen.preregistrationHash !== prereg.preregistrationHash) {
        throw new Error(
          `预注册哈希漂移：冻结=${frozen.preregistrationHash}，当前=${prereg.preregistrationHash}`,
        );
      }
    }
    const result = runAnalyze(prereg, allTasks, true);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  }

  if (doRun) {
    if (!existsSync(PREREG_PATH)) {
      throw new Error(`缺少冻结预注册文件 ${PREREG_PATH}；请先执行 --freeze`);
    }
    const frozen = JSON.parse(readFileSync(PREREG_PATH, 'utf8'));
    if (frozen.preregistrationHash !== prereg.preregistrationHash) {
      throw new Error(
        `预注册哈希不匹配：冻结=${frozen.preregistrationHash}，当前=${prereg.preregistrationHash}`,
      );
    }

    mkdirSync(PARTS_DIR, { recursive: true });
    const selectedTasks =
      stageFilter === 'all' ? allTasks : allTasks.filter((t) => t.stage === stageFilter);
    if (selectedTasks.length === 0) {
      throw new Error(`无效 --stage=${stageFilter}；允许 all | abl | pert | cluster`);
    }

    const existing = loadCompletedRecords(selectedTasks, prereg.preregistrationHash);
    const pending = selectedTasks.filter((t) => !existing.has(t.id));
    process.stderr.write(
      `P6-15 (${prereg.experimentId}) stage=${stageFilter}: total=${selectedTasks.length}, done=${existing.size}, pending=${pending.length}\n`,
    );

    if (pending.length > 0) {
      const envWorkers = Number(process.env.P6_15_WORKERS);
      const workersCount =
        Number.isInteger(envWorkers) && envWorkers >= 1
          ? envWorkers
          : Math.min(availableParallelism(), 4);
      const actualWorkers = Math.min(workersCount, pending.length);
      const buckets = Array.from({ length: actualWorkers }, () => []);
      pending.forEach((task, idx) => buckets[idx % actualWorkers].push(task));

      const tStart = Date.now();
      let doneNow = 0;
      const selfPath = fileURLToPath(import.meta.url);
      await Promise.all(
        buckets.map(
          (chunk, workerIdx) =>
            new Promise((resolve, reject) => {
              const w = new Worker(selfPath, {
                workerData: {
                  tasks: chunk,
                  preregistrationHash: prereg.preregistrationHash,
                  partsDir: PARTS_DIR,
                },
              });
              w.on('message', (msg) => {
                if (msg.type === 'done') {
                  doneNow += 1;
                  if (doneNow % 20 === 0 || doneNow === pending.length) {
                    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
                    process.stderr.write(
                      `[P6-15] ${doneNow}/${pending.length} done (last=${msg.stage}, w${workerIdx}, ${elapsed}s)\n`,
                    );
                  }
                } else if (msg.type === 'finished') {
                  resolve();
                }
              });
              w.on('error', reject);
              w.on('exit', (code) => {
                if (code !== 0) reject(new Error(`Worker ${workerIdx} exited with code ${code}`));
              });
            }),
        ),
      );
    }

    const result = runAnalyze(prereg, allTasks, true);
    process.stdout.write(
      `P6-15 run stage=${stageFilter} complete: progress=${JSON.stringify(result.progress)}, overallVerdict=${result.overallVerdict}\n`,
    );
  }
}

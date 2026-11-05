#!/usr/bin/env node
/**
 * P6 参数搜索管线（探索层，07 §9 / rule 57）。
 *
 * 两阶段、种子隔离：
 *   1) 粗筛：LHS 采样候选配置 × 12 个 search seed × 3650 tick，按候选内
 *      k=3 稳定性/轮廓排序；4 个 shard 可并行。
 *   2) 验证：取 top 6 个候选 × 30 个全新 validation seed × 10950 tick
 *      （前 10 个续跑 14600），按 P6-05 的全特征 k=3 验收判读。
 *
 * 结果只是 exploratory：验证通过也只说明“搜索到的参数区域值得独立确认”，
 * 不是校准、现实因果或 rules-v11 结构涌现声明；confirm seed 必须另立实验。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { asSeed } from '../dist/core/control/ids.js';
import { hashValue } from '../dist/core/hash/hash.js';
import { HASH_DOMAINS } from '../dist/core/hash/domains.js';
import { assertFrozenVersions, buildCellConfig } from '../dist/runner/preregistration.js';
import { readNdjsonTolerant } from '../dist/runner/ndjson.js';
import { median } from '../dist/runner/p6-analysis.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { summarizeWindow } from '../dist/runner/window-stats.js';
import {
  bisectStability,
  fitStandardizer,
  seededShuffle,
  silhouetteScore,
  wardCluster,
} from '../dist/runner/cluster.js';
import {
  clusterCentroids,
  clusterComposition,
  clusterSizes,
  structuralFeatureVector,
  temporalSameClusterRate,
} from '../dist/runner/p6-cluster-summary.js';

const DEFAULTS = {
  prereg: 'out/p6-search-prereg.json',
  dir: 'out/p6-search',
  analysisOut: 'out/p6-search-analysis.json',
  validationPrereg: 'out/p6-search-validation-prereg.json',
  validationDir: 'out/p6-search-validation',
  validationAnalysis: 'out/p6-search-validation-analysis.json',
  population: 40,
  coarseHorizon: 3650,
  coarseWindow: { start: 3285, end: 3649, days: 365 },
  validationHorizon: 10950,
  validationWindow: { start: 10585, end: 10949, days: 365 },
  followupHorizon: 14600,
  followupWindow: { start: 14235, end: 14599, days: 365 },
  followupSeedsPerCandidate: 10,
  candidateCount: 800,
  seedsPerCandidate: 12,
  topCount: 20,
  validationCandidates: 6,
  validationSeedCount: 30,
  shardCount: 4,
};

const SEARCH_SEEDS = Array.from(
  { length: DEFAULTS.seedsPerCandidate },
  (_, index) => `p6-search-seed-${String(index + 1).padStart(3, '0')}`,
);
const VALIDATION_SEEDS = Array.from(
  { length: DEFAULTS.validationSeedCount },
  (_, index) => `p6-search-val-seed-${String(index + 1).padStart(3, '0')}`,
);

const AXES = [
  { path: 'ascent.displacementShare', min: 0.2, max: 1 },
  { path: 'ascent.scarcityWeight', min: 0, max: 60 },
  { path: 'ascent.occupancyMemoryDays', values: [0, 90, 180, 365] },
  { path: 'openness.segregationWeight', min: 2, max: 12 },
  { path: 'openness.mobilityWeight', min: 1, max: 8 },
  { path: 'openness.ascentCostWeight', min: 0.5, max: 4 },
  { path: 'openness.timeConstantDays', min: 30, max: 180 },
  { path: 'networkOpportunity.beta', min: 0.2, max: 1.2 },
  { path: 'network.rewireProb', min: 0.02, max: 0.15 },
  { path: 'dynamics.congestionExponent', min: 0.2, max: 0.6 },
  { path: 'dynamics.polarizationExponent', min: 0.4, max: 1.2 },
  { path: 'need.threshold', min: 0.5, max: 0.95 },
];

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCandidates() {
  const random = mulberry32(20261105);
  const candidates = [];
  for (let index = 0; index < DEFAULTS.candidateCount; index += 1) {
    const params = {};
    for (const axis of AXES) {
      if (axis.values !== undefined) {
        params[axis.path] = axis.values[Math.floor(random() * axis.values.length)];
      } else {
        params[axis.path] = axis.min + random() * (axis.max - axis.min);
      }
    }
    candidates.push({
      candidateId: `c${String(index).padStart(4, '0')}`,
      params,
    });
  }
  return candidates;
}

function candidateOverrides(params) {
  const overrides = {};
  for (const [path, value] of Object.entries(params)) {
    const [head, tail] = path.split('.');
    overrides[head] = overrides[head] ?? {};
    overrides[head][tail] = value;
  }
  return overrides;
}

function buildDesign() {
  return {
    schemaVersion: 'p6-search-prereg-v1',
    hypothesis:
      'P6 参数搜索（探索）：在 rules-v11、mock-weighted-v1、40 人视野内，用固定种子的随机采样 ' +
      `${DEFAULTS.candidateCount} 个候选配置 × ${DEFAULTS.seedsPerCandidate} 个 search seed × ` +
      `${DEFAULTS.coarseHorizon} tick，按候选内 k=3 稳定性/轮廓初筛；取 top ${DEFAULTS.topCount}，` +
      `再选 ${DEFAULTS.validationCandidates} 个候选 × ${DEFAULTS.validationSeedCount} 个全新 validation seed × ` +
      `${DEFAULTS.validationHorizon} tick（前 ${DEFAULTS.followupSeedsPerCandidate} 个续跑 ${DEFAULTS.followupHorizon}）做 k=3 验证。` +
      '验证通过只说明“该参数区域值得独立确认”，不是校准、现实因果或结构涌现；' +
      'confirm seed 必须另立 experimentId，不得复用 search/validation seed。',
    rulesVersion: 'rules-v11',
    policy: 'mock-weighted-v1',
    population: DEFAULTS.population,
    coarse: {
      horizon: DEFAULTS.coarseHorizon,
      window: DEFAULTS.coarseWindow,
      seeds: SEARCH_SEEDS,
      candidateCount: DEFAULTS.candidateCount,
    },
    validation: {
      horizon: DEFAULTS.validationHorizon,
      window: DEFAULTS.validationWindow,
      followupHorizon: DEFAULTS.followupHorizon,
      followupWindow: DEFAULTS.followupWindow,
      followupSeedsPerCandidate: DEFAULTS.followupSeedsPerCandidate,
      seeds: VALIDATION_SEEDS,
      candidates: DEFAULTS.validationCandidates,
    },
    axes: AXES,
    features: ['P0', 'P1', 'P2', 'P3', 'P4', 'G', 'top10', 'Mup', 'Mdown', 'S', 'O'],
    ranking: {
      k: 3,
      stabilityShuffles: 20,
      stabilitySeed: 20261105,
      minClusterRuns: 2,
      score: 'silhouette + ariMedian - penalties（extinct/空簇/最小簇<2）',
    },
    clustering: {
      algorithm: 'ward-lw-v1',
      distance: 'euclidean',
      standardization: 'z-score(pooled)',
      k: 3,
      stabilityShuffles: 20,
      stabilitySeed: 20261105,
      ariMedianMin: 0.7,
      silhouetteMin: 0.35,
      minClusterRuns: 5,
    },
    temporal: { minSameClusterRate: 0.8 },
    antiPreset: { minCandidatesInAnyCluster: 2 },
    exclusion: { excludeExtinct: true, maxExtinctRate: 0.1 },
    budgets: {
      coarseRuns: DEFAULTS.candidateCount * DEFAULTS.seedsPerCandidate,
      validationRuns:
        DEFAULTS.validationCandidates *
        (DEFAULTS.validationSeedCount + DEFAULTS.followupSeedsPerCandidate),
      wallMinutes: 360,
      shards: DEFAULTS.shardCount,
    },
    confirmationStatus: 'exploratory search only; not calibration',
  };
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, mode: null, shard: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} 缺少取值`);
      index += 1;
      return value;
    };
    if (flag === '--freeze') options.mode = 'freeze';
    else if (flag === '--run') options.mode = 'run';
    else if (flag === '--analyze') options.mode = 'analyze';
    else if (flag === '--validate-freeze') options.mode = 'validate-freeze';
    else if (flag === '--validate-run') options.mode = 'validate-run';
    else if (flag === '--validate-analyze') options.mode = 'validate-analyze';
    else if (flag === '--shard') {
      const [indexText, countText] = next().split('/');
      options.shard = Number(indexText);
      options.shardCount = Number(countText);
    } else if (flag === '--prereg') options.prereg = next();
    else if (flag === '--dir') options.dir = next();
    else if (flag === '--out') options.analysisOut = next();
    else if (flag === '--limit') options.limit = Number(next());
    else if (flag === '--force') options.force = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        [
          '用法：',
          '  node scripts/p6-search.mjs --freeze [--force]',
          '  node scripts/p6-search.mjs --run --shard 0/4',
          '  node scripts/p6-search.mjs --analyze',
          '  node scripts/p6-search.mjs --validate-freeze',
          '  node scripts/p6-search.mjs --validate-run --shard 0/4',
          '  node scripts/p6-search.mjs --validate-analyze',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${flag}`);
    }
  }
  if (options.mode === null) throw new Error('必须指定模式');
  if (
    !Number.isInteger(options.shard) ||
    options.shard < 0 ||
    options.shard >= options.shardCount
  ) {
    throw new Error('--shard 必须为 i/n 且 0 <= i < n');
  }
  return options;
}

function loadPrereg(options) {
  if (!existsSync(options.prereg)) throw new Error(`缺少预注册 ${options.prereg}`);
  const artifact = JSON.parse(readFileSync(options.prereg, 'utf8'));
  const recomputed = hashValue(HASH_DOMAINS.preregistration, artifact.design);
  if (recomputed !== artifact.designHash) {
    throw new Error(`预注册哈希不匹配：${artifact.designHash} vs ${recomputed}`);
  }
  return artifact;
}

function freeze(options) {
  const design = buildDesign();
  const designHash = hashValue(HASH_DOMAINS.preregistration, design);
  if (existsSync(options.prereg) && !options.force) {
    throw new Error(`${options.prereg} 已存在；用 --force 才可重冻结`);
  }
  const artifact = {
    schemaVersion: design.schemaVersion,
    experimentId: `p6-search-${designHash.slice(7, 15)}`,
    createdAt: new Date().toISOString(),
    hashDomain: HASH_DOMAINS.preregistration,
    hashPreimage: 'JCS(design)',
    designHash,
    design,
  };
  mkdirSync(dirname(options.prereg), { recursive: true });
  writeFileSync(options.prereg, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        frozen: true,
        experimentId: artifact.experimentId,
        designHash,
        candidates: design.coarse.candidateCount,
        coarseRuns: design.budgets.coarseRuns,
        validationRuns: design.budgets.validationRuns,
      },
      null,
      2,
    ),
  );
}

function windowFor(horizon, design) {
  if (design.coarse !== undefined && horizon === design.coarse.horizon) {
    return design.coarse.window;
  }
  if (design.validation !== undefined && horizon === design.validation.horizon) {
    return design.validation.window;
  }
  if (design.validation !== undefined && horizon === design.validation.followupHorizon) {
    return design.validation.followupWindow;
  }
  if (horizon === design.followupHorizon) return design.followupWindow;
  return design.window ?? design.coarse.window;
}

function runOne(design, candidateId, params, seed, horizon) {
  const config = buildCellConfig(
    { cellKey: `${candidateId}@${horizon}`, overrides: candidateOverrides(params) },
    design.population,
    horizon,
  );
  const window = windowFor(horizon, design);
  const outcome = runSingle(config, asSeed(seed), {
    policy: design.policy,
    maxTicks: horizon,
  });
  const summary = summarizeWindow(
    {
      config,
      stats: outcome.stats,
      flowsByTick: outcome.flowsByTick,
      decisionsByTick: outcome.decisionsByTick,
    },
    'w3',
    window.start,
    window.end,
  );
  return {
    schemaVersion: 'p6-search-run-v1',
    candidateId,
    params,
    seed,
    horizon,
    configHash: outcome.configHash,
    extinct: outcome.report.extinct,
    aliveAtEnd: outcome.report.aliveAtEnd,
    window: {
      start: summary.start,
      end: summary.end,
      observedTicks: summary.observedTicks,
      missingTicks: summary.missingTicks,
      days: window.days,
    },
    features: structuralFeatureVector(summary),
  };
}

function ledgerPath(options, shard) {
  return join(options.dir, `runs.shard-${shard}.ndjson`);
}

function readLedger(path) {
  const { records, repairedTail } = readNdjsonTolerant(path, { repairTail: true });
  if (repairedTail) {
    process.stderr.write(`[search] 已截断末尾半行: ${path}\n`);
  }
  const map = new Map();
  for (const record of records) {
    if (record.status === 'ok')
      map.set(`${record.candidateId}:${record.horizon}:${record.seed}`, record);
  }
  return map;
}

function run(options) {
  const artifact = loadPrereg(options);
  const design = artifact.design;
  assertFrozenVersions(design);
  const candidates = (() => {
    const selected = buildCandidates().filter(
      (_, index) => index % options.shardCount === options.shard,
    );
    return Number.isInteger(options.limit) && options.limit > 0
      ? selected.slice(0, options.limit)
      : selected;
  })();
  mkdirSync(options.dir, { recursive: true });
  const path = ledgerPath(options, options.shard);
  const ledger = readLedger(path);
  let done = 0;
  const total = candidates.length * design.coarse.seeds.length;
  for (const candidate of candidates) {
    for (const seed of design.coarse.seeds) {
      const key = `${candidate.candidateId}:${design.coarse.horizon}:${seed}`;
      if (!ledger.has(key)) {
        const record = runOne(
          design,
          candidate.candidateId,
          candidate.params,
          seed,
          design.coarse.horizon,
        );
        appendFileSync(path, `${JSON.stringify({ ...record, status: 'ok' })}\n`, 'utf8');
        ledger.set(key, record);
      }
      done += 1;
    }
    if (done % 12 === 0) {
      process.stderr.write(`[search shard ${options.shard}] ${done}/${total}\n`);
    }
  }
  console.error(`[search shard ${options.shard}] 完成 ${done}/${total}`);
}

function readAllShards(options, dir) {
  const records = [];
  for (let shard = 0; shard < options.shardCount; shard += 1) {
    const path = join(dir, `runs.shard-${shard}.ndjson`);
    if (!existsSync(path)) continue;
    const { records: shardRecords, repairedTail } = readNdjsonTolerant(path, { repairTail: true });
    if (repairedTail) {
      process.stderr.write(`[search] 已截断末尾半行: ${path}\n`);
    }
    for (const record of shardRecords) {
      if (record.status === 'ok') records.push(record);
    }
  }
  return records;
}

function candidateMetrics(records, design) {
  const usable = records.filter(
    (record) =>
      !record.extinct &&
      record.window.observedTicks >= record.window.days &&
      record.window.missingTicks === 0,
  );
  if (usable.length < 6) return null;
  const points = usable.map((record) => record.features);
  const scaler = fitStandardizer(points);
  const matrix = points.map((point) => scaler.standardize(point));
  const k = design.ranking.k;
  const assignment = wardCluster(matrix, k);
  const sizes = clusterSizes(assignment, k);
  const silhouette = silhouetteScore(matrix, assignment);
  const aris = [];
  for (let iteration = 0; iteration < design.ranking.stabilityShuffles; iteration += 1) {
    const shuffle = seededShuffle(matrix.length, design.ranking.stabilitySeed + iteration);
    aris.push(bisectStability(matrix, k, [shuffle], 0.7).ari);
  }
  aris.sort((left, right) => left - right);
  const ariMedian = median(aris);
  const minSize = Math.min(...sizes);
  const penalties =
    (usable.length < records.length ? 0.2 : 0) +
    (minSize < design.ranking.minClusterRuns ? 0.5 : 0) +
    (sizes.some((size) => size === 0) ? 0.5 : 0);
  return {
    usable: usable.length,
    total: records.length,
    sizes,
    silhouette,
    ariMedian,
    ariMin: aris[0],
    minSize,
    score: silhouette + ariMedian - penalties,
  };
}

function analyze(options) {
  const artifact = loadPrereg(options);
  const design = artifact.design;
  const records = readAllShards(options, options.dir);
  const byCandidate = new Map();
  for (const record of records) {
    const bucket = byCandidate.get(record.candidateId) ?? [];
    bucket.push(record);
    byCandidate.set(record.candidateId, bucket);
  }
  const candidates = [];
  for (const [candidateId, bucket] of byCandidate) {
    const metrics = candidateMetrics(bucket, design);
    if (metrics === null) continue;
    candidates.push({
      candidateId,
      params: bucket[0].params,
      ...metrics,
    });
  }
  candidates.sort((left, right) => right.score - left.score);
  const top = candidates.slice(0, design.topCount ?? DEFAULTS.topCount);
  const selected = [];
  for (const candidate of top) {
    if (selected.length >= DEFAULTS.validationCandidates) break;
    selected.push(candidate);
  }
  const output = {
    schemaVersion: 'p6-search-analysis-v1',
    isExperimentalEvidence: false,
    experimentId: artifact.experimentId,
    preregistration: { path: options.prereg, designHash: artifact.designHash },
    runs: records.length,
    candidatesEvaluated: candidates.length,
    top,
    selectedForValidation: selected,
    notes: [
      '粗筛只用 search seed；top 候选必须用全新 validation seed 复验。',
      '验证通过只说明参数区域值得独立确认，不是校准或结构涌现。',
      '不得把 search seed 的结果直接写入正式对照。',
    ],
  };
  mkdirSync(dirname(options.analysisOut), { recursive: true });
  writeFileSync(options.analysisOut, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(output, null, 2));
}

function validateFreeze(options) {
  const artifact = loadPrereg(options);
  if (!existsSync(options.analysisOut)) throw new Error('先运行 --analyze');
  const analysis = JSON.parse(readFileSync(options.analysisOut, 'utf8'));
  const selected = analysis.selectedForValidation;
  if (!Array.isArray(selected) || selected.length < 2) {
    throw new Error('搜索分析中没有足够的验证候选');
  }
  const design = {
    schemaVersion: 'p6-search-validation-prereg-v1',
    hypothesis:
      'P6 搜索验证（探索）：对粗筛 top 候选使用全新 validation seed，' +
      `在 ${DEFAULTS.validationHorizon} tick 的全特征空间做 k=3 聚类；` +
      '通过只说明参数区域值得独立确认，不是校准或结构涌现。',
    sourceExperimentId: artifact.experimentId,
    sourceDesignHash: artifact.designHash,
    rulesVersion: artifact.design.rulesVersion,
    policy: artifact.design.policy,
    population: DEFAULTS.population,
    horizon: DEFAULTS.validationHorizon,
    window: DEFAULTS.validationWindow,
    followupHorizon: DEFAULTS.followupHorizon,
    followupWindow: DEFAULTS.followupWindow,
    followupSeedsPerCandidate: DEFAULTS.followupSeedsPerCandidate,
    seeds: VALIDATION_SEEDS,
    candidates: selected.map((candidate) => ({
      candidateId: candidate.candidateId,
      params: candidate.params,
    })),
    features: artifact.design.features,
    clustering: artifact.design.clustering,
    temporal: artifact.design.temporal,
    antiPreset: { minCandidatesInAnyCluster: 2 },
    exclusion: artifact.design.exclusion,
  };
  const designHash = hashValue(HASH_DOMAINS.preregistration, design);
  const artifactOut = {
    schemaVersion: design.schemaVersion,
    experimentId: `p6-search-val-${designHash.slice(7, 15)}`,
    createdAt: new Date().toISOString(),
    hashDomain: HASH_DOMAINS.preregistration,
    hashPreimage: 'JCS(design)',
    designHash,
    design,
  };
  mkdirSync(dirname(options.validationPrereg), { recursive: true });
  writeFileSync(options.validationPrereg, `${JSON.stringify(artifactOut, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        frozen: true,
        experimentId: artifactOut.experimentId,
        designHash,
        candidates: selected.length,
      },
      null,
      2,
    ),
  );
}

function validateRun(options) {
  if (!existsSync(options.validationPrereg)) throw new Error('先运行 --validate-freeze');
  const artifact = JSON.parse(readFileSync(options.validationPrereg, 'utf8'));
  const design = artifact.design;
  assertFrozenVersions(design);
  const candidates = design.candidates.filter(
    (_, index) => index % options.shardCount === options.shard,
  );
  mkdirSync(options.validationDir, { recursive: true });
  const path = join(options.validationDir, `runs.shard-${options.shard}.ndjson`);
  const ledger = readLedger(path);
  let done = 0;
  const total = candidates.length * design.seeds.length;
  for (const candidate of candidates) {
    for (const seed of design.seeds) {
      const key = `${candidate.candidateId}:${design.horizon}:${seed}`;
      if (!ledger.has(key)) {
        const record = runOne(
          { ...design, coarse: { horizon: design.horizon, window: design.window } },
          candidate.candidateId,
          candidate.params,
          seed,
          design.horizon,
        );
        appendFileSync(path, `${JSON.stringify({ ...record, status: 'ok' })}\n`, 'utf8');
        ledger.set(key, record);
      }
      done += 1;
    }
    for (const seed of design.seeds.slice(0, design.followupSeedsPerCandidate)) {
      const key = `${candidate.candidateId}:${design.followupHorizon}:${seed}`;
      if (!ledger.has(key)) {
        const record = runOne(
          { ...design, coarse: { horizon: design.followupHorizon, window: design.followupWindow } },
          candidate.candidateId,
          candidate.params,
          seed,
          design.followupHorizon,
        );
        appendFileSync(path, `${JSON.stringify({ ...record, status: 'ok' })}\n`, 'utf8');
        ledger.set(key, record);
      }
      done += 1;
    }
    process.stderr.write(`[search-val shard ${options.shard}] ${done}/${total}\n`);
  }
  console.error(`[search-val shard ${options.shard}] 完成 ${done}/${total}`);
}

function validateAnalyze(options) {
  if (!existsSync(options.validationPrereg)) throw new Error('先运行 --validate-freeze');
  const artifact = JSON.parse(readFileSync(options.validationPrereg, 'utf8'));
  const design = artifact.design;
  const records = [];
  for (let shard = 0; shard < options.shardCount; shard += 1) {
    const path = join(options.validationDir, `runs.shard-${shard}.ndjson`);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      const record = JSON.parse(line);
      if (record.status === 'ok') records.push(record);
    }
  }
  const base = records.filter((record) => record.horizon === design.horizon);
  const follow = records.filter((record) => record.horizon === design.followupHorizon);
  const usable = base.filter(
    (record) =>
      !record.extinct &&
      record.window.observedTicks >= record.window.days &&
      record.window.missingTicks === 0,
  );
  const points = usable.map((record) => record.features);
  const scaler = fitStandardizer(points);
  const matrix = points.map((point) => scaler.standardize(point));
  const assignment = wardCluster(matrix, design.clustering.k);
  const sizes = clusterSizes(assignment, design.clustering.k);
  const composition = clusterComposition(
    assignment,
    usable.map((record) => record.candidateId),
    design.clustering.k,
  );
  const silhouette = silhouetteScore(matrix, assignment);
  const aris = [];
  for (let iteration = 0; iteration < design.clustering.stabilityShuffles; iteration += 1) {
    const shuffle = seededShuffle(matrix.length, design.clustering.stabilitySeed + iteration);
    aris.push(bisectStability(matrix, design.clustering.k, [shuffle], 0.7).ari);
  }
  aris.sort((left, right) => left - right);
  const ariMedian = median(aris);
  const standardizedCentroids = clusterCentroids(matrix, assignment, design.clustering.k);
  const rawCentroids = clusterCentroids(points, assignment, design.clustering.k);
  const baseByKey = new Map(
    usable.map((record) => [`${record.candidateId}:${record.seed}`, record]),
  );
  const baseAssignments = [];
  const followAssignments = [];
  for (const record of follow) {
    const key = `${record.candidateId}:${record.seed}`;
    const baseRecord = baseByKey.get(key);
    if (baseRecord === undefined || record.extinct || record.window.missingTicks !== 0) continue;
    const position = usable.indexOf(baseRecord);
    if (position < 0) continue;
    const standardized = scaler.standardize(record.features);
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let cluster = 0; cluster < standardizedCentroids.length; cluster += 1) {
      let distance = 0;
      for (let index = 0; index < standardized.length; index += 1) {
        const delta = standardized[index] - standardizedCentroids[cluster][index];
        distance += delta * delta;
      }
      if (distance < bestDistance) {
        bestDistance = distance;
        best = cluster;
      }
    }
    baseAssignments.push(assignment[position]);
    followAssignments.push(best);
  }
  const temporalRate = temporalSameClusterRate(baseAssignments, followAssignments);
  const extinctRate =
    base.length === 0 ? 0 : base.filter((record) => record.extinct).length / base.length;
  const antiPreset = composition.some(
    (cluster) => Object.keys(cluster.cells).length >= design.antiPreset.minCandidatesInAnyCluster,
  );
  const reasons = [];
  if (sizes.length !== 3 || sizes.some((size) => size < design.clustering.minClusterRuns)) {
    reasons.push(`簇大小 ${sizes.join('/')} 未全部达到 ${design.clustering.minClusterRuns}`);
  }
  if (ariMedian < design.clustering.ariMedianMin)
    reasons.push(`ARI median ${ariMedian} < ${design.clustering.ariMedianMin}`);
  if (silhouette < design.clustering.silhouetteMin)
    reasons.push(`silhouette ${silhouette} < ${design.clustering.silhouetteMin}`);
  if (temporalRate < design.temporal.minSameClusterRate)
    reasons.push(`temporal ${temporalRate} < ${design.temporal.minSameClusterRate}`);
  if (extinctRate > 0.1) reasons.push(`extinct ${extinctRate} > 0.1`);
  if (!antiPreset) reasons.push('簇与候选一一对应，无法排除预设分组');
  const output = {
    schemaVersion: 'p6-search-validation-analysis-v1',
    isExperimentalEvidence: false,
    experimentId: artifact.experimentId,
    preregistration: { path: options.validationPrereg, designHash: artifact.designHash },
    runs: {
      total: records.length,
      base: base.length,
      usable: usable.length,
      followup: follow.length,
      temporalPairs: baseAssignments.length,
    },
    clustering: {
      k: design.clustering.k,
      sizes,
      composition,
      silhouette,
      ariMedian,
      ariMin: aris[0],
      rawCentroids,
      diagnostics: [2, 4, 5].map((k) => ({
        k,
        sizes: clusterSizes(wardCluster(matrix, k), k),
        silhouette: silhouetteScore(matrix, wardCluster(matrix, k)),
      })),
    },
    temporal: { sameClusterRate: temporalRate, pairs: baseAssignments.length },
    extinctRate,
    verdict: {
      passes: reasons.length === 0 && antiPreset,
      antiPreset,
      reasons,
      status:
        reasons.length === 0 && antiPreset
          ? 'search-candidate-needs-confirmation'
          : 'no-stable-region-found',
    },
    notes: [
      '搜索验证通过只说明参数区域值得用全新 confirm seed 做 P6-05 式确认。',
      '不得把 validation seed 的结果直接当作确认或校准。',
    ],
  };
  mkdirSync(dirname(options.validationAnalysis), { recursive: true });
  writeFileSync(options.validationAnalysis, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(output, null, 2));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'freeze') return freeze(options);
  if (options.mode === 'run') return run(options);
  if (options.mode === 'analyze') return analyze(options);
  if (options.mode === 'validate-freeze') return validateFreeze(options);
  if (options.mode === 'validate-run') return validateRun(options);
  if (options.mode === 'validate-analyze') return validateAnalyze(options);
  throw new Error(`未知模式 ${options.mode}`);
}

try {
  main();
} catch (error) {
  console.error(`p6-search 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

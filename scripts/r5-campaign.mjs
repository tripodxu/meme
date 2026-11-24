#!/usr/bin/env node
/**
 * R5 大规模实验战役 runner（见 docs/plans/r5-campaign.md）。
 *
 * 设计要点：
 * - 每个 task 完成后立即写 out/r5/<exp>/parts/<taskKey>.json（tmp+rename），
 *   启动时加载分片、只补缺失 task；进程被 OOM/信号杀死后可原命令续跑。
 * - 每个实验启动前冻结 out/r5/<exp>/prereg.json（设计 + seed + gate + hash），
 *   不一致拒绝运行。
 * - 并发按人口自适应：N<=200 最多 4 worker，N<=1000 最多 2，N>=3000 用 1；
 *   启动批次前检查 MemAvailable，低于阈值时等待/降并发。
 * - 全部为 mock 仿真，不调用 Jev；本脚本不包含 E8（Jev 剂量实验）。
 *
 * 用法：
 *   node scripts/r5-campaign.mjs --freeze
 *   node scripts/r5-campaign.mjs --run
 *   node scripts/r5-campaign.mjs --run <expId>
 *   node scripts/r5-campaign.mjs --analyze <expId>
 *   node scripts/r5-campaign.mjs --status
 * 环境变量：R5_WORKERS 覆盖并发；R5_DIR 覆盖输出根目录（默认 out/r5）。
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
import { RULES_VERSION } from '../dist/core/control/versions.js';
import { validateRunConfig } from '../dist/core/config/validate.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { runPerturbationPair } from '../dist/runner/perturbation.js';
import {
  bisectStability,
  fitStandardizer,
  seededShuffle,
  silhouetteScore,
  wardCluster,
} from '../dist/runner/cluster.js';

const OUT_ROOT = process.env['R5_DIR'] ?? 'out/r5';

const CANONICAL_CELLS = [
  {
    key: 'A-share100-w0',
    ascent: { displacementShare: 1.0, scarcityWeight: 0 },
  },
  {
    key: 'B-share50-w15',
    ascent: { displacementShare: 0.5, scarcityWeight: 15 },
  },
  {
    key: 'C-share50-w60',
    ascent: { displacementShare: 0.5, scarcityWeight: 60 },
  },
  {
    key: 'D-share50-w30',
    ascent: { displacementShare: 0.5, scarcityWeight: 30 },
  },
  {
    key: 'E-share70-w15',
    ascent: { displacementShare: 0.7, scarcityWeight: 15 },
  },
  {
    key: 'F-share30-w60',
    ascent: { displacementShare: 0.3, scarcityWeight: 60 },
  },
];

function seedList(prefix, count = 30) {
  return Array.from({ length: count }, (_, i) => `${prefix}-s${String(i + 1).padStart(3, '0')}`);
}

function normalizedShares(count, ratio = 0.6) {
  const raw = Array.from({ length: count }, (_, i) => Math.pow(ratio, i));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => v / sum);
}

/** C 变体需要同步缩放所有长度=C 的数组；这是显式 confound，按 exploratory 记录。 */
function classCountOverrides(C) {
  const span = Math.max(1, C - 1);
  return {
    population: {
      classCount: C,
      classShares: normalizedShares(C),
    },
    opportunity: {
      env0: Array.from({ length: C }, (_, i) => 1 + (3.5 * i) / span),
    },
    lifespan: {
      decay: Array.from({ length: C }, (_, i) => 1.3 - (0.55 * i) / span),
    },
    need: {
      needMultiplier: Array.from({ length: C }, (_, i) => 1 + (2.5 * i) / span),
    },
    ascent: {
      crossDays: Array.from({ length: C - 1 }, (_, i) => 30 + 10 * i),
      classCapacity: Array.from({ length: C }, () => 1),
    },
  };
}

function phaseCells() {
  const shares = [0.3, 0.5, 0.7, 0.85, 0.95, 1.0];
  const weights = [0, 15, 30, 45, 60];
  const cells = [];
  for (const share of shares) {
    for (const w of weights) {
      cells.push({
        key: `S${share.toFixed(2)}-W${w}`,
        ascent: { displacementShare: share, scarcityWeight: w },
      });
    }
  }
  return cells;
}

function robustCCells() {
  const cells = [];
  for (const C of [4, 6, 8]) {
    for (const canonical of CANONICAL_CELLS) {
      const base = classCountOverrides(C);
      cells.push({
        key: `C${C}/${canonical.key}`,
        variant: `C${C}`,
        population: base.population,
        opportunity: base.opportunity,
        lifespan: base.lifespan,
        need: base.need,
        ascent: { ...base.ascent, ...canonical.ascent },
      });
    }
  }
  return cells;
}

function robustPolicyCells() {
  const cells = [];
  for (const policy of ['mock-weighted-v1', 'mock-weighted-v2', 'random-uniform-v1']) {
    for (const canonical of CANONICAL_CELLS) {
      cells.push({
        key: `${policy}/${canonical.key}`,
        variant: policy,
        policy,
        ascent: canonical.ascent,
      });
    }
  }
  return cells;
}

function horizonCells() {
  const cells = [];
  for (const ticks of [10950, 21900]) {
    for (const canonical of CANONICAL_CELLS) {
      cells.push({
        key: `T${ticks}/${canonical.key}`,
        variant: `T${ticks}`,
        ticks,
        ascent: canonical.ascent,
      });
    }
  }
  return cells;
}

function genCells() {
  return [
    { key: 'G0-none', population: { generationalMode: 'none' } },
    { key: 'G1-replace', population: { generationalMode: 'replace' } },
    {
      key: 'G2-replace-beq50',
      population: { generationalMode: 'replace', bequestRate: 0.5 },
    },
    {
      key: 'G3-replace-beq80',
      population: { generationalMode: 'replace', bequestRate: 0.8 },
    },
    {
      key: 'G4-replace-inh50',
      population: { generationalMode: 'replace', classInheritanceRate: 0.5 },
    },
    {
      key: 'G5-replace-inh100',
      population: { generationalMode: 'replace', classInheritanceRate: 1.0 },
    },
    {
      key: 'G6-replace-beq50-inh50-talent10',
      population: {
        generationalMode: 'replace',
        bequestRate: 0.5,
        classInheritanceRate: 0.5,
        talentInheritanceWeight: 1.0,
      },
    },
    {
      key: 'G7-replace-beq80-inh100-talent15',
      population: {
        generationalMode: 'replace',
        bequestRate: 0.8,
        classInheritanceRate: 1.0,
        talentInheritanceWeight: 1.5,
      },
    },
  ];
}

const PERT_REGIMES = [
  {
    key: 'R1_A_share100_w0',
    ascent: { displacementShare: 1.0, scarcityWeight: 0 },
  },
  {
    key: 'R2_B_share50_w15',
    ascent: { displacementShare: 0.5, scarcityWeight: 15 },
  },
];

const PERT_MAGNITUDES = [1e-6, 1e-4, 1e-2, 1e-1, 1];
const PERT_MAGNITUDES_N1000 = [1e-4, 1e-2, 1e-1];

const EXPERIMENTS = [
  {
    id: 'r5-phase-n200',
    analysis: 'cluster',
    population: 200,
    ticks: 3650,
    seeds: seedList('r5-phase'),
    cells: phaseCells(),
    groupBy: 'all',
    cellsAreCanonical: false,
  },
  {
    id: 'r5-robust-c',
    analysis: 'cluster',
    population: 200,
    ticks: 3650,
    seeds: seedList('r5-robust'),
    cells: robustCCells(),
    groupBy: 'variant',
    cellsAreCanonical: false,
  },
  {
    id: 'r5-robust-policy',
    analysis: 'cluster',
    population: 200,
    ticks: 3650,
    seeds: seedList('r5-robust'),
    cells: robustPolicyCells(),
    groupBy: 'variant',
    cellsAreCanonical: false,
  },
  {
    id: 'r5-horizon',
    analysis: 'cluster',
    population: 200,
    ticks: 10950,
    seeds: seedList('r5-horizon'),
    cells: horizonCells(),
    groupBy: 'variant',
    cellsAreCanonical: false,
  },
  {
    id: 'r5-scale-n200',
    analysis: 'cluster',
    population: 200,
    ticks: 3650,
    seeds: seedList('r5-scale'),
    cells: CANONICAL_CELLS,
    groupBy: 'all',
    cellsAreCanonical: true,
  },
  {
    id: 'r5-scale-n1000',
    analysis: 'cluster',
    population: 1000,
    ticks: 3650,
    seeds: seedList('r5-scale'),
    cells: CANONICAL_CELLS,
    groupBy: 'all',
    cellsAreCanonical: true,
  },
  {
    id: 'r5-scale-n3000',
    analysis: 'cluster',
    population: 3000,
    ticks: 3650,
    seeds: seedList('r5-scale'),
    cells: CANONICAL_CELLS,
    groupBy: 'all',
    cellsAreCanonical: true,
  },
  {
    id: 'r5-gen-n1000',
    analysis: 'generational',
    population: 1000,
    ticks: 10950,
    seeds: seedList('r5-gen'),
    cells: genCells(),
    groupBy: 'ticks',
    cellsAreCanonical: false,
    followup: { seeds: seedList('r5-gen', 10), ticks: 14600 },
  },
  {
    id: 'r5-pert-n200',
    kind: 'pert',
    analysis: 'pert',
    population: 200,
    ticks: 3650,
    seeds: seedList('r5-pert'),
    cells: [],
    groupBy: 'all',
  },
  {
    id: 'r5-pert-n1000',
    kind: 'pert',
    analysis: 'pert',
    population: 1000,
    ticks: 3650,
    seeds: seedList('r5-pert'),
    cells: [],
    groupBy: 'all',
  },
];

const EXPERIMENT_BY_ID = new Map(EXPERIMENTS.map((exp) => [exp.id, exp]));

function cellsFor(exp) {
  if (exp.kind === 'pert') {
    const magnitudes = exp.population >= 1000 ? PERT_MAGNITUDES_N1000 : PERT_MAGNITUDES;
    return PERT_REGIMES.flatMap((regime) =>
      magnitudes.map((magnitude) => ({
        key: `${regime.key}/M${magnitude}`,
        regimeKey: regime.key,
        magnitude,
        ascent: regime.ascent,
      })),
    );
  }
  return exp.cells;
}

function taskKey(task) {
  return [
    task.expId,
    task.kind,
    task.cellKey,
    task.seed,
    task.ticks,
    task.population,
    task.magnitude ?? '',
  ].join('|');
}

function safeName(key) {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

function expDir(expId) {
  return `${OUT_ROOT}/${expId}`;
}

function partDir(expId) {
  return `${expDir(expId)}/parts`;
}

function partPath(task) {
  return `${partDir(task.expId)}/${safeName(taskKey(task))}.json`;
}

function persistPart(task, result) {
  mkdirSync(partDir(task.expId), { recursive: true });
  const target = partPath(task);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(result), 'utf8');
  renameSync(tmp, target);
}

function loadParts(expId) {
  const map = new Map();
  const dir = partDir(expId);
  if (!existsSync(dir)) return map;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const result = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8'));
      if (result && typeof result.key === 'string') map.set(result.key, result);
    } catch {
      // 损坏/半写分片忽略，由本轮重算该 task。
    }
  }
  return map;
}

function buildConfig(task) {
  const overrides = {
    population: {
      ...(task.overrides?.population ?? {}),
      initialPopulation: task.population,
    },
    schedule: {
      totalTicks: task.ticks,
      statsStride: 1,
      snapshotStride: task.ticks,
    },
    ...(task.overrides ?? {}),
  };
  // 上面的 spread 会把 overrides.population 覆盖回不含 initialPopulation 的版本，
  // 因此显式重建 population / schedule。
  overrides.population = {
    ...(task.overrides?.population ?? {}),
    initialPopulation: task.population,
  };
  overrides.schedule = {
    totalTicks: task.ticks,
    statsStride: 1,
    snapshotStride: task.ticks,
  };
  return mergeConfig(DEFAULT_RUN_CONFIG, overrides);
}

function createPolicyVerifyingSink(expectedPolicy) {
  let observedPolicy = null;
  return {
    sink: {
      onInitialSnapshot() {},
      onTickSettled({ decisions }) {
        for (const d of decisions) {
          if (observedPolicy === null) {
            observedPolicy = d.policyVersion;
          } else if (d.policyVersion !== observedPolicy) {
            throw new Error(`策略漂移：期望 ${observedPolicy}，收到 ${d.policyVersion}`);
          }
          if (d.policyVersion !== expectedPolicy) {
            throw new Error(`策略校验失败：期望 ${expectedPolicy}，实际执行 ${d.policyVersion}`);
          }
        }
      },
      onFinalState() {},
    },
    observedPolicy: () => observedPolicy,
  };
}

function coarseShares(counts, classCount) {
  const out = [0, 0, 0, 0, 0];
  let total = 0;
  for (const value of counts) total += value;
  if (total <= 0) return out;
  for (let i = 0; i < classCount; i += 1) {
    const bin = Math.min(4, Math.floor((i * 5) / Math.max(1, classCount)));
    out[bin] += (counts[i] ?? 0) / total;
  }
  return out;
}

function featuresFromStats(stats, classCount = 5) {
  const rows = stats.slice(-365);
  if (rows.length === 0) return null;
  const vec = new Array(11).fill(0);
  for (const row of rows) {
    const shares = coarseShares(row.classCounts, classCount);
    for (let c = 0; c < 5; c += 1) vec[c] += shares[c] / rows.length;
    vec[5] += row.gini / rows.length;
    vec[6] += row.topWealthShare / rows.length;
    vec[7] += row.mUp / rows.length;
    vec[8] += row.mDown / rows.length;
    vec[9] += row.segregation / rows.length;
    vec[10] += row.openness / rows.length;
  }
  return vec;
}

function windowFeatures(report, classCount = 5) {
  const window = report.windows.find((w) => w.label === 'w3') ?? report.windows.at(-1);
  if (!window || window.missingTicks > 0 || window.classShares.length === 0) return null;
  const vec = new Array(11).fill(0);
  const shares = coarseShares(window.classShares, classCount);
  for (let c = 0; c < 5; c += 1) vec[c] = shares[c];
  vec[5] = window.gini;
  vec[6] = window.topWealthShare;
  vec[7] = window.mUp;
  vec[8] = window.mDown;
  vec[9] = window.segregation;
  vec[10] = window.openness;
  return vec;
}

function runSingleTask(task) {
  const config = buildConfig(task);
  const policy = task.policy ?? 'mock-weighted-v1';
  const verifier = createPolicyVerifyingSink(policy);
  const out = runSingle(config, asSeed(task.seed), {
    policy,
    artifactSink: verifier.sink,
  });
  return {
    key: taskKey(task),
    expId: task.expId,
    kind: 'single',
    policy,
    observedPolicy: verifier.observedPolicy(),
    cellKey: task.cellKey,
    seed: task.seed,
    ticks: task.ticks,
    population: task.population,
    variant: task.variant ?? task.cellKey,
    extinct: out.report.extinct,
    features: featuresFromStats(out.stats, config.population.classCount),
    configHash: computeConfigHash(config),
  };
}

function runPairTask(task) {
  const config = buildConfig(task);
  const policy = task.policy ?? 'mock-weighted-v1';
  const pair = runPerturbationPair(config, asSeed(task.seed), {
    policy,
    checkpointTick: 365,
    declared: { kind: 'wealth_absolute', delta: task.magnitude },
  });
  const classCount = config.population.classCount;
  return {
    key: taskKey(task),
    expId: task.expId,
    kind: 'pair',
    policy,
    cellKey: task.cellKey,
    regimeKey: task.regimeKey,
    magnitude: task.magnitude,
    seed: task.seed,
    ticks: task.ticks,
    population: task.population,
    invalid: pair.invalid,
    firstDivergenceTick: pair.firstDivergenceTick,
    baseline: windowFeatures(pair.baseline.report, classCount),
    treatment: pair.treatment ? windowFeatures(pair.treatment.report, classCount) : null,
    configHash: computeConfigHash(config),
  };
}

if (!isMainThread) {
  const { tasks } = workerData;
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    const result =
      task.kind === 'pair' || task.kind === 'pert' ? runPairTask(task) : runSingleTask(task);
    persistPart(task, result);
    process.stderr.write(
      `[r5] ${task.expId} ${i + 1}/${tasks.length} ${task.cellKey} ${task.seed}\n`,
    );
  }
  parentPort.postMessage({ done: tasks.length });
}

function designFor(exp) {
  const cells = cellsFor(exp).map((cell) => ({
    key: cell.key,
    variant: cell.variant ?? null,
    policy: cell.policy ?? 'mock-weighted-v1',
    ticks: cell.ticks ?? null,
    magnitude: cell.magnitude ?? null,
    overrides: cellOverrides(cell),
  }));
  return {
    schemaVersion: 'r5-prereg-v2',
    experimentId: exp.id,
    rulesVersion: RULES_VERSION,
    defaultPolicy: 'mock-weighted-v1',
    analysis: exp.analysis,
    kind: exp.kind ?? 'single',
    population: exp.population,
    ticks: exp.ticks,
    seeds: exp.seeds,
    followup: exp.followup ?? null,
    groupBy: exp.groupBy,
    cells,
    gate: gateFor(exp),
  };
}

function cellOverrides(cell) {
  if (cell.overrides !== undefined) return cell.overrides;
  return {
    ...(cell.population ? { population: cell.population } : {}),
    ...(cell.opportunity ? { opportunity: cell.opportunity } : {}),
    ...(cell.lifespan ? { lifespan: cell.lifespan } : {}),
    ...(cell.need ? { need: cell.need } : {}),
    ...(cell.ascent ? { ascent: cell.ascent } : {}),
    ...(cell.decision ? { decision: cell.decision } : {}),
  };
}

function gateFor(exp) {
  if (exp.analysis === 'pert') {
    return { absorbedRate: 0.95, tvLimit: 0.1 };
  }
  return {
    k3MinCluster: 5,
    ariMedian: 0.7,
    silhouette: 0.35,
    temporal: 0.8,
    structuralTv: 0.1,
  };
}

function freezeExperiment(exp) {
  const design = designFor(exp);
  const designHash = hashValue(HASH_DOMAINS.preregistration, design);
  mkdirSync(expDir(exp.id), { recursive: true });
  const path = `${expDir(exp.id)}/prereg.json`;
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8'));
    if (existing.designHash !== designHash) {
      throw new Error(`${path} 已存在且设计 hash 不一致；不得改写预注册`);
    }
    return { design, designHash, path, existed: true };
  }
  writeFileSync(
    path,
    `${JSON.stringify({ schemaVersion: 'r5-prereg-v2', designHash, design }, null, 2)}\n`,
    'utf8',
  );
  return { design, designHash, path, existed: false };
}

function verifyPrereg(exp) {
  const frozen = freezeExperiment(exp);
  return frozen;
}

function taskOverrides(exp, cell) {
  return cellOverrides(cell);
}

function generateTasks(exp) {
  const tasks = [];
  const cells = cellsFor(exp);
  for (const cell of cells) {
    const ticks = cell.ticks ?? exp.ticks;
    for (const seed of exp.seeds) {
      tasks.push({
        expId: exp.id,
        kind: exp.kind ?? 'single',
        cellKey: cell.key,
        variant: cell.variant ?? cell.key,
        regimeKey: cell.regimeKey,
        magnitude: cell.magnitude,
        population: exp.population,
        ticks,
        seed,
        policy: cell.policy,
        overrides: taskOverrides(exp, cell),
      });
    }
  }
  if (exp.followup !== undefined) {
    for (const cell of cells) {
      for (const seed of exp.followup.seeds) {
        tasks.push({
          expId: exp.id,
          kind: 'single',
          cellKey: cell.key,
          variant: cell.variant ?? cell.key,
          population: exp.population,
          ticks: exp.followup.ticks,
          seed,
          overrides: taskOverrides(exp, cell),
        });
      }
    }
  }
  return tasks;
}

function chooseWorkers(population) {
  const env = Number(process.env['R5_WORKERS'] ?? '');
  if (Number.isInteger(env) && env > 0) return env;
  const byPopulation = population <= 200 ? 4 : population <= 1000 ? 2 : 1;
  return Math.max(1, Math.min(byPopulation, availableParallelism()));
}

function memAvailableKb() {
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+) kB/m.exec(info);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMemory(workers, population) {
  const perWorkerKb = population <= 200 ? 500_000 : population <= 1000 ? 1_500_000 : 4_500_000;
  const needKb = workers * perWorkerKb + 800_000;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (memAvailableKb() >= needKb) return;
    process.stderr.write(
      `[r5] 内存不足：available=${Math.round(memAvailableKb() / 1024)}MB，` +
        `需要≈${Math.round(needKb / 1024)}MB，等待 60s\n`,
    );
    await sleep(60_000);
  }
  throw new Error('等待内存超时；请降低 R5_WORKERS 后重启');
}

async function runTasks(exp, tasks) {
  const workers = chooseWorkers(exp.population);
  await waitForMemory(workers, exp.population);
  const buckets = Array.from({ length: workers }, () => []);
  tasks.forEach((task, idx) => buckets[idx % workers].push(task));
  const selfPath = fileURLToPath(import.meta.url);
  await Promise.all(
    buckets.map(
      (chunk) =>
        new Promise((resolve, reject) => {
          if (chunk.length === 0) {
            resolve({ done: 0 });
            return;
          }
          const worker = new Worker(selfPath, { workerData: { tasks: chunk } });
          worker.on('message', resolve);
          worker.on('error', reject);
          worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`r5 worker exited with code ${code}`));
          });
        }),
    ),
  );
}

function tv(a, b) {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / 2;
}

function meanVector(rows) {
  const dim = rows[0].length;
  const out = new Array(dim).fill(0);
  for (const row of rows) for (let i = 0; i < dim; i += 1) out[i] += row[i] / rows.length;
  return out;
}

function groupResults(exp, results) {
  const groups = new Map();
  for (const result of results) {
    if (result.kind === 'pair') continue;
    const key =
      exp.groupBy === 'variant'
        ? (result.variant ?? 'all')
        : exp.groupBy === 'ticks'
          ? `T${result.ticks}`
          : 'all';
    const list = groups.get(key) ?? [];
    list.push(result);
    groups.set(key, list);
  }
  return groups;
}

function clusterSummary(rows, k) {
  const points = rows.map((row) => row.features).filter((f) => Array.isArray(f));
  if (points.length < k) return null;
  const std = fitStandardizer(points);
  const z = points.map((point) => std.standardize(point));
  const labels = wardCluster(z, k);
  const sizes = Array.from({ length: k }, (_, c) => labels.filter((l) => l === c).length);
  const silhouette = silhouetteScore(z, labels);
  const aris = [];
  for (let s = 0; s < 20; s += 1) {
    const order = seededShuffle(points.length, 20261122 + k * 997 + s * 7919);
    aris.push(bisectStability(z, k, [order], 0.7).ari);
  }
  aris.sort((a, b) => a - b);
  const ariMedian =
    aris.length % 2 === 0
      ? (aris[aris.length / 2 - 1] + aris[aris.length / 2]) / 2
      : aris[Math.floor(aris.length / 2)];
  const composition = Array.from({ length: k }, () => ({}));
  rows.forEach((row, idx) => {
    const c = labels[idx];
    composition[c][row.cellKey] = (composition[c][row.cellKey] ?? 0) + 1;
  });
  return {
    n: points.length,
    clusterSizes: sizes,
    ariMedian: Number(ariMedian.toFixed(4)),
    ariMin: Number(aris[0].toFixed(4)),
    silhouette: Number(silhouette.toFixed(4)),
    composition,
  };
}

function cellMeans(rows) {
  const byCell = new Map();
  for (const row of rows) {
    const list = byCell.get(row.cellKey) ?? [];
    list.push(row);
    byCell.set(row.cellKey, list);
  }
  const out = {};
  for (const [cellKey, list] of byCell) {
    const feats = list.map((row) => row.features).filter(Boolean);
    if (feats.length === 0) continue;
    const mean = meanVector(feats);
    out[cellKey] = {
      n: feats.length,
      P: mean.slice(0, 5).map((v) => Number(v.toFixed(4))),
      G: Number(mean[5].toFixed(4)),
      topWealth: Number(mean[6].toFixed(4)),
      Mup: Number(mean[7].toFixed(4)),
      Mdown: Number(mean[8].toFixed(4)),
      S: Number(mean[9].toFixed(4)),
      O: Number(mean[10].toFixed(4)),
    };
  }
  return out;
}

function analyzeCluster(exp, results) {
  const groups = groupResults(exp, results);
  const out = { experimentId: exp.id, analysis: 'cluster', groups: {} };
  for (const [group, rows] of groups) {
    const k2 = clusterSummary(rows, 2);
    const k3 = clusterSummary(rows, 3);
    const cells = cellMeans(rows);
    const entry = { n: rows.length, cells, k2, k3 };
    if (exp.id === 'r5-phase-n200') {
      const tvAdjacent = [];
      const keys = Object.keys(cells);
      for (let i = 0; i < keys.length; i += 1) {
        for (let j = i + 1; j < keys.length; j += 1) {
          const a = keys[i];
          const b = keys[j];
          const sameShare = a.split('-')[0] === b.split('-')[0];
          if (!sameShare) continue;
          const wa = Number(a.split('-W')[1]);
          const wb = Number(b.split('-W')[1]);
          if (Math.abs(wa - wb) !== 15) continue;
          tvAdjacent.push({
            cells: [a, b],
            tvP: Number(tv(cells[a].P, cells[b].P).toFixed(4)),
          });
        }
      }
      entry.tvAdjacent = tvAdjacent;
    }
    out.groups[group] = entry;
  }
  return out;
}

function analyzeGenerational(exp, results) {
  const out = analyzeCluster(exp, results);
  out.analysis = 'generational';
  const baseGroup = out.groups.T10950 ?? out.groups[Object.keys(out.groups)[0]] ?? {};
  const cells = baseGroup.cells ?? {};
  const reference = cells['G1-replace'];
  if (reference !== undefined) {
    const tvByCell = {};
    for (const [cellKey, cell] of Object.entries(cells)) {
      tvByCell[cellKey] = Number(tv(reference.P, cell.P).toFixed(4));
    }
    out.tvVsReplace = tvByCell;
    out.mechanismExplained = Object.entries(tvByCell)
      .filter(([key]) => key !== 'G1-replace')
      .some(([, value]) => value >= 0.1);
  }
  return out;
}

function dMetric(a, b) {
  const tvP = tv([a[0], a[1], a[2], a[3], a[4]], [b[0], b[1], b[2], b[3], b[4]]);
  return (
    0.3 * Math.abs(a[5] - b[5]) +
    0.25 * tvP +
    0.2 * Math.abs(a[7] - b[7]) +
    0.15 * Math.abs(a[9] - b[9]) +
    0.1 * Math.abs(a[10] - b[10])
  );
}

function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function analyzePert(exp, results) {
  const groups = new Map();
  for (const row of results) {
    if (row.kind !== 'pair') continue;
    const key = `${row.regimeKey}/M${row.magnitude}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const out = { experimentId: exp.id, analysis: 'pert', groups: {} };
  for (const [key, rows] of groups) {
    const valid = rows.filter((r) => !r.invalid && r.baseline && r.treatment);
    const baselineVectors = valid.map((r) => r.baseline);
    const ds = [];
    for (let i = 0; i < baselineVectors.length; i += 1) {
      for (let j = i + 1; j < baselineVectors.length; j += 1) {
        ds.push(dMetric(baselineVectors[i], baselineVectors[j]));
      }
    }
    const d95 = quantile(ds, 0.95);
    const diffs = valid.map((r) => ({
      d: dMetric(r.baseline, r.treatment),
      tvP: tv(r.baseline.slice(0, 5), r.treatment.slice(0, 5)),
    }));
    const absorbed = diffs.filter((d) => d.d <= d95 && d.tvP < 0.1).length;
    out.groups[key] = {
      pairs: rows.length,
      valid: valid.length,
      baselineD95: Number(d95.toFixed(4)),
      medianD: Number(
        quantile(
          diffs.map((d) => d.d),
          0.5,
        ).toFixed(6),
      ),
      maxD: Number(Math.max(0, ...diffs.map((d) => d.d)).toFixed(6)),
      medianTvP: Number(
        quantile(
          diffs.map((d) => d.tvP),
          0.5,
        ).toFixed(6),
      ),
      absorbedRate: valid.length === 0 ? null : Number((absorbed / valid.length).toFixed(4)),
    };
  }
  return out;
}

function analyzeExperiment(exp) {
  const parts = loadParts(exp.id);
  const results = [...parts.values()];
  let analysis;
  if (exp.analysis === 'pert') analysis = analyzePert(exp, results);
  else if (exp.analysis === 'generational') analysis = analyzeGenerational(exp, results);
  else analysis = analyzeCluster(exp, results);
  writeFileSync(`${expDir(exp.id)}/result.json`, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
  return analysis;
}

function writeRaw(exp) {
  const parts = loadParts(exp.id);
  const runs = [...parts.values()];
  writeFileSync(
    `${expDir(exp.id)}/raw.json`,
    `${JSON.stringify({ experimentId: exp.id, runs }, null, 2)}\n`,
    'utf8',
  );
  return runs.length;
}

async function runExperiment(exp) {
  verifyPrereg(exp);
  const tasks = generateTasks(exp);
  const parts = loadParts(exp.id);
  const pending = tasks.filter((task) => !parts.has(taskKey(task)));
  process.stderr.write(
    `[r5] ${exp.id}: ${tasks.length} tasks, ${tasks.length - pending.length} done, ` +
      `${pending.length} remaining, workers=${chooseWorkers(exp.population)}\n`,
  );
  if (pending.length > 0) {
    await runTasks(exp, pending);
  }
  const count = writeRaw(exp);
  if (count !== tasks.length) {
    throw new Error(`${exp.id} 结果不完整：${count}/${tasks.length}`);
  }
  const analysis = analyzeExperiment(exp);
  process.stderr.write(`[r5] ${exp.id} 完成（${count} tasks）\n`);
  return analysis;
}

const QUEUE = [
  'r5-phase-n200',
  'r5-robust-c',
  'r5-robust-policy',
  'r5-horizon',
  'r5-scale-n200',
  'r5-pert-n200',
  'r5-gen-n1000',
  'r5-scale-n1000',
  'r5-pert-n1000',
  'r5-scale-n3000',
];

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--freeze')) {
    for (const exp of EXPERIMENTS) {
      const frozen = freezeExperiment(exp);
      console.log(
        `${exp.id}: ${frozen.existed ? '已存在' : '已写入'} ${frozen.designHash.slice(0, 20)}…`,
      );
    }
    return;
  }
  if (args.includes('--status')) {
    for (const exp of EXPERIMENTS) {
      const parts = loadParts(exp.id);
      const tasks = generateTasks(exp);
      const hasResult = existsSync(`${expDir(exp.id)}/result.json`);
      console.log(
        `${exp.id}: ${parts.size}/${tasks.length} parts${hasResult ? ' result=yes' : ''}`,
      );
    }
    return;
  }
  if (args.includes('--validate')) {
    for (const exp of EXPERIMENTS) {
      const cells = cellsFor(exp);
      for (const cell of cells) {
        const ticks = cell.ticks ?? exp.ticks;
        const task = {
          expId: exp.id,
          kind: exp.kind ?? 'single',
          cellKey: cell.key,
          variant: cell.variant ?? cell.key,
          regimeKey: cell.regimeKey,
          magnitude: cell.magnitude,
          population: exp.population,
          ticks,
          seed: exp.seeds[0],
          policy: cell.policy,
          overrides: taskOverrides(exp, cell),
        };
        const result = validateRunConfig(buildConfig(task));
        if (!result.ok) {
          console.error(`${exp.id}/${cell.key}: INVALID`);
          for (const issue of result.issues) {
            console.error(`  ${issue.path} ${issue.code} ${issue.message}`);
          }
          process.exitCode = 1;
        }
      }
      console.log(`${exp.id}: ${cells.length} cells validated`);
    }
    return;
  }
  const analyzeIndex = args.indexOf('--analyze');
  if (analyzeIndex >= 0) {
    const expId = args[analyzeIndex + 1];
    const exp = EXPERIMENT_BY_ID.get(expId);
    if (!exp) throw new Error(`未知实验：${expId}`);
    const analysis = analyzeExperiment(exp);
    console.log(JSON.stringify(analysis, null, 2));
    return;
  }
  const runIndex = args.indexOf('--run');
  if (runIndex >= 0) {
    const only = args[runIndex + 1];
    const queue = only ? [only] : QUEUE;
    for (const expId of queue) {
      const exp = EXPERIMENT_BY_ID.get(expId);
      if (!exp) throw new Error(`未知实验：${expId}`);
      if (existsSync(`${expDir(exp.id)}/result.json`) && !args.includes('--force')) {
        console.log(`${exp.id}: 已完成，跳过`);
        continue;
      }
      await runExperiment(exp);
    }
    return;
  }
  throw new Error('用法：--freeze | --run [expId] | --analyze <expId> | --status');
}

if (isMainThread) {
  main().catch((err) => {
    console.error(`r5-campaign 失败：${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
}

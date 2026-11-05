#!/usr/bin/env node
/**
 * P6-03：微扰克隆与正常波动区间（01 §9、07 §7；changes/0050）。
 *
 * 用法：
 *   node scripts/p6-perturbation.mjs --freeze   # 冻结预注册（manifest JSON + hash → out/）
 *   node scripts/p6-perturbation.mjs --run      # 60 个 (regime, seed) 任务（ledger 断点续跑）
 *   node scripts/p6-perturbation.mjs --slim     # 生成入库瘦身产物
 *   node scripts/p6-perturbation.mjs --analyze  # 离线聚合（只读、确定性）
 *
 * 每个任务：检查点跑到 365 → 克隆 → baseline 续跑 + 10 个扰动 cell 续跑。
 * stdout：纯 JSON；进度走 stderr。结论只标 exploratory，不构成确认/校准。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import {
  buildP6PerturbationManifest,
  computeP6PerturbationHash,
  firstTrailingMeanDeviationTick,
  P6_PERTURBATION_BUDGET,
  P6_PERTURBATION_CHECKPOINT,
  P6_PERTURBATION_POPULATION,
  P6_PERTURBATION_TICKS,
  perTickTvSeries,
  summarizeEventFlips,
  summarizePerturbationAnalysis,
  tickClassShares,
} from '../dist/runner/p6-perturbation.js';
import { buildCellConfig } from '../dist/runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import {
  applyParamPerturbation,
  applyWealthPerturbation,
  firstDivergenceTick,
} from '../dist/runner/perturbation.js';
import { computeConfigHash, computeParamsHash } from '../dist/core/config/hash.js';
import { computeAuthoritativeStateHash } from '../dist/core/hash/state-hash.js';
import { captureSnapshot, restoreSnapshot } from '../dist/core/replay/snapshot.js';
import { dScore, pairedDiff } from '../dist/runner/p6-analysis.js';

const args = process.argv.slice(2);
const outDir = 'out';
mkdirSync(outDir, { recursive: true });

const preregPath = `${outDir}/p6-perturbation-prereg.json`;
const ledgerPath = `${outDir}/p6-perturbation-ledger.json`;
const slimPath = `${outDir}/p6-perturbation-slim.json`;
const analysisPath = `${outDir}/p6-perturbation-analysis.json`;

function log(message) {
  process.stderr.write(`[p6-perturbation] ${message}\n`);
}

function experimentId() {
  return `p6-perturbation-${computeP6PerturbationHash().slice(7, 15)}`;
}

function writeJsonAtomic(path, payload, pretty = true) {
  const body = pretty ? `${JSON.stringify(payload, null, 2)}\n` : JSON.stringify(payload);
  const temp = `${path}.tmp`;
  writeFileSync(temp, body, 'utf8');
  renameSync(temp, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function freeze() {
  const manifest = buildP6PerturbationManifest();
  const payload = {
    experimentId: experimentId(),
    preregistrationHash: computeP6PerturbationHash(),
    manifest,
  };
  writeJsonAtomic(preregPath, payload);
  log(`冻结 ${preregPath} hash=${payload.preregistrationHash}`);
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 'p6-perturbation-freeze-v1',
      experimentId: payload.experimentId,
      preregistrationHash: payload.preregistrationHash,
      populationSize: P6_PERTURBATION_POPULATION,
      checkpointTick: P6_PERTURBATION_CHECKPOINT,
      seeds: manifest.seeds.length,
      regimes: manifest.regimes.length,
      cells: manifest.cells.length,
      runs: manifest.regimes.length * manifest.seeds.length * (2 + manifest.cells.length),
      budgets: P6_PERTURBATION_BUDGET,
    })}\n`,
  );
}

function readFrozen() {
  if (!existsSync(preregPath)) {
    log(`缺少预注册产物 ${preregPath}；先执行 --freeze`);
    process.exit(2);
  }
  const frozen = readJson(preregPath);
  if (frozen.preregistrationHash !== computeP6PerturbationHash()) {
    log(
      `预注册哈希不一致：${frozen.preregistrationHash} ≠ ${computeP6PerturbationHash()}；设计变更必须新 experimentId`,
    );
    process.exit(2);
  }
  return frozen;
}

function windowOf(report) {
  const window = report.windows.find((entry) => entry.label === 'w1');
  if (window === undefined) {
    throw new Error('run 报告缺少 w1 窗口');
  }
  return {
    classShares: window.classShares,
    gini: window.gini,
    mUp: window.mUp,
    mDown: window.mDown,
    segregation: window.segregation,
    openness: window.openness,
    fallbackRate: window.fallbackRate,
    tickCount: window.tickCount,
    observedTicks: window.observedTicks,
    missingTicks: window.missingTicks,
  };
}

/** 从同一检查点快照克隆 treatment 状态；只施加声明扰动（07 §7.2）。 */
function prepareTreatment(snapshot, checkpointHash, config, cell) {
  const restored = restoreSnapshot(snapshot);
  if (computeAuthoritativeStateHash(restored) !== checkpointHash) {
    throw new Error('检查点快照 round-trip 哈希不一致；不得继续微扰配对');
  }
  if (cell.kind === 'control') {
    return { state: restored, config, applied: true, invalidReason: null };
  }
  if (cell.kind === 'wealth_absolute') {
    const result = applyWealthPerturbation(restored, cell.delta);
    return {
      state: result.applied ? result.treatment : restored,
      config,
      applied: result.applied,
      invalidReason: result.applied
        ? null
        : 'wealth_absolute 扰动被序列化精度吸收（round-trip 后权威哈希不变，07 §7.4）',
    };
  }
  const result = applyParamPerturbation(config, cell.field, cell.delta);
  if (result.changedPaths.length !== 1 || result.changedPaths[0] !== cell.field) {
    throw new Error(
      `param 扰动实际改变了 ${result.changedPaths.length} 个叶子路径（${result.changedPaths.join(', ')}），与声明 ${cell.field} 不符`,
    );
  }
  if (!result.applied) {
    return {
      state: restored,
      config,
      applied: false,
      invalidReason: 'param 扰动被序列化精度吸收（round-trip 后 configHash 不变，07 §7.4）',
    };
  }
  const treatmentConfig = result.treatment;
  return {
    state: {
      ...restored,
      config: treatmentConfig,
      configHash: computeConfigHash(treatmentConfig),
      paramsHash: computeParamsHash(treatmentConfig),
    },
    config: treatmentConfig,
    applied: true,
    invalidReason: null,
  };
}

function runTask(manifest, regime, seed) {
  const config = buildCellConfig(
    { cellKey: regime.regimeKey, overrides: regime.overrides },
    P6_PERTURBATION_POPULATION,
    P6_PERTURBATION_TICKS,
  );
  const policy = manifest.policyVersion;
  const checkpoint = runSingle(config, seed, {
    policy,
    maxTicks: P6_PERTURBATION_CHECKPOINT,
  });
  const checkpointHash = computeAuthoritativeStateHash(checkpoint.finalState);
  const snapshot = captureSnapshot(checkpoint.finalState);

  const baseline = runSingle(config, seed, {
    policy,
    initialState: restoreSnapshot(snapshot),
  });
  const baselineWindow = windowOf(baseline.report);
  const baselineRecord = {
    regimeKey: regime.regimeKey,
    seed,
    window: baselineWindow,
    tickShares: tickClassShares(baseline.stats),
  };

  const pairs = manifest.cells.map((cell) => {
    const prepared = prepareTreatment(snapshot, checkpointHash, config, cell);
    if (!prepared.applied) {
      return {
        regimeKey: regime.regimeKey,
        seed,
        cellKey: cell.cellKey,
        kind: cell.kind,
        field: cell.field,
        delta: cell.delta,
        applied: false,
        invalidReason: prepared.invalidReason,
        checkpointStateHash: checkpointHash,
        baselineFinalStateHash: baseline.report.finalStateHash,
        treatmentFinalStateHash: null,
        firstDivergenceTick: null,
        firstEventFlipTick: null,
        eventFlipTicks: 0,
        flippedEventCount: 0,
        firstStructuralDeviationTick: null,
        windowTv: 0,
        windowD: 0,
        window: baselineWindow,
        extinct: false,
        fallbackRate: null,
        aliveAtEnd: baseline.report.aliveAtEnd,
      };
    }
    const treatment = runSingle(prepared.config, seed, {
      policy,
      initialState: prepared.state,
    });
    const treatmentWindow = windowOf(treatment.report);
    const diff = pairedDiff(treatmentWindow, baselineWindow);
    const events = summarizeEventFlips(
      baseline.stats,
      baseline.flowsByTick,
      treatment.stats,
      treatment.flowsByTick,
    );
    if (cell.kind === 'control') {
      if (
        treatment.report.finalStateHash !== baseline.report.finalStateHash ||
        firstDivergenceTick(baseline.stats, treatment.stats) !== null
      ) {
        throw new Error(
          `control 克隆不一致（${regime.regimeKey}/${seed}）：检查点克隆或续跑不是确定性的`,
        );
      }
    }
    return {
      regimeKey: regime.regimeKey,
      seed,
      cellKey: cell.cellKey,
      kind: cell.kind,
      field: cell.field,
      delta: cell.delta,
      applied: true,
      invalidReason: null,
      checkpointStateHash: checkpointHash,
      baselineFinalStateHash: baseline.report.finalStateHash,
      treatmentFinalStateHash: treatment.report.finalStateHash,
      firstDivergenceTick: firstDivergenceTick(baseline.stats, treatment.stats),
      firstEventFlipTick: events.firstEventFlipTick,
      eventFlipTicks: events.eventFlipTicks,
      flippedEventCount: events.flippedEventCount,
      firstStructuralDeviationTick: firstTrailingMeanDeviationTick(
        perTickTvSeries(baseline.stats, treatment.stats),
        manifest.differenceThresholds.tv,
        30,
      ),
      windowTv: diff.tv,
      windowD: dScore(diff),
      window: treatmentWindow,
      extinct: treatment.report.extinct,
      fallbackRate: treatmentWindow.fallbackRate,
      aliveAtEnd: treatment.report.aliveAtEnd,
    };
  });

  return {
    regimeKey: regime.regimeKey,
    seed,
    configHash: computeConfigHash(config),
    checkpointTick: P6_PERTURBATION_CHECKPOINT,
    checkpointStateHash: checkpointHash,
    baseline: baselineRecord,
    pairs,
  };
}

function loadLedger(frozen) {
  if (!existsSync(ledgerPath)) {
    return { schemaVersion: 'p6-perturbation-ledger-v1', tasks: {} };
  }
  const ledger = readJson(ledgerPath);
  if (ledger.preregistrationHash !== frozen.preregistrationHash) {
    log('ledger 的 preregistrationHash 与当前冻结不一致；拒绝复用旧批次');
    process.exit(2);
  }
  return ledger;
}

function run() {
  const frozen = readFrozen();
  const manifest = frozen.manifest;
  const ledger = loadLedger(frozen);
  ledger.schemaVersion = 'p6-perturbation-ledger-v1';
  ledger.experimentId = frozen.experimentId;
  ledger.preregistrationHash = frozen.preregistrationHash;
  ledger.tasks ??= {};

  const startedAt = performance.now();
  const total = manifest.regimes.length * manifest.seeds.length;
  let completed = 0;
  let executed = 0;
  for (const regime of manifest.regimes) {
    for (const seed of manifest.seeds) {
      const key = `${regime.regimeKey}|${seed}`;
      completed += 1;
      if (ledger.tasks[key] !== undefined) {
        log(`${completed}/${total} resumed ${key}`);
        continue;
      }
      const task = runTask(manifest, regime, seed);
      ledger.tasks[key] = task;
      writeJsonAtomic(ledgerPath, ledger);
      executed += 1;
      log(`${completed}/${total} ok ${key} pairs=${task.pairs.length}`);
    }
  }
  const wallMinutes = (performance.now() - startedAt) / 60000;
  const runs = total * (2 + manifest.cells.length);
  const expectedKeys = manifest.regimes.flatMap((regime) =>
    manifest.seeds.map((seed) => `${regime.regimeKey}|${seed}`),
  );
  const missing = expectedKeys.filter((key) => ledger.tasks[key] === undefined);
  if (missing.length > 0) {
    log(`任务不完整：缺少 ${missing.length} 个，例如 ${missing[0]}`);
    process.exit(2);
  }
  if (runs > P6_PERTURBATION_BUDGET.maxRuns) {
    log(`超预算 maxRuns：${runs} > ${P6_PERTURBATION_BUDGET.maxRuns}`);
    process.exit(1);
  }
  if (wallMinutes > P6_PERTURBATION_BUDGET.maxWallMinutes) {
    log(
      `超预算 maxWallMinutes：${wallMinutes.toFixed(1)} > ${P6_PERTURBATION_BUDGET.maxWallMinutes}`,
    );
    process.exit(1);
  }
  log(
    `完成 ${Object.keys(ledger.tasks).length}/${total} 任务（本次执行 ${executed}）；wall ${wallMinutes.toFixed(1)} min`,
  );
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 'p6-perturbation-run-v1',
      experimentId: frozen.experimentId,
      preregistrationHash: frozen.preregistrationHash,
      tasks: Object.keys(ledger.tasks).length,
      expectedTasks: total,
      runs,
      wallMinutes,
      withinBudget: true,
    })}\n`,
  );
}

function slim() {
  const frozen = readFrozen();
  if (!existsSync(ledgerPath)) {
    log(`缺少 ${ledgerPath}；先执行 --run`);
    process.exit(2);
  }
  const ledger = readJson(ledgerPath);
  const tasks = Object.values(ledger.tasks);
  const expected = frozen.manifest.regimes.length * frozen.manifest.seeds.length;
  const expectedKeys = frozen.manifest.regimes.flatMap((regime) =>
    frozen.manifest.seeds.map((seed) => `${regime.regimeKey}|${seed}`),
  );
  const missing = expectedKeys.filter((key) => ledger.tasks[key] === undefined);
  if (tasks.length !== expected || missing.length > 0) {
    log(`任务不完整：${tasks.length}/${expected}，缺少 ${missing.length} 个；不得生成入库产物`);
    process.exit(2);
  }
  const payload = {
    schemaVersion: 'p6-perturbation-slim-v1',
    experimentId: frozen.experimentId,
    preregistrationHash: frozen.preregistrationHash,
    seeds: frozen.manifest.seeds,
    regimes: frozen.manifest.regimes.map((regime) => ({
      regimeKey: regime.regimeKey,
      design: regime.design,
      changedPaths: regime.changedPaths,
      fullConfigHash: regime.fullConfigHash,
    })),
    cells: frozen.manifest.cells,
    budgets: frozen.manifest.budgets,
    baseline: tasks.map((task) => task.baseline),
    pairs: tasks.flatMap((task) => task.pairs),
  };
  // 入库产物按紧凑 JSON 写，避免超出 artifacts §1 的 5 MiB 上限。
  writeJsonAtomic(slimPath, payload, false);
  const sizeKiB = Buffer.byteLength(JSON.stringify(payload)) / 1024;
  log(
    `slim ${slimPath} ${sizeKiB.toFixed(0)} KiB tasks=${tasks.length} pairs=${payload.pairs.length}`,
  );
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 'p6-perturbation-slim-v1',
      path: slimPath,
      tasks: tasks.length,
      pairs: payload.pairs.length,
      sizeKiB,
    })}\n`,
  );
}

function analyze() {
  const frozen = readFrozen();
  if (!existsSync(slimPath)) {
    log(`缺少 ${slimPath}；先执行 --slim`);
    process.exit(2);
  }
  const slimData = readJson(slimPath);
  if (slimData.preregistrationHash !== frozen.preregistrationHash) {
    log('slim 的 preregistrationHash 与当前冻结不一致；拒绝分析');
    process.exit(2);
  }
  const analysis = summarizePerturbationAnalysis(
    frozen.manifest,
    slimData.baseline,
    slimData.pairs,
  );
  const payload = {
    ...analysis,
    experimentId: frozen.experimentId,
    preregistrationHash: frozen.preregistrationHash,
    populationSize: frozen.manifest.populationSize,
    checkpointTick: frozen.manifest.checkpointTick,
  };
  writeJsonAtomic(analysisPath, payload);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const mode = args.includes('--freeze')
  ? 'freeze'
  : args.includes('--run')
    ? 'run'
    : args.includes('--slim')
      ? 'slim'
      : args.includes('--analyze')
        ? 'analyze'
        : null;
if (mode === null) {
  log('用法：--freeze | --run | --slim | --analyze');
  process.exit(2);
}

if (mode === 'freeze') {
  freeze();
} else if (mode === 'run') {
  run();
} else if (mode === 'slim') {
  slim();
} else {
  analyze();
}

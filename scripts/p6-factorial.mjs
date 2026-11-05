#!/usr/bin/env node
/**
 * P6-02：多参数 factorial 探索执行与分析（01 §9、07 §6.3；changes/0045）。
 *
 * 用法：
 *   node scripts/p6-factorial.mjs --freeze    # 冻结预注册（manifest JSON + hash → out/）
 *   node scripts/p6-factorial.mjs --run       # 执行 32 cell × 30 seed（ledger 断点续跑）
 *   node scripts/p6-factorial.mjs --slim      # 生成入库瘦身产物
 *   node scripts/p6-factorial.mjs --analyze   # 离线分析（只读、确定性）
 *
 * 预算 = P6_FACTORIAL_BUDGET（src/runner/p6-factorial.ts）。
 * stdout：纯 JSON；进度走 stderr。结论只标 exploratory，不构成确认/校准。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import {
  buildP6FactorialManifest,
  computeP6FactorialHash,
  P6_FACTORIAL_BASELINE_KEY,
  P6_FACTORIAL_BUDGET,
  P6_FACTORIAL_POPULATION,
  P6_FACTORIAL_SEEDS,
  P6_FACTORIAL_TICKS,
} from '../dist/runner/p6-factorial.js';
import { buildBaseConfig } from '../dist/runner/preregistration.js';
import { validateBatchManifest } from '../dist/runner/batch.js';
import { runBatch } from '../dist/runner/batch-cli.js';
import { nodeCheckpointHost } from '../dist/runner/checkpoint-fs.js';
import { evaluateStageA } from '../dist/runner/p6-analysis.js';

const args = process.argv.slice(2);
const outDir = 'out';
mkdirSync(outDir, { recursive: true });

const preregPath = `${outDir}/p6-factorial-prereg.json`;
const summaryPath = `${outDir}/p6-factorial-summary.json`;
const slimPath = `${outDir}/p6-factorial-slim.json`;
const ledgerPath = `${outDir}/p6-factorial-ledger.json`;

function log(message) {
  process.stderr.write(`[p6-factorial] ${message}\n`);
}

function experimentId() {
  return `p6-factorial-${computeP6FactorialHash().slice(7, 15)}`;
}

function freeze() {
  const manifest = buildP6FactorialManifest();
  const payload = {
    experimentId: experimentId(),
    preregistrationHash: computeP6FactorialHash(),
    manifest,
  };
  writeFileSync(preregPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  log(`冻结 ${preregPath} hash=${payload.preregistrationHash}`);
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 'p6-factorial-freeze-v1',
      experimentId: payload.experimentId,
      preregistrationHash: payload.preregistrationHash,
      populationSize: P6_FACTORIAL_POPULATION,
      seeds: P6_FACTORIAL_SEEDS.length,
      cells: manifest.cells.length,
      budgets: P6_FACTORIAL_BUDGET,
    })}\n`,
  );
}

function readFrozen() {
  if (!existsSync(preregPath)) {
    log(`缺少预注册产物 ${preregPath}；先执行 --freeze`);
    process.exit(2);
  }
  const frozen = JSON.parse(readFileSync(preregPath, 'utf8'));
  if (frozen.preregistrationHash !== computeP6FactorialHash()) {
    log(
      `预注册哈希不一致：${frozen.preregistrationHash} ≠ ${computeP6FactorialHash()}；设计变更必须新 experimentId`,
    );
    process.exit(2);
  }
  return frozen;
}

function batchManifestFor(prereg) {
  const baseConfig = buildBaseConfig(P6_FACTORIAL_POPULATION, P6_FACTORIAL_TICKS);
  return validateBatchManifest(
    {
      schemaVersion: 'batch-v1',
      rulesVersion: prereg.rulesVersion,
      engineVersion: prereg.engineVersion,
      populationSize: P6_FACTORIAL_POPULATION,
      totalTicks: P6_FACTORIAL_TICKS,
      policy: prereg.policyVersion,
      seeds: prereg.seeds,
      cells: prereg.cells.map((cell) => ({ cellKey: cell.cellKey, overrides: cell.overrides })),
    },
    baseConfig,
  );
}

async function run() {
  const frozen = readFrozen();
  const manifest = batchManifestFor(frozen.manifest);
  log(`开始 ${experimentId()} runs=${manifest.seeds.length * manifest.cells.length}`);

  const startedAt = performance.now();
  const summary = await runBatch(manifest, {
    baseConfig: buildBaseConfig(P6_FACTORIAL_POPULATION, P6_FACTORIAL_TICKS),
    ledger: { host: nodeCheckpointHost(), path: ledgerPath },
    onProgress: (progress) => {
      const status = progress.resumed ? 'resumed' : progress.ok ? 'ok' : 'FAILED';
      log(`${progress.index + 1}/${progress.total} ${status} ${progress.cellKey} ${progress.seed}`);
    },
  });
  const wallMinutes = (performance.now() - startedAt) / 60000;
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  if (summary.totals.due > P6_FACTORIAL_BUDGET.maxRuns) {
    log(`超预算 maxRuns：${summary.totals.due} > ${P6_FACTORIAL_BUDGET.maxRuns}`);
    process.exit(1);
  }
  if (wallMinutes > P6_FACTORIAL_BUDGET.maxWallMinutes) {
    log(`超预算 maxWallMinutes：${wallMinutes.toFixed(1)} > ${P6_FACTORIAL_BUDGET.maxWallMinutes}`);
    process.exit(1);
  }
  log(
    `完成 ${summary.totals.ok}/${summary.totals.due}（failed ${summary.totals.failed}）；wall ${wallMinutes.toFixed(1)} min`,
  );
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 'p6-factorial-run-v1',
      experimentId: experimentId(),
      preregistrationHash: frozen.preregistrationHash,
      totals: summary.totals,
      wallMinutes,
      withinBudget: true,
    })}\n`,
  );
}

function slim() {
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const runs = summary.runs.map((run) => {
    const w1 = run.report.windows.find((window) => window.label === 'w1');
    return {
      cellKey: run.cellKey,
      seed: run.seed,
      configHash: run.configHash,
      paramsHash: run.paramsHash,
      finalStateHash: run.report.finalStateHash,
      aliveAtEnd: run.report.aliveAtEnd,
      extinct: run.report.extinct,
      endReason: run.report.endReason,
      endTick: run.report.endTick,
      w1,
      w1Labels: run.report.labelsByWindow.w1 ?? [],
      w1Evidence: run.report.labelsEvidenceByWindow.w1 ?? {},
    };
  });
  const payload = {
    schemaVersion: 'p6-factorial-slim-v1',
    experimentId: experimentId(),
    preregistrationHash: computeP6FactorialHash(),
    batchManifestHash: summary.manifestHash,
    totals: summary.totals,
    runs,
  };
  writeFileSync(slimPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const sizeKiB = Buffer.byteLength(JSON.stringify(payload)) / 1024;
  log(`slim ${slimPath} ${sizeKiB.toFixed(0)} KiB runs=${runs.length}`);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 'p6-factorial-slim-v1', path: slimPath, runs: runs.length, sizeKiB })}\n`,
  );
}

function analyze() {
  const frozen = readFrozen();
  if (!existsSync(slimPath)) {
    log(`缺少 ${slimPath}；先执行 --slim`);
    process.exit(2);
  }
  const slimData = JSON.parse(readFileSync(slimPath, 'utf8'));
  const runs = slimData.runs.map((run) => ({
    cellKey: run.cellKey,
    seed: run.seed,
    extinct: run.extinct,
    w1: run.w1,
  }));
  const cellKeys = frozen.manifest.cells
    .map((cell) => cell.cellKey)
    .filter((cellKey) => cellKey !== P6_FACTORIAL_BASELINE_KEY);

  const cells = cellKeys.map((cellKey) => {
    const evaluation = evaluateStageA({
      populationSize: P6_FACTORIAL_POPULATION,
      cellKey,
      targetCellKey: cellKey,
      prereg: frozen.manifest,
      runs,
      totals: slimData.totals,
    });
    return {
      cellKey,
      design: frozen.manifest.cells.find((cell) => cell.cellKey === cellKey)?.design ?? null,
      changedPaths:
        frozen.manifest.cells.find((cell) => cell.cellKey === cellKey)?.changedPaths ?? [],
      tvMedian: evaluation.primary?.median ?? null,
      tvCi95: evaluation.primary?.ci95 ?? null,
      beyondBandRate: evaluation.beyondBandRate,
      pairedSeeds: evaluation.completeness.pairedSeeds,
      complete: evaluation.criteria.complete,
      exploratoryOnly: true,
    };
  });

  const result = {
    schemaVersion: 'p6-factorial-analysis-v1',
    isExperimentalEvidence: true,
    protocol: '07-strict-exploratory',
    primaryMetric: 'TV(P)',
    thresholds: { tv: frozen.manifest.differenceThresholds.tv },
    experimentId: experimentId(),
    preregistrationHash: frozen.preregistrationHash,
    populationSize: P6_FACTORIAL_POPULATION,
    totals: slimData.totals,
    claim:
      'P6-02 多参数探索：描述联合条件与稳定区的 TV(P) 差异；interaction 格点不得单轴归因，结果不构成确认或校准。',
    cells,
    // 结构变化较大的联合区域：TV 中位数最高的格点（仅用于下一轮细化取样，不是确认）。
    criticalCandidates: [...cells]
      .filter((cell) => cell.complete && cell.tvMedian !== null)
      .sort((a, b) => (b.tvMedian ?? 0) - (a.tvMedian ?? 0))
      .slice(0, 8)
      .map((cell) => ({ cellKey: cell.cellKey, tvMedian: cell.tvMedian, design: cell.design })),
    stableRegion: cells
      .filter((cell) => cell.design === 'single')
      .sort((a, b) => (a.tvMedian ?? 0) - (b.tvMedian ?? 0))
      .slice(0, 5)
      .map((cell) => ({ cellKey: cell.cellKey, tvMedian: cell.tvMedian })),
  };
  writeFileSync(
    `${outDir}/p6-factorial-analysis.json`,
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
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
  await run();
} else if (mode === 'slim') {
  slim();
} else {
  analyze();
}

#!/usr/bin/env node
/**
 * P6-01 Stage B：1000 人确认轮执行与分析（07 §8；changes/0039）。
 *
 * 用法：
 *   node scripts/p6-stage-b.mjs --freeze <cellKey>    # 冻结该候选的确认 manifest
 *   node scripts/p6-stage-b.mjs --run <cellKey>       # 执行（baseline+cell × 30 确认种子 = 60 run）
 *   node scripts/p6-stage-b.mjs --analyze <cellKey>   # 离线判读（07 §8 全条件）
 *
 * cellKey ∈ {env0=expanded, env0=compressed, crossDays=half, crossDays=double, psi=1, needThreshold=0.9}
 * stdout：纯 JSON；进度走 stderr。确认种子 p6-stageB-seed-001…030 与 Stage A 不重叠（D-07）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { buildBaseConfig } from '../dist/runner/preregistration.js';
import {
  buildP6StageBManifest,
  computeP6StageBHash,
  isP6StageBCandidate,
  P6_STAGE_B_BUDGET,
  P6_STAGE_B_POPULATION,
  P6_STAGE_B_SEEDS,
  P6_STAGE_B_TICKS,
} from '../dist/runner/p6-stage-b.js';
import { validateBatchManifest } from '../dist/runner/batch.js';
import { runBatch } from '../dist/runner/batch-cli.js';
import { nodeCheckpointHost } from '../dist/runner/checkpoint-fs.js';
import { evaluateStageB } from '../dist/runner/p6-analysis.js';

const args = process.argv.slice(2);
const outDir = 'out';
mkdirSync(outDir, { recursive: true });

function log(message) {
  process.stderr.write(`[p6-stageB] ${message}\n`);
}

function cellArg() {
  const index =
    args.indexOf('--freeze') >= 0
      ? args.indexOf('--freeze')
      : args.indexOf('--run') >= 0
        ? args.indexOf('--run')
        : args.indexOf('--analyze');
  const cellKey = args[index + 1];
  if (cellKey === undefined || !isP6StageBCandidate(cellKey)) {
    log(`需要合法候选 cellKey（收到：${cellKey}）`);
    process.exit(2);
  }
  return cellKey;
}

function experimentId(cellKey) {
  return `p6-stageB-${cellKey.replace(/[^a-zA-Z0-9]/g, '-')}-${computeP6StageBHash(cellKey).slice(7, 15)}`;
}

function freeze(cellKey) {
  const manifest = buildP6StageBManifest(cellKey);
  const payload = {
    experimentId: experimentId(cellKey),
    preregistrationHash: computeP6StageBHash(cellKey),
    manifest,
  };
  const path = `${outDir}/p6-stageB-prereg-${sanitize(cellKey)}.json`;
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  log(`冻结 ${path} hash=${payload.preregistrationHash}`);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 'p6-stageB-freeze-v1', cellKey, hash: payload.preregistrationHash, experimentId: payload.experimentId })}\n`,
  );
}

function sanitize(cellKey) {
  return cellKey.replace(/[^a-zA-Z0-9]/g, '-');
}

async function run(cellKey) {
  const hash = computeP6StageBHash(cellKey);
  const preregPath = `${outDir}/p6-stageB-prereg-${sanitize(cellKey)}.json`;
  if (!existsSync(preregPath)) {
    log(`缺少预注册产物 ${preregPath}；先 --freeze ${cellKey}`);
    process.exit(2);
  }
  const frozen = JSON.parse(readFileSync(preregPath, 'utf8'));
  if (frozen.preregistrationHash !== hash) {
    log(`预注册哈希不一致：${frozen.preregistrationHash} ≠ ${hash}`);
    process.exit(2);
  }
  const manifest = buildP6StageBManifest(cellKey);
  const baseConfig = buildBaseConfig(P6_STAGE_B_POPULATION, P6_STAGE_B_TICKS);
  const batchManifest = validateBatchManifest(
    {
      schemaVersion: 'batch-v1',
      rulesVersion: manifest.rulesVersion,
      engineVersion: manifest.engineVersion,
      populationSize: P6_STAGE_B_POPULATION,
      totalTicks: P6_STAGE_B_TICKS,
      policy: manifest.policyVersion,
      seeds: manifest.seeds,
      cells: manifest.cells.map((cell) => ({ cellKey: cell.cellKey, overrides: cell.overrides })),
    },
    baseConfig,
  );

  log(`开始 ${cellKey} preregHash=${hash}（60 run × 1000 人 × 3650 tick；预计 ~60 min）`);
  const startedAt = performance.now();
  const summary = await runBatch(batchManifest, {
    baseConfig,
    ledger: {
      host: nodeCheckpointHost(),
      path: `${outDir}/p6-stageB-ledger-${sanitize(cellKey)}.json`,
    },
    onProgress: (progress) => {
      const status = progress.resumed ? 'resumed' : progress.ok ? 'ok' : 'FAILED';
      log(
        `${progress.index + 1}/${progress.total} ${status} ${progress.cellKey} ${progress.seed}` +
          (progress.ok && !progress.resumed ? ` ${Math.round(progress.elapsedMs)}ms` : ''),
      );
    },
  });
  const wallMinutes = (performance.now() - startedAt) / 60000;
  const summaryPath = `${outDir}/p6-stageB-summary-${sanitize(cellKey)}.json`;
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  if (summary.totals.due > P6_STAGE_B_BUDGET.maxRuns) {
    log(`超预算 maxRuns：${summary.totals.due} > ${P6_STAGE_B_BUDGET.maxRuns}`);
    process.exit(1);
  }
  if (wallMinutes > P6_STAGE_B_BUDGET.maxWallMinutes) {
    log(`超预算 maxWallMinutes：${wallMinutes.toFixed(1)} > ${P6_STAGE_B_BUDGET.maxWallMinutes}`);
    process.exit(1);
  }
  log(
    `完成 ${summary.totals.ok}/${summary.totals.due}；wall ${wallMinutes.toFixed(1)} min；报告 ${summaryPath}`,
  );
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 'p6-stageB-run-v1',
      cellKey,
      preregistrationHash: hash,
      experimentId: experimentId(cellKey),
      totals: summary.totals,
      wallMinutes,
    })}\n`,
  );
}

// ---------- 判读（07 §8/§9；离线、只读、确定性） ----------

function loadAnalysisRuns(cellKey) {
  const slimPath = `${outDir}/p6-stageB-slim-${sanitize(cellKey)}.json`;
  const summaryPath = `${outDir}/p6-stageB-summary-${sanitize(cellKey)}.json`;
  if (existsSync(slimPath)) {
    const slim = JSON.parse(readFileSync(slimPath, 'utf8'));
    return {
      runs: slim.runs.map((run) => ({
        cellKey: run.cellKey,
        seed: run.seed,
        extinct: run.extinct,
        w2b: run.w2b,
        w3: run.w3,
      })),
      totals: slim.totals,
      source: slimPath,
    };
  }
  if (existsSync(summaryPath)) {
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    const windowOf = (report, label) => {
      const window = report.windows.find((entry) => entry.label === label);
      if (window === undefined) {
        return undefined;
      }
      return { ...window, segregation: window.networkEmpty ? null : window.segregation };
    };
    return {
      runs: summary.runs.map((run) => ({
        cellKey: run.cellKey,
        seed: run.seed,
        extinct: run.report.extinct,
        w2b: windowOf(run.report, 'w2b'),
        w3: windowOf(run.report, 'w3'),
      })),
      totals: summary.totals,
      source: summaryPath,
    };
  }
  throw new Error(`缺少 ${slimPath} 或 ${summaryPath}；先 --run ${cellKey}`);
}

function analyze(cellKey) {
  const preregPath = `${outDir}/p6-stageB-prereg-${sanitize(cellKey)}.json`;
  if (!existsSync(preregPath)) {
    log(`缺少预注册产物 ${preregPath}；先 --freeze ${cellKey}`);
    process.exit(2);
  }
  const frozen = JSON.parse(readFileSync(preregPath, 'utf8'));
  const data = loadAnalysisRuns(cellKey);
  const evaluation = evaluateStageB({
    cellKey,
    targetCellKey: cellKey,
    prereg: frozen.manifest,
    runs: data.runs,
    totals: data.totals,
  });
  const computedHash = computeP6StageBHash(cellKey);
  const result = {
    ...evaluation,
    experimentId: experimentId(cellKey),
    preregistrationHash: frozen.preregistrationHash,
    computedPreregistrationHash: computedHash,
    preregistrationHashConsistent: frozen.preregistrationHash === computedHash,
    sourceArtifact: data.source,
    runs: data.totals,
    isExperimentalEvidence: true,
  };
  writeFileSync(
    `${outDir}/p6-stageB-analysis-${sanitize(cellKey)}.json`,
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const mode = args.includes('--freeze')
  ? 'freeze'
  : args.includes('--run')
    ? 'run'
    : args.includes('--analyze')
      ? 'analyze'
      : null;
if (mode === null) {
  log('用法：--freeze <cellKey> | --run <cellKey> | --analyze <cellKey>');
  process.exit(2);
}
const cellKey = cellArg();
if (mode === 'freeze') {
  freeze(cellKey);
} else if (mode === 'run') {
  await run(cellKey);
} else {
  analyze(cellKey);
}

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

// ---------- 判读（07 §8 全条件；离线、只读、确定性） ----------

const THRESHOLDS = { gini: 0.03, tv: 0.1, mUp: 0.05, segregation: 0.05, openness: 0.05 };

function windowMetrics(report, label) {
  const window = report.windows.find((entry) => entry.label === label);
  if (window === undefined) {
    throw new Error(`缺窗口 ${label}`);
  }
  return {
    classShares: window.classShares,
    gini: window.gini,
    mUp: window.mUp,
    mDown: window.mDown,
    segregation: window.networkEmpty ? null : window.segregation,
    openness: window.openness,
  };
}

function tvP(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    sum += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
  }
  return 0.5 * sum;
}

function pairedDiff(ma, mb) {
  return {
    tv: tvP(ma.classShares, mb.classShares),
    gini: ma.gini - mb.gini,
    mUp: ma.mUp - mb.mUp,
    mDown: ma.mDown - mb.mDown,
    segregation:
      ma.segregation === null || mb.segregation === null ? null : ma.segregation - mb.segregation,
    openness: ma.openness - mb.openness,
  };
}

function dScore(ma, mb) {
  const diff = pairedDiff(ma, mb);
  const abs = (value) => (value === null ? 0 : Math.abs(value));
  return (
    0.3 * abs(diff.gini) +
    0.25 * diff.tv +
    0.2 * abs(diff.mUp) +
    0.15 * abs(diff.segregation) +
    0.1 * abs(diff.openness)
  );
}

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 95% 区间：配对差的 [2.5%, 97.5%] 经验分位（30 个配对，非参数区间）。 */
function ci95(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const loIndex = Math.floor(0.025 * (sorted.length - 1));
  const hiIndex = Math.ceil(0.975 * (sorted.length - 1));
  return [sorted[loIndex], sorted[hiIndex]];
}

function analyze(cellKey) {
  const summary = JSON.parse(
    readFileSync(`${outDir}/p6-stageB-summary-${sanitize(cellKey)}.json`, 'utf8'),
  );
  const usable = summary.runs.filter((run) => !run.report.extinct);
  const extinctCount = summary.runs.length - usable.length;
  const byKey = new Map(usable.map((run) => [`${run.cellKey}\u0000${run.seed}`, run]));
  const baselineRuns = usable.filter((run) => run.cellKey === 'baseline');
  const candidateRuns = usable.filter((run) => run.cellKey === cellKey);

  // baseline 跨种子波动带（同 manifest、同种子集、07 §8.3）。
  const baselinePairwiseD = [];
  for (let i = 0; i < baselineRuns.length; i += 1) {
    for (let j = i + 1; j < baselineRuns.length; j += 1) {
      baselinePairwiseD.push(
        dScore(
          windowMetrics(baselineRuns[i].report, 'w2b'),
          windowMetrics(baselineRuns[j].report, 'w2b'),
        ),
      );
    }
  }
  baselinePairwiseD.sort((x, y) => x - y);
  const baselineD95 =
    baselinePairwiseD.length > 0
      ? baselinePairwiseD[
          Math.min(baselinePairwiseD.length - 1, Math.floor(0.95 * baselinePairwiseD.length))
        ]
      : null;

  const windows = ['w2b', 'w3'];
  const perWindow = windows.map((label) => {
    const diffs = { tv: [], gini: [], mUp: [], mDown: [], segregation: [], openness: [] };
    let paired = 0;
    for (const seed of P6_STAGE_B_SEEDS) {
      const candidateRun = byKey.get(`${cellKey}\u0000${seed}`);
      const baselineRun = byKey.get(`baseline\u0000${seed}`);
      if (candidateRun === undefined || baselineRun === undefined) {
        continue;
      }
      const diff = pairedDiff(
        windowMetrics(candidateRun.report, label),
        windowMetrics(baselineRun.report, label),
      );
      paired += 1;
      diffs.tv.push(diff.tv);
      diffs.gini.push(diff.gini);
      diffs.mUp.push(diff.mUp);
      diffs.mDown.push(diff.mDown);
      if (diff.segregation !== null) {
        diffs.segregation.push(diff.segregation);
      }
      diffs.openness.push(diff.openness);
    }
    const stats = {};
    for (const [key, values] of Object.entries(diffs)) {
      if (values.length === 0) {
        continue;
      }
      const med = median(values);
      const [lo, hi] = ci95(values);
      const sign = Math.sign(med);
      stats[key] = {
        median: med,
        ci95: [lo, hi],
        ci95CrossesZero: lo <= 0 && hi >= 0,
        directionAgree: values.filter((value) => Math.sign(value) === sign).length / values.length,
        threshold: THRESHOLDS[key === 'tv' ? 'tv' : key],
        overThreshold: Math.abs(med) >= THRESHOLDS[key === 'tv' ? 'tv' : key],
      };
    }
    return { window: label, paired, stats };
  });

  // 主窗口判定：w2b 为主；w3 为相邻独立窗口复核（07 §8.4：相邻窗口不构成独立复现，
  // 独立复现 = 与 Stage A 的种子分离 + 后续如需再拆种子集）。
  const w2b = perWindow[0];
  const primary = w2b.stats.tv;
  const anyThreshold = perWindow.some((entry) =>
    Object.values(entry.stats).some((stat) => stat.overThreshold),
  );
  const directionOk =
    primary !== undefined &&
    Object.values(w2b.stats)
      .filter((stat) => stat.overThreshold)
      .every((stat) => stat.directionAgree >= 0.9);
  const ciOk = perWindow.some((entry) =>
    Object.values(entry.stats).some((stat) => stat.overThreshold && !stat.ci95CrossesZero),
  );
  const withinBand =
    baselineD95 === null
      ? null
      : candidateRuns.length > 0 && baselineRuns.length > 0
        ? (() => {
            let over = 0;
            let total = 0;
            for (const seed of P6_STAGE_B_SEEDS) {
              const candidateRun = byKey.get(`${cellKey}\u0000${seed}`);
              const baselineRun = byKey.get(`baseline\u0000${seed}`);
              if (candidateRun === undefined || baselineRun === undefined) {
                continue;
              }
              total += 1;
              if (
                dScore(
                  windowMetrics(candidateRun.report, 'w2b'),
                  windowMetrics(baselineRun.report, 'w2b'),
                ) > baselineD95
              ) {
                over += 1;
              }
            }
            return total > 0 ? over / total : null;
          })()
        : null;
  const fallbackRuns = usable.filter((run) => {
    const w1 = run.report.windows.find((entry) => entry.label === 'w2b');
    return w1 !== undefined && w1.fallbackRate !== null && w1.fallbackRate > 0;
  });
  const artifactFree = extinctCount === 0 && fallbackRuns.length === 0;
  const confirmed =
    artifactFree && anyThreshold && directionOk && (ciOk ?? false) && (withinBand ?? 0) >= 0.5;

  const result = {
    schemaVersion: 'p6-stageB-analysis-v1',
    cellKey,
    preregistrationHash: computeP6StageBHash(cellKey),
    experimentId: experimentId(cellKey),
    runs: summary.totals,
    extinctCount,
    baselineD95,
    windows: perWindow,
    criteria: {
      anyThreshold,
      directionOk,
      ci95NotCrossingZero: ciOk ?? false,
      beyondBaselineBand: withinBand,
      artifactFree,
    },
    confirmed,
    claim: confirmed
      ? 'Stage B 确认：Stage A 效应在 1000 人 × 3650 tick 复现（07 §8 全条件）。'
      : 'Stage A 效应未在 Stage B 全条件确认——按预注册口径记录，不得声称结构显著改变。',
    isExperimentalEvidence: true,
    stageClaim: '确认轮效应判定；不构成三类结构结论或校准（P6-05 另有验收，AGENTS #9）',
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

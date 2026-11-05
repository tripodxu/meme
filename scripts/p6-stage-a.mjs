#!/usr/bin/env node
/**
 * P6-01 Stage A：单参数筛查执行与分析（01 §9、07 §3/§6.2/§8；changes/0037）。
 *
 * 用法：
 *   node scripts/p6-stage-a.mjs --freeze                 # 冻结预注册（manifest JSON + hash → out/）
 *   node scripts/p6-stage-a.mjs --run <40|200|both>      # 执行扫描（断点续跑：out/ ledger）
 *   node scripts/p6-stage-a.mjs --analyze                # 离线分析（只读、确定性）
 *
 * 预注册口径见 src/runner/p6-stage-a.ts（即冻结文件）；预算 = D-04 v1。
 * stdout：纯 JSON（freeze/analyze）；进度走 stderr。结果不做结构结论（Stage A 仅筛选）。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import {
  buildP6StageACells,
  buildP6StageAManifest,
  computeP6StageAHash,
  P6_STAGE_A_BASELINE_KEY,
  P6_STAGE_A_BUDGET,
  P6_STAGE_A_SEEDS,
  P6_STAGE_A_TICKS,
} from '../dist/runner/p6-stage-a.js';
import { buildBaseConfig } from '../dist/runner/preregistration.js';
import { validateBatchManifest } from '../dist/runner/batch.js';
import { runBatch } from '../dist/runner/batch-cli.js';
import { nodeCheckpointHost } from '../dist/runner/checkpoint-fs.js';
import { evaluateStageA } from '../dist/runner/p6-analysis.js';

const args = process.argv.slice(2);
const outDir = 'out';
mkdirSync(outDir, { recursive: true });

function log(message) {
  process.stderr.write(`[p6-stageA] ${message}\n`);
}

function experimentId(populationSize) {
  return `p6-stageA-${populationSize}-${computeP6StageAHash(populationSize).slice(7, 15)}`;
}

function freeze() {
  for (const populationSize of [40, 200]) {
    const manifest = buildP6StageAManifest(populationSize);
    const payload = {
      experimentId: experimentId(populationSize),
      preregistrationHash: computeP6StageAHash(populationSize),
      manifest,
    };
    const path = `${outDir}/p6-stageA-prereg-${populationSize}.json`;
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    log(`冻结 ${path} hash=${payload.preregistrationHash}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 'p6-stageA-freeze-v1',
      frozen: [
        { populationSize: 40, hash: computeP6StageAHash(40), experimentId: experimentId(40) },
        { populationSize: 200, hash: computeP6StageAHash(200), experimentId: experimentId(200) },
      ],
      budgets: P6_STAGE_A_BUDGET,
      seeds: P6_STAGE_A_SEEDS.length,
      cells: buildP6StageACells(40).length,
    })}\n`,
  );
}

function batchManifestFor(populationSize) {
  const prereg = buildP6StageAManifest(populationSize);
  const baseConfig = buildBaseConfig(populationSize, P6_STAGE_A_TICKS);
  return validateBatchManifest(
    {
      schemaVersion: 'batch-v1',
      rulesVersion: prereg.rulesVersion,
      engineVersion: prereg.engineVersion,
      populationSize,
      totalTicks: prereg.totalTicks,
      policy: prereg.policyVersion,
      seeds: prereg.seeds,
      cells: prereg.cells.map((cell) => ({ cellKey: cell.cellKey, overrides: cell.overrides })),
    },
    baseConfig,
  );
}

async function run(populationSize) {
  const hash = computeP6StageAHash(populationSize);
  const summaryPath = `${outDir}/p6-stageA-summary-${populationSize}.json`;
  log(`开始 population=${populationSize} preregHash=${hash}`);

  // 冻结校验：预注册产物必须已存在且哈希一致（防止跑的是未冻结设计）。
  const preregPath = `${outDir}/p6-stageA-prereg-${populationSize}.json`;
  if (!existsSync(preregPath)) {
    log(`缺少预注册产物 ${preregPath}；先执行 --freeze`);
    process.exit(2);
  }
  const frozen = JSON.parse(readFileSync(preregPath, 'utf8'));
  if (frozen.preregistrationHash !== hash) {
    log(`预注册哈希不一致：${frozen.preregistrationHash} ≠ ${hash}；设计变更必须新 experimentId`);
    process.exit(2);
  }

  const startedAt = performance.now();
  const summary = await runBatch(batchManifestFor(populationSize), {
    baseConfig: buildBaseConfig(populationSize, P6_STAGE_A_TICKS),
    ledger: {
      host: nodeCheckpointHost(),
      path: `${outDir}/p6-stageA-ledger-${populationSize}.json`,
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
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  // D-04 预算纪律：超预算如实报错（不静默截断种子）。
  if (summary.totals.due > P6_STAGE_A_BUDGET.maxRuns) {
    log(`超预算 maxRuns：${summary.totals.due} > ${P6_STAGE_A_BUDGET.maxRuns}`);
    process.exit(1);
  }
  if (wallMinutes > P6_STAGE_A_BUDGET.maxWallMinutes) {
    log(`超预算 maxWallMinutes：${wallMinutes.toFixed(1)} > ${P6_STAGE_A_BUDGET.maxWallMinutes}`);
    process.exit(1);
  }
  log(
    `完成 ${summary.totals.ok}/${summary.totals.due}（failed ${summary.totals.failed}）；` +
      `wall ${wallMinutes.toFixed(1)} min（预算 ${P6_STAGE_A_BUDGET.maxWallMinutes}）；报告 ${summaryPath}`,
  );
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 'p6-stageA-run-v1',
      populationSize,
      preregistrationHash: hash,
      experimentId: experimentId(populationSize),
      totals: summary.totals,
      wallMinutes,
      withinBudget: true,
    })}\n`,
  );
}

// ---------- 入库瘦身（artifacts §1：单产物 ≤ 5 MiB；全量 summary 用命令重建） ----------

function slimOne(populationSize) {
  const summary = JSON.parse(
    readFileSync(`${outDir}/p6-stageA-summary-${populationSize}.json`, 'utf8'),
  );
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
  return {
    schemaVersion: 'p6-stageA-slim-v1',
    populationSize,
    preregistrationHash: computeP6StageAHash(populationSize),
    batchManifestHash: summary.manifestHash,
    totals: summary.totals,
    runs,
  };
}

function slim() {
  for (const populationSize of [40, 200]) {
    const payload = slimOne(populationSize);
    const path = `${outDir}/p6-stageA-slim-${populationSize}.json`;
    writeFileSync(
      path,
      `${JSON.stringify(payload, null, 2)}
`,
      'utf8',
    );
    const sizeKiB = Buffer.byteLength(JSON.stringify(payload)) / 1024;
    log(`slim ${path} ${sizeKiB.toFixed(0)} KiB runs=${payload.runs.length}`);
  }
}

// ---------- 分析（离线、只读、确定性） ----------

const THRESHOLDS = { gini: 0.03, tv: 0.1, mUp: 0.05, segregation: 0.05, openness: 0.05 };

function w1Metrics(report) {
  const w1 = report.windows.find((window) => window.label === 'w1');
  if (w1 === undefined) {
    throw new Error('run 报告缺 w1 窗口');
  }
  return {
    classShares: w1.classShares,
    gini: w1.gini,
    mUp: w1.mUp,
    mDown: w1.mDown,
    segregation: w1.networkEmpty ? null : w1.segregation,
    openness: w1.openness,
    aliveTickAverage: w1.aliveTickAverage,
    networkEmpty: w1.networkEmpty,
    missingTicks: w1.missingTicks,
    observedTicks: w1.observedTicks,
  };
}

function tvP(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    sum += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
  }
  return 0.5 * sum;
}

function dScore(ma, mb) {
  const tv = tvP(ma.classShares, mb.classShares);
  const term = (x, y) => (x === null || y === null ? 0 : Math.abs(x - y));
  return (
    0.3 * Math.abs(ma.gini - mb.gini) +
    0.25 * tv +
    0.2 * term(ma.mUp, mb.mUp) +
    0.15 * term(ma.segregation, mb.segregation) +
    0.1 * term(ma.openness, mb.openness)
  );
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function analyze() {
  log(
    '警告：--analyze 使用历史“任意指标”口径（p6-stageA-analysis-v1），不得用于候选或判定；严格判读请用 --analyze-strict',
  );
  const runs40 = JSON.parse(readFileSync(`${outDir}/p6-stageA-summary-40.json`, 'utf8'));
  const runs200 = JSON.parse(readFileSync(`${outDir}/p6-stageA-summary-200.json`, 'utf8'));

  const perPopulation = [runs40, runs200].map((summary, populationIndex) => {
    const populationSize = populationIndex === 0 ? 40 : 200;
    // 排除规则：extinct run 不计入结构判定（07 §3 排除规则冻结项）。
    const usable = summary.runs.filter((run) => !run.report.extinct);
    const extinctCount = summary.runs.length - usable.length;
    const byKey = new Map(usable.map((run) => [`${run.cellKey}\u0000${run.seed}`, run]));
    const baselineRuns = usable.filter((run) => run.cellKey === P6_STAGE_A_BASELINE_KEY);
    const baselineMetrics = new Map(baselineRuns.map((run) => [run.seed, w1Metrics(run.report)]));

    // baseline 跨种子波动区间：两两 D 的 95 分位（07 §8.3 参考口径）。
    const baselineSeeds = baselineRuns.map((run) => run.seed);
    const pairwiseD = [];
    for (let i = 0; i < baselineSeeds.length; i += 1) {
      for (let j = i + 1; j < baselineSeeds.length; j += 1) {
        pairwiseD.push(
          dScore(baselineMetrics.get(baselineSeeds[i]), baselineMetrics.get(baselineSeeds[j])),
        );
      }
    }
    pairwiseD.sort((x, y) => x - y);
    const baselineD95 =
      pairwiseD.length > 0
        ? pairwiseD[Math.min(pairwiseD.length - 1, Math.floor(0.95 * pairwiseD.length))]
        : null;

    const cellKeys = [...new Set(usable.map((run) => run.cellKey))].filter(
      (key) => key !== P6_STAGE_A_BASELINE_KEY,
    );

    const cells = cellKeys.map((cellKey) => {
      const metrics = { tv: [], gini: [], mUp: [], mDown: [], segregation: [], openness: [] };
      const dScores = [];
      let paired = 0;
      let directionAgree = { tv: 0, gini: 0, mUp: 0, mDown: 0, segregation: 0, openness: 0 };
      for (const seed of P6_STAGE_A_SEEDS) {
        const run = byKey.get(`${cellKey}\u0000${seed}`);
        const baseline = baselineMetrics.get(seed);
        if (run === undefined || baseline === undefined) {
          continue;
        }
        const cellMetrics = w1Metrics(run.report);
        paired += 1;
        const diff = {
          tv: tvP(cellMetrics.classShares, baseline.classShares),
          gini: cellMetrics.gini - baseline.gini,
          mUp: cellMetrics.mUp - baseline.mUp,
          mDown: cellMetrics.mDown - baseline.mDown,
          segregation:
            cellMetrics.segregation === null || baseline.segregation === null
              ? null
              : cellMetrics.segregation - baseline.segregation,
          openness: cellMetrics.openness - baseline.openness,
        };
        metrics.tv.push(diff.tv);
        metrics.gini.push(diff.gini);
        metrics.mUp.push(diff.mUp);
        metrics.mDown.push(diff.mDown);
        if (diff.segregation !== null) {
          metrics.segregation.push(diff.segregation);
        }
        metrics.openness.push(diff.openness);
        dScores.push(dScore(cellMetrics, baseline));
        // 方向一致率：与配对差中位数同号的种子比例（tv 恒为正幅值，不参与方向）。
        const signConsistent = (values, med) => {
          const sign = Math.sign(med);
          return values.filter((value) => Math.sign(value) === sign).length / values.length;
        };
        directionAgree.gini = signConsistent(metrics.gini, median(metrics.gini));
        directionAgree.mUp = signConsistent(metrics.mUp, median(metrics.mUp));
        directionAgree.mDown = signConsistent(metrics.mDown, median(metrics.mDown));
        if (metrics.segregation.length > 0) {
          directionAgree.segregation = signConsistent(
            metrics.segregation,
            median(metrics.segregation),
          );
        }
        directionAgree.openness = signConsistent(metrics.openness, median(metrics.openness));
      }

      const medians = {
        tv: median(metrics.tv),
        gini: median(metrics.gini),
        mUp: median(metrics.mUp),
        mDown: median(metrics.mDown),
        segregation: metrics.segregation.length > 0 ? median(metrics.segregation) : null,
        openness: median(metrics.openness),
      };
      const medAbs = (value) => (value === null ? 0 : Math.abs(value));
      // 预注册筛选判据（manifest.hypothesis）：任一预注册指标配对中位数超阈值
      // 且方向一致率 ≥ 0.9（tv 以 |ΔG| 同批评估方向；tv 本身取幅值口径）。
      const directionOk =
        Math.max(
          directionAgree.gini,
          directionAgree.mUp,
          directionAgree.mDown,
          directionAgree.openness,
        ) >= 0.9;
      const thresholdHit =
        medAbs(medians.tv) >= THRESHOLDS.tv ||
        medAbs(medians.gini) >= THRESHOLDS.gini ||
        medAbs(medians.mUp) >= THRESHOLDS.mUp ||
        medAbs(medians.segregation) >= THRESHOLDS.segregation ||
        medAbs(medians.openness) >= THRESHOLDS.openness;
      const withinBand =
        baselineD95 === null
          ? null
          : dScores.filter((d) => d > baselineD95).length / dScores.length;
      return {
        cellKey,
        paired,
        medians,
        directionAgree,
        thresholdHit,
        directionOk,
        screenedIn: thresholdHit && directionOk,
        dOverBaselineBandShare: withinBand,
        dMedian: median(dScores),
      };
    });

    return {
      populationSize,
      // 预注册哈希来自冻结产物（batch manifestHash 是执行件哈希，两者并存可对账）。
      preregistrationHash: computeP6StageAHash(populationSize),
      batchManifestHash: summary.manifestHash,
      runs: summary.totals,
      extinctCount,
      baselineRuns: baselineRuns.length,
      baselineD95,
      cells,
    };
  });

  const screenedIn = perPopulation.flatMap((population) =>
    population.cells
      .filter((cell) => cell.screenedIn)
      .map((cell) => ({
        populationSize: population.populationSize,
        cellKey: cell.cellKey,
        medians: cell.medians,
      })),
  );

  const result = {
    schemaVersion: 'p6-stageA-analysis-v1',
    deprecated: true,
    protocol: 'legacy-any-metric',
    isExperimentalEvidence: true,
    stageClaim: 'Stage A 筛选（方向/效应量）；不构成结构结论或校准（AGENTS #9）',
    thresholds: THRESHOLDS,
    populations: perPopulation,
    screenedIn,
    screenedInNote:
      screenedIn.length === 0
        ? '无单元达到 Stage A 筛选判据；按预注册口径不进入 Stage B（后续轮次可扩参数域）'
        : '入选单元进入 Stage B（1000 人 × 3650 tick 独立确认）候选清单',
  };
  writeFileSync(
    `${outDir}/p6-stageA-analysis.json`,
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// ---------- 严格口径重算（07 主指标 TV(P)；changes/0043） ----------

function analyzeStrict() {
  const populations = [40, 200].map((populationSize) => {
    const preregPath = `${outDir}/p6-stageA-prereg-${populationSize}.json`;
    const slimPath = `${outDir}/p6-stageA-slim-${populationSize}.json`;
    if (!existsSync(preregPath) || !existsSync(slimPath)) {
      log(`缺少 ${preregPath} 或 ${slimPath}；无法严格重算`);
      process.exit(2);
    }
    const frozen = JSON.parse(readFileSync(preregPath, 'utf8'));
    const computedHash = computeP6StageAHash(populationSize);
    if (frozen.preregistrationHash !== computedHash) {
      log(
        `预注册哈希不一致：${frozen.preregistrationHash} ≠ ${computedHash}；拒绝分析（换实验请新建 experimentId）`,
      );
      process.exit(2);
    }
    const slim = JSON.parse(readFileSync(slimPath, 'utf8'));
    const runs = slim.runs.map((run) => ({
      cellKey: run.cellKey,
      seed: run.seed,
      extinct: run.extinct,
      w1: run.w1,
    }));
    const cellKeys = [...new Set(runs.map((run) => run.cellKey))].filter(
      (key) => key !== P6_STAGE_A_BASELINE_KEY,
    );
    const cells = cellKeys.map((cellKey) =>
      evaluateStageA({
        populationSize,
        cellKey,
        targetCellKey: cellKey,
        prereg: frozen.manifest,
        runs,
        totals: slim.totals,
      }),
    );
    const computedHash = computeP6StageAHash(populationSize);
    return {
      populationSize,
      preregistrationHash: frozen.preregistrationHash,
      computedPreregistrationHash: computedHash,
      preregistrationHashConsistent: true,
      runs: slim.totals,
      cells,
      screenedIn: cells
        .filter((cell) => cell.screenedIn)
        .map((cell) => ({
          cellKey: cell.cellKey,
          primaryMedian: cell.primary?.median ?? null,
          primaryCi95: cell.primary?.ci95 ?? null,
        })),
    };
  });

  const result = {
    schemaVersion: 'p6-stageA-analysis-strict-v1',
    isExperimentalEvidence: true,
    protocol: '07-strict',
    primaryMetric: 'TV(P)',
    thresholds: { tv: 0.1 },
    note: '按 07 §8 主指标 TV(P) 重算；旧 p6-stageA-analysis.json 的任意指标筛选保留为历史记录，不再用于候选。',
    populations,
    screenedIn: populations.flatMap((population) =>
      population.screenedIn.map((cell) => ({ populationSize: population.populationSize, ...cell })),
    ),
  };
  writeFileSync(
    `${outDir}/p6-stageA-analysis-strict.json`,
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const mode = args.includes('--freeze')
  ? 'freeze'
  : args.includes('--run')
    ? 'run'
    : args.includes('--analyze-strict')
      ? 'analyze-strict'
      : args.includes('--analyze')
        ? 'analyze'
        : args.includes('--slim')
          ? 'slim'
          : null;
if (mode === null) {
  log('用法：--freeze | --run <40|200|both> | --analyze | --analyze-strict');
  process.exit(2);
}

if (mode === 'freeze') {
  freeze();
} else if (mode === 'run') {
  const target = args[args.indexOf('--run') + 1] ?? 'both';
  if (target === '40') {
    await run(40);
  } else if (target === '200') {
    await run(200);
  } else if (target === 'both') {
    await run(40);
    await run(200);
  } else {
    log(`未知 --run 目标：${target}（40|200|both）`);
    process.exit(2);
  }
} else if (mode === 'slim') {
  slim();
} else if (mode === 'analyze-strict') {
  analyzeStrict();
} else {
  analyze();
}

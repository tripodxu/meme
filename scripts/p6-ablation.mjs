#!/usr/bin/env node
/**
 * P6-04a：五个必跑消融（01 §9、07 §11；changes/0051）。
 *
 * 用法：
 *   node scripts/p6-ablation.mjs --freeze   # 冻结预注册（manifest JSON + hash → out/）
 *   node scripts/p6-ablation.mjs --run      # 6 cell × 30 seed = 180 run（ledger 断点续跑）
 *   node scripts/p6-ablation.mjs --slim     # 生成入库瘦身产物
 *   node scripts/p6-ablation.mjs --analyze  # 离线分析（只读、确定性）
 *
 * 主指标 TV(P)；只有 TV 达门槛、CI 不跨 0 且 100% 超出 baseline D95 才标
 * mechanismExplained（07 §11）。ψ=1 另检验 P4 下降方向。仅 exploratory。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import {
  buildP6AblationManifest,
  computeP6AblationHash,
  P6_ABLATION_BASELINE_KEY,
  P6_ABLATION_BUDGET,
  P6_ABLATION_POPULATION,
  P6_ABLATION_SEEDS,
  P6_ABLATION_TICKS,
  summarizeAblationExtras,
} from '../dist/runner/p6-ablation.js';
import { buildBaseConfig } from '../dist/runner/preregistration.js';
import { validateBatchManifest } from '../dist/runner/batch.js';
import { runBatch } from '../dist/runner/batch-cli.js';
import { nodeCheckpointHost } from '../dist/runner/checkpoint-fs.js';
import { evaluateStageA } from '../dist/runner/p6-analysis.js';

const args = process.argv.slice(2);
const outDir = 'out';
mkdirSync(outDir, { recursive: true });

const preregPath = `${outDir}/p6-ablation-prereg.json`;
const summaryPath = `${outDir}/p6-ablation-summary.json`;
const slimPath = `${outDir}/p6-ablation-slim.json`;
const ledgerPath = `${outDir}/p6-ablation-ledger.json`;
const analysisPath = `${outDir}/p6-ablation-analysis.json`;

function log(message) {
  process.stderr.write(`[p6-ablation] ${message}\n`);
}

function experimentId() {
  return `p6-ablation-${computeP6AblationHash().slice(7, 15)}`;
}

function freeze() {
  const manifest = buildP6AblationManifest();
  const payload = {
    experimentId: experimentId(),
    preregistrationHash: computeP6AblationHash(),
    manifest,
  };
  writeFileSync(preregPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  log(`冻结 ${preregPath} hash=${payload.preregistrationHash}`);
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 'p6-ablation-freeze-v1',
      experimentId: payload.experimentId,
      preregistrationHash: payload.preregistrationHash,
      populationSize: P6_ABLATION_POPULATION,
      seeds: P6_ABLATION_SEEDS.length,
      cells: manifest.cells.length,
      runs: manifest.cells.length * manifest.seeds.length,
      budgets: P6_ABLATION_BUDGET,
    })}\n`,
  );
}

function readFrozen() {
  if (!existsSync(preregPath)) {
    log(`缺少预注册产物 ${preregPath}；先执行 --freeze`);
    process.exit(2);
  }
  const frozen = JSON.parse(readFileSync(preregPath, 'utf8'));
  if (frozen.preregistrationHash !== computeP6AblationHash()) {
    log(
      `预注册哈希不一致：${frozen.preregistrationHash} ≠ ${computeP6AblationHash()}；设计变更必须新 experimentId`,
    );
    process.exit(2);
  }
  return frozen;
}

function batchManifestFor(prereg) {
  const baseConfig = buildBaseConfig(P6_ABLATION_POPULATION, P6_ABLATION_TICKS);
  return validateBatchManifest(
    {
      schemaVersion: 'batch-v1',
      rulesVersion: prereg.rulesVersion,
      engineVersion: prereg.engineVersion,
      populationSize: P6_ABLATION_POPULATION,
      totalTicks: P6_ABLATION_TICKS,
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
    baseConfig: buildBaseConfig(P6_ABLATION_POPULATION, P6_ABLATION_TICKS),
    ledger: { host: nodeCheckpointHost(), path: ledgerPath },
    onProgress: (progress) => {
      const status = progress.resumed ? 'resumed' : progress.ok ? 'ok' : 'FAILED';
      log(`${progress.index + 1}/${progress.total} ${status} ${progress.cellKey} ${progress.seed}`);
    },
  });
  const wallMinutes = (performance.now() - startedAt) / 60000;
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  const runs = summary.totals.due;
  if (runs > P6_ABLATION_BUDGET.maxRuns) {
    log(`超预算 maxRuns：${runs} > ${P6_ABLATION_BUDGET.maxRuns}`);
    process.exit(1);
  }
  if (wallMinutes > P6_ABLATION_BUDGET.maxWallMinutes) {
    log(`超预算 maxWallMinutes：${wallMinutes.toFixed(1)} > ${P6_ABLATION_BUDGET.maxWallMinutes}`);
    process.exit(1);
  }
  log(
    `完成 ${summary.totals.ok}/${summary.totals.due}（failed ${summary.totals.failed}）；wall ${wallMinutes.toFixed(1)} min`,
  );
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 'p6-ablation-run-v1',
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
    schemaVersion: 'p6-ablation-slim-v1',
    experimentId: experimentId(),
    preregistrationHash: computeP6AblationHash(),
    batchManifestHash: summary.manifestHash,
    totals: summary.totals,
    runs,
  };
  writeFileSync(slimPath, JSON.stringify(payload), 'utf8');
  const sizeKiB = Buffer.byteLength(JSON.stringify(payload)) / 1024;
  log(`slim ${slimPath} ${sizeKiB.toFixed(0)} KiB runs=${runs.length}`);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 'p6-ablation-slim-v1', path: slimPath, runs: runs.length, sizeKiB })}\n`,
  );
}

function analyze() {
  const frozen = readFrozen();
  if (!existsSync(slimPath)) {
    log(`缺少 ${slimPath}；先执行 --slim`);
    process.exit(2);
  }
  const slimData = JSON.parse(readFileSync(slimPath, 'utf8'));
  if (slimData.preregistrationHash !== frozen.preregistrationHash) {
    log('slim 的 preregistrationHash 与当前冻结不一致；拒绝分析');
    process.exit(2);
  }
  const runs = slimData.runs.map((run) => ({
    cellKey: run.cellKey,
    seed: run.seed,
    extinct: run.extinct,
    w1: run.w1,
  }));
  const cellKeys = frozen.manifest.cells
    .map((cell) => cell.cellKey)
    .filter((cellKey) => cellKey !== P6_ABLATION_BASELINE_KEY);
  const baselineBySeed = new Map(
    runs.filter((run) => run.cellKey === P6_ABLATION_BASELINE_KEY).map((run) => [run.seed, run]),
  );

  const cells = cellKeys.map((cellKey) => {
    const evaluation = evaluateStageA({
      populationSize: P6_ABLATION_POPULATION,
      cellKey,
      targetCellKey: cellKey,
      prereg: frozen.manifest,
      runs,
      totals: slimData.totals,
    });
    const candidateBySeed = new Map(
      runs.filter((run) => run.cellKey === cellKey).map((run) => [run.seed, run]),
    );
    const pairs = frozen.manifest.seeds
      .map((seed) => {
        const baseline = baselineBySeed.get(seed);
        const candidate = candidateBySeed.get(seed);
        if (baseline?.w1 === undefined || candidate?.w1 === undefined) {
          return null;
        }
        return { baseline: baseline.w1, candidate: candidate.w1 };
      })
      .filter((pair) => pair !== null);
    const extras = summarizeAblationExtras(cellKey, pairs);
    const changedPaths =
      frozen.manifest.cells.find((cell) => cell.cellKey === cellKey)?.changedPaths ?? [];
    return {
      cellKey,
      changedPaths,
      tvMedian: evaluation.primary?.median ?? null,
      tvCi95: evaluation.primary?.ci95 ?? null,
      beyondBandRate: evaluation.beyondBandRate,
      baselineD95: evaluation.baselineD95,
      paired: evaluation.completeness.paired,
      complete: evaluation.criteria.complete,
      metrics: evaluation.metrics,
      ...extras,
      // 07 §11：结构显著退化需同时过 TV 门槛/区间/完整性，并 100% 超出 baseline 波动带。
      mechanismExplained: evaluation.screenedIn && evaluation.beyondBandRate === 1,
      exploratoryOnly: true,
    };
  });

  const result = {
    schemaVersion: 'p6-ablation-analysis-v1',
    isExperimentalEvidence: true,
    protocol: '07-ablation-exploratory',
    primaryMetric: 'TV(P)',
    thresholds: { tv: frozen.manifest.differenceThresholds.tv },
    experimentId: experimentId(),
    preregistrationHash: frozen.preregistrationHash,
    populationSize: P6_ABLATION_POPULATION,
    totals: slimData.totals,
    baselineD95: cells[0]?.baselineD95 ?? null,
    claim:
      'P6-04a 五消融：只有消融后结构显著退化（TV(P)≥0.10、CI 不跨 0、100% 超出 baseline D95）' +
      '才可说该机制在本实验范围内有解释力；ψ=1 另检验 P4 下降方向。仅 exploratory，' +
      '不构成现实因果、确认或校准（07 §11、AGENTS #9）。Jev/mock 对照另列，未在无轮换密钥时运行。',
    cells,
  };
  writeFileSync(analysisPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
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

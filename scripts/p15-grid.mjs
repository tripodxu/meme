#!/usr/bin/env node
/**
 * P1.5-01/03 批量网格运行（headless，无 UI/网络）。
 *
 * 用法：
 *   node scripts/p15-grid.mjs --stage screen   # 预检：每 cell 1 种子 × 短 tick，筛查崩溃/爆炸
 *   node scripts/p15-grid.mjs --stage full     # 正式：按预注册 manifest 跑全部 cell × 30 种子
 *
 * 输出（机器可读 JSON，stdout 纯 JSON；进度走 stderr）：
 *   { preregistrationHash, cells: [{cellKey, seeds: [{seed, window metrics, labels, aliveAtEnd, finalStateHash, elapsedMs}]}] }
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';

import {
  buildPreregManifest,
  computePreregistrationHash,
  buildCellConfig,
} from '../dist/core/../runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { asSeed } from '../dist/core/control/ids.js';
import { featureVector, meetsInitialDifference } from '../dist/runner/distance.js';
import {
  fitStandardizer,
  chooseKBySilhouette,
  bisectStability,
  minClusterSize,
  seededShuffle,
} from '../dist/runner/cluster.js';

const args = process.argv.slice(2);
const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : 'screen';

function log(message) {
  process.stderr.write(`[p15] ${message}\n`);
}

// W0-3 冻结口径（07 §8.1）：20 次确定性洗牌，判定量 = median，必报 min。
// 洗牌种子是任意但固定的字面量；修改它们＝分析管线变更＝新 experimentId。
const STABILITY_SEED_OFFSETS = [
  20261103, 20261104, 20261105, 20261106, 20261107, 20261108, 20261109, 20261110, 20261111,
  20261112, 20261113, 20261114, 20261115, 20261116, 20261117, 20261118, 20261119, 20261120,
  20261121, 20261122,
];

/** 偶数长度取中间两数均值（与 core `median` 同口径）。 */
function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

const manifest = buildPreregManifest();
const preregistrationHash = computePreregistrationHash(manifest);
log(`preregistrationHash=${preregistrationHash}`);
log(`stage=${stage} cells=${manifest.cells.length} seeds=${manifest.seeds.length}`);

// burn-in 必须止于首个分析窗口起点之前（07 §5）：否则窗口混入排序暂态。
const firstWindowStart = Math.min(...manifest.windows.map((window) => window.start));
if (manifest.warmupTicks > firstWindowStart) {
  throw new Error(`warmupTicks=${manifest.warmupTicks} 超过首个分析窗口起点 ${firstWindowStart}`);
}

const seedsForStage = stage === 'screen' ? manifest.seeds.slice(0, 1) : manifest.seeds;
const ticksForStage = stage === 'screen' ? 400 : manifest.totalTicks;

// 预算护栏（07 §3）：超出即中止，不得把超预算批次当正式证据。
const projectedRuns = manifest.cells.length * seedsForStage.length;
if (projectedRuns > manifest.budgets.maxRuns) {
  throw new Error(`预计 ${projectedRuns} run 超过 budgets.maxRuns=${manifest.budgets.maxRuns}`);
}

const cellResults = [];
let runCount = 0;
const startedAt = performance.now();
for (const cell of manifest.cells) {
  const config = buildCellConfig(cell, manifest.populationSize, ticksForStage);
  const seedResults = [];
  for (const seed of seedsForStage) {
    const runStart = performance.now();
    const outcome = runSingle(config, asSeed(seed), { policy: 'mock-weighted-v1' });
    const elapsedMs = Math.round(performance.now() - runStart);
    const w1 = outcome.report.windows.find((window) => window.label === 'w1');
    const w3 = outcome.report.windows.find((window) => window.label === 'w3');
    const w2b = outcome.report.windows.find((window) => window.label === 'w2b');
    const windowPayload = (window) =>
      window === undefined
        ? null
        : {
            label: window.label,
            available: window.missingTicks === 0,
            missingTicks: window.missingTicks,
            classShares: window.classShares,
            gini: window.gini,
            topWealthShare: window.topWealthShare,
            mUp: window.mUp,
            mDown: window.mDown,
            segregation: window.segregation,
            openness: window.openness,
            edgeCountAverage: window.edgeCountAverage,
            crossClassEdgeShare: window.crossClassEdgeShare,
            deathRate: window.deathRate,
            networkEmpty: window.networkEmpty,
            labels: outcome.report.labelsByWindow[window.label] ?? [],
            evidence: outcome.report.labelsEvidenceByWindow[window.label] ?? {},
          };
    runCount += 1;
    seedResults.push({
      seed,
      elapsedMs,
      extinct: outcome.report.extinct,
      endReason: outcome.report.endReason,
      endTick: outcome.report.endTick,
      aliveAtEnd: outcome.report.aliveAtEnd,
      finalStateHash: outcome.report.finalStateHash,
      configHash: outcome.configHash,
      paramsHash: outcome.paramsHash,
      w1: windowPayload(w1),
      w3: windowPayload(w3),
      w2b: windowPayload(w2b),
    });
  }
  log(`cell=${cell.cellKey} done (${seedResults.length} seeds)`);
  cellResults.push({
    cellKey: cell.cellKey,
    design: cell.design,
    changedPaths: cell.changedPaths,
    hypothesis: cell.hypothesis,
    seeds: seedResults,
  });
}

// 设计类型分布（07 §6.2/§6.3）：单轴 cell 的效应可归因到单个参数，
// 交互 cell 只回答「联合条件是否可达」，产物必须自带该区分，避免下游误用。
const cellsByDesign = { baseline: 0, single: 0, interaction: 0 };
for (const cell of cellResults) {
  cellsByDesign[cell.design] += 1;
}
log(`cellsByDesign=${JSON.stringify(cellsByDesign)}`);

// 聚类（仅 full 阶段）：预注册全部特征窗口（w2b + w3）的特征点 → z-score(pooled) →
// Ward k∈[2,5]。同一 run 的 w2b/w3 都在同一空间聚类，直接比较簇号得到
// 吸引子稳定性（07 §5 v5 修订），不再用「投影到 w3 质心」的近似。
let clustering = null;
if (stage === 'full') {
  const featureWindows = manifest.clustering.featureWindows;
  const points = [];
  const pointMeta = [];
  for (const cell of cellResults) {
    for (const seedResult of cell.seeds) {
      for (const key of featureWindows) {
        const w = seedResult[key];
        if (w !== null && w.available) {
          points.push(featureVector(w));
          pointMeta.push({
            cell: cell.cellKey,
            seed: seedResult.seed,
            window: key,
            networkEmpty: w.networkEmpty === true,
          });
        }
      }
    }
  }
  log(`clustering points=${points.length} windows=${featureWindows.join(',')}`);
  if (points.length >= 8) {
    // z-score 标尺只在 pooled 特征矩阵上拟合一次；w2b 复用同一标尺，禁止原始值混入。
    const scaler = fitStandardizer(points);
    const z = points.map((row) => scaler.standardize(row));
    const choice = chooseKBySilhouette(z);
    const stabilityShuffles = manifest.clustering.stabilityShuffles;
    if (STABILITY_SEED_OFFSETS.length !== stabilityShuffles) {
      throw new Error(
        `洗牌种子数 ${STABILITY_SEED_OFFSETS.length} 与预注册 stabilityShuffles=${stabilityShuffles} 不一致`,
      );
    }
    const stabilityRuns = STABILITY_SEED_OFFSETS.map((seed) =>
      bisectStability(
        z,
        choice.k,
        [seededShuffle(z.length, seed)],
        manifest.clustering.stabilityMinAri,
      ),
    );
    const ariValues = stabilityRuns.map((run) => run.ari);
    // 判定量 = median（07 §8.1 W0-3）；min 必须同报，不得只引用 max。
    const medianAri = medianOf(ariValues);
    const minAri = Math.min(...ariValues);
    const maxAri = Math.max(...ariValues);
    const clusterSizes = new Map();
    for (const a of choice.assignment) {
      clusterSizes.set(a, (clusterSizes.get(a) ?? 0) + 1);
    }
    const smallestCluster = minClusterSize(choice.assignment);
    const minClusterMet = smallestCluster >= manifest.clustering.minClusterRuns;
    // 吸引子稳定性（07 §5 v5 修订）：同一 run 的 w2b 与 w3 特征点在同一 z-score
    // 空间各自入簇，直接比较簇号是否一致；阈值来自预注册，不做事后择取。
    let temporalConsistency = null;
    {
      const windows = manifest.clustering.featureWindows;
      const byRun = new Map();
      for (let index = 0; index < pointMeta.length; index += 1) {
        const meta = pointMeta[index];
        const key = `${meta.cell}|${meta.seed}`;
        const entry = byRun.get(key) ?? {};
        entry[meta.window] = choice.assignment[index];
        byRun.set(key, entry);
      }
      let same = 0;
      let total = 0;
      for (const entry of byRun.values()) {
        const clusters = windows.map((window) => entry[window]).filter((v) => v !== undefined);
        if (clusters.length < 2) continue;
        total += 1;
        if (clusters.every((cluster) => cluster === clusters[0])) same += 1;
      }
      const rate = total === 0 ? null : Math.round((same / total) * 1000) / 1000;
      temporalConsistency = {
        windows: [...windows],
        sameClusterRate: rate,
        total,
        minRate: manifest.clustering.temporalConsistencyMinRate,
        met: rate !== null && rate >= manifest.clustering.temporalConsistencyMinRate,
      };
    }
    // G1.5 判定协议（diagnosis §6 预注册写死；07 §8.1 聚类口径不变）：
    // k 由轮廓系数选择，但必须同时满足 k=2 的 ARI median ≥ 门槛，否则直接判定
    // 「无宏观二态」，不得退而报告 k=4/k=5 充当通过。
    const k2Runs = STABILITY_SEED_OFFSETS.map((seed) =>
      bisectStability(z, 2, [seededShuffle(z.length, seed)], manifest.clustering.stabilityMinAri),
    );
    const k2MedianAri = medianOf(k2Runs.map((run) => run.ari));
    const k2HardGateMet = k2MedianAri >= manifest.clustering.stabilityMinAri;
    // 非退化簇：≥1 个簇至少含一个非空网络窗口的特征点（全死亡 run 已被窗口可用性排除）。
    const clusterIds = [...new Set(choice.assignment)];
    const nonDegenerateClusters = clusterIds.filter((cluster) =>
      choice.assignment.some(
        (assigned, index) => assigned === cluster && pointMeta[index]?.networkEmpty === false,
      ),
    ).length;
    // 均值场方向预测（预注册写死）：位移平衡钉住底层（全部 cell P0(w3)≥0.15）
    // 且分布稳态（全部 cell ‖P(w2b)−P(w3)‖₁<0.10）。
    const perCellMeans = cellResults.map((cell) => {
      const w3 = cell.seeds.filter((seedResult) => seedResult.w3?.available);
      const w2b = cell.seeds.filter((seedResult) => seedResult.w2b?.available);
      const meanP0 =
        w3.length === 0
          ? Number.NaN
          : w3.reduce((sum, seedResult) => sum + (seedResult.w3.classShares[0] ?? 0), 0) /
            w3.length;
      let drift = Number.NaN;
      if (w3.length > 0 && w2b.length > 0) {
        const classCount = (w3[0].w3.classShares ?? []).length;
        drift =
          w3.reduce((sum, seedResult) => {
            const w2bWindow = seedResult.w2b;
            if (w2bWindow === null || !w2bWindow.available) return sum;
            let l1Sum = 0;
            for (let c = 0; c < classCount; c += 1) {
              l1Sum += Math.abs(
                (w2bWindow.classShares[c] ?? 0) - (seedResult.w3.classShares[c] ?? 0),
              );
            }
            return sum + l1Sum / 2;
          }, 0) / w3.length;
      }
      return { cellKey: cell.cellKey, meanP0, drift };
    });
    const worstP0 = Math.min(...perCellMeans.map((entry) => entry.meanP0));
    const worstDrift = Math.max(...perCellMeans.map((entry) => entry.drift));
    const meanFieldDirectionMet = worstP0 >= 0.15 && worstDrift < 0.1;
    const g15Passed =
      k2HardGateMet &&
      minClusterMet &&
      medianAri >= manifest.clustering.stabilityMinAri &&
      temporalConsistency?.met === true &&
      nonDegenerateClusters >= 1 &&
      meanFieldDirectionMet;
    clustering = {
      k: choice.k,
      silhouette: Math.round(choice.score * 1000) / 1000,
      // `stabilityAri` 是判定量（median）；min/max 同报，不得只引用最大值（07 §8.1）。
      stabilityAri: Math.round(medianAri * 1000) / 1000,
      stabilityAriMedian: Math.round(medianAri * 1000) / 1000,
      stabilityAriMin: Math.round(minAri * 1000) / 1000,
      stabilityAriMax: Math.round(maxAri * 1000) / 1000,
      stabilityMinAri: manifest.clustering.stabilityMinAri,
      stabilityShuffles,
      stabilityStable: minClusterMet && medianAri >= manifest.clustering.stabilityMinAri,
      minClusterSize: smallestCluster,
      minClusterRuns: manifest.clustering.minClusterRuns,
      minClusterMet,
      temporalConsistency,
      clusterSizes: Object.fromEntries([...clusterSizes.entries()].map(([k, v]) => [`c${k}`, v])),
      assignment: choice.assignment.map((cluster, index) => ({
        ...pointMeta[index],
        cluster: `c${cluster}`,
      })),
      g15: {
        criteria: {
          k2MinAri: manifest.clustering.stabilityMinAri,
          stabilityMinAri: manifest.clustering.stabilityMinAri,
          temporalConsistencyMinRate: manifest.clustering.temporalConsistencyMinRate,
          minClusterRuns: manifest.clustering.minClusterRuns,
          meanFieldP0Min: 0.15,
          meanFieldDriftMax: 0.1,
        },
        k2StabilityAriMedian: Math.round(k2MedianAri * 1000) / 1000,
        k2StabilityAriMin: Math.round(Math.min(...k2Runs.map((run) => run.ari)) * 1000) / 1000,
        k2HardGateMet,
        nonDegenerateClusters,
        meanField: {
          worstCellP0: Math.round(worstP0 * 1000) / 1000,
          worstCellDrift: Math.round(worstDrift * 1000) / 1000,
          met: meanFieldDirectionMet,
        },
        passed: g15Passed,
        verdict: g15Passed
          ? 'G1.5 通过：>=2 类可复现结构聚类'
          : k2HardGateMet
            ? 'G1.5 未通过：聚类协议子项不满足'
            : '无宏观二态（k=2 ARI median < 门槛，不得以 k=4/k=5 充当通过）',
      },
    };
  }
}

// 预注册 cell 必须与 baseline 有实际差异（07 §8），否则该 cell 无信息量。
// 门槛取 manifest.differenceThresholds，运行后不得放宽。
let cellDistinctness = null;
if (stage === 'full') {
  const pickWindow = (cellKey) => {
    const cell = cellResults.find((entry) => entry.cellKey === cellKey);
    return cell?.seeds.find((seedResult) => seedResult.w2b?.available)?.w2b ?? null;
  };
  const baselineWindow = pickWindow('baseline');
  if (baselineWindow !== null) {
    cellDistinctness = cellResults
      .filter((cell) => cell.cellKey !== 'baseline')
      .map((cell) => {
        const probe = pickWindow(cell.cellKey);
        if (probe === null) {
          return {
            cellKey: cell.cellKey,
            design: cell.design,
            met: null,
            detail: '无可用 w2b，无法比较',
          };
        }
        const { met, detail } = meetsInitialDifference(
          probe,
          baselineWindow,
          manifest.differenceThresholds,
        );
        return { cellKey: cell.cellKey, design: cell.design, met, detail };
      });
  }
}

const wallMinutes = Math.round((performance.now() - startedAt) / 60000);
const output = {
  schemaVersion: 'p15-grid-v2',
  stage,
  preregistrationHash,
  runCount,
  wallMinutes,
  manifest,
  execution: {
    stage,
    totalTicks: ticksForStage,
    seeds: seedsForStage,
    runCount,
    warmupTicks: manifest.warmupTicks,
  },
  clustering,
  cellsByDesign,
  cellDistinctness,
  cells: cellResults,
};
mkdirSync('out', { recursive: true });
// 预算护栏（07 §3）：实际值必须落在预注册 budgets 内，超限不得当作正式证据。
{
  const sizeWithoutBudget = Buffer.byteLength(`${JSON.stringify(output, null, 2)}\n`, 'utf8');
  const violations = [];
  if (runCount > manifest.budgets.maxRuns) {
    violations.push(`runCount=${runCount} > maxRuns=${manifest.budgets.maxRuns}`);
  }
  if (wallMinutes > manifest.budgets.maxWallMinutes) {
    violations.push(
      `wallMinutes=${wallMinutes} > maxWallMinutes=${manifest.budgets.maxWallMinutes}`,
    );
  }
  if (sizeWithoutBudget > manifest.budgets.maxStorageBytes) {
    violations.push(
      `storageBytes=${sizeWithoutBudget} > maxStorageBytes=${manifest.budgets.maxStorageBytes}`,
    );
  }
  output.budgets = {
    maxRuns: manifest.budgets.maxRuns,
    maxWallMinutes: manifest.budgets.maxWallMinutes,
    maxStorageBytes: manifest.budgets.maxStorageBytes,
    observed: { runCount, wallMinutes, storageBytes: sizeWithoutBudget },
    ok: violations.length === 0,
    violations,
  };
  if (violations.length > 0) {
    log(`budgets 超限: ${violations.join('; ')}`);
    process.exitCode = 2;
  }
}
const serialized = `${JSON.stringify(output, null, 2)}\n`;
writeFileSync(`out/p15-${stage}.json`, serialized, 'utf8');
process.stdout.write(`${JSON.stringify(output)}\n`);
log(
  `written out/p15-${stage}.json (${runCount} runs, ${wallMinutes}min, ${statSync(`out/p15-${stage}.json`).size} bytes)`,
);

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
import { mkdirSync, writeFileSync } from 'node:fs';

import {
  buildPreregManifest,
  computePreregistrationHash,
  buildCellConfig,
} from '../dist/core/../runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { asSeed } from '../dist/core/control/ids.js';
import {
  zScoreMatrix,
  chooseKBySilhouette,
  bisectStability,
  seededShuffle,
} from '../dist/runner/cluster.js';

const args = process.argv.slice(2);
const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : 'screen';

function log(message) {
  process.stderr.write(`[p15] ${message}\n`);
}

const manifest = buildPreregManifest();
const preregistrationHash = computePreregistrationHash(manifest);
log(`preregistrationHash=${preregistrationHash}`);
log(`stage=${stage} cells=${manifest.cells.length} seeds=${manifest.seeds.length}`);

const seedsForStage = stage === 'screen' ? manifest.seeds.slice(0, 1) : manifest.seeds;
const ticksForStage = stage === 'screen' ? 400 : manifest.totalTicks;

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
    });
  }
  log(`cell=${cell.cellKey} done (${seedResults.length} seeds)`);
  cellResults.push({ cellKey: cell.cellKey, hypothesis: cell.hypothesis, seeds: seedResults });
}

// 聚类（仅 full 阶段）：w1+w3 特征点 → z-score → Ward k∈[2,5]；同 run 双窗应同簇。
let clustering = null;
if (stage === 'full') {
  const points = [];
  const pointMeta = [];
  for (const cell of cellResults) {
    for (const seedResult of cell.seeds) {
      for (const key of ['w1', 'w3']) {
        const w = seedResult[key];
        if (w !== null && w.available) {
          points.push([
            ...w.classShares,
            w.gini,
            w.topWealthShare,
            w.mUp,
            w.mDown,
            w.segregation,
            w.openness,
          ]);
          pointMeta.push({ cell: cell.cellKey, seed: seedResult.seed, window: key });
        }
      }
    }
  }
  // 时间稳定性：同一 (cell,seed) 的 w1/w3 簇一致性。
  const byRun = new Map();
  for (const p of pointMeta) {
    const key = p.cell + '|' + p.seed;
    byRun.set(key, (byRun.get(key) ?? 0) + 1);
  }
  log(`clustering points=${points.length}`);
  if (points.length >= 8) {
    const z = zScoreMatrix(points);
    const choice = chooseKBySilhouette(z);
    const stability = bisectStability(z, choice.k, [seededShuffle(points.length, 20261103)]);
    const clusterSizes = new Map();
    for (const a of choice.assignment) {
      clusterSizes.set(a, (clusterSizes.get(a) ?? 0) + 1);
    }
    clustering = {
      k: choice.k,
      silhouette: Math.round(choice.score * 1000) / 1000,
      stabilityAri: Math.round(stability.ari * 1000) / 1000,
      stabilityStable: stability.stable,
      clusterSizes: Object.fromEntries([...clusterSizes.entries()].map(([k, v]) => [`c${k}`, v])),
      assignment: choice.assignment.map((cluster, index) => ({
        ...pointMeta[index],
        cluster: `c${cluster}`,
      })),
    };
  }
}

const wallMinutes = Math.round((performance.now() - startedAt) / 60000);
const output = {
  schemaVersion: 'p15-grid-v1',
  stage,
  preregistrationHash,
  runCount,
  wallMinutes,
  manifest: {
    populationSize: manifest.populationSize,
    totalTicks: ticksForStage,
    seeds: seedsForStage,
    labelThresholdVersion: manifest.labelThresholdVersion,
    labelThresholdsHash: manifest.labelThresholdsHash,
  },
  clustering,
  cells: cellResults,
};
mkdirSync('out', { recursive: true });
writeFileSync(`out/p15-${stage}.json`, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(output)}\n`);
log(`written out/p15-${stage}.json (${runCount} runs, ${wallMinutes}min)`);

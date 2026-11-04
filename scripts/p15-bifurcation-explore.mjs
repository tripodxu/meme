#!/usr/bin/env node
/**
 * P1.5 涌现分叉探索：参数路径迟滞（探索层，不是确认轮）。
 *
 * 问题：W4 的两类分裂是参数体制级（share=1 vs <1），没有证明同一参数下存在
 * 两个稳定吸引域。本脚本用「同一 mid 参数、不同到达路径」检验迟滞：
 *   up:   w=10 预热 → w=mid 继续
 *   down: w=60 预热 → w=mid 继续
 *   control: 全程 w=mid
 * 若 up/down 在同一 (share=0.5, w=mid) 收敛到显著不同的结构，且差异超过
 * 同路径种子噪声，则存在路径依赖/迟滞候选；否则是负结果。
 *
 * 用法：
 *   node scripts/p15-bifurcation-explore.mjs --stage screen
 *   node scripts/p15-bifurcation-explore.mjs --stage full [--seeds 10]
 *
 * 输出：out/p15-bifurcation-explore.json（探索层；不得引用为 G1.5 确认证据）
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';

import { buildCellConfig } from '../dist/runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { asSeed } from '../dist/core/control/ids.js';
import { computeConfigHash, computeParamsHash } from '../dist/core/config/hash.js';

const args = process.argv.slice(2);
const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : 'screen';
const seedCount = args.includes('--seeds')
  ? Number(args[args.indexOf('--seeds') + 1])
  : stage === 'screen'
    ? 1
    : stage === 'long'
      ? 3
      : 10;
const SEEDS = Array.from(
  { length: seedCount },
  (_, index) => `p15b-seed-${String(index + 1).padStart(3, '0')}`,
);

const POPULATION = 40;
const TICKS = stage === 'screen' ? 400 : stage === 'long' ? 5475 : 3650;
const WARMUP = stage === 'screen' ? 200 : 1825;
const SHARE = 0.5;
// 强对照：无锚定 vs 最大锚定；middle-heavy 初值让占用压力立即为正（默认 IC 在
// 早期 tick 可能尚未超过目标份额，屏障恒为 0，路径无差异）。
const W_LOW = 0;
const W_HIGH = 100;
const IC_PRESETS = {
  default: { key: 'ic-default', classShares: [0.45, 0.3, 0.15, 0.08, 0.02] },
  middle: { key: 'ic-middle', classShares: [0.1, 0.25, 0.35, 0.22, 0.08] },
  bottom: { key: 'ic-bottom', classShares: [0.6, 0.25, 0.1, 0.04, 0.01] },
};
const icKey = args.includes('--ic') ? args[args.indexOf('--ic') + 1] : 'middle';
const IC = IC_PRESETS[icKey];
if (IC === undefined) {
  throw new Error(`未知 --ic=${icKey}；可选 ${Object.keys(IC_PRESETS).join('/')}`);
}
const MIDS = stage === 'screen' ? [20] : [20, 25, 30];
const OUTPUT_PATH = `out/p15-bifurcation-${stage === 'long' ? 'long-' : 'explore-'}${icKey}.json`;

function log(message) {
  process.stderr.write(`[bifurcation] ${message}\n`);
}

function cellConfig(cellKey, weight) {
  return buildCellConfig(
    {
      cellKey,
      overrides: {
        ascent: { displacementShare: SHARE, scarcityWeight: weight },
        population: { classShares: IC.classShares },
      },
    },
    POPULATION,
    TICKS,
  );
}

function resumeState(state, config) {
  return {
    ...state,
    config,
    configHash: computeConfigHash(config),
    paramsHash: computeParamsHash(config),
  };
}

function finalMetrics(state, outcome, classCount) {
  const alive = state.society.agents.filter((agent) => agent.alive);
  const counts = new Array(classCount).fill(0);
  for (const agent of alive) {
    counts[agent.classIndex] = (counts[agent.classIndex] ?? 0) + 1;
  }
  const total = alive.length === 0 ? 1 : alive.length;
  const classShares = counts.map((count) => count / total);
  let up = 0;
  let down = 0;
  for (const matrix of outcome.flowsByTick.values()) {
    for (let from = 0; from < classCount; from += 1) {
      for (let to = 0; to < classCount; to += 1) {
        if (to === from + 1) up += matrix[from]?.[to] ?? 0;
        if (to === from - 1) down += matrix[from]?.[to] ?? 0;
      }
    }
  }
  return {
    alive: alive.length,
    classShares,
    p0: classShares[0] ?? 0,
    gini: state.society.gini,
    openness: state.society.openness,
    mUp: up,
    mDown: down,
  };
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sd(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1),
  );
}

function l1(a, b) {
  let sum = 0;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    sum += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
  }
  return sum;
}

const startedAt = performance.now();
const rows = [];
let runCount = 0;

for (const mid of MIDS) {
  const configLow = cellConfig(`w${W_LOW}`, W_LOW);
  const configHigh = cellConfig(`w${W_HIGH}`, W_HIGH);
  const configMid = cellConfig(`w${mid}`, mid);
  for (const seed of SEEDS) {
    const seedValue = asSeed(seed);
    for (const path of ['up', 'down', 'control']) {
      if (path === 'control') {
        const outcome = runSingle(configMid, seedValue, {
          policy: 'mock-weighted-v1',
          maxTicks: TICKS,
        });
        runCount += 1;
        rows.push({
          mid,
          path,
          seed,
          ic: IC.key,
          extinct: outcome.report.extinct,
          metrics: finalMetrics(outcome.finalState, outcome, configMid.population.classCount),
        });
        continue;
      }
      const warmConfig = path === 'up' ? configLow : configHigh;
      const warm = runSingle(warmConfig, seedValue, {
        policy: 'mock-weighted-v1',
        maxTicks: WARMUP,
      });
      runCount += 1;
      if (warm.report.extinct) {
        rows.push({ mid, path, seed, ic: IC.key, extinct: true, metrics: null });
        continue;
      }
      const warmupMetrics = finalMetrics(warm.finalState, warm, configMid.population.classCount);
      const resumed = runSingle(configMid, seedValue, {
        policy: 'mock-weighted-v1',
        maxTicks: TICKS,
        initialState: resumeState(warm.finalState, configMid),
      });
      runCount += 1;
      rows.push({
        mid,
        path,
        seed,
        ic: IC.key,
        extinct: resumed.report.extinct,
        warmup: warmupMetrics,
        metrics: resumed.report.extinct
          ? null
          : finalMetrics(resumed.finalState, resumed, configMid.population.classCount),
      });
    }
    log(`mid=${mid} seed=${seed} done`);
  }
}

function pairwiseL1(rows) {
  if (rows.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      sum += l1(rows[i].metrics.classShares, rows[j].metrics.classShares);
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return null;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const analysis = MIDS.map((mid) => {
  const group = (path) =>
    rows.filter((row) => row.mid === mid && row.path === path && row.metrics !== null);
  const up = group('up');
  const down = group('down');
  const control = group('control');
  const paired = Math.min(up.length, down.length);
  const deltas = [];
  const featureDistances = [];
  for (let index = 0; index < paired; index += 1) {
    deltas.push(up[index].metrics.p0 - down[index].metrics.p0);
    featureDistances.push(l1(up[index].metrics.classShares, down[index].metrics.classShares));
  }
  const upP0 = up.map((row) => row.metrics.p0);
  const downP0 = down.map((row) => row.metrics.p0);
  const gap = mean(upP0) === null || mean(downP0) === null ? null : mean(upP0) - mean(downP0);
  const pooledSd = Math.sqrt((sd(upP0) ** 2 + sd(downP0) ** 2) / 2);
  const classCount = up[0]?.metrics.classShares.length ?? 5;
  const warmupFingerprint = (groupRows) =>
    groupRows.length === 0
      ? null
      : Array.from({ length: classCount }, (_, classIndex) =>
          mean(groupRows.map((row) => row.warmup.classShares[classIndex] ?? 0)),
        );
  const betweenPathL1 = mean(featureDistances);
  const withinUp = pairwiseL1(up);
  const withinDown = pairwiseL1(down);
  const noiseFloor = Math.max(withinUp, withinDown);
  // 结构性锁定的定义：底层两阶级合计 < 5%。仅看 P0 会漏掉「P0=0 但 P1 仍有 30%」
  // 的差异；锁定比例和流动性才是路径效应的主判据。
  const isLocked = (row) => row.metrics.classShares[0] + row.metrics.classShares[1] < 0.05;
  const lockedFraction = (groupRows) =>
    groupRows.length === 0 ? null : groupRows.filter(isLocked).length / groupRows.length;
  const upMup = up.map((row) => row.metrics.mUp);
  const downMup = down.map((row) => row.metrics.mUp);
  const mUpGap =
    mean(downMup) !== null && mean(upMup) !== null ? mean(downMup) - mean(upMup) : null;
  const mUpPooledSd = Math.sqrt((sd(upMup) ** 2 + sd(downMup) ** 2) / 2);
  const separatedByMobility = mUpGap !== null && Math.abs(mUpGap) > Math.max(5, 2 * mUpPooledSd);
  return {
    mid,
    counts: { up: up.length, down: down.length, control: control.length },
    warmupClassShares: {
      up: warmupFingerprint(up),
      down: warmupFingerprint(down),
    },
    p0: {
      up: { mean: mean(upP0), sd: sd(upP0), min: Math.min(...upP0), max: Math.max(...upP0) },
      down: {
        mean: mean(downP0),
        sd: sd(downP0),
        min: Math.min(...downP0),
        max: Math.max(...downP0),
      },
      control: {
        mean: mean(control.map((row) => row.metrics.p0)),
        sd: sd(control.map((row) => row.metrics.p0)),
      },
      gap,
      pooledSd,
      separatedByP0: gap !== null && Math.abs(gap) > Math.max(0.05, 2 * pooledSd),
    },
    distribution: {
      betweenPathL1: { mean: betweenPathL1, max: Math.max(...featureDistances) },
      withinPathL1: { up: withinUp, down: withinDown },
      noiseFloor,
      separatedByL1: betweenPathL1 !== null && betweenPathL1 > Math.max(0.1, 2 * noiseFloor),
      note: 'L1 会被上层内部重分配放大；锁定比例/流动性是主判据。',
    },
    lockedFraction: {
      up: lockedFraction(up),
      down: lockedFraction(down),
      control: lockedFraction(control),
    },
    mobility: {
      mUp: {
        up: { mean: mean(upMup), sd: sd(upMup) },
        down: { mean: mean(downMup), sd: sd(downMup) },
        control: { mean: mean(control.map((row) => row.metrics.mUp)) },
        gap: mUpGap,
        pooledSd: mUpPooledSd,
        separated: separatedByMobility,
      },
      mDown: {
        up: mean(up.map((row) => row.metrics.mDown)),
        down: mean(down.map((row) => row.metrics.mDown)),
        control: mean(control.map((row) => row.metrics.mDown)),
      },
    },
    pathDependent:
      (lockedFraction(up) ?? 0) - (lockedFraction(down) ?? 0) >= 0.5 || separatedByMobility,
    pairedDelta: {
      runs: paired,
      mean: mean(deltas),
      median: median(deltas),
      sameSign: deltas.filter((delta) => Math.sign(delta) === Math.sign(mean(deltas) ?? 0)).length,
    },
  };
});

const wallMinutes = Math.round((performance.now() - startedAt) / 60000);
const output = {
  schemaVersion: 'p15-bifurcation-explore-v1',
  stage,
  family: 'parameter-path-hysteresis',
  exploratory: true,
  note: '探索层（07 §6.1）：同一 mid 参数下比较 up/down 路径；不得引用为 G1.5 或校准证据。',
  design: {
    share: SHARE,
    midWeights: MIDS,
    initialCondition: IC,
    lowWeight: W_LOW,
    highWeight: W_HIGH,
    warmupTicks: WARMUP,
    totalTicks: TICKS,
    seeds: SEEDS,
  },
  execution: { runCount, wallMinutes },
  rows,
  analysis,
};
mkdirSync('out', { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(
  `${JSON.stringify({
    runCount,
    wallMinutes,
    analysis: analysis.map((entry) => ({
      mid: entry.mid,
      p0: entry.p0,
      distribution: entry.distribution,
      mobility: entry.mobility,
      pairedDelta: entry.pairedDelta,
    })),
  })}\n`,
);
log(`written ${OUTPUT_PATH} (${runCount} runs, ${wallMinutes}min)`);

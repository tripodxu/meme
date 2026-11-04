#!/usr/bin/env node
/**
 * P1.5 分叉机制探针（探索层，不是确认轮）。
 *
 * 三个问题：
 * 1. `up` 锁定是否依赖开放准入？warmup 用 share=1（1:1 位移）vs share=0.5；
 * 2. 底层抽空后，去掉占用锚定（w=0）能否恢复？
 * 3. 记录锁定的底层份额与流动性，供研究记录引用。
 *
 * 用法：node scripts/p15-bifurcation-probe.mjs [--seeds 3]
 * 输出：out/p15-bifurcation-probe.json（探索层）
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';

import { buildCellConfig } from '../dist/runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { asSeed } from '../dist/core/control/ids.js';
import { computeConfigHash, computeParamsHash } from '../dist/core/config/hash.js';

const args = process.argv.slice(2);
const seedCount = args.includes('--seeds') ? Number(args[args.indexOf('--seeds') + 1]) : 3;
const SEEDS = Array.from(
  { length: seedCount },
  (_, index) => `p15b-probe-${String(index + 1).padStart(3, '0')}`,
);
const IC = [0.1, 0.25, 0.35, 0.22, 0.08];
const MID = 25;
const WARMUP = 1825;
const MID_END = 3650;
const RECOVERY_END = 5475;

function config(cellKey, share, weight, totalTicks) {
  return buildCellConfig(
    {
      cellKey,
      overrides: {
        ascent: { displacementShare: share, scarcityWeight: weight },
        population: { classShares: IC },
      },
    },
    40,
    totalTicks,
  );
}

function resume(state, nextConfig) {
  return {
    ...state,
    config: nextConfig,
    configHash: computeConfigHash(nextConfig),
    paramsHash: computeParamsHash(nextConfig),
  };
}

function metrics(state, outcome) {
  const alive = state.society.agents.filter((agent) => agent.alive);
  const counts = new Array(5).fill(0);
  for (const agent of alive) {
    counts[agent.classIndex] = (counts[agent.classIndex] ?? 0) + 1;
  }
  const total = alive.length === 0 ? 1 : alive.length;
  const classShares = counts.map((count) => count / total);
  let up = 0;
  let down = 0;
  for (const matrix of outcome.flowsByTick.values()) {
    for (let from = 0; from < 5; from += 1) {
      for (let to = 0; to < 5; to += 1) {
        if (to === from + 1) up += matrix[from]?.[to] ?? 0;
        if (to === from - 1) down += matrix[from]?.[to] ?? 0;
      }
    }
  }
  return {
    alive: alive.length,
    classShares,
    locked: (classShares[0] ?? 0) + (classShares[1] ?? 0) < 0.05,
    p0: classShares[0] ?? 0,
    mUp: up,
    mDown: down,
  };
}

const startedAt = performance.now();
const rows = [];

for (const seed of SEEDS) {
  const value = asSeed(seed);
  const midConfig = config('mid', 0.5, MID, RECOVERY_END);
  const results = {};

  for (const warmShare of [0.5, 1]) {
    const warmConfig = config(`warm-share${warmShare}`, warmShare, 0, RECOVERY_END);
    const warm = runSingle(warmConfig, value, {
      policy: 'mock-weighted-v1',
      maxTicks: WARMUP,
    });
    const mid = runSingle(midConfig, value, {
      policy: 'mock-weighted-v1',
      maxTicks: MID_END,
      initialState: resume(warm.finalState, midConfig),
    });
    results[`up-share${warmShare}`] = {
      warmup: metrics(warm.finalState, warm),
      final: metrics(mid.finalState, mid),
    };
    if (warmShare === 0.5) {
      const recoveryConfig = config('recovery', 0.5, 0, RECOVERY_END);
      const recovery = runSingle(recoveryConfig, value, {
        policy: 'mock-weighted-v1',
        maxTicks: RECOVERY_END,
        initialState: resume(mid.finalState, recoveryConfig),
      });
      results.recovery = metrics(recovery.finalState, recovery);
    }
  }
  rows.push({ seed, mid: MID, ...results });
}

const sum = (values) => values.reduce((total, value) => total + value, 0);
const mean = (values) => (values.length === 0 ? null : sum(values) / values.length);
const summary = {
  seeds: SEEDS.length,
  mid: MID,
  upShare05: {
    lockedFraction: mean(rows.map((row) => (row['up-share0.5'].final.locked ? 1 : 0))),
    mUp: mean(rows.map((row) => row['up-share0.5'].final.mUp)),
  },
  upShare1: {
    lockedFraction: mean(rows.map((row) => (row['up-share1'].final.locked ? 1 : 0))),
    mUp: mean(rows.map((row) => row['up-share1'].final.mUp)),
  },
  recovery: {
    lockedFraction: mean(rows.map((row) => (row.recovery.locked ? 1 : 0))),
    mUp: mean(rows.map((row) => row.recovery.mUp)),
  },
};

const wallMinutes = Math.round((performance.now() - startedAt) / 60000);
const output = {
  schemaVersion: 'p15-bifurcation-probe-v1',
  stage: 'probe',
  exploratory: true,
  note: '探索层机制探针：share 消融与锁定后恢复；不构成 G1.5/P6 证据。',
  execution: { seeds: SEEDS, runCount: SEEDS.length * 5, wallMinutes },
  summary,
  rows,
};
mkdirSync('out', { recursive: true });
writeFileSync('out/p15-bifurcation-probe.json', `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ summary, wallMinutes })}\n`);

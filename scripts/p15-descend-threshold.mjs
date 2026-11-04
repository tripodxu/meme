#!/usr/bin/env node
/**
 * P1.5 descend 权重阈值探针（探索层，不是确认轮）。
 *
 * 背景：mock 策略下存在路径依赖的底层锁定，random 策略下不复现。一个候选解释是
 * 「下降倾向」决定底层能否被抽空。本脚本固定其它 mock 权重，只扫描 descend 权重 d：
 * - d=0：无下降；d=1.2：mock 原值；d 越大越接近 random 的高下降率。
 * 若存在阈值 d*，使 `up` 锁定在高 d 下消失，则锁定是策略的下降倾向驱动，
 * 不是 rules-v10 的结构性分岔。
 *
 * 用法：
 *   node scripts/p15-descend-threshold.mjs --stage screen
 *   node scripts/p15-descend-threshold.mjs --stage full [--seeds 5]
 *
 * 输出：out/p15-descend-threshold-explore.json（探索层；不得引用为 G1.5 证据）
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';

import { buildCellConfig } from '../dist/runner/preregistration.js';
import { runSingle } from '../dist/runner/run-cell.js';
import { asSeed } from '../dist/core/control/ids.js';
import { computeConfigHash, computeParamsHash } from '../dist/core/config/hash.js';
import { rngUnit } from '../dist/core/rng/rng.js';
import { RNG_EVENT_TAGS } from '../dist/core/rng/tags.js';
import { weightedSampleIndex } from '../dist/core/rng/sampling.js';
import { agentIndexFromId } from '../dist/core/model/agent.js';
import { DECISION_SCHEMA_VERSION } from '../dist/core/control/versions.js';

const args = process.argv.slice(2);
const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : 'screen';
const seedCount = args.includes('--seeds') ? Number(args[args.indexOf('--seeds') + 1]) : 5;
const SEEDS = Array.from(
  { length: seedCount },
  (_, index) => `p15d-seed-${String(index + 1).padStart(3, '0')}`,
);
const D_VALUES = stage === 'screen' ? [0, 1.2, 4] : [0, 0.2, 0.5, 0.8, 1.2, 2, 4];
const descendCondition = args.includes('--descend-condition')
  ? args[args.indexOf('--descend-condition') + 1]
  : 'streak';
const IC = [0.1, 0.25, 0.35, 0.22, 0.08];
const MID = 25;
const TICKS = stage === 'screen' ? 400 : 3650;
const WARMUP = stage === 'screen' ? 200 : 1825;
const OUTPUT_PATH =
  descendCondition === 'always'
    ? 'out/p15-descend-unconditional-explore.json'
    : 'out/p15-descend-threshold-explore.json';

function log(message) {
  process.stderr.write(`[descend] ${message}\n`);
}

class DescendWeightPolicy {
  constructor(descendWeight, descendCondition) {
    this.descendWeight = descendWeight;
    this.descendCondition = descendCondition;
    this.policyVersion = `explore-descend-${descendCondition}-${descendWeight}-v1`;
  }

  decide(input) {
    const agent = input.simState.society.agents[agentIndexFromId(input.agentId)];
    if (agent === undefined || agent.id !== input.agentId || !agent.alive) {
      throw new Error(`决策个体不存在或已死亡: ${input.agentId}`);
    }
    const weights = input.legal.actions.map((action) => {
      if (action === 'accumulate') return 1;
      if (action === 'ascend') {
        const cost = input.legal.ascendCost;
        return cost !== null && agent.value >= 1.5 * cost ? 0.8 : 0;
      }
      if (action === 'descend') {
        if (this.descendCondition === 'always') return this.descendWeight;
        return agent.belowNeedStreak >= 7 ? this.descendWeight : 0;
      }
      return 0.1;
    });
    const r = rngUnit(input.seed, input.tick, input.agentId, RNG_EVENT_TAGS.exploreDescend, 0);
    const index = weightedSampleIndex(weights, r);
    const selected = input.legal.actions[index];
    if (selected === undefined) {
      throw new Error('加权抽样未产生合法行动');
    }
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const probabilities = {};
    input.legal.actions.forEach((action, actionIndex) => {
      probabilities[action] = (weights[actionIndex] ?? 0) / total;
    });
    return {
      schemaVersion: DECISION_SCHEMA_VERSION,
      runId: input.runId,
      tick: input.tick,
      agentId: input.agentId,
      stateHash: input.stateHash,
      actionSetHash: input.actionSetHash,
      legalActions: [...input.legal.actions],
      policyVersion: this.policyVersion,
      promptVersion: null,
      promptStyle: null,
      requestedAction: null,
      selectedAction: selected,
      source: 'mock',
      probabilitySource: 'derived',
      requestedModel: 'mock',
      responseModel: null,
      probabilities,
      confidence: null,
      topK: 1,
      usage: {},
      latencyMs: 0,
      attempts: 1,
      fallbackReason: null,
      rawResponse: null,
    };
  }
}

function config(cellKey, weight, totalTicks) {
  return buildCellConfig(
    {
      cellKey,
      overrides: {
        ascent: { displacementShare: 0.5, scarcityWeight: weight },
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
    mUp: up,
    mDown: down,
  };
}

const startedAt = performance.now();
const rows = [];
let runCount = 0;

for (const descendWeight of D_VALUES) {
  const policy = new DescendWeightPolicy(descendWeight, descendCondition);
  const midConfig = config(`mid-d${descendWeight}`, MID, TICKS);
  for (const seed of SEEDS) {
    const value = asSeed(seed);
    for (const path of ['up', 'down', 'control']) {
      if (path === 'control') {
        const outcome = runSingle(midConfig, value, {
          policy: 'mock-weighted-v1',
          policyImpl: policy,
          maxTicks: TICKS,
        });
        runCount += 1;
        rows.push({
          descendWeight,
          path,
          seed,
          extinct: outcome.report.extinct,
          metrics: metrics(outcome.finalState, outcome),
        });
        continue;
      }
      const warmConfig = config(`warm-${path}-d${descendWeight}`, path === 'up' ? 0 : 100, TICKS);
      const warm = runSingle(warmConfig, value, {
        policy: 'mock-weighted-v1',
        policyImpl: policy,
        maxTicks: WARMUP,
      });
      runCount += 1;
      if (warm.report.extinct) {
        rows.push({ descendWeight, path, seed, extinct: true, metrics: null });
        continue;
      }
      const resumed = runSingle(midConfig, value, {
        policy: 'mock-weighted-v1',
        policyImpl: policy,
        maxTicks: TICKS,
        initialState: resume(warm.finalState, midConfig),
      });
      runCount += 1;
      rows.push({
        descendWeight,
        path,
        seed,
        extinct: resumed.report.extinct,
        metrics: resumed.report.extinct ? null : metrics(resumed.finalState, resumed),
      });
    }
  }
  log(`descendWeight=${descendWeight} done`);
}

const mean = (values) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

const analysis = D_VALUES.map((descendWeight) => {
  const group = (path) =>
    rows.filter(
      (row) => row.descendWeight === descendWeight && row.path === path && row.metrics !== null,
    );
  const up = group('up');
  const down = group('down');
  const control = group('control');
  const lockedFraction = (rowsInGroup) =>
    rowsInGroup.length === 0
      ? null
      : rowsInGroup.filter((row) => row.metrics.locked).length / rowsInGroup.length;
  return {
    descendWeight,
    locked: {
      up: lockedFraction(up),
      down: lockedFraction(down),
      control: lockedFraction(control),
    },
    mUp: {
      up: mean(up.map((row) => row.metrics.mUp)),
      down: mean(down.map((row) => row.metrics.mUp)),
      control: mean(control.map((row) => row.metrics.mUp)),
    },
  };
});

const wallMinutes = Math.round((performance.now() - startedAt) / 60000);
const output = {
  schemaVersion: 'p15-descend-threshold-explore-v1',
  stage,
  exploratory: true,
  note: '探索层：固定其它 mock 权重，仅扫描 descend 权重；不构成 G1.5/P6 证据，也不改变生产策略。',
  design: {
    share: 0.5,
    midWeight: MID,
    warmupTicks: WARMUP,
    totalTicks: TICKS,
    seeds: SEEDS,
    descendCondition,
  },
  execution: { runCount, wallMinutes },
  analysis,
  rows,
};
mkdirSync('out', { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ analysis, wallMinutes, runCount })}\n`);
log(`written ${OUTPUT_PATH} (${runCount} runs, ${wallMinutes}min)`);

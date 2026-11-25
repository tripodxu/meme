#!/usr/bin/env node
/**
 * P6-04b 1-seed live pilot（07 §11）。
 *
 * 同一配置（40 人、730 tick、decision.interval=30）分别跑：
 *   mock-weighted-v1、random-uniform-v1、jev_live（单个 seed）。
 * 输出 w1 结构指标、live 决策聚合（回退/模型/usage/延迟）与三方描述性差异。
 *
 * **pilot 不是正式对照**：1 个 seed、无区间/显著性；只用于验证 harness、回退率与
 * 运行时长。正式对照需 5–10 个 seed，并把 live 与 mock/random 分开报告。
 *
 * 用法：
 *   node --env-file=.env scripts/p6-04b-live-pilot.mjs --seed p6-04b-live-seed-001
 *   node --env-file=.env scripts/p6-04b-live-pilot.mjs --skip-live   # 只跑 mock/random
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname } from 'node:path';

import { createDemoConfig } from '../dist/core/config/defaults.js';
import { asSeed } from '../dist/core/control/ids.js';
import { runSingle, runSingleWithPolicy } from '../dist/runner/run-cell.js';
import {
  AttemptBudget,
  JevLivePolicy,
  SlidingCircuitWindow,
  SlidingFallbackRateWindow,
} from '../dist/decision/live.js';
import { dScore, pairedDiff } from '../dist/runner/p6-analysis.js';

function parseArgs(argv) {
  const options = {
    seed: 'p6-04b-live-seed-001',
    population: 40,
    ticks: 730,
    decisionInterval: 30,
    promptStyle: 'neutral',
    model: process.env.JEV_MODEL ?? 'jev-1.13.0',
    out: 'out/p6-04b-live-pilot.json',
    rawOut: 'out/p6-04b-live-pilot-decisions.ndjson.gz',
    skipLive: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} 缺少取值`);
      index += 1;
      return value;
    };
    if (flag === '--seed') options.seed = next();
    else if (flag === '--population') options.population = Number(next());
    else if (flag === '--ticks') options.ticks = Number(next());
    else if (flag === '--decision-interval') options.decisionInterval = Number(next());
    else if (flag === '--prompt-style') options.promptStyle = next();
    else if (flag === '--model') options.model = next();
    else if (flag === '--out') options.out = next();
    else if (flag === '--raw-out') options.rawOut = next();
    else if (flag === '--skip-live') options.skipLive = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        [
          '用法：node --env-file=.env scripts/p6-04b-live-pilot.mjs [options]',
          '  --seed <s>               默认 p6-04b-live-seed-001',
          '  --population <n>         默认 40',
          '  --ticks <n>              默认 730',
          '  --decision-interval <n>  默认 30',
          '  --prompt-style <s>       neutral|survival_hint，默认 neutral',
          '  --model <m>              默认 JEV_MODEL 或 jev-1.13.0',
          '  --out <path>             摘要 JSON',
          '  --raw-out <path.gz>      live 决策原始记录（含 rawResponse，本地审计）',
          '  --skip-live              只跑 mock/random',
          '  --dry-run                只打印计划',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${flag}`);
    }
  }
  if (options.promptStyle !== 'neutral' && options.promptStyle !== 'survival_hint') {
    throw new Error('--prompt-style 必须为 neutral 或 survival_hint');
  }
  return options;
}

function windowOf(report) {
  const window = report.windows.find((entry) => entry.label === 'w1');
  if (window === undefined) throw new Error('报告缺少 w1');
  return {
    classShares: window.classShares,
    gini: window.gini,
    mUp: window.mUp,
    mDown: window.mDown,
    segregation: window.segregation,
    openness: window.openness,
    fallbackRate: window.fallbackRate,
    tickCount: window.tickCount,
    observedTicks: window.observedTicks,
    missingTicks: window.missingTicks,
    labels: report.labelsByWindow.w1 ?? [],
  };
}

function sideSummary(outcome) {
  return {
    finalStateHash: outcome.report.finalStateHash,
    aliveAtEnd: outcome.report.aliveAtEnd,
    extinct: outcome.report.extinct,
    endTick: outcome.report.endTick,
    endReason: outcome.report.endReason,
    window: windowOf(outcome.report),
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function decisionSummary(decisions) {
  const fallbackReasons = {};
  const responseModels = new Set();
  const probabilitySources = { exact: 0, derived: 0, none: 0 };
  let inputTokens = 0;
  let outputTokens = 0;
  let missingUsage = 0;
  const latencies = [];
  for (const record of decisions) {
    if (record.fallbackReason !== null) {
      fallbackReasons[record.fallbackReason] = (fallbackReasons[record.fallbackReason] ?? 0) + 1;
    }
    if (record.responseModel !== null) responseModels.add(record.responseModel);
    probabilitySources[record.probabilitySource] += 1;
    inputTokens += record.usage.inputTokens ?? 0;
    outputTokens += record.usage.outputTokens ?? 0;
    if (record.source === 'jev_live' && record.usage.inputTokens === undefined) missingUsage += 1;
    latencies.push(record.latencyMs);
  }
  return {
    due: decisions.length,
    fallbacks: decisions.filter((record) => record.fallbackReason !== null).length,
    fallbackReasons,
    responseModels: [...responseModels].sort(),
    probabilitySources,
    usage: { inputTokens, outputTokens, missingRecords: missingUsage },
    latencyMs: {
      min: latencies.length === 0 ? null : Math.min(...latencies),
      p50: percentile(latencies, 0.5),
      max: latencies.length === 0 ? null : Math.max(...latencies),
      samples: latencies.length,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = createDemoConfig({
    population: { initialPopulation: options.population },
    schedule: {
      totalTicks: options.ticks,
      statsStride: 1,
      snapshotStride: 100,
    },
    decision: { interval: options.decisionInterval },
  });
  const seed = asSeed(options.seed);
  const decisionPoints = Math.floor(options.ticks / options.decisionInterval) + 1;
  const dueDecisions = options.population * decisionPoints;

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          seed: options.seed,
          population: options.population,
          ticks: options.ticks,
          decisionInterval: options.decisionInterval,
          decisionPoints,
          dueDecisions,
          promptStyle: options.promptStyle,
          requestedModel: options.model,
          endpoint: process.env.JEV_ENDPOINT ?? null,
          skipLive: options.skipLive,
        },
        null,
        2,
      ),
    );
    return;
  }

  const startedAt = Date.now();
  const mockOutcome = runSingle(config, seed, { policy: 'mock-weighted-v1' });
  const randomOutcome = runSingle(config, seed, { policy: 'random-uniform-v1' });
  const mock = sideSummary(mockOutcome);
  const random = sideSummary(randomOutcome);

  let live = null;
  let liveDecisions = [];
  let liveError = null;
  if (!options.skipLive) {
    const apiKey = process.env.JEV_API_KEY ?? '';
    if (apiKey.length === 0) {
      throw new Error('缺少 JEV_API_KEY；用 --env-file=.env 加载，或先 --skip-live');
    }
    const budget = new AttemptBudget(Math.max(100, dueDecisions * 3), 6_000_000);
    const policy = new JevLivePolicy(
      apiKey,
      {
        endpoint: process.env.JEV_ENDPOINT,
        requestTimeoutMs: 60_000,
        maxTotalAttempts: 3,
        networkRetryLimit: 2,
        rateLimitRetryLimit: 3,
        serverErrorRetryLimit: 2,
        baseBackoffMs: 500,
        jitterMs: () => 0,
        deadlineMs: Date.now() + 90 * 60 * 1000,
        budget,
        failureWindow: new SlidingCircuitWindow(),
        fallbackRateWindow: new SlidingFallbackRateWindow(),
      },
      {
        fetchImpl: fetch,
        sleep: (ms, signal) =>
          new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve();
            });
          }),
        nowMs: () => Date.now(),
      },
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90 * 60 * 1000);
    timeout.unref?.();
    // 包装策略以保留逐决策记录：即使中途熔断/回退率超限，也能保存已完成部分。
    const seen = [];
    const tracedPolicy = {
      policyVersion: policy.policyVersion,
      async decide(input, signal) {
        const record = await policy.decide(input, signal);
        seen.push(record);
        return record;
      },
    };
    try {
      const outcome = await runSingleWithPolicy(config, seed, {
        policy: tracedPolicy,
        runId: `local-p6-04b-pilot-${options.seed.replace(/[^A-Za-z0-9-]/g, '-')}`,
        requestedModel: options.model,
        promptStyle: options.promptStyle,
        maxTicks: options.ticks,
        signal: controller.signal,
      });
      live = sideSummary(outcome);
      liveDecisions = [...seen];
    } catch (error) {
      liveError = { code: error.code ?? error.name, message: error.message };
      liveDecisions = [...seen];
    } finally {
      clearTimeout(timeout);
      if (liveDecisions.length > 0) {
        writeFileSync(
          options.rawOut,
          gzipSync(liveDecisions.map((record) => JSON.stringify(record)).join('\n') + '\n'),
        );
      }
    }
  }

  const comparisons = {};
  if (live !== null) {
    const liveWindow = live.window;
    const mockWindow = mock.window;
    const randomWindow = random.window;
    comparisons.liveVsMock = {
      ...pairedDiff(liveWindow, mockWindow),
      d: dScore(pairedDiff(liveWindow, mockWindow)),
    };
    comparisons.liveVsRandom = {
      ...pairedDiff(liveWindow, randomWindow),
      d: dScore(pairedDiff(liveWindow, randomWindow)),
    };
  }
  comparisons.mockVsRandom = {
    ...pairedDiff(random.window, mock.window),
    d: dScore(pairedDiff(random.window, mock.window)),
  };

  const report = {
    schemaVersion: 'p6-04b-live-pilot-v1',
    isExperimentalEvidence: false,
    pilot: true,
    purpose:
      '1-seed harness/fallback/runtime pilot；不是正式 live/mock 对照，无区间/显著性，不构成结构证据。',
    seed: options.seed,
    population: options.population,
    ticks: options.ticks,
    decisionInterval: options.decisionInterval,
    decisionPoints,
    dueDecisions,
    promptStyle: options.promptStyle,
    requestedModel: options.model,
    endpoint: process.env.JEV_ENDPOINT ?? null,
    elapsedMs: Date.now() - startedAt,
    mock,
    random,
    live,
    liveError,
    decisions: liveDecisions.length === 0 ? null : decisionSummary(liveDecisions),
    rawResponsesPath: liveDecisions.length === 0 ? null : options.rawOut,
    comparisons,
  };
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (liveError !== null) process.exit(1);
}

main().catch((error) => {
  console.error(`pilot 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

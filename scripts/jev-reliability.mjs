#!/usr/bin/env node
/**
 * P6-04b 前置：Jev 重测信度（07 §11）。
 *
 * 固定一个由 mock 跑到 warmup tick 的真实 state，对同一 state 连续调用 live 模型
 * `--repeats` 次（默认 20），报告选项分布、top-1 一致率、概率向量 ICC(2,1) 与
 * 重复间平均 TV 距离。未达门槛时 verdict=model_unstable，live 只作描述性案例。
 *
 * 用法：
 *   node --env-file=.env scripts/jev-reliability.mjs --out out/p6-04b-reliability.json
 *   node --env-file=.env scripts/jev-reliability.mjs --repeats 20 --prompt-style neutral
 *
 * 密钥只从 JEV_API_KEY 读取，不打印、不写盘、不进摘要。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createDemoConfig } from '../dist/core/config/defaults.js';
import { asSeed } from '../dist/core/control/ids.js';
import { computeActionSetHash, enumerateLegalActions } from '../dist/core/legal-actions.js';
import { runSingle } from '../dist/runner/run-cell.js';
import {
  buildDecisionState,
  computeDecisionStateHash,
  PROMPT_VERSION,
} from '../dist/decision/serialize.js';
import { callJev, resolveEndpoint, TOKEN_ESTIMATOR_VERSION } from '../dist/decision/jev-client.js';
import {
  AttemptBudget,
  SlidingCircuitWindow,
  SlidingFallbackRateWindow,
} from '../dist/decision/live.js';
import { summarizeReliability } from '../dist/runner/reliability.js';

function parseArgs(argv) {
  const options = {
    repeats: 20,
    population: 40,
    warmup: 365,
    promptStyle: 'neutral',
    seed: 'p6-04b-reliability',
    model: process.env.JEV_MODEL ?? 'jev-1.13.0',
    out: null,
    maxInputTokens: 2_000_000,
    maxCalls: null,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${flag} 缺少取值`);
      }
      index += 1;
      return value;
    };
    if (flag === '--repeats') options.repeats = Number(next());
    else if (flag === '--population') options.population = Number(next());
    else if (flag === '--warmup') options.warmup = Number(next());
    else if (flag === '--prompt-style') options.promptStyle = next();
    else if (flag === '--seed') options.seed = next();
    else if (flag === '--model') options.model = next();
    else if (flag === '--out') options.out = next();
    else if (flag === '--max-input-tokens') options.maxInputTokens = Number(next());
    else if (flag === '--max-calls') options.maxCalls = Number(next());
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        [
          '用法：node --env-file=.env scripts/jev-reliability.mjs [options]',
          '  --repeats <n>           重复次数，默认 20',
          '  --population <n>        构造 state 的 mock 人口，默认 40',
          '  --warmup <n>            mock 跑到该 tick 取 state，默认 365',
          '  --prompt-style <s>      neutral|survival_hint，默认 neutral',
          '  --seed <s>              mock state 的种子，默认 p6-04b-reliability',
          '  --model <m>             请求模型，默认 JEV_MODEL 或 jev-1.13.0',
          '  --out <path>            写 JSON 报告',
          '  --max-input-tokens <n>  预算上限，默认 2000000',
          '  --max-calls <n>         调用上限，默认 repeats*3',
          '  --dry-run               只构造 state 并打印计划，不发请求',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${flag}`);
    }
  }
  if (!Number.isInteger(options.repeats) || options.repeats < 1) {
    throw new Error('--repeats 必须为正整数');
  }
  if (options.promptStyle !== 'neutral' && options.promptStyle !== 'survival_hint') {
    throw new Error('--prompt-style 必须为 neutral 或 survival_hint');
  }
  return options;
}

function percentile(values, fraction) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function pickAgent(state) {
  let selected = null;
  for (const agent of state.society.agents) {
    if (!agent.alive) {
      continue;
    }
    const legal = enumerateLegalActions(state, agent.id);
    if (selected === null || legal.actions.length > selected.legal.actions.length) {
      selected = { agent, legal };
    }
  }
  return selected;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.JEV_API_KEY ?? '';
  if (!options.dryRun && apiKey.length === 0) {
    console.error('缺少 JEV_API_KEY；用 --env-file=.env 加载，或先执行 --dry-run');
    process.exit(2);
  }
  const endpoint = resolveEndpoint(process.env.JEV_ENDPOINT);
  const config = createDemoConfig({
    population: { initialPopulation: options.population },
    schedule: {
      totalTicks: options.warmup,
      statsStride: Math.min(10, options.warmup),
      snapshotStride: Math.min(100, options.warmup),
    },
  });
  const seed = asSeed(options.seed);
  const mock = runSingle(config, seed, { policy: 'mock-weighted-v1' });
  const state = mock.finalState;
  const selected = pickAgent(state);
  if (selected === null || selected.legal.actions.length < 2) {
    console.error('未找到拥有 >=2 个合法行动的存活个体；该 state 无法做选择分布重测');
    process.exit(2);
  }
  const decisionState = buildDecisionState(state, selected.agent.id, selected.legal, []);
  const input = {
    runId: 'local-p6-04b-reliability',
    seed,
    config,
    tick: state.society.tick,
    agentId: selected.agent.id,
    stateHash: computeDecisionStateHash(decisionState),
    actionSetHash: computeActionSetHash(selected.legal.actions),
    legal: selected.legal,
    state: decisionState,
    simState: state,
    topK: 1,
    requestedModel: options.model,
    promptVersion: PROMPT_VERSION,
    promptStyle: options.promptStyle,
    recentEvents: [],
  };
  const stateInfo = {
    tick: state.society.tick,
    agentId: selected.agent.id,
    legalActions: selected.legal.actions,
    stateHash: input.stateHash,
    actionSetHash: input.actionSetHash,
    population: options.population,
    seed: options.seed,
  };
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          endpoint,
          requestedModel: options.model,
          promptStyle: options.promptStyle,
          repeats: options.repeats,
          state: stateInfo,
        },
        null,
        2,
      ),
    );
    return;
  }

  const budget = new AttemptBudget(options.maxCalls ?? options.repeats * 3, options.maxInputTokens);
  const clientOptions = {
    endpoint: process.env.JEV_ENDPOINT,
    requestTimeoutMs: 30_000,
    maxTotalAttempts: 2,
    networkRetryLimit: 1,
    rateLimitRetryLimit: 1,
    serverErrorRetryLimit: 1,
    baseBackoffMs: 500,
    jitterMs: () => 0,
    deadlineMs: Date.now() + 20 * 60 * 1000,
    budget,
    failureWindow: new SlidingCircuitWindow(),
    fallbackRateWindow: new SlidingFallbackRateWindow(),
  };
  const deps = {
    fetchImpl: fetch,
    nowMs: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }),
  };
  const controller = new AbortController();
  const records = [];
  const startedAt = Date.now();
  for (let index = 0; index < options.repeats; index += 1) {
    const result = await callJev(
      input,
      apiKey,
      clientOptions,
      deps,
      options.promptStyle,
      controller.signal,
    );
    const record = result.record;
    records.push({
      selectedAction: record.selectedAction,
      probabilities: record.probabilities,
      probabilitySource: record.probabilitySource,
      source: record.source,
      fallbackReason: record.fallbackReason,
      responseModel: record.responseModel,
      usage: record.usage,
      latencyMs: record.latencyMs,
      attempts: record.attempts,
    });
    process.stderr.write(
      `[jev-reliability] ${index + 1}/${options.repeats} source=${record.source} ` +
        `fallback=${record.fallbackReason ?? 'none'} model=${record.responseModel ?? 'null'}\n`,
    );
    if (record.fallbackReason === 'http_401' || record.fallbackReason === 'http_403') {
      break;
    }
  }
  const summary = summarizeReliability(records, selected.legal.actions);
  const inputTokens = records.reduce((sum, record) => sum + (record.usage.inputTokens ?? 0), 0);
  const outputTokens = records.reduce((sum, record) => sum + (record.usage.outputTokens ?? 0), 0);
  const missingUsage = records.filter(
    (record) => record.source === 'jev_live' && record.usage.inputTokens === undefined,
  ).length;
  const report = {
    schemaVersion: 'jev-reliability-report-v1',
    isExperimentalEvidence: false,
    purpose: '07 §11 test-retest reliability: same state repeated, no simulation rollout',
    experimentId: 'p6-04b-reliability',
    endpoint,
    requestedModel: options.model,
    promptStyle: options.promptStyle,
    repeats: records.length,
    state: stateInfo,
    tokenEstimator: TOKEN_ESTIMATOR_VERSION,
    budget: budget.usage(),
    elapsedMs: Date.now() - startedAt,
    usage: { inputTokens, outputTokens, missingRecords: missingUsage },
    latencyMs: {
      min: records.length === 0 ? null : Math.min(...records.map((record) => record.latencyMs)),
      p50: percentile(
        records.map((record) => record.latencyMs),
        0.5,
      ),
      max: records.length === 0 ? null : Math.max(...records.map((record) => record.latencyMs)),
      samples: records.length,
    },
    summary,
    records,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out !== null) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, text, 'utf8');
    process.stderr.write(`[jev-reliability] 报告写入 ${options.out}\n`);
  }
  process.stdout.write(text);
}

main().catch((error) => {
  console.error(`重测信度失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * P2-07：真实 Jev 冒烟（小规模、低预算、默认不随 CI 运行）。
 *
 * 只做一件事：用真实端点跑一次短 run，证明「认证 → 请求 → 响应解析 → 决策写入」
 * 这条链路在当前网络条件下真的通，并给出可复核的 usage / 回退 / 延迟摘要。
 * **不是实验证据**：参与者规模与 tick 数都远低于 07 §8 的验收口径。
 *
 * 端点必须可配置：官方域名按地域返回 451，受限网络只能经自建网关转发。
 *
 * 用法：
 *   JEV_API_KEY=jv-... node scripts/smoke-live.mjs
 *   JEV_API_KEY=... node scripts/smoke-live.mjs --population 12 --ticks 20 --out out/p2-07-smoke.json
 *
 * 密钥只从 JEV_API_KEY 读取，不打印、不写盘、不进摘要。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createDemoConfig } from '../dist/core/config/defaults.js';
import { asSeed } from '../dist/core/control/ids.js';
import { resolveEndpoint, TOKEN_ESTIMATOR_VERSION } from '../dist/decision/jev-client.js';
import {
  AttemptBudget,
  JevLivePolicy,
  SlidingCircuitWindow,
  SlidingFallbackRateWindow,
} from '../dist/decision/live.js';
import { runSingleWithPolicy } from '../dist/runner/run-cell.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32（ULID）

function newLocalRunId() {
  let time = Date.now();
  let head = '';
  for (let i = 0; i < 10; i += 1) {
    head = ALPHABET[time % 32] + head;
    time = Math.floor(time / 32);
  }
  let tail = '';
  for (let i = 0; i < 16; i += 1) {
    tail += ALPHABET[Math.floor(Math.random() * 32)];
  }
  return `local-${head}${tail}`;
}

function parseArgs(argv) {
  const options = {
    population: 8,
    ticks: 10,
    maxCalls: null,
    maxInputTokens: 200_000,
    endpoint: process.env.JEV_ENDPOINT ?? undefined,
    model: process.env.JEV_MODEL ?? 'jev-1.13.0',
    promptStyle: 'neutral',
    seed: 'p2-07-smoke',
    out: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${flag} 缺少取值`);
      i += 1;
      return value;
    };
    if (flag === '--population') options.population = Number(next());
    else if (flag === '--ticks') options.ticks = Number(next());
    else if (flag === '--max-calls') options.maxCalls = Number(next());
    else if (flag === '--max-input-tokens') options.maxInputTokens = Number(next());
    else if (flag === '--endpoint') options.endpoint = next();
    else if (flag === '--model') options.model = next();
    else if (flag === '--prompt-style') options.promptStyle = next();
    else if (flag === '--seed') options.seed = next();
    else if (flag === '--out') options.out = next();
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        [
          '用法: JEV_API_KEY=jv-... node scripts/smoke-live.mjs [选项]',
          '  --population <n>       人数（默认 8）',
          '  --ticks <n>            最长 tick（默认 10）',
          '  --max-calls <n>        调用预算（默认按决策点数自动估算）',
          '  --max-input-tokens <n> input token 预算（默认 200000）',
          '  --endpoint <url>       覆盖上游端点（默认 JEV_ENDPOINT 或官方地址）',
          '  --model <name>         请求模型名（默认 JEV_MODEL 或 jev-1.13.0）',
          '  --prompt-style <s>     neutral | survival_hint（默认 neutral）',
          '  --seed <s>             run 种子（默认 p2-07-smoke）',
          '  --out <path>           写机器可读摘要 JSON',
          '  --dry-run              只校验配置与端点格式，不发任何请求',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${flag}`);
    }
  }
  return options;
}

function percentile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function summarizeRun(outcome, context) {
  const records = outcome.decisions;
  const due = records.length;
  const ok = records.filter((record) => record.source !== 'fallback').length;
  const fallbacks = due - ok;
  const fallbackReasons = {};
  for (const record of records) {
    if (record.source === 'fallback') {
      const key = record.fallbackReason ?? 'unknown';
      fallbackReasons[key] = (fallbackReasons[key] ?? 0) + 1;
    }
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let listCost = 0;
  let usageMissing = 0;
  const latencies = [];
  const responseModels = new Set();
  for (const record of records) {
    if (record.latencyMs !== null && record.latencyMs !== undefined) {
      latencies.push(record.latencyMs);
    }
    if (record.responseModel !== null) responseModels.add(record.responseModel);
    const usage = record.usage ?? {};
    if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
      usageMissing += 1;
    }
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    const raw = record.rawResponse;
    const cost =
      raw && typeof raw === 'object' && raw.usage && typeof raw.usage === 'object'
        ? raw.usage.cost
        : undefined;
    if (typeof cost === 'number') listCost += cost;
  }
  const fallbackRate = due === 0 ? null : fallbacks / due;
  return {
    ...context,
    runId: records[0]?.runId ?? null,
    decisionsDue: due,
    decisionsOk: ok,
    fallbacks,
    fallbackRate,
    fallbackReasons,
    usage: {
      inputTokens,
      outputTokens,
      listCost,
      missingRecords: usageMissing,
      tokenEstimator: TOKEN_ESTIMATOR_VERSION,
    },
    latencyMs: {
      min: percentile(latencies, 0),
      p50: percentile(latencies, 0.5),
      max: percentile(latencies, 1),
      samples: latencies.length,
    },
    responseModels: [...responseModels],
    finalStateHash: outcome.report.finalStateHash,
    aliveAtEnd: outcome.report.aliveAtEnd,
    endReason: outcome.report.endReason,
    endTick: outcome.report.endTick,
    cancelled: outcome.report.cancelled,
    // 07 §8 的验收口径要求 >=30 配对种子与更长视野；这里只是链路验证。
    isExperimentalEvidence: false,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let endpoint;
  try {
    endpoint = resolveEndpoint(options.endpoint);
  } catch (error) {
    console.error(`端点非法：${error.message}`);
    process.exit(2);
  }

  const apiKey = process.env.JEV_API_KEY ?? '';
  const target = {
    endpoint,
    endpointIsDefault: options.endpoint === undefined,
    requestedModel: options.model,
    promptStyle: options.promptStyle,
    population: options.population,
    maxTicks: options.ticks,
    seed: options.seed,
  };

  if (options.dryRun) {
    console.log(
      JSON.stringify({ dryRun: true, apiKeyPresent: apiKey.length > 0, ...target }, null, 2),
    );
    console.log(`端点：${endpoint}${options.endpoint === undefined ? '（默认官方）' : ''}`);
    console.log(`模型：${options.model}`);
    console.log('未发起任何请求。');
    process.exit(0);
  }

  if (apiKey.length === 0) {
    console.error('缺少 JEV_API_KEY（只从环境变量读取，不接受参数传入）');
    process.exit(2);
  }
  if (!Number.isInteger(options.population) || options.population < 2) {
    console.error('--population 必须是 >=2 的整数');
    process.exit(2);
  }
  if (!Number.isInteger(options.ticks) || options.ticks < 1) {
    console.error('--ticks 必须是 >=1 的整数');
    process.exit(2);
  }

  const config = createDemoConfig({
    population: { initialPopulation: options.population },
    schedule: {
      totalTicks: options.ticks,
      // 校验要求 stride <= totalTicks；短 run 直接按 tick 数收缩。
      statsStride: Math.min(10, options.ticks),
      snapshotStride: Math.min(100, options.ticks),
    },
  });

  const interval = config.decision.interval;
  const decisionPoints = Math.floor(options.ticks / interval) + 1;
  // 每次 attempt（含重试）都占一次预留，留 2 倍余量，避免重试把预算吃光造成假回退。
  const defaultCalls = Math.max(8, options.population * decisionPoints * 2);
  const maxCalls = options.maxCalls ?? defaultCalls;

  const budget = new AttemptBudget(maxCalls, options.maxInputTokens);
  const circuit = new SlidingCircuitWindow();
  const fallbackWindow = new SlidingFallbackRateWindow();
  const policy = new JevLivePolicy(
    apiKey,
    {
      endpoint: options.endpoint,
      requestTimeoutMs: 60_000,
      maxTotalAttempts: 3,
      networkRetryLimit: 2,
      rateLimitRetryLimit: 3,
      serverErrorRetryLimit: 2,
      baseBackoffMs: 500,
      jitterMs: () => Math.floor(Math.random() * 250),
      budget,
      failureWindow: circuit,
      fallbackRateWindow: fallbackWindow,
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

  const runId = newLocalRunId();
  const startedAt = Date.now();
  // 包一层只为诊断：失败时能看到「哪些决策回退、原因是什么」，否则异常会把记录一起吞掉。
  const seen = [];
  const failures = [];
  const tracedPolicy = {
    policyVersion: policy.policyVersion,
    async decide(input, signal) {
      try {
        const record = await policy.decide(input, signal);
        seen.push(record);
        return record;
      } catch (error) {
        // 策略层抛错时记录上下文再上抛：否则回退原因会随异常一起丢失。
        failures.push({
          agentId: input.agentId,
          tick: input.tick,
          code: error.code ?? error.name,
          message: error.message,
        });
        throw error;
      }
    },
  };
  let outcome;
  try {
    outcome = await runSingleWithPolicy(config, asSeed(options.seed), {
      policy: tracedPolicy,
      runId,
      requestedModel: options.model,
      promptStyle: options.promptStyle,
      maxTicks: options.ticks,
    });
  } catch (error) {
    const reasons = {};
    for (const record of seen) {
      const key = record.fallbackReason ?? record.source;
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
    console.error(`冒烟失败：${error.code ?? error.name}: ${error.message}`);
    console.error(
      JSON.stringify(
        {
          ...target,
          runId,
          elapsedMs: Date.now() - startedAt,
          budget: { maxCalls },
          observedDecisions: seen.length,
          observedReasons: reasons,
          failures,
          lastRecord:
            seen.length === 0
              ? null
              : {
                  tick: seen[seen.length - 1].tick,
                  source: seen[seen.length - 1].source,
                  selectedAction: seen[seen.length - 1].selectedAction,
                  fallbackReason: seen[seen.length - 1].fallbackReason,
                  attempts: seen[seen.length - 1].attempts,
                  responseModel: seen[seen.length - 1].responseModel,
                  usage: seen[seen.length - 1].usage,
                  rawResponse: seen[seen.length - 1].rawResponse,
                },
          error: { code: error.code ?? null, message: error.message },
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const summary = summarizeRun(outcome, {
    ...target,
    endpoint,
    elapsedMs: Date.now() - startedAt,
    budget: { maxCalls, maxInputTokens: options.maxInputTokens },
  });
  const passed =
    summary.decisionsOk > 0 &&
    summary.aliveAtEnd > 0 &&
    (summary.fallbackRate === null || summary.fallbackRate <= 0.2);
  summary.passed = passed;

  console.log(JSON.stringify(summary, null, 2));
  if (options.out !== null) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log(`摘要已写入 ${options.out}`);
  }
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`未捕获错误：${error.stack ?? error.message}`);
  process.exit(1);
});

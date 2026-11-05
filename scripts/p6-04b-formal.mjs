#!/usr/bin/env node
/**
 * P6-04b 正式 live/mock/random 对照（07 §11）。
 *
 * 三阶段：
 *   --freeze   冻结预注册设计（10 个新 seed × 4 组：mock、random、live-neutral、
 *              live-survival_hint），写入 designHash 后不得再改；
 *   --run      按预注册执行，mock/random 先跑，live 以并发池跑；ledger 追加式
 *              落盘，断点续跑只跳过已完成的 runKey；
 *   --analyze  按预注册统计口径输出配对 TV(P)、bootstrap 95% 区间、有符号 ΔG
 *              的置换检验、BH 校正与基线波动带，并列出被质量闸门剔除的 run。
 *
 * 密钥只从 JEV_API_KEY 读取（建议 systemd EnvironmentFile 或 --env-file），
 * 不打印、不写摘要、不进命令行。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';

import { createDemoConfig } from '../dist/core/config/defaults.js';
import { asSeed } from '../dist/core/control/ids.js';
import { hashValue } from '../dist/core/hash/hash.js';
import { HASH_DOMAINS } from '../dist/core/hash/domains.js';
import { runSingle, runSingleWithPolicy } from '../dist/runner/run-cell.js';
import {
  AttemptBudget,
  JevLivePolicy,
  SlidingCircuitWindow,
  SlidingFallbackRateWindow,
} from '../dist/decision/live.js';
import {
  LIVE_BASELINE_BAND_RATE,
  LIVE_DIRECTION_MIN_RATE,
  LIVE_FALLBACK_RATE_LIMIT,
  LIVE_PRIMARY_THRESHOLD,
  summarizeFormalLive,
} from '../dist/runner/p6-live-comparison.js';

const FORMAL_SEEDS = Array.from(
  { length: 10 },
  (_, index) => `p6-04b-formal-seed-${String(index + 1).padStart(3, '0')}`,
);
const PROMPT_STYLES = ['neutral', 'survival_hint'];
const BASELINE_POLICIES = ['mock-weighted-v1', 'random-uniform-v1'];
const REQUESTED_MODEL = process.env.JEV_MODEL ?? 'jev-1.13.0';
const ENDPOINT = 'https://jev.logicc.top/v1/systemone';
const PREREG_SCHEMA = 'p6-04b-live-prereg-v1';

const DEFAULTS = {
  prereg: 'out/p6-04b-formal-prereg.json',
  dir: 'out/p6-04b-formal',
  analysisOut: 'out/p6-04b-formal-analysis.json',
  concurrency: 4,
  population: 40,
  ticks: 730,
  decisionInterval: 30,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS, mode: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} 缺少取值`);
      index += 1;
      return value;
    };
    if (flag === '--freeze') options.mode = 'freeze';
    else if (flag === '--run') options.mode = 'run';
    else if (flag === '--analyze') options.mode = 'analyze';
    else if (flag === '--prereg') options.prereg = next();
    else if (flag === '--dir') options.dir = next();
    else if (flag === '--out') options.analysisOut = next();
    else if (flag === '--concurrency') options.concurrency = Number(next());
    else if (flag === '--mock-only') options.mockOnly = true;
    else if (flag === '--live-only') options.liveOnly = true;
    else if (flag === '--force') options.force = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        [
          '用法：',
          '  node scripts/p6-04b-formal.mjs --freeze [--prereg out/...json] [--force]',
          '  node --env-file=.env scripts/p6-04b-formal.mjs --run [--concurrency 4]',
          '      [--prereg out/...json] [--dir out/p6-04b-formal] [--mock-only|--live-only]',
          '  node scripts/p6-04b-formal.mjs --analyze',
          '      [--prereg out/...json] [--dir out/p6-04b-formal] [--out out/...analysis.json]',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${flag}`);
    }
  }
  if (options.mode === null) throw new Error('必须指定 --freeze、--run 或 --analyze 之一');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('--concurrency 必须为 >=1 的整数');
  }
  return options;
}

function buildDesign() {
  const decisionPoints = Math.floor(DEFAULTS.ticks / DEFAULTS.decisionInterval) + 1;
  return {
    schemaVersion: PREREG_SCHEMA,
    hypothesis:
      '正式 P6-04b live 对照（07 §11）：固定 rules-v11、40 人、730 tick、decision.interval=30，' +
      '用 10 个新配对 seed 比较 mock-weighted-v1、random-uniform-v1 与 jev_live，' +
      '并对 jev_live 预注册 neutral / survival_hint 两种提示。主指标 TV(P) 达到 0.10、' +
      'bootstrap 95% 区间不跨 0、ΔG 方向一致率 >=0.90、候选-基线 D 100% 超出 baseline D95 ' +
      '才称 descriptive-structural-candidate；单个 10-seed 集合不满足 07 §8 第 4 条独立确认，' +
      '因此不构成确认、校准或现实因果。',
    experimentType: 'jev_behavior',
    rulesVersion: 'rules-v11',
    population: DEFAULTS.population,
    ticks: DEFAULTS.ticks,
    decisionInterval: DEFAULTS.decisionInterval,
    decisionPoints,
    nominalDueDecisionsPerRun: DEFAULTS.population * decisionPoints,
    warmupTicks: 365,
    window: { label: 'w1', start: 365, end: 729, tickCount: 365 },
    seeds: FORMAL_SEEDS,
    pairing: 'same-seed-derived-initial-population-and-addressed-random',
    policies: [
      { policyVersion: 'mock-weighted-v1', promptStyle: null, runs: FORMAL_SEEDS.length },
      { policyVersion: 'random-uniform-v1', promptStyle: null, runs: FORMAL_SEEDS.length },
      { policyVersion: 'jev_live', promptStyle: 'neutral', runs: FORMAL_SEEDS.length },
      { policyVersion: 'jev_live', promptStyle: 'survival_hint', runs: FORMAL_SEEDS.length },
    ],
    requestedModel: REQUESTED_MODEL,
    promptVersion: 'prompt-v3',
    endpoint: ENDPOINT,
    primaryMetric: 'TV(P)',
    primaryThreshold: LIVE_PRIMARY_THRESHOLD,
    directionMetric: 'deltaG',
    directionMinRate: LIVE_DIRECTION_MIN_RATE,
    baselineBandRate: LIVE_BASELINE_BAND_RATE,
    baselineD95Method: 'pairwise-D-nearest-rank-0.95',
    analysis: {
      bootstrapIterations: 10_000,
      permutationIterations: 100_000,
      analysisSeed: 20261105,
      bhQ: 0.05,
      family: [
        'live(neutral) vs mock',
        'live(neutral) vs random',
        'live(survival_hint) vs mock',
        'live(survival_hint) vs random',
        'live(survival_hint) vs live(neutral)',
      ],
      tvPermutationTest: 'not-applicable: TV(P) 非负，符号翻转零分布不以 0 为中心',
    },
    exclusionRules: {
      excludeExtinctRuns: true,
      excludeUnavailableWindows: true,
      excludeNetworkEmptyFromSegregation: true,
      maxTechnicalRetries: 1,
      maxFallbackRate: LIVE_FALLBACK_RATE_LIMIT,
      excludeModelDrift: true,
      excludeMissingUsage: true,
      excludeCancelled: true,
    },
    budgets: {
      maxCalls: 25_000,
      maxInputTokens: 45_000_000,
      maxWallMinutes: 240,
      concurrency: DEFAULTS.concurrency,
    },
    reliabilityGate: {
      source: 'changes/0054',
      top1Agreement: 0.7,
      icc21: 0.9886,
      meanTv: 0.0565,
      verdict: 'reliable',
    },
    confirmationStatus: 'single-seed-set-descriptive',
  };
}

function freeze(options) {
  const design = buildDesign();
  const designHash = hashValue(HASH_DOMAINS.preregistration, design);
  if (existsSync(options.prereg) && !options.force) {
    throw new Error(
      `${options.prereg} 已存在；预注册不得覆盖（确需重冻结用 --force 并新建 experimentId）`,
    );
  }
  const artifact = {
    schemaVersion: PREREG_SCHEMA,
    experimentId: `p6-04b-formal-${designHash.slice('sha256:'.length, 'sha256:'.length + 8)}`,
    createdAt: new Date().toISOString(),
    hashDomain: HASH_DOMAINS.preregistration,
    hashPreimage: 'JCS(design)',
    designHash,
    design,
  };
  mkdirSync(dirname(options.prereg), { recursive: true });
  writeFileSync(options.prereg, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        frozen: true,
        prereg: options.prereg,
        experimentId: artifact.experimentId,
        designHash,
        seeds: design.seeds.length,
        liveRuns: design.seeds.length * PROMPT_STYLES.length,
      },
      null,
      2,
    ),
  );
}

function loadPrereg(options) {
  if (!existsSync(options.prereg)) {
    throw new Error(`缺少预注册文件 ${options.prereg}；先执行 --freeze`);
  }
  const artifact = JSON.parse(readFileSync(options.prereg, 'utf8'));
  const recomputed = hashValue(HASH_DOMAINS.preregistration, artifact.design);
  if (recomputed !== artifact.designHash) {
    throw new Error(`预注册哈希不匹配：文件 ${artifact.designHash}，重算 ${recomputed}`);
  }
  return artifact;
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
  const sorted = [...latencies].sort((left, right) => left - right);
  return {
    due: decisions.length,
    fallbacks: decisions.filter((record) => record.fallbackReason !== null).length,
    fallbackReasons,
    responseModels: [...responseModels].sort(),
    probabilitySources,
    usage: { inputTokens, outputTokens, missingRecords: missingUsage },
    latencyMs: {
      min: sorted.length === 0 ? null : (sorted[0] ?? null),
      p50: sorted.length === 0 ? null : (sorted[Math.floor(0.5 * sorted.length)] ?? null),
      max: sorted.length === 0 ? null : (sorted[sorted.length - 1] ?? null),
      samples: sorted.length,
    },
  };
}

function runKeyOf(policyVersion, promptStyle, seed) {
  return `${policyVersion}:${promptStyle ?? 'none'}:${seed}`;
}

function readLedger(path) {
  if (!existsSync(path)) return new Map();
  const records = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line);
    if (record.status === 'ok') records.set(record.runKey, record);
  }
  return records;
}

function appendLedger(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

function makeConfig(design) {
  return createDemoConfig({
    population: { initialPopulation: design.population },
    schedule: { totalTicks: design.ticks, statsStride: 1, snapshotStride: 100 },
    decision: { interval: design.decisionInterval },
  });
}

function baseRecord(design, policyVersion, promptStyle, seed) {
  return {
    schemaVersion: 'p6-04b-formal-run-v1',
    runKey: runKeyOf(policyVersion, promptStyle, seed),
    experimentId: design.experimentId,
    seed,
    policyVersion,
    promptStyle,
    requestedModel: policyVersion === 'jev_live' ? REQUESTED_MODEL : null,
    population: design.population,
    ticks: design.ticks,
    decisionInterval: design.decisionInterval,
    startedAt: new Date().toISOString(),
  };
}

function recordFromRun(design, base, side, decisions, elapsedMs) {
  const summary = decisionSummary(decisions);
  const models = summary.responseModels;
  return {
    ...base,
    status: 'ok',
    elapsedMs,
    finalStateHash: side.finalStateHash,
    aliveAtEnd: side.aliveAtEnd,
    extinct: side.extinct,
    endTick: side.endTick,
    endReason: side.endReason,
    cancelled: false,
    window: side.window,
    dueDecisions: summary.due,
    fallbackRate: summary.due === 0 ? null : summary.fallbacks / summary.due,
    responseModels: models,
    missingUsage: summary.usage.missingRecords,
    decisions: summary,
  };
}

function failedRecord(design, base, error, decisions, elapsedMs) {
  const summary = decisionSummary(decisions);
  return {
    ...base,
    status: 'failed',
    elapsedMs,
    error: {
      code: error?.code ?? error?.name ?? 'UNKNOWN',
      message: error instanceof Error ? error.message : String(error),
    },
    cancelled: error?.code === 'JEV_CANCELLED',
    dueDecisions: summary.due,
    fallbackRate: summary.due === 0 ? null : summary.fallbacks / summary.due,
    responseModels: summary.responseModels,
    missingUsage: summary.usage.missingRecords,
    decisions: summary,
  };
}

async function runBaselines(options, design, config, ledger, ledgerPath) {
  for (const seed of design.seeds) {
    for (const policyVersion of BASELINE_POLICIES) {
      const runKey = runKeyOf(policyVersion, null, seed);
      if (ledger.has(runKey)) continue;
      const base = baseRecord(design, policyVersion, null, seed);
      const startedAt = Date.now();
      try {
        const outcome = runSingle(config, asSeed(seed), { policy: policyVersion });
        const record = recordFromRun(
          design,
          base,
          sideSummary(outcome),
          [],
          Date.now() - startedAt,
        );
        appendLedger(ledgerPath, record);
        ledger.set(runKey, record);
        process.stderr.write(`[baseline] ${runKey} ok\n`);
      } catch (error) {
        const record = failedRecord(design, base, error, [], Date.now() - startedAt);
        appendLedger(ledgerPath, record);
        process.stderr.write(`[baseline] ${runKey} failed: ${record.error.message}\n`);
      }
    }
  }
}

async function runPool(tasks, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      await worker(tasks[index], index);
    }
  });
  await Promise.all(workers);
}

async function runLive(options, design, config, ledger, ledgerPath) {
  const apiKey = process.env.JEV_API_KEY ?? '';
  if (apiKey.length === 0) {
    throw new Error('缺少 JEV_API_KEY；用 systemd EnvironmentFile 或 --env-file=.env 提供');
  }
  const liveTasks = [];
  for (const seed of design.seeds) {
    for (const promptStyle of PROMPT_STYLES) {
      const runKey = runKeyOf('jev_live', promptStyle, seed);
      if (!ledger.has(runKey)) liveTasks.push({ seed, promptStyle, runKey });
    }
  }
  if (liveTasks.length === 0) {
    process.stderr.write('[live] 所有 live run 已完成，跳过\n');
    return;
  }
  const budget = new AttemptBudget(design.budgets.maxCalls, design.budgets.maxInputTokens);
  const deadline = Date.now() + design.budgets.maxWallMinutes * 60 * 1000;
  let done = 0;
  await runPool(liveTasks, options.concurrency, async (task) => {
    const base = baseRecord(design, 'jev_live', task.promptStyle, task.seed);
    const startedAt = Date.now();
    const seen = [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, deadline - Date.now()));
    timeout.unref?.();
    const policy = new JevLivePolicy(
      apiKey,
      {
        endpoint: process.env.JEV_ENDPOINT ?? design.endpoint,
        requestTimeoutMs: 60_000,
        maxTotalAttempts: 3,
        networkRetryLimit: 2,
        rateLimitRetryLimit: 3,
        serverErrorRetryLimit: 2,
        baseBackoffMs: 500,
        jitterMs: () => 0,
        deadlineMs: deadline,
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
    const tracedPolicy = {
      policyVersion: policy.policyVersion,
      async decide(input, signal) {
        const record = await policy.decide(input, signal);
        seen.push(record);
        return record;
      },
    };
    try {
      const outcome = await runSingleWithPolicy(config, asSeed(task.seed), {
        policy: tracedPolicy,
        runId: `p6-04b-formal-${task.runKey}`.replace(/[^A-Za-z0-9-]/g, '-'),
        requestedModel: REQUESTED_MODEL,
        promptStyle: task.promptStyle,
        maxTicks: design.ticks,
        signal: controller.signal,
      });
      const record = recordFromRun(
        design,
        base,
        sideSummary(outcome),
        seen,
        Date.now() - startedAt,
      );
      appendLedger(ledgerPath, record);
      ledger.set(task.runKey, record);
    } catch (error) {
      const record = failedRecord(design, base, error, seen, Date.now() - startedAt);
      appendLedger(ledgerPath, record);
      process.stderr.write(`[live] ${task.runKey} failed: ${record.error.message}\n`);
    } finally {
      clearTimeout(timeout);
      if (seen.length > 0) {
        const rawDir = join(options.dir, 'raw');
        mkdirSync(rawDir, { recursive: true });
        writeFileSync(
          join(rawDir, `${task.runKey.replace(/[^A-Za-z0-9-]/g, '_')}.ndjson.gz`),
          gzipSync(seen.map((record) => JSON.stringify(record)).join('\n') + '\n'),
        );
      }
      done += 1;
      process.stderr.write(`[live] ${done}/${liveTasks.length} ${task.runKey}\n`);
    }
  });
}

async function run(options) {
  const artifact = loadPrereg(options);
  const design = artifact.design;
  design.experimentId = artifact.experimentId;
  const config = makeConfig(design);
  mkdirSync(options.dir, { recursive: true });
  const ledgerPath = join(options.dir, 'runs.ndjson');
  const ledger = readLedger(ledgerPath);
  process.stderr.write(
    `[run] ${artifact.experimentId} 已完成 ${ledger.size}/${design.seeds.length * 4} 个 run\n`,
  );
  if (options.mockOnly) {
    await runBaselines(options, design, config, ledger, ledgerPath);
    return;
  }
  if (!options.liveOnly) {
    await runBaselines(options, design, config, ledger, ledgerPath);
  }
  await runLive(options, design, config, ledger, ledgerPath);
}

function analyze(options) {
  const artifact = loadPrereg(options);
  const design = artifact.design;
  const ledgerPath = join(options.dir, 'runs.ndjson');
  if (!existsSync(ledgerPath)) throw new Error(`缺少 ledger ${ledgerPath}`);
  const records = [];
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line);
    if (record.status === 'ok') records.push(record);
  }
  const summary = summarizeFormalLive(
    records.map((record) => ({
      runKey: record.runKey,
      seed: record.seed,
      policyVersion: record.policyVersion,
      promptStyle: record.promptStyle,
      window: record.window,
      extinct: record.extinct,
      endReason: record.endReason,
      cancelled: record.cancelled,
      fallbackRate: record.fallbackRate,
      responseModels: record.responseModels,
      missingUsage: record.missingUsage,
    })),
    {
      nRequired: design.seeds.length,
      bootstrapIterations: design.analysis.bootstrapIterations,
      permutationIterations: design.analysis.permutationIterations,
      analysisSeed: design.analysis.analysisSeed,
    },
  );
  const output = {
    schemaVersion: 'p6-04b-formal-analysis-v1',
    isExperimentalEvidence: false,
    experimentId: artifact.experimentId,
    preregistration: {
      path: options.prereg,
      designHash: artifact.designHash,
      createdAt: artifact.createdAt,
    },
    completedRuns: records.length,
    expectedRuns: design.seeds.length * 4,
    summary,
  };
  mkdirSync(dirname(options.analysisOut), { recursive: true });
  writeFileSync(options.analysisOut, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(output, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'freeze') return freeze(options);
  if (options.mode === 'run') return run(options);
  if (options.mode === 'analyze') return analyze(options);
  throw new Error(`未知模式 ${options.mode}`);
}

main().catch((error) => {
  console.error(`p6-04b-formal 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

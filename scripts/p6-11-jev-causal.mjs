#!/usr/bin/env node
/**
 * P6-11（阶段 R3 / ADR 0013）：真实 Jev 提示词规范诱导宏观相变 30-seed 配对因果实验。
 *
 * 三阶段：
 *   --freeze   冻结预注册设计（30 新 seed × 3 组：mock-weighted-v1、live-neutral、live-survival_hint）
 *   --run      按预注册执行，mock 先跑，live 以并发池跑；ledger 追加式落盘支持断点续跑
 *   --analyze  按 ADR 0013 输出 ΔO（主指标）/ ΔS / ΔMup / ΔG 的 bootstrap 95% CI、置换检验与 BH 校正
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';

import { createDemoConfig } from '../dist/core/config/defaults.js';
import { asSeed } from '../dist/core/control/ids.js';
import { hashValue } from '../dist/core/hash/hash.js';
import { HASH_DOMAINS } from '../dist/core/hash/domains.js';
import { runSingle, runSingleWithPolicy } from '../dist/runner/run-cell.js';
import { nodeCheckpointHost } from '../dist/runner/checkpoint-fs.js';
import { readNdjsonTolerant } from '../dist/runner/ndjson.js';
import {
  AttemptBudget,
  JevLivePolicy,
  SlidingCircuitWindow,
  SlidingFallbackRateWindow,
} from '../dist/decision/live.js';
import { bootstrapMedianCi, median, signFlipPermutationP } from '../dist/runner/p6-analysis.js';

function tvDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return 0.5 * sum;
}
import {
  LIVE_FALLBACK_RATE_LIMIT,
  liveRunExclusionReasons,
} from '../dist/runner/p6-live-comparison.js';

const SEEDS = Array.from({ length: 30 }, (_, i) => `p6-jev-seed-${String(i + 1).padStart(3, '0')}`);
const PROMPT_STYLES = ['neutral', 'survival_hint'];
const REQUESTED_MODEL = process.env.JEV_MODEL ?? 'jev-1.13.0';
const ENDPOINT = process.env.JEV_ENDPOINT ?? 'https://jev.logicc.top/v1/systemone';
const PREREG_SCHEMA = 'p6-11-jev-causal-prereg-v1';

const DEFAULTS = {
  prereg: 'out/p6-11-jev-causal-prereg.json',
  dir: 'out/p6-11-jev-causal',
  analysisOut: 'out/p6-11-jev-causal-analysis.json',
  concurrency: 6,
  minIntervalMs: 0,
  checkpointEveryTicks: 30,
  quotaWaitMinutes: 0,
  maxResumeAttempts: 48,
  maxWallMinutes: null,
  population: 40,
  ticks: 730,
  decisionInterval: 30,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS, mode: null, mockOnly: false, liveOnly: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const val = argv[i + 1];
      if (val === undefined) throw new Error(`${flag} 缺少取值`);
      i += 1;
      return val;
    };
    if (flag === '--freeze') options.mode = 'freeze';
    else if (flag === '--run') options.mode = 'run';
    else if (flag === '--analyze') options.mode = 'analyze';
    else if (flag === '--prereg') options.prereg = next();
    else if (flag === '--dir') options.dir = next();
    else if (flag === '--out') options.analysisOut = next();
    else if (flag === '--concurrency') options.concurrency = Number(next());
    else if (flag === '--min-interval-ms') options.minIntervalMs = Number(next());
    else if (flag === '--quota-wait-minutes') options.quotaWaitMinutes = Number(next());
    else if (flag === '--max-resume-attempts') options.maxResumeAttempts = Number(next());
    else if (flag === '--max-wall-minutes') options.maxWallMinutes = Number(next());
    else if (flag === '--mock-only') options.mockOnly = true;
    else if (flag === '--live-only') options.liveOnly = true;
    else if (flag === '--force') options.force = true;
    else throw new Error(`未知参数：${flag}`);
  }
  if (options.mode === null) throw new Error('必须指定 --freeze、--run 或 --analyze');
  if (!Number.isFinite(options.minIntervalMs) || options.minIntervalMs < 0) {
    throw new Error('--min-interval-ms 必须为非负有限数字');
  }
  if (!Number.isFinite(options.quotaWaitMinutes) || options.quotaWaitMinutes < 0) {
    throw new Error('--quota-wait-minutes 必须为非负有限数字');
  }
  if (!Number.isInteger(options.maxResumeAttempts) || options.maxResumeAttempts < 1) {
    throw new Error('--max-resume-attempts 必须为正整数');
  }
  if (
    options.maxWallMinutes !== null &&
    (!Number.isFinite(options.maxWallMinutes) || options.maxWallMinutes <= 0)
  ) {
    throw new Error('--max-wall-minutes 必须为正有限数字');
  }
  return options;
}

function buildDesign() {
  const baseCfg = createDemoConfig();
  return {
    schemaVersion: PREREG_SCHEMA,
    adr: 'ADR 0013',
    rulesVersion: baseCfg.rulesVersion,
    population: DEFAULTS.population,
    ticks: DEFAULTS.ticks,
    decisionInterval: DEFAULTS.decisionInterval,
    window: { label: 'w1', start: 365, end: 729, tickCount: 365 },
    seeds: SEEDS,
    groups: [
      { policyVersion: 'mock-weighted-v1', promptStyle: null, runs: SEEDS.length },
      { policyVersion: 'jev_live', promptStyle: 'neutral', runs: SEEDS.length },
      { policyVersion: 'jev_live', promptStyle: 'survival_hint', runs: SEEDS.length },
    ],
    requestedModel: REQUESTED_MODEL,
    promptVersion: 'prompt-v3',
    endpoint: ENDPOINT,
    primaryComparison: 'live(survival_hint) vs live(neutral)',
    primaryMetric: 'deltaO',
    effectThreshold: 0.05,
    secondaryMetrics: ['deltaS', 'deltaMup'],
    analysis: {
      bootstrapIterations: 10_000,
      permutationIterations: 100_000,
      analysisSeed: 20261118,
      bhQ: 0.05,
    },
    budgets: {
      maxCalls: 75_000,
      maxInputTokens: 120_000_000,
      maxWallMinutes: 600,
    },
  };
}

function freeze(options) {
  const design = buildDesign();
  const designHash = hashValue(HASH_DOMAINS.preregistration, design);
  if (existsSync(options.prereg) && !options.force) {
    throw new Error(`${options.prereg} 已存在（如需重冻结请使用 --force）`);
  }
  const artifact = {
    schemaVersion: PREREG_SCHEMA,
    experimentId: `p6-11-${designHash.slice('sha256:'.length, 'sha256:'.length + 8)}`,
    createdAt: new Date().toISOString(),
    designHash,
    design,
  };
  mkdirSync(dirname(options.prereg), { recursive: true });
  writeFileSync(options.prereg, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify({ frozen: true, experimentId: artifact.experimentId, designHash }, null, 2),
  );
}

function loadPrereg(options) {
  if (!existsSync(options.prereg)) throw new Error(`缺少 ${options.prereg}，先执行 --freeze`);
  const artifact = JSON.parse(readFileSync(options.prereg, 'utf8'));
  const recomputed = hashValue(HASH_DOMAINS.preregistration, artifact.design);
  if (recomputed !== artifact.designHash) throw new Error('designHash 校验失败');
  return artifact;
}

function runKeyOf(policyVersion, promptStyle, seed) {
  return `${policyVersion}:${promptStyle ?? 'none'}:${seed}`;
}

function readLedger(path) {
  const { records } = readNdjsonTolerant(path, { repairTail: true });
  const ledger = new Map();
  for (const r of records) {
    if (r.status === 'ok') ledger.set(r.runKey, r);
  }
  return ledger;
}

function appendLedger(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

function windowOf(report) {
  const w = report.windows.find((e) => e.label === 'w1');
  if (!w) throw new Error('报告缺少 w1');
  return {
    classShares: w.classShares,
    gini: w.gini,
    mUp: w.mUp,
    mDown: w.mDown,
    segregation: w.segregation,
    openness: w.openness,
    fallbackRate: w.fallbackRate,
    tickCount: w.tickCount,
    observedTicks: w.observedTicks,
    missingTicks: w.missingTicks,
  };
}

function decisionSummary(decisions) {
  const responseModels = new Set();
  const fallbackReasons = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let missingUsage = 0;
  const latencies = [];
  for (const d of decisions) {
    if (d.fallbackReason !== null) {
      fallbackReasons[d.fallbackReason] = (fallbackReasons[d.fallbackReason] ?? 0) + 1;
    }
    if (d.responseModel !== null) responseModels.add(d.responseModel);
    inputTokens += d.usage.inputTokens ?? 0;
    outputTokens += d.usage.outputTokens ?? 0;
    if (d.source === 'jev_live' && d.usage.inputTokens === undefined) missingUsage += 1;
    latencies.push(d.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  return {
    due: decisions.length,
    fallbacks: decisions.filter((d) => d.fallbackReason !== null).length,
    fallbackReasons,
    responseModels: [...responseModels].sort(),
    usage: { inputTokens, outputTokens, missingRecords: missingUsage },
    latencyMs: {
      min: latencies[0] ?? null,
      p50: latencies[Math.floor(latencies.length * 0.5)] ?? null,
      max: latencies[latencies.length - 1] ?? null,
    },
  };
}

async function runPool(tasks, concurrency, worker) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= tasks.length) return;
        await worker(tasks[idx]);
      }
    }),
  );
}

function makeConfig(design) {
  return createDemoConfig({
    population: { initialPopulation: design.population },
    schedule: { totalTicks: design.ticks, statsStride: 1, snapshotStride: 100 },
    decision: { interval: design.decisionInterval },
  });
}

async function executeRun(options) {
  const artifact = loadPrereg(options);
  const { design } = artifact;
  const config = makeConfig(design);
  const ledgerPath = join(options.dir, 'ledger.ndjson');
  const ledger = existsSync(ledgerPath) ? readLedger(ledgerPath) : new Map();

  if (!options.liveOnly) {
    for (const seed of design.seeds) {
      const runKey = runKeyOf('mock-weighted-v1', null, seed);
      if (ledger.has(runKey)) continue;
      const t0 = Date.now();
      const outcome = runSingle(config, asSeed(seed), {});
      const record = {
        runKey,
        seed,
        policyVersion: 'mock-weighted-v1',
        promptStyle: null,
        status: 'ok',
        elapsedMs: Date.now() - t0,
        extinct: outcome.report.extinct,
        endReason: outcome.report.endReason,
        cancelled: false,
        finalStateHash: outcome.report.finalStateHash,
        window: windowOf(outcome.report),
        fallbackRate: 0,
        responseModels: [],
        missingUsage: 0,
      };
      appendLedger(ledgerPath, record);
      ledger.set(runKey, record);
    }
    process.stderr.write(`[mock] 30/30 完成\n`);
  }

  if (options.mockOnly) return;

  const apiKey = process.env.JEV_API_KEY ?? '';
  if (!apiKey) throw new Error('缺少 JEV_API_KEY');
  const liveTasks = [];
  for (const seed of design.seeds) {
    for (const promptStyle of PROMPT_STYLES) {
      const runKey = runKeyOf('jev_live', promptStyle, seed);
      if (!ledger.has(runKey)) liveTasks.push({ seed, promptStyle, runKey });
    }
  }
  if (liveTasks.length === 0) {
    process.stderr.write('[live] 60/60 已全部完成\n');
    return;
  }

  const budget = new AttemptBudget(design.budgets.maxCalls, design.budgets.maxInputTokens);
  const wallMinutes = options.maxWallMinutes ?? design.budgets.maxWallMinutes;
  const deadline = Date.now() + wallMinutes * 60 * 1000;
  const checkpointsDir = join(options.dir, 'checkpoints');
  mkdirSync(checkpointsDir, { recursive: true });
  const checkpointHost = nodeCheckpointHost();
  let done = 0;
  let nextAllowedAt = 0;
  const sleepAbortable = (ms, sig) =>
    new Promise((resolve) => {
      if (ms <= 0 || sig?.aborted) {
        resolve();
        return;
      }
      const tm = setTimeout(resolve, ms);
      sig?.addEventListener(
        'abort',
        () => {
          clearTimeout(tm);
          resolve();
        },
        { once: true },
      );
    });
  const waitPacer = async (sig) => {
    if (options.minIntervalMs <= 0) return;
    const now = Date.now();
    const waitMs = Math.max(0, nextAllowedAt - now);
    nextAllowedAt = Math.max(now, nextAllowedAt) + options.minIntervalMs;
    if (waitMs > 0) await sleepAbortable(waitMs, sig);
  };

  await runPool(liveTasks, options.concurrency, async (task) => {
    const t0 = Date.now();
    const safeKey = task.runKey.replace(/[^A-Za-z0-9-]/g, '_');
    const checkpointPath = join(checkpointsDir, `${safeKey}.progress.json`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, deadline - Date.now()));
    timer.unref?.();
    let seen = [];
    try {
      for (let attempt = 1; ; attempt += 1) {
        seen = [];
        const policy = new JevLivePolicy(
          apiKey,
          {
            endpoint: process.env.JEV_ENDPOINT ?? design.endpoint,
            requestTimeoutMs: 60_000,
            maxTotalAttempts: 5,
            networkRetryLimit: 3,
            rateLimitRetryLimit: 4,
            serverErrorRetryLimit: 4,
            baseBackoffMs: 1500,
            jitterMs: () => 0,
            deadlineMs: deadline,
            budget,
            failureWindow: new SlidingCircuitWindow(),
            fallbackRateWindow: new SlidingFallbackRateWindow(),
          },
          {
            fetchImpl: fetch,
            sleep: (ms, sig) =>
              new Promise((resolve) => {
                const tm = setTimeout(resolve, ms);
                sig.addEventListener('abort', () => {
                  clearTimeout(tm);
                  resolve();
                });
              }),
            nowMs: () => Date.now(),
          },
        );
        const tracedPolicy = {
          policyVersion: policy.policyVersion,
          async decide(input, sig) {
            await waitPacer(sig);
            const rec = await policy.decide(input, sig);
            if (options.minIntervalMs > 0 && rec.fallbackReason === 'retry_after_exceeded') {
              nextAllowedAt = Math.max(nextAllowedAt, Date.now() + 65_000);
            }
            seen.push(rec);
            return rec;
          },
        };
        try {
          const outcome = await runSingleWithPolicy(config, asSeed(task.seed), {
            policy: tracedPolicy,
            runId: `p6-11-${task.runKey}`.replace(/[^A-Za-z0-9-]/g, '-'),
            requestedModel: design.requestedModel,
            promptStyle: task.promptStyle,
            maxTicks: design.ticks,
            signal: controller.signal,
            runCheckpoint: {
              host: checkpointHost,
              path: checkpointPath,
              everyTicks: options.checkpointEveryTicks,
              cellKey: task.runKey,
            },
          });
          const allDecisions = outcome.decisions ?? seen;
          const ds = decisionSummary(allDecisions);
          const record = {
            runKey: task.runKey,
            seed: task.seed,
            policyVersion: 'jev_live',
            promptStyle: task.promptStyle,
            status: 'ok',
            elapsedMs: Date.now() - t0,
            extinct: outcome.report.extinct,
            endReason: outcome.report.endReason,
            cancelled: outcome.cancelled,
            finalStateHash: outcome.report.finalStateHash,
            window: windowOf(outcome.report),
            decisions: ds,
            fallbackRate: ds.due === 0 ? null : ds.fallbacks / ds.due,
            responseModels: ds.responseModels,
            missingUsage: ds.usage.missingRecords,
          };
          appendLedger(ledgerPath, record);
          ledger.set(task.runKey, record);
          if (allDecisions.length > 0) {
            const rawDir = join(options.dir, 'raw');
            mkdirSync(rawDir, { recursive: true });
            writeFileSync(
              join(rawDir, `${safeKey}.ndjson.gz`),
              gzipSync(allDecisions.map((r) => JSON.stringify(r)).join('\n') + '\n'),
            );
          }
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = err && typeof err === 'object' ? err.code : undefined;
          const isQuotaPause =
            code === 'jev_circuit_open' ||
            code === 'jev_fallback_rate_exceeded' ||
            /熔断|回退率超过阈值/.test(msg);
          if (
            isQuotaPause &&
            options.quotaWaitMinutes > 0 &&
            attempt < options.maxResumeAttempts &&
            Date.now() + 60_000 < deadline
          ) {
            process.stderr.write(
              `[live] PAUSED ${task.runKey} (attempt ${attempt}/${options.maxResumeAttempts}): ${msg}; waiting ${options.quotaWaitMinutes}m to resume from checkpoint...\n`,
            );
            await sleepAbortable(options.quotaWaitMinutes * 60_000, controller.signal);
            if (!controller.signal.aborted) {
              continue;
            }
          }
          const record = {
            runKey: task.runKey,
            seed: task.seed,
            policyVersion: 'jev_live',
            promptStyle: task.promptStyle,
            status: 'failed',
            elapsedMs: Date.now() - t0,
            error: msg,
            decisions: decisionSummary(seen),
          };
          appendLedger(ledgerPath, record);
          process.stderr.write(`[live] FAILED ${task.runKey}: ${record.error}\n`);
          if (seen.length > 0) {
            const rawDir = join(options.dir, 'raw');
            mkdirSync(rawDir, { recursive: true });
            writeFileSync(
              join(rawDir, `${safeKey}.ndjson.gz`),
              gzipSync(seen.map((r) => JSON.stringify(r)).join('\n') + '\n'),
            );
          }
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      done += 1;
      process.stderr.write(`[live] ${done}/${liveTasks.length} ${task.runKey}\n`);
    }
  });
}

function benjaminiHochberg(pValues, q = 0.05) {
  const m = pValues.length;
  const indexed = pValues.map((p, idx) => ({ p, idx })).sort((a, b) => a.p - b.p);
  const adjusted = new Array(m).fill(1);
  let prev = 1;
  for (let i = m - 1; i >= 0; i -= 1) {
    const rank = i + 1;
    const adj = Math.min(prev, (indexed[i].p * m) / rank);
    adjusted[indexed[i].idx] = adj;
    prev = adj;
  }
  return adjusted.map((adj, idx) => ({
    rawP: pValues[idx],
    bhAdjustedP: adj,
    significant: adj <= q,
  }));
}

function analyze(options) {
  const artifact = loadPrereg(options);
  const { design } = artifact;
  const ledgerPath = join(options.dir, 'ledger.ndjson');
  const ledger = readLedger(ledgerPath);

  const included = new Map();
  const excluded = [];
  for (const r of ledger.values()) {
    const reasons = liveRunExclusionReasons(r);
    if (reasons.length > 0) {
      excluded.push({ runKey: r.runKey, reasons });
    } else {
      included.set(r.runKey, r);
    }
  }

  const pairs = [];
  const groupCounts = {
    mock: 0,
    'live-neutral': 0,
    'live-survival_hint': 0,
  };
  for (const r of included.values()) {
    if (r.policyVersion === 'mock-weighted-v1') groupCounts.mock += 1;
    else if (r.promptStyle === 'neutral') groupCounts['live-neutral'] += 1;
    else if (r.promptStyle === 'survival_hint') groupCounts['live-survival_hint'] += 1;
  }
  for (const seed of design.seeds) {
    const mock = included.get(runKeyOf('mock-weighted-v1', null, seed));
    const neutral = included.get(runKeyOf('jev_live', 'neutral', seed));
    const survival = included.get(runKeyOf('jev_live', 'survival_hint', seed));
    if (neutral && survival) {
      pairs.push({ seed, mock: mock ?? null, neutral, survival });
    }
  }

  // 执行完整性：三臂各 30 组、90/90 有效、0 剔除、0 缺配对、单一服务端模型、
  // 全部回退率 <= 预注册上限。任一不满足都不得进入因果判定。
  const responseModels = [
    ...new Set(
      [...included.values()].flatMap((r) =>
        (r.responseModels ?? []).filter((model) => model.length > 0),
      ),
    ),
  ].sort();
  const maxFallbackRate = Math.max(
    0,
    ...[...included.values()].map((r) => r.fallbackRate ?? 0),
  );
  const expectedPerGroup = design.seeds.length;
  const completeness = {
    expectedRuns: expectedPerGroup * 3,
    ledgerRuns: ledger.size,
    validRuns: included.size,
    excluded: excluded.length,
    groups: groupCounts,
    pairedSeeds: pairs.length,
    responseModels,
    maxFallbackRate,
    fallbackLimit: LIVE_FALLBACK_RATE_LIMIT,
    complete:
      ledger.size === expectedPerGroup * 3 &&
      included.size === expectedPerGroup * 3 &&
      excluded.length === 0 &&
      groupCounts.mock === expectedPerGroup &&
      groupCounts['live-neutral'] === expectedPerGroup &&
      groupCounts['live-survival_hint'] === expectedPerGroup &&
      pairs.length === expectedPerGroup &&
      responseModels.length === 1 &&
      maxFallbackRate <= LIVE_FALLBACK_RATE_LIMIT,
  };

  const dO = pairs.map((p) => p.survival.window.openness - p.neutral.window.openness);
  const dS = pairs.map((p) => p.survival.window.segregation - p.neutral.window.segregation);
  const dMup = pairs.map((p) => p.survival.window.mUp - p.neutral.window.mUp);
  const dG = pairs.map((p) => p.survival.window.gini - p.neutral.window.gini);
  const tv = pairs.map((p) =>
    tvDistance(p.survival.window.classShares, p.neutral.window.classShares),
  );

  // 分析 seed 一律取自预注册（analysisSeed），不再使用未声明的 20261218。
  const analysisSeed = design.analysis.analysisSeed;
  const summarizeSigned = (vals, name, idxOffset) => {
    const med = median(vals);
    const seed = analysisSeed + idxOffset;
    const [ciLow, ciHigh] = bootstrapMedianCi(vals, {
      iterations: design.analysis.bootstrapIterations,
      seed,
    });
    const pVal = signFlipPermutationP(vals, {
      iterations: design.analysis.permutationIterations,
      seed,
    });
    return {
      metric: name,
      median: med,
      ci95: [ciLow, ciHigh],
      ciExcludesZero: ciLow > 0 || ciHigh < 0,
      permutationP: pVal,
      analysisSeed: seed,
      meetsThreshold05: Math.abs(med) >= 0.05,
    };
  };

  const metrics = [
    summarizeSigned(dO, 'deltaO', 1),
    summarizeSigned(dS, 'deltaS', 2),
    summarizeSigned(dMup, 'deltaMup', 3),
    summarizeSigned(dG, 'deltaG', 4),
  ];
  const bh = benjaminiHochberg(
    metrics.slice(0, 3).map((m) => m.permutationP),
    design.analysis.bhQ,
  );
  for (let i = 0; i < 3; i += 1) {
    metrics[i].bhAdjustedP = bh[i].bhAdjustedP;
    metrics[i].bhSignificant = bh[i].significant;
  }

  const tvMedian = median(tv);
  const [tvLow, tvHigh] = bootstrapMedianCi(tv, {
    iterations: design.analysis.bootstrapIterations,
    seed: analysisSeed + 5,
  });
  const primary = metrics[0];
  const passesCausalClaim =
    completeness.complete &&
    primary.meetsThreshold05 &&
    primary.ciExcludesZero &&
    primary.bhSignificant;

  const out = {
    schemaVersion: 'p6-11-jev-causal-analysis-v2',
    experimentId: artifact.experimentId,
    designHash: artifact.designHash,
    pairedSeeds: pairs.length,
    totalValidRuns: included.size,
    excludedRuns: excluded,
    fallbackLimit: LIVE_FALLBACK_RATE_LIMIT,
    completeness,
    // 预注册只声明 requestedModel；实际服务端模型以 ledger 的 responseModels 为准。
    requestedModel: design.requestedModel,
    observedResponseModels: responseModels,
    comparison: 'live(survival_hint) - live(neutral)',
    metrics,
    tvP: { median: tvMedian, ci95: [tvLow, tvHigh] },
    passesCausalClaim,
  };
  mkdirSync(dirname(options.analysisOut), { recursive: true });
  writeFileSync(options.analysisOut, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(out, null, 2));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === 'freeze') freeze(opts);
  else if (opts.mode === 'run') await executeRun(opts);
  else analyze(opts);
}

main().catch((err) => {
  console.error(`p6-11 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

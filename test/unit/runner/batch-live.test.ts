import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG } from '../../../src/core/config/defaults.js';
import {
  DECISION_SCHEMA_VERSION,
  ENGINE_VERSION,
  RULES_VERSION,
} from '../../../src/core/control/versions.js';
import { errorCodes, StratifyError } from '../../../src/core/control/errors.js';
import type { DecisionInput, DecisionPolicy } from '../../../src/decision/policy.js';
import type { DecisionRecord } from '../../../src/decision/types.js';
import { SharedBatchBudget } from '../../../src/runner/budget.js';
import { RateLimiter, rateLimitedFetch } from '../../../src/runner/rate-limit.js';
import { runBatchWithPolicy } from '../../../src/runner/batch-live.js';
import { validateBatchManifest, type BatchManifest } from '../../../src/runner/batch.js';
import { memoryCheckpointHost } from '../../../src/runner/checkpoint.js';

const BASE_POPULATION = DEFAULT_RUN_CONFIG.population.initialPopulation;

function liveManifest(): BatchManifest {
  return validateBatchManifest({
    schemaVersion: 'batch-v1',
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    populationSize: BASE_POPULATION,
    totalTicks: 20,
    // manifest.policy 描述 run 的策略标识字段；live 批跑用 policyFactory 注入实现。
    policy: 'mock-weighted-v1',
    seeds: ['s1', 's2'],
    cells: [{ cellKey: 'baseline', overrides: {} }],
  });
}

/** 测试替身：异步策略，记录并发峰值与调用数。 */
class FakeLivePolicy implements DecisionPolicy {
  readonly policyVersion = 'fake-live-v1';
  static active = 0;
  static maxActive = 0;
  static calls = 0;
  static readonly requestedModels: string[] = [];

  constructor(
    private readonly budget?: SharedBatchBudget,
    private readonly reserveTokens = 10,
  ) {}

  async decide(input: DecisionInput, signal: AbortSignal): Promise<DecisionRecord> {
    FakeLivePolicy.requestedModels.push(input.requestedModel);
    // 取消语义与真实 client 一致：aborted 时返回 cancelled 回退记录（不抛错），
    // 由 runSingleWithPolicy 的循环头置 cancelled 并停止。
    if (signal.aborted) {
      return this.cancelledRecord(input);
    }
    FakeLivePolicy.active += 1;
    FakeLivePolicy.maxActive = Math.max(FakeLivePolicy.maxActive, FakeLivePolicy.active);
    FakeLivePolicy.calls += 1;
    // 模拟 P2-04 client 的预算预留→结算时序。
    let reserved = 0;
    if (this.budget !== undefined) {
      reserved = this.reserveTokens;
      if (!this.budget.reserve(reserved)) {
        FakeLivePolicy.active -= 1;
        throw new StratifyError(errorCodes.JEV_BUDGET_EXHAUSTED, '共享预算耗尽');
      }
    }
    try {
      // 微任务级让出即可（不引真实计时器，保持测试快速且确定）。
      await Promise.resolve();
      if (signal.aborted) {
        return this.cancelledRecord(input);
      }
      this.budget?.settle(reserved, reserved);
      return makeRecord(input, this.policyVersion, {
        source: 'jev_live',
        fallbackReason: null,
        responseModel: 'fake-live-model',
        usage: { inputTokens: this.reserveTokens, outputTokens: 1 },
        latencyMs: 2,
      });
    } finally {
      FakeLivePolicy.active -= 1;
    }
  }

  private cancelledRecord(input: DecisionInput): DecisionRecord {
    return makeRecord(input, this.policyVersion, {
      source: 'fallback',
      fallbackReason: 'cancelled',
      attempts: 0,
    });
  }
}

/** 按 DecisionRecord 真实 schema 构造测试记录（不做强转）。 */
function makeRecord(
  input: DecisionInput,
  policyVersion: string,
  overrides: {
    source: DecisionRecord['source'];
    fallbackReason: DecisionRecord['fallbackReason'];
    responseModel?: string | null;
    usage?: { inputTokens?: number; outputTokens?: number };
    latencyMs?: number;
    attempts?: number;
  },
): DecisionRecord {
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    runId: input.runId,
    tick: input.tick,
    agentId: input.agentId,
    stateHash: input.stateHash,
    actionSetHash: input.actionSetHash,
    legalActions: [...input.legal.actions],
    policyVersion,
    promptVersion: null,
    promptStyle: input.promptStyle,
    requestedAction: null,
    selectedAction: input.legal.actions[0] ?? 'accumulate',
    source: overrides.source,
    probabilitySource: 'none',
    requestedModel: input.requestedModel,
    responseModel: overrides.responseModel ?? null,
    probabilities: null,
    confidence: null,
    topK: input.topK,
    usage: overrides.usage ?? {},
    latencyMs: overrides.latencyMs ?? 0,
    attempts: overrides.attempts ?? 1,
    fallbackReason: overrides.fallbackReason,
    rawResponse: null,
  };
}

function resetPolicyCounters(): void {
  FakeLivePolicy.active = 0;
  FakeLivePolicy.maxActive = 0;
  FakeLivePolicy.calls = 0;
  FakeLivePolicy.requestedModels.length = 0;
}

describe('SharedBatchBudget（P5-02）', () => {
  it('构造参数校验：调用数与 token 上限必须为正整数', () => {
    expect(() => new SharedBatchBudget(0, 10)).toThrowError(/maxCalls/);
    expect(() => new SharedBatchBudget(1.5, 10)).toThrowError(/maxCalls/);
    expect(() => new SharedBatchBudget(1, 0)).toThrowError(/maxInputTokens/);
    expect(() => new SharedBatchBudget(1, 1.5)).toThrowError(/maxInputTokens/);
  });

  it('keepReserved 将预留转为已花费并清空在途；recordUsageUnknown 不改变预算', () => {
    const budget = new SharedBatchBudget(2, 100);
    expect(budget.reserve(10)).toBe(true);
    expect(budget.inFlightTokens).toBe(10);
    budget.keepReserved(10);
    expect(budget.inFlightTokens).toBe(0);
    expect(budget.usage()).toMatchObject({ callsUsed: 1, tokensSpent: 10, tokensReserved: 0 });
    budget.recordUsageUnknown();
    expect(budget.usage()).toMatchObject({ tokensSpent: 10, tokensReserved: 0 });
  });

  it('跨 run 共享记账：总调用与总 token 不随 run 数放大', () => {
    const budget = new SharedBatchBudget(5, 1000);
    // 两个「run」各预留一次。
    expect(budget.reserve(300)).toBe(true);
    expect(budget.reserve(300)).toBe(true);
    budget.settle(300, 320); // overage → 永久 exhausted（04 §7 fail-closed）
    expect(budget.exhausted).toBe(true);
    expect(budget.usage()).toMatchObject({
      maxCalls: 5,
      maxInputTokens: 1000,
      callsUsed: 2,
      tokensSpent: 320,
      tokensReserved: 300,
      overageDetected: true,
      exhausted: true,
    });
  });

  it('非法构造拒绝', () => {
    expect(() => new SharedBatchBudget(0, 100)).toThrowError(TypeError);
    expect(() => new SharedBatchBudget(5, 0)).toThrowError(TypeError);
    expect(() => new SharedBatchBudget(1.5, 100)).toThrowError(TypeError);
  });

  it('耗尽后 reserve 拒绝（fail-closed）', () => {
    const budget = new SharedBatchBudget(1, 100);
    expect(budget.reserve(60)).toBe(true);
    budget.settle(60, 60);
    expect(budget.reserve(60)).toBe(false); // 调用数耗尽
    const tokens = new SharedBatchBudget(10, 100);
    tokens.reserve(80);
    tokens.settle(80, 80);
    expect(tokens.reserve(80)).toBe(false); // token 耗尽
  });
});

describe('RateLimiter（P5-02）', () => {
  it('并发上限约束在途调用', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 2, minIntervalMs: 0 });
    const release1 = await limiter.acquire();
    const release2 = await limiter.acquire();
    expect(limiter.activeCount).toBe(2);
    // 第 3 个 acquire 挂起等待时隙：释放一个后它才完成。
    let thirdDone = false;
    const third = limiter.acquire().then((release) => {
      thirdDone = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thirdDone).toBe(false);
    expect(limiter.activeCount).toBe(2);
    release1();
    const release3 = await third;
    expect(thirdDone).toBe(true);
    expect(limiter.activeCount).toBe(2);
    release2();
    release3();
    expect(limiter.activeCount).toBe(0);
  });

  it('最小间隔约束相邻调用开始时刻（注入时钟）', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = new RateLimiter({
      maxConcurrent: 4,
      minIntervalMs: 100,
      nowMs: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    const r1 = await limiter.acquire(); // 立即
    r1();
    const r2 = await limiter.acquire(); // 等 100
    expect(sleeps).toEqual([100]);
    r2();
    const r3 = await limiter.acquire();
    expect(sleeps).toEqual([100, 100]);
    r3();
  });

  it('被取消的 acquire 拒绝且不占时隙', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 });
    const release = await limiter.acquire();
    const controller = new AbortController();
    const pending = limiter.acquire(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrowError(/被取消/);
    release();
    expect(limiter.activeCount).toBe(0);
  });

  it('rateLimitedFetch 包裹 fetch 并在完成/失败后释放', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 });
    const fetchImpl = rateLimitedFetch(limiter)(async () => new Response('ok'));
    const response = await fetchImpl('https://example.invalid', {
      signal: new AbortController().signal,
    });
    expect(await response.text()).toBe('ok');
    expect(limiter.activeCount).toBe(0);
  });
});

describe('runBatchWithPolicy（P5-02）', () => {
  it('默认缺预算时拒绝启动；仅显式 requireBudget=false 可关闭', async () => {
    await expect(
      runBatchWithPolicy({
        manifest: liveManifest(),
        policyFactory: () => new FakeLivePolicy(),
      }),
    ).rejects.toThrowError(/默认必须提供批内共享预算/);
  });

  it('runCheckpoint 校验并透传到每个 run（护栏停止后保留检查点）', async () => {
    resetPolicyCounters();
    const budget = new SharedBatchBudget(1000, 1_000_000);
    const host = memoryCheckpointHost();
    const summary = await runBatchWithPolicy({
      manifest: liveManifest(),
      policyFactory: () => new FakeLivePolicy(budget),
      budget,
      maxTicksPerRun: 5,
      runCheckpoint: { host, dir: 'ckpt', everyTicks: 2 },
    });
    expect(summary.totals).toMatchObject({ due: 2, ok: 2, failed: 0 });
    // maxTicks 护栏停止不是正常结束：检查点必须保留，供下一段恢复。
    expect([...host.files.keys()].filter((key) => key.startsWith('ckpt/'))).toEqual([
      'ckpt/run-0.progress.json',
      'ckpt/run-1.progress.json',
    ]);

    await expect(
      runBatchWithPolicy({
        manifest: liveManifest(),
        policyFactory: () => new FakeLivePolicy(),
        budget,
        runCheckpoint: { host, dir: 'ckpt', everyTicks: 0 },
      }),
    ).rejects.toThrowError(/everyTicks/);
    await expect(
      runBatchWithPolicy({
        manifest: liveManifest(),
        policyFactory: () => new FakeLivePolicy(),
        budget,
        runCheckpoint: { host, dir: '', everyTicks: 2 },
      }),
    ).rejects.toThrowError(/runCheckpoint\.dir/);
  });

  it('requestedModel 未指定时不冒充 mock', async () => {
    resetPolicyCounters();
    const budget = new SharedBatchBudget(1000, 1_000_000);
    const summary = await runBatchWithPolicy({
      manifest: liveManifest(),
      policyFactory: () => new FakeLivePolicy(budget),
      budget,
    });
    expect(summary.runs).toHaveLength(2);
    // live 路径的 model 元数据由 manifest/调用方提供；缺省不得回填成 mock。
    expect(FakeLivePolicy.requestedModels.length).toBeGreaterThan(0);
    expect(FakeLivePolicy.requestedModels.every((model) => model === 'unknown')).toBe(true);
  });

  it('并发批跑全成功：并发峰值不超上限，摘要含共享预算用量', async () => {
    resetPolicyCounters();
    const budget = new SharedBatchBudget(1000, 1_000_000);
    const summary = await runBatchWithPolicy({
      manifest: liveManifest(),
      policyFactory: () => new FakeLivePolicy(budget),
      concurrency: 2,
      budget,
    });
    expect(summary.totals).toMatchObject({ due: 2, ok: 2, failed: 0, resumed: 0 });
    expect(FakeLivePolicy.maxActive).toBeLessThanOrEqual(2);
    expect(summary.budgetUsage).toBeDefined();
    expect(summary.budgetUsage?.tokensReserved).toBe(0);
    expect(summary.budgetUsage?.exhausted).toBe(false);
  });

  it('预算耗尽：停止发起新 run，剩余任务按同因失败不冒充完成（G5a）', async () => {
    resetPolicyCounters();
    // 2 任务 × 每 run 3 决策(20 tick / interval 10 → tick 0,10 两决策) × 10 token ≈ 40 token；
    // 给 30 token 预算：第一个 run 中途耗尽。
    const budget = new SharedBatchBudget(100, 30);
    const summary = await runBatchWithPolicy({
      manifest: liveManifest(),
      policyFactory: () => new FakeLivePolicy(budget),
      concurrency: 1,
      budget,
    });
    expect(summary.totals.failed).toBeGreaterThan(0);
    expect(summary.budgetUsage?.exhausted).toBe(true);
    const codes = new Set(summary.failures.map((failure) => failure.code));
    expect(codes.has(errorCodes.JEV_BUDGET_EXHAUSTED)).toBe(true);
    // 所有任务都有明确记录（ok + failed = due）。
    expect(summary.totals.ok + summary.totals.failed).toBe(summary.totals.due);
  });

  it('批级致命失败（auth）停止批次，剩余任务记录同因失败', async () => {
    resetPolicyCounters();
    class AuthFailPolicy implements DecisionPolicy {
      readonly policyVersion = 'fake-auth-v1';
      async decide(): Promise<DecisionRecord> {
        throw new StratifyError(errorCodes.JEV_AUTH_FAILED, '认证失败');
      }
    }
    const summary = await runBatchWithPolicy({
      manifest: liveManifest(),
      policyFactory: () => new AuthFailPolicy(),
      concurrency: 1,
      requireBudget: false,
    });
    expect(summary.totals.ok).toBe(0);
    expect(summary.failures.every((failure) => failure.code === errorCodes.JEV_AUTH_FAILED)).toBe(
      true,
    );
    expect(summary.totals.ok + summary.totals.failed).toBe(summary.totals.due);
  });

  it('取消：不再发起新 run，在途任务计入失败不冒充完成', async () => {
    resetPolicyCounters();
    const controller = new AbortController();
    const host = memoryCheckpointHost();
    const manifest = liveManifest();
    // 专用策略：第一次 decide 阻塞直到 signal abort（确定性取消点），
    // 返回 cancelled 回退记录（与真实 client 的取消语义一致）。
    class HangUntilAbortPolicy implements DecisionPolicy {
      readonly policyVersion = 'fake-hang-abort-v1';
      async decide(input: DecisionInput, signal: AbortSignal): Promise<DecisionRecord> {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return makeRecord(input, this.policyVersion, {
          source: 'fallback',
          fallbackReason: 'cancelled',
          attempts: 0,
        });
      }
    }
    const summaryPromise = runBatchWithPolicy({
      manifest,
      policyFactory: () => new HangUntilAbortPolicy(),
      concurrency: 1,
      signal: controller.signal,
      ledger: { host, path: 'ledger.json' },
      requireBudget: false,
    });
    // 第一个 run 已进入挂起决策后再取消（微任务探测，确定性强于固定毫秒）。
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const summary = await summaryPromise;
    expect(summary.totals.ok).toBeLessThan(summary.totals.due);
    expect(summary.failures.some((failure) => failure.code === 'cancelled')).toBe(true);
    expect(summary.totals.ok + summary.totals.failed).toBe(summary.totals.due);
  });

  it('ledger 续跑时模型/policyVersion 不一致拒绝复用', async () => {
    resetPolicyCounters();
    const host = memoryCheckpointHost();
    const manifest = liveManifest();
    const budget = new SharedBatchBudget(1000, 1_000_000);
    const first = await runBatchWithPolicy({
      manifest,
      policyFactory: () => new FakeLivePolicy(budget),
      budget,
      requestedModel: 'model-a',
      policyVersion: 'fake-live-v1',
      ledger: { host, path: 'live-ledger.json' },
    });
    expect(first.totals.ok).toBe(2);

    await expect(
      runBatchWithPolicy({
        manifest,
        policyFactory: () => new FakeLivePolicy(budget),
        budget,
        requestedModel: 'model-b',
        policyVersion: 'fake-live-v1',
        ledger: { host, path: 'live-ledger.json' },
      }),
    ).rejects.toThrowError(/模型\/prompt 与本次调用不一致/);

    await expect(
      runBatchWithPolicy({
        manifest,
        policyFactory: () => new FakeLivePolicy(budget),
        budget,
        requestedModel: 'model-a',
        policyVersion: 'other-v1',
        ledger: { host, path: 'live-ledger.json' },
      }),
    ).rejects.toThrowError(/policyVersion 与本次调用不一致/);
  });

  it('legacy live ledger 缺少 provenance 时拒绝续跑', async () => {
    resetPolicyCounters();
    const host = memoryCheckpointHost();
    const manifest = liveManifest();
    const budget = new SharedBatchBudget(1000, 1_000_000);
    await runBatchWithPolicy({
      manifest,
      policyFactory: () => new FakeLivePolicy(budget),
      budget,
      ledger: { host, path: 'legacy-ledger.json' },
    });
    const ledger = JSON.parse(host.files.get('legacy-ledger.json') as string) as {
      runs: Record<string, unknown>[];
    };
    for (const run of ledger.runs) {
      delete run['provenance'];
    }
    host.files.set('legacy-ledger.json', JSON.stringify(ledger));

    await expect(
      runBatchWithPolicy({
        manifest,
        policyFactory: () => new FakeLivePolicy(budget),
        budget,
        ledger: { host, path: 'legacy-ledger.json' },
      }),
    ).rejects.toThrowError(/缺少 provenance/);
  });

  it('ledger resume：kill 后只重跑未完成任务', async () => {
    resetPolicyCounters();
    const host = memoryCheckpointHost();
    const manifest = liveManifest();
    class FailAlwaysPolicy implements DecisionPolicy {
      readonly policyVersion = 'fake-fail-always-v1';
      async decide(): Promise<DecisionRecord> {
        throw new StratifyError(errorCodes.INVARIANT_VIOLATED, '注入故障');
      }
    }
    // 第一段：全失败 → ledger 有失败记录；第二段：成功策略 → 全部重试成功。
    const first = await runBatchWithPolicy({
      manifest,
      policyFactory: () => new FailAlwaysPolicy(),
      ledger: { host, path: 'ledger.json' },
      requireBudget: false,
    });
    expect(first.totals.ok).toBe(0);
    const second = await runBatchWithPolicy({
      manifest,
      policyFactory: () => new FakeLivePolicy(),
      ledger: { host, path: 'ledger.json' },
      requireBudget: false,
    });
    expect(second.totals).toMatchObject({ due: 2, ok: 2, failed: 0 });
    // 历史失败保留（07 §3）。
    expect(second.failures.length).toBeGreaterThan(0);
    // 最终摘要与一次性同策略无 ledger 对照的 finalStateHash 一致（确定性口径）。
    const control = await runBatchWithPolicy({
      manifest,
      policyFactory: () => new FakeLivePolicy(),
      requireBudget: false,
    });
    for (const seed of ['s1', 's2']) {
      const resumedRecord = second.runs.find((run) => run.seed === seed);
      const controlRecord = control.runs.find((run) => run.seed === seed);
      expect(resumedRecord?.report.finalStateHash).toBe(controlRecord?.report.finalStateHash);
    }
  });
});

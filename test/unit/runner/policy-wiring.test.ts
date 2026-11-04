import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { errorCodes, StratifyError } from '../../../src/core/control/errors.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { DECISION_SCHEMA_VERSION } from '../../../src/core/control/versions.js';
import { MockPolicy, RandomPolicy } from '../../../src/decision/policies.js';
import type { DecisionInput, DecisionPolicy } from '../../../src/decision/policy.js';
import type { DecisionRecord } from '../../../src/decision/types.js';
import { runSingle, runSingleWithPolicy } from '../../../src/runner/run-cell.js';

/**
 * P2-01/P2-06 接线测试（changes/0015 / ADR-0003）：
 * - runner 通过 DecisionPolicy 接口调用策略，不再硬编码 mock/random；
 * - 决策记录进入 RunOutcome.decisions；
 * - 同步 mock 路径与异步 MockPolicy 路径逐位等价；
 * - 更换策略会改变决策与终态；fallback 计入 decisionsByTick。
 */

const SEED = asSeed('policy-wiring-seed');
const CONFIG = createDemoConfig({
  population: { initialPopulation: 6 },
  schedule: { totalTicks: 60, statsStride: 1, snapshotStride: 100 },
});

function record(input: DecisionInput, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    runId: input.runId,
    tick: input.tick,
    agentId: input.agentId,
    stateHash: input.stateHash,
    actionSetHash: input.actionSetHash,
    legalActions: [...input.legal.actions],
    policyVersion: 'test-scripted-v1',
    promptVersion: null,
    promptStyle: null,
    requestedAction: null,
    selectedAction: 'accumulate',
    source: 'mock',
    probabilitySource: 'derived',
    requestedModel: 'test',
    responseModel: null,
    probabilities: { accumulate: 1 },
    confidence: null,
    topK: 1,
    usage: {},
    latencyMs: 0,
    attempts: 1,
    fallbackReason: null,
    rawResponse: null,
    ...overrides,
  };
}

class AccumulateOnlyPolicy implements DecisionPolicy {
  readonly policyVersion = 'test-accumulate-v1';
  decide(input: DecisionInput): DecisionRecord {
    return record(input);
  }
}

class AuthFailPolicy implements DecisionPolicy {
  readonly policyVersion = 'test-auth-fail-v1';
  calls = 0;
  decide(): DecisionRecord {
    this.calls += 1;
    throw new StratifyError(errorCodes.JEV_AUTH_FAILED, 'Jev 认证失败（http_401）');
  }
}

class AbortAtTickPolicy implements DecisionPolicy {
  readonly policyVersion = 'test-abort-v1';
  constructor(
    private readonly controller: AbortController,
    private readonly atTick: number,
  ) {}
  decide(input: DecisionInput): DecisionRecord {
    if (input.tick >= this.atTick) {
      this.controller.abort();
    }
    return record(input);
  }
}

class FallbackPolicy implements DecisionPolicy {
  readonly policyVersion = 'test-fallback-v1';
  decide(input: DecisionInput): DecisionRecord {
    return record(input, { source: 'fallback', fallbackReason: 'timeout' });
  }
}

describe('Policy 接线（P2-01/P2-06）', () => {
  it('同步 run 通过接口决策并收集 DecisionRecord', () => {
    const outcome = runSingle(CONFIG, SEED, { policy: 'mock-weighted-v1' });
    expect(outcome.decisions.length).toBeGreaterThan(0);
    expect(outcome.decisions.every((entry) => entry.source === 'mock')).toBe(true);
    expect(outcome.decisions[0]?.schemaVersion).toBe(DECISION_SCHEMA_VERSION);
    expect(outcome.decisions[0]?.legalActions.length).toBeGreaterThan(0);
  });

  it('异步 MockPolicy 与同步 mock 路径逐位等价（决策顺序 + 终态哈希）', async () => {
    const sync = runSingle(CONFIG, SEED, { policy: 'mock-weighted-v1' });
    const asyncOutcome = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new MockPolicy(),
      runId: 'local-batch',
      requestedModel: 'mock',
      promptStyle: 'neutral',
    });
    expect(asyncOutcome.report.finalStateHash).toBe(sync.report.finalStateHash);
    expect(asyncOutcome.decisions.map((entry) => entry.selectedAction)).toEqual(
      sync.decisions.map((entry) => entry.selectedAction),
    );
    expect(asyncOutcome.report.aliveAtEnd).toBe(sync.report.aliveAtEnd);
  });

  it('RandomPolicy 在异步路径上确定：同种子两次运行终态一致', async () => {
    const options = {
      policy: new RandomPolicy(),
      runId: 'local-batch',
      requestedModel: 'random',
      promptStyle: 'neutral' as const,
    };
    const first = await runSingleWithPolicy(CONFIG, SEED, options);
    const second = await runSingleWithPolicy(CONFIG, SEED, options);
    expect(second.report.finalStateHash).toBe(first.report.finalStateHash);
    expect(second.decisions.map((entry) => entry.selectedAction)).toEqual(
      first.decisions.map((entry) => entry.selectedAction),
    );
  });

  it('更换 Policy 会改变决策与终态（策略不是装饰）', async () => {
    const mock = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new MockPolicy(),
      runId: 'local-batch',
      requestedModel: 'mock',
      promptStyle: 'neutral',
    });
    const scripted = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new AccumulateOnlyPolicy(),
      runId: 'local-batch',
      requestedModel: 'mock',
      promptStyle: 'neutral',
    });
    expect(scripted.decisions.every((entry) => entry.selectedAction === 'accumulate')).toBe(true);
    expect(mock.decisions.some((entry) => entry.selectedAction !== 'accumulate')).toBe(true);
    expect(scripted.report.finalStateHash).not.toBe(mock.report.finalStateHash);
  });

  it('异步策略默认从 config.decision.topK 读取 topK', async () => {
    const config = createDemoConfig({
      population: { initialPopulation: 6 },
      schedule: { totalTicks: 20, statsStride: 1, snapshotStride: 100 },
      decision: { topK: 3 },
    });
    let seen: number | null = null;
    class CaptureTopKPolicy implements DecisionPolicy {
      readonly policyVersion = 'test-topk-v1';
      decide(input: DecisionInput): DecisionRecord {
        seen = input.topK;
        return record(input);
      }
    }
    await runSingleWithPolicy(config, SEED, {
      policy: new CaptureTopKPolicy(),
      runId: 'local-batch',
      requestedModel: 'mock',
      promptStyle: 'neutral',
    });
    expect(seen).toBe(3);
  });

  it('认证失败抛出后 run 立即终止，不再继续决策', async () => {
    const policy = new AuthFailPolicy();
    await expect(
      runSingleWithPolicy(CONFIG, SEED, {
        policy,
        runId: 'local-batch',
        requestedModel: 'mock',
        promptStyle: 'neutral',
      }),
    ).rejects.toMatchObject({ code: errorCodes.JEV_AUTH_FAILED });
    // 04 §5/§6：401/403 必须停止 live run，而不是让全部个体静默 accumulate。
    expect(policy.calls).toBe(1);
  });

  it('取消后不再结算新 tick，未执行 tick 的决策不进入产物', async () => {
    const controller = new AbortController();
    const outcome = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new AbortAtTickPolicy(controller, 20),
      runId: 'local-batch',
      requestedModel: 'mock',
      promptStyle: 'neutral',
      signal: controller.signal,
    });
    expect(outcome.report.cancelled).toBe(true);
    expect(outcome.stats.length).toBe(20);
    expect(outcome.report.endTick).toBe(19);
    // 被取消 tick 的部分决策不得留下「已决策未执行」记录。
    expect(outcome.decisions.some((entry) => entry.tick >= 20)).toBe(false);
  });

  it('启动前已取消：零 tick、零决策，直接标 cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new MockPolicy(),
      runId: 'local-batch',
      requestedModel: 'mock',
      promptStyle: 'neutral',
      signal: controller.signal,
    });
    expect(outcome.report.cancelled).toBe(true);
    expect(outcome.stats.length).toBe(0);
    expect(outcome.decisions.length).toBe(0);
  });

  it('fallback 来源计入 decisionsByTick.fallbacks', async () => {
    const outcome = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new FallbackPolicy(),
      runId: 'local-batch',
      requestedModel: 'mock',
      promptStyle: 'neutral',
    });
    const fallbackTicks = [...outcome.decisionsByTick.values()].filter(
      (entry) => entry.fallbacks > 0,
    );
    expect(fallbackTicks.length).toBeGreaterThan(0);
    expect(outcome.decisions.every((entry) => entry.source === 'fallback')).toBe(true);
  });
});

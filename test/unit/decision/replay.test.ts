import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { enumerateLegalActions } from '../../../src/core/legal-actions.js';
import {
  buildReplayIndex,
  POLICY_VERSION_MOCK_REPLAY,
  POLICY_VERSION_REPLAY,
  ReplayPolicy,
} from '../../../src/decision/replay.js';
import { buildDecisionState } from '../../../src/decision/serialize.js';
import type { DecisionInput } from '../../../src/decision/policy.js';
import type { DecisionRecord } from '../../../src/decision/types.js';
import { runSingle, runSingleWithPolicy } from '../../../src/runner/run-cell.js';

/**
 * P2-06 回放契约（04 §9）：
 * - 只使用 selectedAction，requestedAction 不得复活；
 * - 合法则重放，缺失/非法记 replay_invalid 并回退 accumulate；
 * - 来源按原始策略区分；回放不消耗上游预算。
 */

const SEED = asSeed('replay-policy-seed');
const CONFIG = createDemoConfig({
  population: { initialPopulation: 6 },
  schedule: { totalTicks: 60, statsStride: 1, snapshotStride: 100 },
});

function inputFor(record: DecisionRecord): DecisionInput {
  const state = createSimulation(CONFIG, SEED);
  const agent = state.society.agents.find((candidate) => candidate.id === record.agentId);
  if (agent === undefined) throw new Error('roster 缺少 agent');
  const legal = enumerateLegalActions(state, agent.id);
  const decisionState = buildDecisionState(state, agent.id, legal, []);
  return {
    runId: 'local-replay-test',
    seed: SEED,
    config: CONFIG,
    tick: record.tick,
    agentId: agent.id,
    stateHash: 'sha256:replay',
    actionSetHash: 'sha256:replay',
    legal,
    state: decisionState,
    simState: state,
    topK: 1,
    requestedModel: 'mock',
    promptVersion: null,
    promptStyle: 'neutral',
    recentEvents: [],
  };
}

describe('ReplayPolicy（P2-06 / 04 §9）', () => {
  it('重放 mock 日志得到同一终态与同一 selectedAction 序列', async () => {
    const original = runSingle(CONFIG, SEED, { policy: 'mock-weighted-v1' });
    const replayed = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new ReplayPolicy(buildReplayIndex(original.decisions)),
      runId: 'local-replay',
      requestedModel: 'mock',
      promptStyle: 'neutral',
    });
    expect(replayed.report.finalStateHash).toBe(original.report.finalStateHash);
    expect(replayed.decisions.map((entry) => entry.selectedAction)).toEqual(
      original.decisions.map((entry) => entry.selectedAction),
    );
    expect(replayed.decisions.every((entry) => entry.source === 'mock_replay')).toBe(true);
    expect(
      replayed.decisions.every((entry) => entry.policyVersion === POLICY_VERSION_MOCK_REPLAY),
    ).toBe(true);
  });

  it('缺失记录记 replay_invalid 并回退 accumulate，run 继续', async () => {
    const replayed = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new ReplayPolicy(new Map()),
      runId: 'local-replay',
      requestedModel: 'mock',
      promptStyle: 'neutral',
    });
    expect(replayed.decisions.length).toBeGreaterThan(0);
    expect(
      replayed.decisions.every(
        (entry) =>
          entry.source === 'fallback' &&
          entry.selectedAction === 'accumulate' &&
          entry.fallbackReason === 'replay_invalid',
      ),
    ).toBe(true);
  });

  it('selectedAction 在当前合法集之外时记 replay_invalid', async () => {
    const original = runSingle(CONFIG, SEED, { policy: 'mock-weighted-v1' });
    const broken = original.decisions.map((entry) => ({ ...entry, selectedAction: 'attack' }));
    const replayed = await runSingleWithPolicy(CONFIG, SEED, {
      policy: new ReplayPolicy(buildReplayIndex(broken)),
      runId: 'local-replay',
      requestedModel: 'mock',
      promptStyle: 'neutral',
    });
    expect(replayed.decisions.every((entry) => entry.fallbackReason === 'replay_invalid')).toBe(
      true,
    );
  });

  it('只使用 selectedAction：非法 requestedAction 不会复活', () => {
    const original = runSingle(CONFIG, SEED, { policy: 'mock-weighted-v1' });
    const base = original.decisions[0];
    if (base === undefined) throw new Error('缺少决策记录');
    const record: DecisionRecord = {
      ...base,
      requestedAction: 'attack',
      selectedAction: 'accumulate',
      source: 'jev_live',
      fallbackReason: null,
    };
    const policy = new ReplayPolicy(buildReplayIndex([record]));
    const decision = policy.decide(inputFor(record));
    if (decision instanceof Promise) throw new Error('回放策略必须同步');
    expect(decision.selectedAction).toBe('accumulate');
    expect(decision.requestedAction).toBeNull();
    expect(decision.source).toBe('jev_replay');
    expect(decision.fallbackReason).toBeNull();
  });

  it('原始回退记录重放后仍是 fallback，不冒充模型判断', () => {
    const original = runSingle(CONFIG, SEED, { policy: 'mock-weighted-v1' });
    const base = original.decisions[0];
    if (base === undefined) throw new Error('缺少决策记录');
    const record: DecisionRecord = {
      ...base,
      source: 'fallback',
      fallbackReason: 'timeout',
      selectedAction: 'accumulate',
    };
    const policy = new ReplayPolicy(buildReplayIndex([record]));
    const decision = policy.decide(inputFor(record));
    if (decision instanceof Promise) throw new Error('回放策略必须同步');
    expect(decision.source).toBe('fallback');
    expect(decision.fallbackReason).toBe('timeout');
    expect(decision.policyVersion).toBe(POLICY_VERSION_REPLAY);
  });

  it('同一 (tick, agentId) 重复记录显式失败', () => {
    const original = runSingle(CONFIG, SEED, { policy: 'mock-weighted-v1' });
    const base = original.decisions[0];
    if (base === undefined) throw new Error('缺少决策记录');
    expect(() => buildReplayIndex([base, base])).toThrow(/回放记录重复/);
  });
});

import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed, type AgentId } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { enumerateLegalActions } from '../../../src/core/legal-actions.js';
import { step } from '../../../src/core/engine/engine.js';
import type { SimState } from '../../../src/core/model/state.js';
import { computeAuthoritativeStateHash } from '../../../src/core/hash/state-hash.js';
import {
  captureSnapshot,
  restoreSnapshot,
  type DecisionLogEntry,
} from '../../../src/core/replay/snapshot.js';
import { decideMockWeighted } from '../../../src/decision/mock.js';

const SEED = asSeed('replay-seed');

function makeConfig() {
  return createDemoConfig({
    population: { initialPopulation: 8 },
    schedule: { totalTicks: 30, statsStride: 10, snapshotStride: 100 },
  });
}

/** mock 决策生成器（与引擎测试相同的纯函数路径）。 */
function collectMockDecisions(
  state: SimState,
  log: DecisionLogEntry[],
): Map<AgentId, { selectedAction: string }> {
  const map = new Map<AgentId, { selectedAction: string }>();
  if (state.society.tick % state.config.decision.interval !== 0) {
    return map;
  }
  for (const agent of state.society.agents) {
    if (!agent.alive) continue;
    const legal = enumerateLegalActions(state, agent.id);
    const decision = decideMockWeighted({
      runId: 'local-replay-test',
      seed: state.seed,
      state,
      agentId: agent.id,
      stateHash: 'sha256:00',
      actionSetHash: 'sha256:00',
      legal,
    });
    map.set(agent.id, { selectedAction: decision.selectedAction });
    log.push({
      tick: state.society.tick,
      agentId: agent.id,
      selectedAction: decision.selectedAction,
    });
  }
  return map;
}

function drive(state: SimState, log: DecisionLogEntry[] | null, maxTicks: number): SimState {
  for (let i = 0; i < maxTicks && state.society.tick < state.config.schedule.totalTicks; i += 1) {
    const log2: DecisionLogEntry[] = [];
    const decisions = collectMockDecisions(state, log2);
    if (log !== null) log.push(...log2);
    const result = step(state, decisions, { runId: 'local-replay-test' });
    state = result.state;
    if (result.endReason !== null) break;
  }
  return state;
}

describe('快照恢复与回放（P1-08 / 04 §9）', () => {
  it('中途恢复最终哈希与连续运行一致', () => {
    const config = makeConfig();
    const reference = drive(createSimulation(config, SEED), null, 30);
    // 分段运行：10 tick → 快照 → 恢复 → 继续到结束
    let state = createSimulation(config, SEED);
    for (let i = 0; i < 10; i += 1) {
      state = step(state, collectMockDecisions(state, []), { runId: 'local-replay-test' }).state;
    }
    const snapshot = captureSnapshot(state);
    const serialized = JSON.parse(JSON.stringify(snapshot)) as unknown;
    const restored = restoreSnapshot(serialized);
    const resumed = drive(restored, null, 30);
    expect(computeAuthoritativeStateHash(resumed)).toBe(computeAuthoritativeStateHash(reference));
  });

  it('快照损坏被拒绝且不产生部分状态', () => {
    const state = createSimulation(makeConfig(), SEED);
    const snapshot = captureSnapshot(state);
    const tamperedState = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    const tamperedInner = tamperedState['state'] as Record<string, unknown>;
    tamperedInner['society'] = {
      ...(tamperedInner['society'] as Record<string, unknown>),
      tick: 999,
    };
    expect(() => restoreSnapshot(tamperedState)).toThrowError(/stateHash 与内容不一致/);

    const badVersion = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    badVersion['schemaVersion'] = 'stratify-snapshot-v0';
    expect(() => restoreSnapshot(badVersion)).toThrowError(/未知快照 schemaVersion/);
  });

  it('决策日志回放（selectedAction）产生相同最终哈希', () => {
    const config = makeConfig();
    const log: DecisionLogEntry[] = [];
    const reference = drive(createSimulation(config, SEED), log, 30);
    expect(log.length).toBeGreaterThan(0);
    // 回放：初始状态 + 日志 selectedAction，按 (tick, agentId) 索引。
    const byKey = new Map<string, string>();
    for (const entry of log) {
      byKey.set(`${entry.tick}|${entry.agentId}`, entry.selectedAction);
    }
    let replayed = createSimulation(config, SEED);
    while (replayed.society.tick < replayed.config.schedule.totalTicks) {
      const tick = replayed.society.tick;
      const decisions = new Map<AgentId, { selectedAction: string }>();
      for (const agent of replayed.society.agents) {
        if (!agent.alive || tick % replayed.config.decision.interval !== 0) continue;
        const action = byKey.get(`${tick}|${agent.id}`);
        if (action !== undefined) {
          decisions.set(agent.id, { selectedAction: action });
        }
      }
      const result = step(replayed, decisions, { runId: 'local-replay-test' });
      replayed = result.state;
      if (result.endReason !== null) break;
    }
    expect(computeAuthoritativeStateHash(replayed)).toBe(computeAuthoritativeStateHash(reference));
  });

  it('微扰克隆：只改变指定字段，其余权威字段哈希不变', () => {
    let state = createSimulation(makeConfig(), SEED);
    for (let i = 0; i < 5; i += 1) {
      state = step(state, collectMockDecisions(state, []), { runId: 'local-replay-test' }).state;
    }
    const baseline = JSON.parse(JSON.stringify(state.society.agents)) as unknown;
    const clone = structuredCloneProxy(state);
    const target = clone.society.agents[0];
    if (target === undefined) throw new Error('roster 过小');
    target.value += 0.0001; // 微扰默认绝对量 ΔValue=1e-4（rule.md 48）
    // 其余个体深度相等
    expect(JSON.stringify(clone.society.agents.slice(1))).toBe(
      JSON.stringify((baseline as SimState['society']['agents']).slice(1)),
    );
    // 克隆不改变原世界
    const originalFirst = state.society.agents[0];
    expect(originalFirst?.value).not.toBe(target.value);
  });
});

function structuredCloneProxy(state: SimState): SimState {
  return restoreSnapshot(JSON.parse(JSON.stringify(captureSnapshot(state))) as unknown);
}

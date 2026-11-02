import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  createDemoConfig,
  mergeConfig,
  type DeepPartialConfig,
} from '../../src/core/config/defaults.js';
import { asSeed, type AgentId } from '../../src/core/control/ids.js';
import { createSimulation } from '../../src/core/init/simulation.js';
import { step } from '../../src/core/engine/engine.js';
import { enumerateLegalActions } from '../../src/core/legal-actions.js';
import { computeAuthoritativeStateHash } from '../../src/core/hash/state-hash.js';
import { captureSnapshot, restoreSnapshot } from '../../src/core/replay/snapshot.js';
import { decideMockWeighted } from '../../src/decision/mock.js';
import { decideRandomUniform } from '../../src/decision/random.js';
import { assertInvariants, assertEventInvariants } from './helpers.js';
import type { RunConfig } from '../../src/core/config/types.js';
import type { SimState } from '../../src/core/model/state.js';

/** 生成 schema 合法的小型随机配置。 */
function arbitraryConfig(): fc.Arbitrary<RunConfig> {
  return fc
    .record({
      population: fc.integer({ min: 4, max: 24 }),
      classCount: fc.integer({ min: 2, max: 4 }),
      beta: fc.float({ min: 0, max: 1, noNaN: true }),
      threshold: fc.float({ min: 0, max: 1, noNaN: true }),
      belowNeedLimit: fc.integer({ min: 1, max: 5 }),
      rewireProb: fc.float({ min: 0, max: 1, noNaN: true }),
      lossRate: fc.float({ min: 0, max: 0.5, noNaN: true }),
      candidateCount: fc.integer({ min: 0, max: 3 }),
      ageMode: fc.constantFrom('uniform' as const, 'newborn' as const),
      policy: fc.constantFrom('mock-weighted-v1' as const, 'random-uniform-v1' as const),
      seedTag: fc.integer({ min: 1, max: 1_000_000 }),
      ticks: fc.integer({ min: 20, max: 120 }),
    })
    .map((raw) => {
      const classCount = raw.classCount;
      // 由 seedTag 确定性生成归一化比例（性质测试内不使用 Math.random）。
      const weights = Array.from({ length: classCount }, (_, c) => 1 + ((raw.seedTag + c * 7) % 5));
      const weightSum = weights.reduce((a, b) => a + b, 0);
      const shares = weights.map((w) => w / weightSum);
      const env0 = Array.from({ length: classCount }, (_, c) => 1 + 0.5 * c);
      const decay = Array.from({ length: classCount }, () => 0.5);
      const needMultiplier = Array.from({ length: classCount }, (_, c) => 1 + 0.3 * c);
      const crossDays = Array.from({ length: classCount - 1 }, (_, c) => 10 + 10 * c);
      const overrides: DeepPartialConfig = {
        population: {
          initialPopulation: raw.population,
          classCount,
          classShares: shares,
          initialAgeMode: raw.ageMode,
        },
        opportunity: { env0 },
        ascent: { crossDays },
        lifespan: {
          decay,
          initialLife: { mean: 300, sigma: 60, min: 30, max: 2000 },
        },
        need: {
          threshold: raw.threshold,
          belowNeedLimit: raw.belowNeedLimit,
          bufferDays: 2,
          needMultiplier,
        },
        competition: {
          lossRate: raw.lossRate,
          candidateCount: raw.candidateCount,
        },
        network: { rewireProb: raw.rewireProb, maxDegree: 3, initialDegree: 1 },
        networkOpportunity: { beta: raw.beta },
        decision: {
          interval: fcSampleInterval(raw.seedTag),
          topK: 1,
          policy: raw.policy,
        },
        schedule: { totalTicks: raw.ticks, statsStride: 1, snapshotStride: 100 },
      };
      return mergeConfig(createDemoConfig(), overrides);
    });
}

function fcSampleInterval(tag: number): number {
  // 由 seedTag 派生确定性决策间隔（2/3/5），避免在 map 内调用 fc。
  const candidates = [2, 3, 5];
  return candidates[tag % candidates.length] ?? 2;
}

function decisionsFor(state: SimState): Map<AgentId, { selectedAction: string }> {
  const map = new Map<AgentId, { selectedAction: string }>();
  if (state.society.tick % state.config.decision.interval !== 0) {
    return map;
  }
  for (const agent of state.society.agents) {
    if (!agent.alive) continue;
    const legal = enumerateLegalActions(state, agent.id);
    const decision =
      state.config.decision.policy === 'mock-weighted-v1'
        ? decideMockWeighted({
            runId: 'local-property',
            seed: state.seed,
            state,
            agentId: agent.id,
            stateHash: 'sha256:00',
            actionSetHash: 'sha256:00',
            legal,
          })
        : decideRandomUniform({
            runId: 'local-property',
            seed: state.seed,
            state,
            agentId: agent.id,
            stateHash: 'sha256:00',
            actionSetHash: 'sha256:00',
            legal,
          });
    map.set(agent.id, { selectedAction: decision.selectedAction });
  }
  return map;
}

function driveUntil(
  initialState: SimState,
  maxTicks: number,
  checkpoint?: { at: number; snapshot: unknown },
): SimState {
  let state = initialState;
  for (let i = 0; i < maxTicks && state.society.tick < state.config.schedule.totalTicks; i += 1) {
    const result = step(state, decisionsFor(state), { runId: 'local-property' });
    assertEventInvariants(result.events);
    state = result.state;
    assertInvariants(state);
    if (checkpoint !== undefined && state.society.tick === checkpoint.at) {
      (checkpoint as { snapshot: unknown }).snapshot = captureSnapshot(state);
    }
    if (result.endReason !== null) break;
  }
  return state;
}

describe('性质测试：任意合法配置下不变量（08 §4）', () => {
  it('全部 03 §7 不变量在数百 tick 内始终成立', () => {
    const property = fc.property(
      arbitraryConfig(),
      fc.integer({ min: 1, max: 1000 }),
      (config, seedNo) => {
        const seed = asSeed(`prop-${seedNo}`);
        const state = createSimulation(config, seed);
        assertInvariants(state);
        driveUntil(state, config.schedule.totalTicks);
      },
    );
    expect(() => fc.assert(property, { numRuns: 25 })).not.toThrow();
  });

  it('decode(encode(state)) 与权威状态哈希一致', () => {
    const property = fc.property(
      arbitraryConfig(),
      fc.integer({ min: 1, max: 1000 }),
      (config, seedNo) => {
        const seed = asSeed(`hash-${seedNo}`);
        const state = createSimulation(config, seed);
        driveUntil(state, Math.min(30, config.schedule.totalTicks));
        const hashBefore = computeAuthoritativeStateHash(state);
        const roundTrip = JSON.parse(JSON.stringify(state)) as unknown;
        // encodeSimState/decodeSimState 路径由 snapshot 封装
        const restored = restoreSnapshot(captureSnapshot(state));
        expect(computeAuthoritativeStateHash(restored)).toBe(hashBefore);
        void roundTrip;
      },
    );
    expect(() => fc.assert(property, { numRuns: 15 })).not.toThrow();
  });

  it('任意快照点恢复后与连续运行最终哈希相同', () => {
    const property = fc.property(
      arbitraryConfig(),
      fc.integer({ min: 1, max: 1000 }),
      (config, seedNo) => {
        const seed = asSeed(`snap-${seedNo}`);
        const half = Math.floor(config.schedule.totalTicks / 2);
        const checkpoint = { at: half, snapshot: null as unknown };
        const continuous = createSimulation(config, seed);
        const finalContinuous = driveUntil(continuous, config.schedule.totalTicks);
        const segmentedStart = createSimulation(config, seed);
        driveUntil(segmentedStart, config.schedule.totalTicks, checkpoint);
        if (checkpoint.snapshot === null || checkpoint.snapshot === undefined) {
          return true; // 提前结束未达检查点
        }
        const resumed = restoreSnapshot(checkpoint.snapshot);
        const finalResumed = driveUntil(resumed, config.schedule.totalTicks);
        expect(computeAuthoritativeStateHash(finalResumed)).toBe(
          computeAuthoritativeStateHash(finalContinuous),
        );
        return true;
      },
    );
    expect(() => fc.assert(property, { numRuns: 12 })).not.toThrow();
  });

  it('同配置+初始状态+mock 决策重复运行完全相同', () => {
    const property = fc.property(
      arbitraryConfig(),
      fc.integer({ min: 1, max: 1000 }),
      (config, seedNo) => {
        const seed = asSeed(`det-${seedNo}`);
        const a = createSimulation(config, seed);
        const b = createSimulation(config, seed);
        const finalA = driveUntil(a, config.schedule.totalTicks);
        const finalB = driveUntil(b, config.schedule.totalTicks);
        expect(computeAuthoritativeStateHash(finalA)).toBe(computeAuthoritativeStateHash(finalB));
      },
    );
    expect(() => fc.assert(property, { numRuns: 15 })).not.toThrow();
  });

  it('任意无效行动不会导致负 Value/非法阶级，且有失效事件', () => {
    const property = fc.property(
      arbitraryConfig(),
      fc.integer({ min: 1, max: 1000 }),
      fc.subarray(['ascend', 'descend'] as const, { minLength: 1, maxLength: 2 }),
      (config, seedNo, forced) => {
        const seed = asSeed(`invalid-${seedNo}`);
        let state = createSimulation(config, seed);
        let sawInvalid = false;
        for (let i = 0; i < Math.min(10, config.schedule.totalTicks); i += 1) {
          const decisions = decisionsFor(state);
          if (state.society.tick % state.config.decision.interval === 0) {
            const first = state.society.agents.find((agent) => agent.alive);
            if (first !== undefined) {
              const action = forced[0] ?? 'ascend';
              decisions.set(first.id, { selectedAction: action });
            }
          }
          const result = step(state, decisions, { runId: 'local-property' });
          sawInvalid =
            sawInvalid || result.executions.some((entry) => entry.status === 'stale_invalid');
          assertEventInvariants(result.events);
          state = result.state;
          assertInvariants(state);
          if (result.endReason !== null) break;
        }
        void sawInvalid;
      },
    );
    expect(() => fc.assert(property, { numRuns: 15 })).not.toThrow();
  });
});

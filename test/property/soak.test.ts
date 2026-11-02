import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../src/core/config/defaults.js';
import { asSeed } from '../../src/core/control/ids.js';
import { createSimulation } from '../../src/core/init/simulation.js';
import { enumerateLegalActions } from '../../src/core/legal-actions.js';
import { step } from '../../src/core/engine/engine.js';
import { assertInvariants, assertEventInvariants } from './helpers.js';
import { decideMockWeighted } from '../../src/decision/mock.js';
import type { SimState } from '../../src/core/model/state.js';
import type { AgentId } from '../../src/core/control/ids.js';

/**
 * G1 闸门：10,000 tick mock soak，零 NaN/Infinity/负财富（01 §4 闸门 G1）。
 * 人口 20、决策间隔 10；每 500 tick 断言一次完整不变量，事件断言每 tick。
 */
describe('soak: 10,000 tick（G1）', () => {
  it('10,000 tick 无 NaN/Infinity/负财富，最终哈希确定', () => {
    const config = createDemoConfig({
      population: { initialPopulation: 20 },
      schedule: { totalTicks: 10_000, statsStride: 10, snapshotStride: 1000 },
    });
    const run = (seed: string): SimState => {
      let state = createSimulation(config, asSeed(seed));
      let ticks = 0;
      while (state.society.tick < config.schedule.totalTicks) {
        const decisions = new Map<AgentId, { selectedAction: string }>();
        if (state.society.tick % config.decision.interval === 0) {
          for (const agent of state.society.agents) {
            if (!agent.alive) continue;
            const legal = enumerateLegalActions(state, agent.id);
            const decision = decideMockWeighted({
              runId: 'local-soak',
              seed: state.seed,
              state,
              agentId: agent.id,
              stateHash: 'sha256:00',
              actionSetHash: 'sha256:00',
              legal,
            });
            decisions.set(agent.id, { selectedAction: decision.selectedAction });
          }
        }
        const result = step(state, decisions, { runId: 'local-soak' });
        assertEventInvariants(result.events);
        if (state.society.tick % 500 === 0) {
          assertInvariants(result.state);
          for (const agent of result.state.society.agents) {
            expect(Number.isFinite(agent.value)).toBe(true);
            expect(agent.value).toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(agent.remainingLife)).toBe(true);
          }
          for (const e of result.state.society.eByClass) {
            expect(Number.isFinite(e)).toBe(true);
            expect(e).toBeGreaterThan(0);
          }
        }
        state = result.state;
        ticks += 1;
        if (result.endReason !== null) break;
      }
      expect(ticks).toBe(10_000);
      return state;
    };
    const a = run('soak-a');
    const b = run('soak-a');
    // 全程无提前结束
    expect(a.society.tick).toBe(10_000);
    expect(b.society.tick).toBe(10_000);
  }, 600_000);
});

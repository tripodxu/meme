import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RUN_CONFIG,
  mergeConfig,
  type DeepPartialConfig,
} from '../../../src/core/config/defaults.js';
import { validateRunConfig } from '../../../src/core/config/validate.js';
import { asAgentId, asSeed, type AgentId } from '../../../src/core/control/ids.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { step, type StepDecisions } from '../../../src/core/engine/engine.js';
import {
  computeAscendBarrier,
  enumerateLegalActions,
  scarcityTargetShares,
} from '../../../src/core/legal-actions.js';
import type { SimState } from '../../../src/core/model/state.js';

/**
 * rules-v10 占用锚定（changes/0013）：目标阶级占比高于机会隐含参照份额时，
 * 上升余额门槛增加 `scarcityWeight × crossBase × pressure`。
 * `scarcityWeight=0` 必须与 v9 逐位一致；>0 时枚举侧与引擎复核侧同时拒绝。
 */

const SEED = asSeed('scarcity-seed');
const AGENT = asAgentId('a-0000');

function config(scarcityWeight: number) {
  const result = validateRunConfig(
    mergeConfig(DEFAULT_RUN_CONFIG, {
      population: { initialPopulation: 3, classCount: 2, classShares: [1 / 3, 2 / 3] },
      opportunity: { env0: [1, 1.5] },
      lifespan: { decay: [1.3, 1.15] },
      need: { needMultiplier: [1, 1.3] },
      ascent: { crossDays: [30], scarcityWeight },
      network: { maxDegree: 0, initialDegree: 0 },
      decision: { interval: 10_000 },
      schedule: { totalTicks: 5, statsStride: 1, snapshotStride: 100 },
    } as DeepPartialConfig),
  );
  if (!result.ok) {
    throw new Error(`配置非法: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

/** 3 人 roster：a-0000 在底层、其余两人在目标阶级（P1=2/3 > target 0.4）。 */
function setup(scarcityWeight: number): SimState {
  const state = createSimulation(config(scarcityWeight), SEED);
  const agents = state.society.agents;
  const a = agents[0];
  if (a === undefined || agents.length < 3) throw new Error('roster 过小');
  a.classIndex = 0;
  a.maxClassIndex = 0;
  a.value = 300; // 足以支付 cost+cushion（≈265.5），不足以支付 barrier（≈120）
  a.remainingLife = 100_000;
  for (const incumbent of agents.slice(1)) {
    incumbent.classIndex = 1;
    incumbent.maxClassIndex = 1;
    incumbent.value = 10;
    incumbent.remainingLife = 100_000;
  }
  return state;
}

function decideAscend(state: SimState): StepDecisions {
  const map = new Map<AgentId, { selectedAction: string }>();
  for (const agent of state.society.agents) {
    if (agent.alive) {
      map.set(agent.id, { selectedAction: agent.id === 'a-0000' ? 'ascend' : 'accumulate' });
    }
  }
  return map;
}

describe('占用锚定：参照份额与壁垒（rules-v10）', () => {
  it('参照份额按 1/env0 归一化；env0 越高目标占比越小', () => {
    const targets = scarcityTargetShares(config(0));
    expect(targets[0]).toBeCloseTo(0.6, 12);
    expect(targets[1]).toBeCloseTo(0.4, 12);
  });

  it('scarcityWeight=0 → 壁垒恒为 0（与 v9 逐位一致）', () => {
    expect(computeAscendBarrier(config(0), 0, 100, [1 / 3, 2 / 3])).toBe(0);
  });

  it('目标阶级超占比 → 壁垒 = w × crossBase × (P/target − 1)', () => {
    const barrier = computeAscendBarrier(config(2), 0, 100, [1 / 3, 2 / 3]);
    expect(barrier).toBeCloseTo(2 * 100 * (2 / 3 / 0.4 - 1), 10);
    // 目标阶级未超占比时壁垒为 0
    expect(computeAscendBarrier(config(2), 0, 100, [0.9, 0.1])).toBe(0);
  });

  it('壁垒进入合法行动枚举：同余额在 w=0 时可上升、w=2 时被排除', () => {
    const open = enumerateLegalActions(setup(0), AGENT);
    const anchored = enumerateLegalActions(setup(2), AGENT);
    expect(open.actions).toContain('ascend');
    expect(anchored.actions).not.toContain('ascend');
  });

  it('引擎复核侧拒绝：w=2 时 ascend 记 insufficient_cushion，阶级不变', () => {
    const state = setup(2);
    const result = step(state, decideAscend(state), { runId: 'scarcity' });
    expect(result.state.society.agents[0]?.classIndex).toBe(0);
    const invalid = result.events.find((event) => event.type === 'action_invalid');
    expect(invalid?.type === 'action_invalid' && invalid.reason).toBe('insufficient_cushion');
    const record = result.executions.find((entry) => entry.agentId === 'a-0000');
    expect(record?.status).toBe('stale_invalid');
  });

  it('w=0 时同一余额可正常升阶', () => {
    const state = setup(0);
    const result = step(state, decideAscend(state), { runId: 'scarcity-open' });
    expect(result.state.society.agents[0]?.classIndex).toBe(1);
  });
});

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
import { sampleDisplacementTarget } from '../../../src/core/legal-actions.js';
import { RNG_EVENT_TAGS } from '../../../src/core/rng/tags.js';
import type { SimState } from '../../../src/core/model/state.js';

/**
 * rules-v8 位移准入（D-09）：'class' 参照系下上升需击败目标阶级在位者，
 * 被击败者降级（零和下行流，治理 G-A 的底层抽空）；'own' 模式不进入对决
 * 分支、不消费 displacement RNG（G-D 逐位一致）。
 */

const SEED = asSeed('displacement-seed');

function config(referenceMode: 'own' | 'class') {
  const base = validateRunConfig(
    mergeConfig(DEFAULT_RUN_CONFIG, {
      population: { initialPopulation: 2, classCount: 2, classShares: [0.5, 0.5] },
      opportunity: { env0: [1, 1.5] },
      lifespan: { decay: [1.3, 1.15] },
      need: { needMultiplier: [1, 1.3] },
      ascent: { crossDays: [30] },
      network: { maxDegree: 0, initialDegree: 0 },
      decision: { interval: 10_000 },
      schedule: { totalTicks: 5, statsStride: 1, snapshotStride: 100 },
    } as DeepPartialConfig),
  );
  if (!base.ok) {
    throw new Error(`配置非法: ${JSON.stringify(base.issues)}`);
  }
  const result = validateRunConfig(mergeConfig(base.config, { need: { referenceMode } }));
  if (!result.ok) {
    throw new Error(`配置非法: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

function setup(
  attacker: { ge: number; hard: number; value: number },
  incumbent: { ge: number; hard: number; value: number },
): SimState {
  const state = createSimulation(config('class'), SEED);
  const a = state.society.agents[0];
  const b = state.society.agents[1];
  if (a === undefined || b === undefined) throw new Error('roster 过小');
  a.classIndex = 0;
  a.maxClassIndex = 0;
  (a as { ge: number }).ge = attacker.ge;
  (a as { hard: number }).hard = attacker.hard;
  a.value = attacker.value;
  a.remainingLife = 100_000;
  b.classIndex = 1;
  b.maxClassIndex = 1;
  (b as { ge: number }).ge = incumbent.ge;
  (b as { hard: number }).hard = incumbent.hard;
  b.value = incumbent.value;
  b.remainingLife = 100_000;
  return state;
}

function ascendDecision(state: SimState): StepDecisions {
  const map = new Map<AgentId, { selectedAction: string }>();
  for (const agent of state.society.agents) {
    if (agent.alive) {
      map.set(agent.id, { selectedAction: agent.id === 'a-0000' ? 'ascend' : 'accumulate' });
    }
  }
  return map;
}

describe('位移准入：class 模式上升需击败在位者（rules-v8）', () => {
  it('攻击方压倒性获胜 → 升阶且在位者被降级（零和下行流）', () => {
    // 攻击方 value 极大（logPower 值项占优）→ pInitiator≈1 → 必胜
    const state = setup({ ge: 1, hard: 1, value: 1_000_000 }, { ge: 0.2, hard: 0.2, value: 10 });
    const result = step(state, ascendDecision(state), { runId: 'displacement' });
    const attacker = result.state.society.agents[0];
    const incumbent = result.state.society.agents[1];
    expect(attacker?.classIndex).toBe(1); // 升阶成功
    expect(incumbent?.classIndex).toBe(0); // 在位者被击败降级
    expect(incumbent?.lastDescentTick).toBe(0);
    // 阶段 C 对全体存活者 classAge+=1：降级者在结算后与升阶者同为 1（03 §2.1）
    expect(incumbent?.classAge).toBe(1);
    expect(incumbent?.maxClassIndex).toBe(1); // 历史最高不变
    // 事件链：对决 + 降级（passive）+ 升阶
    const types = result.events.map((event) => event.type);
    expect(types).toContain('competition_resolved');
    const descended = result.events.find((event) => event.type === 'class_descended');
    expect(descended?.type === 'class_descended' && descended.reason).toBe('passive');
    expect(descended?.type === 'class_descended' && descended.from).toBe(1);
    // 对决财富转移：败者损失、胜者收益（竞争结算语义完整适用）
    const lossEvent = result.events.find(
      (event) => event.type === 'wealth_changed' && event.cause === 'competition_loss',
    );
    expect(lossEvent?.type === 'wealth_changed' && lossEvent.agentId).toBe('a-0001');
  });

  it('攻击方被守擂击败 → 不升阶、不支付 cross，仅承受对决损失', () => {
    // 攻击方恰好可负担（value≈cost+cushion，logPower 低）→ 在位者压倒性守擂
    const state = setup({ ge: 0.2, hard: 0.2, value: 300 }, { ge: 3, hard: 3, value: 1_000_000 });
    const attackerBefore = state.society.agents[0]?.value as number;
    const result = step(state, ascendDecision(state), { runId: 'displacement' });
    const attacker = result.state.society.agents[0];
    const incumbent = result.state.society.agents[1];
    expect(attacker?.classIndex).toBe(0); // 未升阶
    expect(incumbent?.classIndex).toBe(1); // 在位者守住
    // 未支付 cross：财富变化仅来自对决损失（8%）
    const attackerDelta = (attacker?.value as number) - attackerBefore;
    expect(attackerDelta).toBeLessThan(0);
    expect(attackerDelta).toBeCloseTo(-0.08 * attackerBefore, 0); // 量级＝竞争损失
    const invalid = result.events.find((event) => event.type === 'action_invalid');
    expect(invalid?.type === 'action_invalid' && invalid.reason).toBe('displacement_lost');
    // 执行记录：未执行 + 原因可审计
    const record = result.executions.find((entry) => entry.agentId === 'a-0000');
    expect(record?.status).toBe('stale_invalid');
    expect(record?.reason).toBe('displacement_lost');
    expect(record?.executedAction).toBeNull();
  });

  it('目标阶级为空 → 无对决直接准入（不消费 displacement 地址的语义等价于边界扩张）', () => {
    // 在位者放到底层：class 1 为空 → 无在位者
    const state = setup({ ge: 1, hard: 1, value: 1_000_000 }, { ge: 1, hard: 1, value: 10 });
    const incumbent = state.society.agents[1];
    if (incumbent === undefined) throw new Error('roster 过小');
    incumbent.classIndex = 0;
    const result = step(state, ascendDecision(state), { runId: 'displacement' });
    expect(result.state.society.agents[0]?.classIndex).toBe(1);
    expect(result.events.some((event) => event.type === 'competition_resolved')).toBe(false);
    expect(result.events.some((event) => event.type === 'class_descended')).toBe(false);
  });

  it('own 模式不进入对决分支：在位者存在时仍直接升阶（G-D 逐位）', () => {
    const state = createSimulation(config('own'), SEED);
    const a = state.society.agents[0];
    const b = state.society.agents[1];
    if (a === undefined || b === undefined) throw new Error('roster 过小');
    a.classIndex = 0;
    a.maxClassIndex = 0;
    a.value = 1_000_000;
    a.remainingLife = 100_000;
    b.classIndex = 1;
    b.maxClassIndex = 1;
    b.value = 10;
    const result = step(state, ascendDecision(state), { runId: 'displacement-own' });
    expect(result.state.society.agents[0]?.classIndex).toBe(1);
    expect(result.state.society.agents[1]?.classIndex).toBe(1); // 在位者不动
    expect(result.events.some((event) => event.type === 'competition_resolved')).toBe(false);
  });
});

describe('sampleDisplacementTarget：确定性抽样与池边界', () => {
  it('同 (seed,tick,attacker) 抽样结果一致；空池返回 null', () => {
    const state = setup({ ge: 1, hard: 1, value: 1 }, { ge: 1, hard: 1, value: 1 });
    const first = sampleDisplacementTarget(
      state.seed,
      0,
      asAgentId('a-0000'),
      state.society.agents,
      1,
    );
    const second = sampleDisplacementTarget(
      state.seed,
      0,
      asAgentId('a-0000'),
      state.society.agents,
      1,
    );
    expect(first?.id).toBe(second?.id);
    expect(['a-0000', 'a-0001']).toContain(first?.id);
    // 目标阶级无人
    expect(
      sampleDisplacementTarget(state.seed, 0, asAgentId('a-0000'), state.society.agents, 1),
    ).not.toBeNull();
    expect(sampleDisplacementTarget(state.seed, 0, asAgentId('a-0000'), [], 1)).toBeNull();
    // 池过滤：只取目标阶级存活者
    const onlyClass0 = sampleDisplacementTarget(
      state.seed,
      0,
      asAgentId('a-0000'),
      state.society.agents,
      0,
    );
    expect(onlyClass0?.classIndex).toBe(0);
    void RNG_EVENT_TAGS.displacementTarget;
  });
});

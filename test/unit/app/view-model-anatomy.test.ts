import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { RunController } from '../../../src/app/run-controller.js';
import {
  agentLifeTimeline,
  agentLineage,
  agentMechanismAnatomy,
  firstDivergenceTick,
  previewCompetition,
} from '../../../src/app/view-model.js';

function initTestState(seed: string, initialPopulation = 12) {
  const ctrl = new RunController();
  const config = createDemoConfig({ population: { initialPopulation } });
  const res = ctrl.prepare(config, seed, 'mock-weighted-v1');
  if (!res.ok) throw new Error('prepare failed');
  const state = ctrl.getState();
  if (state === null) throw new Error('missing state');
  return state;
}

describe('view-model 机制解剖与预演纯函数（E1）', () => {
  it('agentMechanismAnatomy 返回有限的日增因子与升阶三段门槛', () => {
    const state = initTestState('anatomy-seed', 12);
    const c0 = state.society.agents.find((a) => a.classIndex === 0);
    expect(c0).toBeDefined();
    if (c0 === undefined) return;
    const anatomy = agentMechanismAnatomy(state, c0.id);
    expect(anatomy).not.toBeNull();
    expect(anatomy!.expectedDailyGain).toBeGreaterThan(0);
    expect(anatomy!.canAscendFurther).toBe(true);
    expect(anatomy!.ascendCost).toBeGreaterThan(0);
    expect(anatomy!.ascendTotalRequired).toBeGreaterThanOrEqual(anatomy!.ascendCost);
  });

  it('previewCompetition 直接调用 core 计算真实胜率与净损耗', () => {
    const state = initTestState('comp-seed', 12);
    const a0 = state.society.agents[0]!;
    const a1 = state.society.agents[1]!;
    a0.value = 120;
    a1.value = 60;
    const preview = previewCompetition(state, a0.id, a1.id);
    expect(preview).not.toBeNull();
    expect(preview!.pWin).toBeGreaterThan(0);
    expect(preview!.pWin).toBeLessThan(1);
    expect(preview!.winGain).toBeGreaterThan(0);
    expect(preview!.winNetLoss).toBeGreaterThanOrEqual(0);
  });

  it('agentLifeTimeline 与 agentLineage 正确提取升阶与代际事件', () => {
    const state = initTestState('life-seed', 8);
    const a0 = state.society.agents[0]!;
    const a1 = state.society.agents[1]!;
    const events = [
      {
        schemaVersion: 'stratify-event-v1' as const,
        runId: 'r1',
        tick: 12,
        seq: 1,
        type: 'class_ascended' as const,
        agentId: a0.id,
        from: 0,
        to: 1,
        cost: 50,
        reason: 'active' as const,
      },
      {
        schemaVersion: 'stratify-event-v1' as const,
        runId: 'r1',
        tick: 20,
        seq: 2,
        type: 'agent_born' as const,
        agentId: a1.id,
        parentId: a0.id,
        classIndex: 1,
        value: 20,
      },
    ];
    const timeline = agentLifeTimeline(events, a0.id, 0);
    expect(timeline.some((p) => p.kind === 'ascend' && p.tick === 12)).toBe(true);
    const lineage = agentLineage(events, state, a0.id);
    expect(lineage.children).toHaveLength(1);
    expect(lineage.children[0]?.id).toBe(a1.id);
  });

  it('firstDivergenceTick 定位首个偏离 tick', () => {
    const base = {
      tick: 0,
      gini: 0.3,
      openness: 0.5,
      segregation: 0.2,
      medianValue: 10,
    } as never;
    const diff = {
      tick: 5,
      gini: 0.31,
      openness: 0.5,
      segregation: 0.2,
      medianValue: 10,
    } as never;
    expect(firstDivergenceTick([base, base], [base, base])).toBeNull();
    expect(
      firstDivergenceTick([base, diff], [base, { ...(base as object), tick: 5 } as never]),
    ).toBe(5);
  });
});

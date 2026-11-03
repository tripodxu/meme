import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG } from '../../../src/core/config/defaults.js';
import {
  classBuffer,
  computeNeedOwn,
  computeOpportunity,
  effortFunction,
  lifeLoss,
  logPower,
  median,
  resolveCompetition,
  stableSigmoid,
} from '../../../src/core/engine/settlement.js';
import { agentIdFromIndex, type AgentState } from '../../../src/core/model/agent.js';

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: agentIdFromIndex(0),
    alive: true,
    classIndex: 2,
    maxClassIndex: 2,
    value: 100,
    ge: 1,
    hard: 1,
    initialLife: 25550,
    remainingLife: 20000,
    classAge: 5,
    baselineSum: 50,
    belowNeedStreak: 0,
    lastAscentTick: null,
    lastDescentTick: null,
    ties: [],
    deathTick: null,
    deathReason: null,
    ...overrides,
  };
}

describe('努力函数 F(h)（03 §6 阶段 C）', () => {
  it('F(1)=1、F(0)=0、单调递增且稳定', () => {
    const shape = DEFAULT_RUN_CONFIG.effort.shape;
    expect(effortFunction(shape, 1)).toBeCloseTo(1, 12);
    expect(effortFunction(shape, 0)).toBeCloseTo(0, 12);
    expect(effortFunction(shape, 0.2)).toBeLessThan(effortFunction(shape, 0.5));
    expect(effortFunction(shape, 0.5)).toBeLessThan(effortFunction(shape, 2));
  });

  it('FShape 接近 0 时无 NaN（expm1 稳定实现）', () => {
    for (const shape of [1e-9, 1e-6, 0.001]) {
      const value = effortFunction(shape, 1);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeCloseTo(1, 6);
    }
  });
});

describe('阶级缓冲与需求线（03 §3/§6）', () => {
  it('首日 buffer=0，第 bufferDays 日为 1', () => {
    expect(classBuffer(1, 30)).toBe(0);
    expect(classBuffer(30, 30)).toBe(1);
    expect(classBuffer(15, 30)).toBeCloseTo(14 / 29, 12);
    expect(classBuffer(100, 30)).toBe(1);
  });

  it('need = buffer×baselineSum×ψ[class]×(env0[c]/env0[0])^φ（v4，结构锚定）', () => {
    // φ=1 默认：ψ_eff = 2.5 × (3.2/1) = 8
    const need = computeNeedOwn(DEFAULT_RUN_CONFIG, 30, 60, 3);
    expect(need).toBeCloseTo(1 * 60 * 2.5 * (3.2 / 1), 12);
    // φ=0 退回 v3：无 pow
    const v3Config = {
      ...DEFAULT_RUN_CONFIG,
      need: { ...DEFAULT_RUN_CONFIG.need, envExponent: 0 },
    };
    expect(computeNeedOwn(v3Config, 30, 60, 3)).toBeCloseTo(1 * 60 * 2.5, 12);
  });
});

describe('竞争能力与结算（03 §6 阶段 B）', () => {
  it('logPower 与公式一致', () => {
    const agent = makeAgent({ value: 9, ge: 4, hard: 2 });
    const expected = 0.35 * Math.log1p(9) + 0.6 * Math.log(4) + 0.4 * Math.log(2);
    expect(logPower(DEFAULT_RUN_CONFIG, agent)).toBeCloseTo(expected, 12);
  });

  it('极端 Value 不产生 NaN/Infinity，pA 位于 (0,1)', () => {
    const big = makeAgent({ value: 1e15 });
    const small = makeAgent({ value: 0 });
    const outcome = resolveCompetition(DEFAULT_RUN_CONFIG, big, small, 0.5);
    expect(Number.isFinite(outcome.pInitiator)).toBe(true);
    expect(outcome.pInitiator).toBeGreaterThan(0);
    expect(outcome.pInitiator).toBeLessThan(1);
  });

  it('高打低发起方获胜 ×0.5；低打高获胜 ×1.25；防守方获胜 ×1', () => {
    // 发起方在高层且实力强 → direction=high_to_low，发起方获胜
    const high = makeAgent({ classIndex: 3, maxClassIndex: 3, value: 1e9, ge: 100, hard: 100 });
    const low = makeAgent({
      id: agentIdFromIndex(1),
      classIndex: 0,
      maxClassIndex: 0,
      value: 100,
      ge: 0.2,
      hard: 0.2,
    });
    const winByInitiator = resolveCompetition(DEFAULT_RUN_CONFIG, high, low, 0.5);
    expect(winByInitiator.winner).toBe('initiator');
    expect(winByInitiator.direction).toBe('high_to_low');
    expect(winByInitiator.directionMultiplier).toBeCloseTo(0.5, 12);
    // 防守方（低层）实力反超 → 发起方 r>=pA 判负，方向乘子恒 1
    const weakHigh = makeAgent({ classIndex: 3, maxClassIndex: 3, value: 100, ge: 0.2, hard: 0.2 });
    const strongLow = makeAgent({
      id: agentIdFromIndex(1),
      classIndex: 0,
      maxClassIndex: 0,
      value: 1e9,
      ge: 100,
      hard: 100,
    });
    const winByDefender = resolveCompetition(DEFAULT_RUN_CONFIG, weakHigh, strongLow, 0.9999);
    expect(winByDefender.winner).toBe('target');
    expect(winByDefender.direction).toBe('high_to_low');
    expect(winByDefender.directionMultiplier).toBe(1);

    // 低打高发起方获胜 ×1.25
    const lowInitiator = makeAgent({
      value: 1e9,
      ge: 100,
      hard: 100,
      classIndex: 0,
      maxClassIndex: 0,
    });
    const highTarget = makeAgent({
      id: agentIdFromIndex(1),
      value: 100,
      ge: 0.2,
      hard: 0.2,
      classIndex: 3,
      maxClassIndex: 3,
    });
    const upset = resolveCompetition(DEFAULT_RUN_CONFIG, lowInitiator, highTarget, 0.0001);
    expect(upset.winner).toBe('initiator');
    expect(upset.direction).toBe('low_to_high');
    expect(upset.directionMultiplier).toBeCloseTo(1.25, 12);
  });

  it('gain<=loss；loss=min(loser.value, lossRate×loser.value)', () => {
    const a = makeAgent({ value: 50 });
    const b = makeAgent({ id: agentIdFromIndex(1), value: 10, ge: 0.2, hard: 0.2 });
    const outcome = resolveCompetition(DEFAULT_RUN_CONFIG, a, b, 0.5);
    expect(outcome.winner).toBe('initiator');
    expect(outcome.loss).toBeCloseTo(Math.min(10, 0.08 * 10), 12);
    expect(outcome.gain).toBeLessThanOrEqual(outcome.loss);
  });

  it('跨层 power 乘子：发起 ×0.85、防守 ×1.15', () => {
    // 同一对个体，同层 vs 跨层：跨层时发起方胜率下降
    const a = makeAgent({ classIndex: 1, maxClassIndex: 1, value: 100, ge: 1, hard: 1 });
    const bSame = makeAgent({
      id: agentIdFromIndex(1),
      classIndex: 1,
      maxClassIndex: 1,
      value: 100,
      ge: 1,
      hard: 1,
    });
    const bLow = makeAgent({
      id: agentIdFromIndex(2),
      classIndex: 0,
      maxClassIndex: 0,
      value: 100,
      ge: 1,
      hard: 1,
    });
    const sameClass = resolveCompetition(DEFAULT_RUN_CONFIG, a, bSame, 0.5);
    const crossClass = resolveCompetition(DEFAULT_RUN_CONFIG, a, bLow, 0.5);
    expect(crossClass.pInitiator).toBeLessThan(sameClass.pInitiator);
    // 防守方加成：交换发起方后防守胜率上升
    const reverseSame = resolveCompetition(DEFAULT_RUN_CONFIG, bSame, a, 0.5);
    expect(reverseSame.pInitiator).toBeCloseTo(1 - sameClass.pInitiator, 12);
  });

  it('跨层乘子为 0 时立即抛错，不产出 NaN 概率', () => {
    // 注入超域配置：校验层已拒绝 0，此处验证运行期兜底（直接调用 resolveCompetition）。
    const zeroMultiplier = {
      ...DEFAULT_RUN_CONFIG,
      competition: {
        ...DEFAULT_RUN_CONFIG.competition,
        crossClassInitiatorMultiplier: 0,
        crossClassTargetMultiplier: 0,
      },
    } as typeof DEFAULT_RUN_CONFIG;
    const low = makeAgent({ classIndex: 0, maxClassIndex: 0 });
    const high = makeAgent({ id: agentIdFromIndex(1), classIndex: 1, maxClassIndex: 1 });
    expect(() => resolveCompetition(zeroMultiplier, high, low, 0.5)).toThrowError(
      /跨层竞争乘子必须为正/,
    );
  });

  it('非法输入抛不变量错误', () => {
    expect(() => logPower(DEFAULT_RUN_CONFIG, makeAgent({ ge: 0 }))).toThrowError(/power 输入非法/);
    expect(() => logPower(DEFAULT_RUN_CONFIG, makeAgent({ value: -1 }))).toThrowError(
      /power 输入非法/,
    );
  });
});

describe('寿命损耗（03 §6 阶段 E）', () => {
  it('loss = decay[c]×max(1+0.15×(hard-1), 0.5)', () => {
    const lowHard = lifeLoss(DEFAULT_RUN_CONFIG, { classIndex: 0, hard: 0.2 });
    expect(lowHard).toBeCloseTo(1.3 * Math.max(1 + 0.15 * -0.8, 0.5), 12);
    const highHard = lifeLoss(DEFAULT_RUN_CONFIG, { classIndex: 0, hard: 3 });
    expect(highHard).toBeCloseTo(1.3 * 1.3, 12);
    const topClass = lifeLoss(DEFAULT_RUN_CONFIG, { classIndex: 4, hard: 1 });
    expect(topHard0(topClass)).toBe(true);
  });

  function topHard0(value: number): boolean {
    return Math.abs(value - 0.75) < 1e-9;
  }
});

describe('机会乘子（03 §6 阶段 C）', () => {
  it('无邻居为 1', () => {
    expect(computeOpportunity(DEFAULT_RUN_CONFIG, [], [5, 5])).toBe(1);
  });

  it('偶数中位数取中间两数均值；公式与截断一致', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    // 邻居中位数高于全体 → 乘子 >1；受 [0.7,1.5] 截断
    const rich = computeOpportunity(DEFAULT_RUN_CONFIG, [100, 100], [1, 2, 100, 100]);
    expect(rich).toBeGreaterThan(1);
    expect(rich).toBeLessThanOrEqual(1.5);
    const poor = computeOpportunity(DEFAULT_RUN_CONFIG, [0, 0], [0, 0, 100, 100]);
    expect(poor).toBeLessThan(1);
    expect(poor).toBeGreaterThanOrEqual(0.7);
  });
});

describe('数值稳定 sigmoid', () => {
  it('极端输入无 NaN 且单调', () => {
    expect(stableSigmoid(0)).toBe(0.5);
    expect(Number.isFinite(stableSigmoid(1000))).toBe(true);
    expect(Number.isFinite(stableSigmoid(-1000))).toBe(true);
    expect(stableSigmoid(-10)).toBeLessThan(stableSigmoid(10));
  });
});

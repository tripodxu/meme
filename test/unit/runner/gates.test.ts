import { describe, expect, it } from 'vitest';

import {
  compareSemanticState,
  evaluateGateA,
  evaluateGateB,
  evaluateGateC,
  evaluateGateD,
  GATE_CRITERIA,
  GATE_SEEDS,
  type GateBLevel,
  type GateRunWindows,
} from '../../../src/runner/gates.js';
import type { WindowSummary } from '../../../src/runner/window-stats.js';

/** 构造最小可用窗口摘要（缺失窗口/空网络由 overrides 控制）。 */
function makeWindow(label: 'w2b' | 'w3', overrides: Partial<WindowSummary> = {}): WindowSummary {
  return {
    label,
    start: label === 'w2b' ? 1825 : 2555,
    end: label === 'w2b' ? 2554 : 3284,
    tickCount: 730,
    missingTicks: 0,
    observedTicks: 730,
    deadTicks: 0,
    classShares: [0.2, 0.2, 0.2, 0.2, 0.2],
    gini: 0.4,
    topWealthShare: 0.3,
    mUp: 0.5,
    mDown: 0.1,
    segregation: 0.3,
    openness: 0.5,
    eByClass: [1, 1.5, 2.2, 3.2, 4.5],
    medianValue: 2,
    aliveTickAverage: 40,
    deathRate: 0.02,
    competitionLossRate: 0.1,
    fallbackRate: null,
    flowCounts: Array.from({ length: 5 }, () => new Array<number>(5).fill(0)),
    flowRowRates: Array.from({ length: 5 }, () => new Array<null>(5).fill(null)),
    networkEmpty: false,
    edgeCountAverage: 50,
    crossClassEdgeShare: 0.4,
    avgDegree: 2.5,
    connectedComponents: 1,
    blocks30d: [],
    partialBlockMerged: false,
    ...overrides,
  };
}

function makeRun(
  seed: string,
  w3: Partial<WindowSummary>,
  w2b: Partial<WindowSummary> = {},
): GateRunWindows {
  return { seed, w2b: makeWindow('w2b', w2b), w3: makeWindow('w3', w3) };
}

describe('GATE_CRITERIA（handoff §4.1 冻结判据）', () => {
  it('判据与种子集登记固定', () => {
    expect(GATE_CRITERIA).toEqual({
      p0MeanMin: 0.15,
      mUpMeanMax: 0.6,
      p4RangeMin: 0.4,
      pL1PairMin: 0.1,
      minDistinctPairs: 2,
      w2bW3L1Max: 0.1,
    });
    expect(GATE_SEEDS).toHaveLength(30);
    expect(GATE_SEEDS[0]).toBe('p15-seed-001');
  });
});

describe('G-A：baseline P0(w3)/mUp(w3) 均值门槛', () => {
  it('P0≥0.15 且 mUp≤0.60 → 通过', () => {
    const runs = Array.from({ length: 30 }, (_, i) =>
      makeRun(`s${i}`, { classShares: [0.3, 0.2, 0.2, 0.2, 0.1], mUp: 0.5 }),
    );
    const result = evaluateGateA(runs);
    expect(result.passed).toBe(true);
    expect(result.p0Mean).toBeCloseTo(0.3, 12);
    expect(result.mUpMean).toBeCloseTo(0.5, 12);
    expect(result.extinctCount).toBe(0);
  });

  it('P0 偏低或 mUp 偏高 → 未通过', () => {
    const lowP0 = evaluateGateA([
      makeRun('s', { classShares: [0.1, 0.2, 0.2, 0.2, 0.3], mUp: 0.5 }),
    ]);
    expect(lowP0.passed).toBe(false);
    const highMup = evaluateGateA([
      makeRun('s', { classShares: [0.3, 0.2, 0.2, 0.2, 0.1], mUp: 0.7 }),
    ]);
    expect(highMup.passed).toBe(false);
  });

  it('全灭 run 排除出均值但计入 extinctCount；全部不可用 → 未通过', () => {
    const dead = makeRun('dead', { missingTicks: 730, aliveTickAverage: 0 });
    const alive = makeRun('alive', { classShares: [0.3, 0.2, 0.2, 0.2, 0.1], mUp: 0.5 });
    const mixed = evaluateGateA([dead, alive]);
    expect(mixed.extinctCount).toBe(1);
    expect(mixed.p0Mean).toBeCloseTo(0.3, 12);
    const allDead = evaluateGateA([dead, dead]);
    expect(allDead.passed).toBe(false);
    expect(Number.isNaN(allDead.p0Mean)).toBe(true);
  });
});

describe('G-C：‖P(w2b)−P(w3)‖₁ < 0.10', () => {
  it('分布漂移小 → 通过；漂移大 → 未通过', () => {
    const stable = evaluateGateC([
      makeRun(
        's',
        { classShares: [0.2, 0.2, 0.2, 0.2, 0.2] },
        { classShares: [0.21, 0.2, 0.2, 0.2, 0.19] },
      ),
    ]);
    expect(stable.passed).toBe(true);
    expect(stable.l1Mean).toBeCloseTo(0.02, 12);
    const drifting = evaluateGateC([
      makeRun(
        's',
        { classShares: [0.6, 0.1, 0.1, 0.1, 0.1] },
        { classShares: [0.1, 0.1, 0.1, 0.1, 0.6] },
      ),
    ]);
    expect(drifting.passed).toBe(false);
  });

  it('全部窗口不可用 → 未通过且统计为 NaN', () => {
    const dead = makeRun('dead', { missingTicks: 730 });
    const result = evaluateGateC([dead, dead]);
    expect(result.passed).toBe(false);
    expect(Number.isNaN(result.l1Mean)).toBe(true);
  });

  it('长度不一致的 P 向量抛错（结构性缺陷）', () => {
    expect(() =>
      evaluateGateC([
        {
          seed: 's',
          w2b: makeWindow('w2b', { classShares: [0.5, 0.5] }),
          w3: makeWindow('w3', { classShares: [0.3, 0.3, 0.4] }),
        },
      ]),
    ).toThrowError(/L1 输入长度不一致/);
  });
});

describe('G-B：P4 极差与相邻档位 ‖ΔP‖₁', () => {
  function levels(classSharesByParam: Record<string, number[][]>): GateBLevel[] {
    const result: GateBLevel[] = [];
    for (const [parameter, cells] of Object.entries(classSharesByParam)) {
      cells.forEach((classShares, levelIndex) => {
        result.push({
          cellKey: `${parameter}#${levelIndex}`,
          parameter,
          levelIndex,
          classSharesMean: classShares,
        });
      });
    }
    return result;
  }

  it('极差 ≥0.40 且 ≥2 个相邻对 → 通过', () => {
    const result = evaluateGateB(
      levels({
        bufferDays: [
          [0.6, 0.2, 0.1, 0.05, 0.05],
          [0.3, 0.25, 0.2, 0.15, 0.1],
          [0.05, 0.1, 0.15, 0.2, 0.5],
        ],
        threshold: [
          [0.5, 0.2, 0.15, 0.1, 0.05],
          [0.3, 0.25, 0.2, 0.15, 0.1],
          [0.1, 0.15, 0.2, 0.25, 0.3],
        ],
      }),
    );
    expect(result.p4Range).toBeCloseTo(0.45, 12);
    expect(result.passed).toBe(true);
    expect(result.distinctPairs.length).toBeGreaterThanOrEqual(2);
  });

  it('空档位输入 → 未通过', () => {
    const result = evaluateGateB([]);
    expect(result.passed).toBe(false);
    expect(Number.isNaN(result.p4Range)).toBe(true);
  });

  it('极差不足或只有一对拉开 → 未通过', () => {
    const narrow = evaluateGateB(
      levels({
        bufferDays: [
          [0.2, 0.2, 0.2, 0.2, 0.2],
          [0.2, 0.2, 0.2, 0.2, 0.2],
          [0.2, 0.2, 0.2, 0.2, 0.2],
        ],
      }),
    );
    expect(narrow.passed).toBe(false);
    const singlePair = evaluateGateB(
      levels({
        // P4（末位）：0.7 / 0.3 / 0.3 → 极差 0.40 达标
        // L0↔L1 ‖ΔP‖₁=0.8 ≥0.10，L1↔L2=0 → 仅 1 对，未通过
        bufferDays: [
          [0.05, 0.05, 0.1, 0.1, 0.7],
          [0.1, 0.15, 0.2, 0.25, 0.3],
          [0.1, 0.15, 0.2, 0.25, 0.3],
        ],
        threshold: [
          [0.35, 0.2, 0.2, 0.15, 0.1],
          [0.35, 0.2, 0.2, 0.15, 0.1],
          [0.35, 0.2, 0.2, 0.15, 0.1],
        ],
      }),
    );
    expect(singlePair.p4Range).toBeGreaterThanOrEqual(0.4);
    expect(singlePair.distinctPairs.length).toBe(1);
    expect(singlePair.passed).toBe(false);
  });
});

describe('G-D：语义状态逐位比较', () => {
  // v5 参照形状：无 refIncome（state-v1 语义）；v6 实际状态多出 refIncome，
  // compareSemanticState 会先剔除它再逐字段比较（G-D 口径）。
  const v5Society = {
    tick: 10,
    agents: [{ id: 'a-0001', value: 0.1, classIndex: 1 }],
    eByClass: [1, 1.5],
    openness: 0.5,
    initialClassShares: [0.5, 0.5],
    gini: 0.4,
    segregation: 0.3,
    mUp: 0.1,
    mDown: 0.05,
    edgeCount: 4,
    flowWindow: [
      {
        tick: 5,
        counts: [
          [0, 1],
          [0, 0],
        ],
      },
    ],
    lastOpennessUpdateTick: 0,
  };
  // flowWindow 克隆：结构相等但引用不同，强制走数组逐元素比较分支。
  const v6Society = {
    ...v5Society,
    refIncome: [2, 3],
    flowWindow: [
      {
        tick: 5,
        counts: [
          [0, 1],
          [0, 0],
        ],
      },
    ],
  };

  it('完全一致（refIncome 差异被剔除，信封字段不参与）→ equal', () => {
    const withDifferentRefIncome = { ...v6Society, refIncome: [9, 9] };
    const result = compareSemanticState(withDifferentRefIncome, v5Society);
    expect(result.equal).toBe(true);
    expect(result.firstDifference).toBeNull();
  });

  it('agents/宏观字段任一差异报告首个路径；浮点按位比较', () => {
    expect(compareSemanticState({ ...v6Society, gini: 0.41 }, v5Society).firstDifference).toContain(
      '$.gini',
    );
    expect(
      compareSemanticState(
        { ...v6Society, agents: [{ id: 'a-0001', value: 0.1, classIndex: 0 }] },
        v5Society,
      ).firstDifference,
    ).toContain('$.agents[0].classIndex');
    // Object.is 级别：0.1 与 0.1+ulp 不同
    const ulp = 0.1 + Number.EPSILON;
    expect(ulp).not.toBe(0.1);
    expect(compareSemanticState({ ...v6Society, openness: ulp }, v5Society).equal).toBe(false);
  });

  it('结构分支：NaN==NaN 视为相等、数组长度差、对象键数差、键缺失、叶子值差', () => {
    // 双侧同位 NaN：视为相等（数值路径未扰动的语义口径）
    const bothNan = compareSemanticState(
      { ...v6Society, mUp: Number.NaN },
      { ...v5Society, mUp: Number.NaN },
    );
    expect(bothNan.equal).toBe(true);
    // flowWindow 长度不同
    const lengthDiff = compareSemanticState({ ...v6Society, flowWindow: [] }, v5Society);
    expect(lengthDiff.equal).toBe(false);
    expect(lengthDiff.firstDifference).toContain('flowWindow.length');
    // 嵌套对象键数不同
    const keyCountDiff = compareSemanticState(
      { ...v6Society, agents: [{ id: 'a-0001', value: 0.1 }] },
      v5Society,
    );
    expect(keyCountDiff.equal).toBe(false);
    expect(keyCountDiff.firstDifference).toContain('agents[0].keys');
    // 同键数但键名不同（键在参照中缺失）
    const keyMissing = compareSemanticState(
      { ...v6Society, agents: [{ id: 'a-0001', extra: 1 }] },
      { ...v5Society, agents: [{ id: 'a-0001', value: 0.1 }] },
    );
    expect(keyMissing.equal).toBe(false);
    expect(keyMissing.firstDifference).toContain('agents[0].extra');
    // 叶子值类型相同但值不同（字符串）
    const leafDiff = compareSemanticState(
      { ...v6Society, agents: [{ id: 'a-9999' }] },
      { ...v5Society, agents: [{ id: 'a-0001' }] },
    );
    expect(leafDiff.equal).toBe(false);
    expect(leafDiff.firstDifference).toContain('agents[0].id');
  });

  it('evaluateGateD：全部一致 + class 往返 → 通过', () => {
    const good = evaluateGateD(
      [{ seed: 's', equal: true, firstDifference: null, refIncomeHeldInitial: true }],
      true,
    );
    expect(good.passed).toBe(true);
    const bad = evaluateGateD(
      [{ seed: 's', equal: false, firstDifference: '$.gini', refIncomeHeldInitial: true }],
      true,
    );
    expect(bad.passed).toBe(false);
    expect(bad.detail).toContain('$.gini');
    const noRoundTrip = evaluateGateD(
      [{ seed: 's', equal: true, firstDifference: null, refIncomeHeldInitial: true }],
      false,
    );
    expect(noRoundTrip.passed).toBe(false);
  });
});

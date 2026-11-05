import { describe, expect, it } from 'vitest';

import {
  buildP6AblationCells,
  buildP6AblationManifest,
  computeP6AblationHash,
  P6_ABLATION_BUDGET,
  P6_ABLATION_PREDICTIONS,
  P6_ABLATION_SEEDS,
  summarizeAblationExtras,
  type AblationWindowPair,
} from '../../../src/runner/p6-ablation.js';
import {
  buildPreregHashInput,
  computePreregistrationHash,
} from '../../../src/runner/preregistration.js';
import type { P6WindowMetrics } from '../../../src/runner/p6-analysis.js';

function windowOf(overrides: Partial<P6WindowMetrics> = {}): P6WindowMetrics {
  return {
    classShares: [0.5, 0.3, 0.15, 0.04, 0.01],
    gini: 0.4,
    mUp: 0.5,
    mDown: 0.5,
    segregation: 0.1,
    openness: 0.5,
    fallbackRate: 0,
    tickCount: 365,
    observedTicks: 365,
    missingTicks: 0,
    ...overrides,
  };
}

describe('P6-04 消融预注册（07 §11）', () => {
  it('baseline + 五个单轴消融，changedPaths 恰为 1', () => {
    const cells = buildP6AblationCells();
    expect(cells).toHaveLength(6);
    const baseline = cells.find((cell) => cell.cellKey === 'baseline');
    expect(baseline?.design).toBe('baseline');
    expect(baseline?.changedPaths).toEqual([]);
    const ablations = cells.filter((cell) => cell.cellKey !== 'baseline');
    expect(ablations).toHaveLength(5);
    for (const cell of ablations) {
      expect(cell.design).toBe('single');
      expect(cell.changedPaths).toHaveLength(1);
    }
    expect(ablations.map((cell) => cell.changedPaths[0]).sort()).toEqual(
      [
        'dynamics.congestionExponent',
        'dynamics.polarizationExponent',
        'need.needMultiplier',
        'networkOpportunity.beta',
        'openness.updateMode',
      ].sort(),
    );
  });

  it('30 个独立种子；预算覆盖 6 cell × 30 seed = 180 run', () => {
    const manifest = buildP6AblationManifest();
    expect(manifest.seeds).toHaveLength(30);
    expect(new Set(manifest.seeds).size).toBe(30);
    expect(manifest.seeds.every((seed) => seed.startsWith('p6-ablation-seed-'))).toBe(true);
    const runs = manifest.cells.length * manifest.seeds.length;
    expect(runs).toBe(180);
    expect(runs).toBeLessThanOrEqual(P6_ABLATION_BUDGET.maxRuns);
    expect(P6_ABLATION_SEEDS).toEqual(manifest.seeds);
  });

  it('预注册哈希覆盖 cells、seeds 与预算', () => {
    const manifest = buildP6AblationManifest();
    const baseHash = computeP6AblationHash();
    expect(computePreregistrationHash(manifest)).toBe(baseHash);

    const mutatedCells = {
      ...manifest,
      cells: manifest.cells.map((cell, index) =>
        index === 1 ? { ...cell, overrides: { networkOpportunity: { beta: 0.1 } } } : cell,
      ),
    };
    const mutatedSeeds = {
      ...manifest,
      seeds: [...manifest.seeds.slice(0, -1), 'p6-ablation-seed-999'],
    };
    const mutatedBudget = {
      ...manifest,
      budgets: { ...manifest.budgets, maxRuns: manifest.budgets.maxRuns + 1 },
    };
    expect(computePreregistrationHash(mutatedCells)).not.toBe(baseHash);
    expect(computePreregistrationHash(mutatedSeeds)).not.toBe(baseHash);
    expect(computePreregistrationHash(mutatedBudget)).not.toBe(baseHash);
    expect(JSON.stringify(buildPreregHashInput(mutatedCells))).not.toBe(
      JSON.stringify(buildPreregHashInput(manifest)),
    );
  });

  it('只有 ψ=1 预注册 P4 下降方向；其余不设方向', () => {
    expect(P6_ABLATION_PREDICTIONS['psi=1']).toEqual({
      metric: 'classShare4',
      direction: 'decrease',
      note: '07 §11：移除阶级持有成本，预期顶层塌缩显著增强（P4 下降）',
    });
    for (const cellKey of ['beta=0', 'openness=fixed', 'eta=0', 'kappa=0']) {
      expect(P6_ABLATION_PREDICTIONS[cellKey]?.metric).toBe('none');
      expect(P6_ABLATION_PREDICTIONS[cellKey]?.direction).toBe('none');
    }
  });
});

describe('P6-04 消融分项与方向判定', () => {
  function buildPairs(options: {
    readonly p4Delta: number;
    readonly negative?: number;
    readonly count?: number;
  }): AblationWindowPair[] {
    const count = options.count ?? 30;
    const negative = options.negative ?? count;
    return Array.from({ length: count }, (_, index) => {
      const sign = index < negative ? -1 : 1;
      return {
        baseline: windowOf(),
        candidate: windowOf({
          classShares: [0.5, 0.3, 0.15, 0.04 + 0.01 * 0, 0.01 + sign * options.p4Delta],
          gini: 0.4 + 0.01,
          mUp: 0.5 + 0.02,
        }),
      };
    });
  }

  it('ψ=1 的 P4 全部下降时预测成立', () => {
    const extras = summarizeAblationExtras('psi=1', buildPairs({ p4Delta: 0.02 }));
    expect(extras.classShareDeltaMedians[4]).toBeCloseTo(-0.02, 10);
    expect(extras.predictionMetricDelta).toBeCloseTo(-0.02, 10);
    expect(extras.predictionAgree).toBe(1);
    expect(extras.predictionHolds).toBe(true);
    expect(extras.giniDelta).toBeCloseTo(0.01, 10);
    expect(extras.mUpDelta).toBeCloseTo(0.02, 10);
  });

  it('P4 同号率不足 90% 时预测不成立', () => {
    const extras = summarizeAblationExtras('psi=1', buildPairs({ p4Delta: 0.02, negative: 25 }));
    expect(extras.predictionAgree).toBeCloseTo(25 / 30, 10);
    expect(extras.predictionHolds).toBe(false);
  });

  it('无方向预测的 cell 返回 null 判定，但仍报告分项', () => {
    const extras = summarizeAblationExtras('beta=0', buildPairs({ p4Delta: 0.02 }));
    expect(extras.prediction.metric).toBe('none');
    expect(extras.predictionMetricDelta).toBeNull();
    expect(extras.predictionAgree).toBeNull();
    expect(extras.predictionHolds).toBeNull();
    expect(extras.classShareDeltaMedians).toHaveLength(5);
  });
});

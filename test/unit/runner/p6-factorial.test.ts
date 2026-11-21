import { describe, expect, it } from 'vitest';

import {
  buildP6FactorialCells,
  buildP6FactorialManifest,
  computeP6FactorialHash,
  P6_FACTORIAL_BASELINE_KEY,
  P6_FACTORIAL_BUDGET,
  P6_FACTORIAL_POPULATION,
  P6_FACTORIAL_SEEDS,
  P6_FACTORIAL_TICKS,
  P6_FACTORIAL_WARMUP,
} from '../../../src/runner/p6-factorial.js';
import { computePreregistrationHash } from '../../../src/runner/preregistration.js';

describe('P6-02 多参数 factorial 预注册（07 §6.3）', () => {
  it('2^5 全因子：baseline + 5 single + 26 interaction，无重复配置', () => {
    const cells = buildP6FactorialCells();
    expect(cells).toHaveLength(32);
    const byDesign = (design: string) => cells.filter((cell) => cell.design === design);
    expect(byDesign('baseline')).toHaveLength(1);
    expect(byDesign('single')).toHaveLength(5);
    expect(byDesign('interaction')).toHaveLength(26);
    expect(byDesign('baseline')[0]?.cellKey).toBe(P6_FACTORIAL_BASELINE_KEY);
    expect(new Set(cells.map((cell) => cell.fullConfigHash)).size).toBe(32);
  });

  it('design 与 changedPaths 数量自洽；交互格点不得单轴归因', () => {
    for (const cell of buildP6FactorialCells()) {
      if (cell.design === 'baseline') {
        expect(cell.changedPaths).toEqual([]);
      } else if (cell.design === 'single') {
        expect(cell.changedPaths, cell.cellKey).toHaveLength(1);
      } else {
        expect(cell.changedPaths.length, cell.cellKey).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('代表性联合格点的 changedPaths 覆盖全部声明轴', () => {
    const cells = buildP6FactorialCells();
    const combo = cells.find(
      (cell) =>
        cell.cellKey === 'threshold=0.9+psi=flat+env0=expanded+crossDays=half+decay=steeper',
    );
    expect(combo).toBeDefined();
    expect(combo?.design).toBe('interaction');
    expect(combo?.changedPaths).toEqual([
      'ascent.crossDays',
      'lifespan.decay',
      'need.needMultiplier',
      'need.threshold',
      'opportunity.env0',
    ]);
  });

  it('种子、视野与预算按冻结口径进入 manifest', () => {
    const manifest = buildP6FactorialManifest();
    expect(manifest.populationSize).toBe(P6_FACTORIAL_POPULATION);
    expect(manifest.totalTicks).toBe(P6_FACTORIAL_TICKS);
    expect(manifest.warmupTicks).toBe(P6_FACTORIAL_WARMUP);
    expect(manifest.seeds).toEqual(P6_FACTORIAL_SEEDS);
    expect(manifest.seeds).toHaveLength(30);
    expect(new Set(manifest.seeds).size).toBe(30);
    expect(manifest.seeds.every((seed) => seed.startsWith('p6-factorial-seed-'))).toBe(true);
    expect(manifest.budgets).toEqual(P6_FACTORIAL_BUDGET);
    expect(manifest.primaryMetric).toBe('TV(P)');
    expect(manifest.cells).toHaveLength(32);
  });

  it('预注册哈希确定且对预算敏感（换预算 = 新 experimentId）', () => {
    const first = computeP6FactorialHash();
    expect(computeP6FactorialHash()).toBe(first);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    const modified = {
      ...buildP6FactorialManifest(),
      budgets: { ...P6_FACTORIAL_BUDGET, maxRuns: P6_FACTORIAL_BUDGET.maxRuns + 1 },
    };
    expect(computePreregistrationHash(modified)).not.toBe(first);
  });
});

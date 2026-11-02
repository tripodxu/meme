import type { WindowSummary } from './window-stats.js';

/**
 * 结构距离 D（07 §8 / rule.md 51）：
 * `D=0.30|ΔG|+0.25×TV(P)+0.20|ΔMup|+0.15|ΔS|+0.10|ΔO|`；
 * D 只用于筛选，单项指标必须同时保留。
 */
export function structuralDistance(a: WindowSummary, b: WindowSummary): number {
  return (
    0.3 * Math.abs(a.gini - b.gini) +
    0.25 * totalVariation(a.classShares, b.classShares) +
    0.2 * Math.abs(a.mUp - b.mUp) +
    0.15 * Math.abs(a.segregation - b.segregation) +
    0.1 * Math.abs(a.openness - b.openness)
  );
}

/** `TV(P)=0.5Σ|P[c]-P'[c]|`；阶级数不同时抛错。 */
export function totalVariation(p: readonly number[], q: readonly number[]): number {
  if (p.length !== q.length) {
    throw new Error(`TV(P) 阶级数不同: ${p.length} vs ${q.length}`);
  }
  let sum = 0;
  for (let c = 0; c < p.length; c += 1) {
    sum += Math.abs((p[c] ?? 0) - (q[c] ?? 0));
  }
  return sum / 2;
}

/** 初始实际差异门槛（07 §8，可预注册调整）：任一单项达标即认为“有实际差异”。 */
export interface DifferenceThresholds {
  readonly gini: number;
  readonly tv: number;
  readonly mUp: number;
  readonly segregation: number;
  readonly openness: number;
}

export const DEFAULT_DIFFERENCE_THRESHOLDS: DifferenceThresholds = {
  gini: 0.03,
  tv: 0.1,
  mUp: 0.05,
  segregation: 0.05,
  openness: 0.05,
};

export function meetsInitialDifference(
  a: WindowSummary,
  b: WindowSummary,
  thresholds: DifferenceThresholds = DEFAULT_DIFFERENCE_THRESHOLDS,
): { readonly met: boolean; readonly detail: string } {
  const tv = totalVariation(a.classShares, b.classShares);
  const dG = Math.abs(a.gini - b.gini);
  const dMup = Math.abs(a.mUp - b.mUp);
  const dS = Math.abs(a.segregation - b.segregation);
  const dO = Math.abs(a.openness - b.openness);
  const met =
    dG >= thresholds.gini ||
    tv >= thresholds.tv ||
    dMup >= thresholds.mUp ||
    dS >= thresholds.segregation ||
    dO >= thresholds.openness;
  return {
    met,
    detail: `|ΔG|=${dG.toFixed(4)} TV=${tv.toFixed(4)} |ΔMup|=${dMup.toFixed(4)} |ΔS|=${dS.toFixed(4)} |ΔO|=${dO.toFixed(4)}`,
  };
}

/** 聚类特征向量（07 §8.1）：窗口均值 P[c]、G、top10、Mup、Mdown、S、O。 */
export function featureVector(window: WindowSummary): number[] {
  return [
    ...window.classShares,
    window.gini,
    window.topWealthShare,
    window.mUp,
    window.mDown,
    window.segregation,
    window.openness,
  ];
}

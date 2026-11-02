import { DEFAULT_LABEL_THRESHOLDS, type LabelThresholds } from '../core/labels/thresholds.js';
import type { WindowSummary } from './window-stats.js';

/**
 * 结构标签应用（07 §10，labels-v3）。标签只作描述、可多标签或未归类，
 * 不得反馈到模拟；结构判异固定 C=5 与固定指标窗口。
 */

export interface LabelEvaluation {
  readonly labels: readonly string[];
  readonly unclassified: boolean;
  /** 每个标签的判定依据（原始指标与阈值），供覆盖/重叠审计。 */
  readonly evidence: Readonly<Record<string, string>>;
}

function evaluatePyramid(
  p: readonly number[],
  t: LabelThresholds,
  ev: Record<string, string>,
): boolean {
  const tol = t.monotonicTolerance;
  let monotonic = true;
  for (let i = 0; i + 1 < p.length; i += 1) {
    if ((p[i] as number) < (p[i + 1] ?? 0) - tol) {
      monotonic = false;
    }
  }
  const bottomTwo = (p[0] ?? 0) + (p[1] ?? 0);
  const top = p[4] ?? 0;
  const middle = (p[1] ?? 0) + (p[2] ?? 0) + (p[3] ?? 0);
  const ok =
    monotonic &&
    bottomTwo >= t.labels.pyramid.bottomTwoShareMin &&
    top <= t.labels.pyramid.topShareMax &&
    middle >= t.labels.pyramid.middleThreeShareMin;
  ev['pyramid'] =
    `monotonic=${monotonic} bottomTwo=${bottomTwo.toFixed(3)} top=${top.toFixed(3)} middle=${middle.toFixed(3)}`;
  return ok;
}

function evaluateOlive(
  p: readonly number[],
  t: LabelThresholds,
  ev: Record<string, string>,
): boolean {
  const mode = p[t.labels.olive.modeClassIndex] ?? 0;
  const tol = t.modeTolerance;
  let modeDominant = true;
  for (let i = 0; i < p.length; i += 1) {
    if (mode < (p[i] ?? 0) - tol) {
      modeDominant = false;
    }
  }
  const middle = (p[1] ?? 0) + (p[2] ?? 0) + (p[3] ?? 0);
  const bottom = p[0] ?? 0;
  const top = p[4] ?? 0;
  const ok =
    middle >= t.labels.olive.middleThreeShareMin &&
    modeDominant &&
    bottom <= t.labels.olive.poleShareMax &&
    top <= t.labels.olive.poleShareMax;
  ev['olive'] =
    `middle=${middle.toFixed(3)} mode=${mode.toFixed(3)} bottom=${bottom.toFixed(3)} top=${top.toFixed(3)}`;
  return ok;
}

function evaluateBipolar(
  p: readonly number[],
  gini: number,
  t: LabelThresholds,
  ev: Record<string, string>,
): boolean {
  const poles = (p[0] ?? 0) + (p[4] ?? 0);
  const middle = (p[1] ?? 0) + (p[2] ?? 0) + (p[3] ?? 0);
  const ok =
    poles >= t.labels.bipolar.poleSumMin &&
    middle <= t.labels.bipolar.middleThreeShareMax &&
    gini >= t.labels.bipolar.giniMin;
  ev['bipolar'] = `poles=${poles.toFixed(3)} middle=${middle.toFixed(3)} gini=${gini.toFixed(3)}`;
  return ok;
}

function evaluateClosedStratified(
  openness: number,
  mUp: number,
  segregation: number,
  edgeCount: number,
  blockSupport: number,
  t: LabelThresholds,
  ev: Record<string, string>,
): boolean {
  const c = t.labels.closedStratified;
  const base = openness <= c.opennessMax && mUp <= c.mUpMax && segregation >= c.segregationMin;
  const edgesOk = !c.requiresEdgeCount || edgeCount > 0;
  const ok = base && edgesOk && blockSupport >= c.blockSupportMin;
  ev['closedStratified'] =
    `O=${openness.toFixed(3)} Mup=${mUp.toFixed(3)} S=${segregation.toFixed(3)} edges=${edgeCount} blockSupport=${blockSupport.toFixed(2)}`;
  return ok;
}

function evaluateHighFlowNetwork(
  mUp: number,
  openness: number,
  segregation: number,
  crossClassEdgeShare: number,
  t: LabelThresholds,
  ev: Record<string, string>,
): boolean {
  const c = t.labels.highFlowNetwork;
  const ok =
    mUp >= c.mUpMin &&
    openness >= c.opennessMin &&
    segregation <= c.segregationMax &&
    crossClassEdgeShare >= c.crossClassEdgeShareMin;
  ev['highFlowNetwork'] =
    `Mup=${mUp.toFixed(3)} O=${openness.toFixed(3)} S=${segregation.toFixed(3)} cross=${crossClassEdgeShare.toFixed(3)}`;
  return ok;
}

function evaluateTopHeavy(
  p: readonly number[],
  pyramid: boolean,
  olive: boolean,
  t: LabelThresholds,
  ev: Record<string, string>,
): boolean {
  const top = p[4] ?? 0;
  const ok = top >= t.labels.topHeavy.topShareMin && !pyramid && !olive;
  ev['topHeavy'] = `top=${top.toFixed(3)} pyramid=${pyramid} olive=${olive}`;
  return ok;
}

/** 封闭分层要求“窗口至少 80% 的 30 日块成立”（07 §10）。 */
function closedStratifiedBlockSupport(window: WindowSummary, t: LabelThresholds): number {
  const c = t.labels.closedStratified;
  const blocks = window.blocks30d;
  if (blocks.length === 0) {
    return 0;
  }
  let satisfied = 0;
  for (const block of blocks) {
    if (
      block.openness <= c.opennessMax &&
      window.mUp <= c.mUpMax &&
      window.segregation >= c.segregationMin
    ) {
      satisfied += 1;
    }
  }
  return satisfied / blocks.length;
}

/** 对单个窗口摘要应用完整标签表；未命中任何标签为“未归类”。 */
export function evaluateLabels(
  window: WindowSummary,
  thresholds: LabelThresholds = DEFAULT_LABEL_THRESHOLDS,
): LabelEvaluation {
  const evidence: Record<string, string> = {};
  const p = window.classShares;
  if (window.missingTicks > 0) {
    return {
      labels: [],
      unclassified: true,
      evidence: { window: `missingTicks=${window.missingTicks}` },
    };
  }
  const pyramid = evaluatePyramid(p, thresholds, evidence);
  const olive = evaluateOlive(p, thresholds, evidence);
  const bipolar = evaluateBipolar(p, window.gini, thresholds, evidence);
  const closed = evaluateClosedStratified(
    window.openness,
    window.mUp,
    window.segregation,
    window.edgeCountAverage,
    closedStratifiedBlockSupport(window, thresholds),
    thresholds,
    evidence,
  );
  const highFlow = evaluateHighFlowNetwork(
    window.mUp,
    window.openness,
    window.segregation,
    window.crossClassEdgeShare,
    thresholds,
    evidence,
  );
  const topHeavy = evaluateTopHeavy(p, pyramid, olive, thresholds, evidence);
  const labels: string[] = [];
  if (pyramid) labels.push('pyramid');
  if (olive) labels.push('olive');
  if (bipolar) labels.push('bipolar');
  if (closed) labels.push('closedStratified');
  if (highFlow) labels.push('highFlowNetwork');
  if (topHeavy) labels.push('topHeavy');
  return { labels, unclassified: labels.length === 0, evidence };
}

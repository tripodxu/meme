import { HASH_DOMAINS } from '../hash/domains.js';
import { hashValue } from '../hash/hash.js';

/** 结构标签阈值表版本（07 §10）；变化必须升级并重新预注册。 */
export const LABEL_THRESHOLDS_VERSION = 'labels-v3';

/** 单标签的窗口条件字段；全部为封闭结构，新增条件必须升级阈值版本。 */
export interface PyramidConditions {
  readonly adjacentMonotonic: 'nonIncreasing';
  readonly bottomTwoShareMin: number;
  readonly topShareMax: number;
  readonly middleThreeShareMin: number;
}
export interface OliveConditions {
  readonly middleThreeShareMin: number;
  readonly modeClassIndex: number;
  readonly poleShareMax: number;
}
export interface BipolarConditions {
  readonly poleSumMin: number;
  readonly middleThreeShareMax: number;
  readonly giniMin: number;
}
export interface ClosedStratifiedConditions {
  readonly opennessMax: number;
  readonly mUpMax: number;
  readonly segregationMin: number;
  readonly requiresEdgeCount: boolean;
  readonly blockSupportMin: number;
}
export interface HighFlowNetworkConditions {
  readonly mUpMin: number;
  readonly opennessMin: number;
  readonly segregationMax: number;
  readonly crossClassEdgeShareMin: number;
}
export interface TopHeavyConditions {
  readonly topShareMin: number;
}

export interface LabelThresholds {
  /** 结构判异固定 `C=5`；其他 C 不使用本表（07 §10）。 */
  readonly classCount: number;
  readonly monotonicTolerance: number;
  readonly modeTolerance: number;
  readonly labels: {
    readonly pyramid: PyramidConditions;
    readonly olive: OliveConditions;
    readonly bipolar: BipolarConditions;
    readonly closedStratified: ClosedStratifiedConditions;
    readonly highFlowNetwork: HighFlowNetworkConditions;
    readonly topHeavy: TopHeavyConditions;
  };
}

/**
 * `labels-v3` 首轮筛查阈值表（07 §10）。这是可配置描述的默认值，
 * 不得反馈到模拟；标签只作描述，"三种结构"按指纹聚类计数。
 */
export const DEFAULT_LABEL_THRESHOLDS: LabelThresholds = Object.freeze({
  classCount: 5,
  monotonicTolerance: 0.02,
  modeTolerance: 0.02,
  labels: Object.freeze({
    pyramid: Object.freeze({
      adjacentMonotonic: 'nonIncreasing',
      bottomTwoShareMin: 0.6,
      topShareMax: 0.1,
      middleThreeShareMin: 0.2,
    }),
    olive: Object.freeze({
      middleThreeShareMin: 0.6,
      modeClassIndex: 2,
      poleShareMax: 0.2,
    }),
    bipolar: Object.freeze({
      poleSumMin: 0.5,
      middleThreeShareMax: 0.4,
      giniMin: 0.4,
    }),
    closedStratified: Object.freeze({
      opennessMax: 0.25,
      mUpMax: 0.05,
      segregationMin: 0.5,
      requiresEdgeCount: true,
      blockSupportMin: 0.8,
    }),
    highFlowNetwork: Object.freeze({
      mUpMin: 0.2,
      opennessMin: 0.6,
      segregationMax: 0.2,
      crossClassEdgeShareMin: 0.35,
    }),
    topHeavy: Object.freeze({
      topShareMin: 0.5,
    }),
  }),
});

/**
 * `labelThresholdsHash`（02 §8）：覆盖完整标签阈值表与 tolerance，
 * 与 `preregistrationHash` 同时覆盖；只记录版本字符串不足以防篡改。
 */
export function computeLabelThresholdsHash(
  thresholds: LabelThresholds = DEFAULT_LABEL_THRESHOLDS,
): string {
  return hashValue(HASH_DOMAINS.labelThresholds, thresholds);
}

import {
  CONFIG_SCHEMA_VERSION,
  RULES_VERSION,
  STATE_SCHEMA_VERSION,
} from '../../core/control/versions.js';

/**
 * 全站科学声明与版本单一数据源（F0）。
 * 规则版本与 schema 版本均直接读取 core 常量，禁止在 UI 组件中手写或拼接矛盾口径。
 */
export const CLAIMS = {
  rulesVersion: RULES_VERSION,
  configSchemaVersion: CONFIG_SCHEMA_VERSION,
  stateSchemaVersion: STATE_SCHEMA_VERSION,
  schemaSummary: `${CONFIG_SCHEMA_VERSION} / ${STATE_SCHEMA_VERSION}`,
  g6Badge: 'G6 (D1 两体制) 已收口',
  g6Detail: 'G6 D1 两体制已校准（P6-15 / P6-15b，mock-weighted-v1；传统 k≥3 未通过）',
  g6Footer: 'G6 D1 已收口 · 两体制预设已冻结（传统 k≥3 未通过）',
  g6BoundaryNote:
    'P6-15（N=40，660/660，真实 mock-weighted-v1）在新旧条件 4 双口径下确认两体制+连续统（k=2 ARI=1.000、sil=0.6602、TV(P)=0.7279），跨规模微扰 100% 吸收；P6-15b（N=600，官方 evaluateStageB）独立确认体制 II ψ=1 消融结构退化（w2b TV(P)=0.2425，100% 超 D95），仅两体制代表预设已冻结为 calibrated: true。适用边界：仅限 D1 两体制目标、rules-v19 默认 generationalMode=none 与 mock-weighted-v1；传统 k≥3、β/O/η/κ 消融与现实因果均未成立，不得表述为“三态涌现”。',
  calibratedPresetNotice: (name: string, rulesVersion: string): string =>
    `已载入已校准两体制预设「${name}」（${rulesVersion}，D1 两体制 mock-weighted-v1 冻结配置；修改任一参数将转为未校准自定义）。`,
} as const;

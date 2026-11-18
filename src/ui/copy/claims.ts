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
  g6Badge: 'G6 已通过（D1 两体制）',
  g6Detail: 'G6 已通过（D1 两体制 · P6-09 + R4）',
  g6Footer: 'G6 已通过（D1 两体制，仅 mock/N=200）',
  g6BoundaryNote:
    'D1“2 体制 + 连续统”已在 rules-v16 / N=200 / mock-weighted-v1 下通过 P6-09 与 R4 闭环；传统 k≥3 离散结构与 Jev 因果对照仍未通过，不得外推为“三态涌现”或现实因果。',
  calibratedPresetNotice: (name: string, rulesVersion: string): string =>
    `已载入 G6 校准预设「${name}」（D1 两体制，${rulesVersion}）。`,
} as const;

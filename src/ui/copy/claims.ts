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
  g6Badge: 'G6 未通过',
  g6Detail: 'G6 未通过（R4 消融未达结构退化门槛）',
  g6Footer: 'G6 未通过 · 未校准演示',
  g6BoundaryNote:
    'P6-09 在 ADR 0010 口径下得到 two-regime-candidate（rules-v16 / N=200 / mock-weighted-v1），但 R4 五项消融按 07 §11 的 TV(P) ≥ 0.10 门槛重算后全部未达，G6 保持未通过；传统 k≥3 离散结构与 Jev 因果对照亦未通过，不得外推为“三态涌现”“已校准”或现实因果。',
  calibratedPresetNotice: (name: string, rulesVersion: string): string =>
    `已载入预设「${name}」（${rulesVersion}，未校准演示）。`,
} as const;

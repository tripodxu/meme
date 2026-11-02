/**
 * 版本常量。三个版本轴互不复用：
 * - `rulesVersion` 管社会结算语义；
 * - `schemaVersion` 管序列化/导入导出；
 * - `promptVersion` 管 Jev 输入。
 */
export const RULES_VERSION = 'rules-v3' as const;
export const ENGINE_VERSION = 'engine-v0.0.0' as const;
export const DECISION_SCHEMA_VERSION = 'stratify-decision-v1' as const;
export const CONFIG_SCHEMA_VERSION = 'stratify-config-v1' as const;
export const PARAMS_SCHEMA_VERSION = 'stratify-params-v1' as const;
export const INITIAL_POPULATION_SCHEMA_VERSION = 'stratify-initial-population-v1' as const;
export const PREREGISTRATION_SCHEMA_VERSION = 'stratify-preregistration-v1' as const;

export type RulesVersion = typeof RULES_VERSION;
export type EngineVersion = typeof ENGINE_VERSION;

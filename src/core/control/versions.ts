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
/** 权威状态序列化 schema；字段增删或含义变化必须升级。 */
export const STATE_SCHEMA_VERSION = 'stratify-state-v1' as const;
/** 快照封装 schema（02 §7：原子写入由存储适配层负责）。 */
export const SNAPSHOT_SCHEMA_VERSION = 'stratify-snapshot-v1' as const;

export type SnapshotSchemaVersion = typeof SNAPSHOT_SCHEMA_VERSION;
/** run 身份块 schema（02 §10）。 */
export const RUN_IDENTITY_SCHEMA_VERSION = 'stratify-run-identity-v1' as const;

export type RulesVersion = typeof RULES_VERSION;
export type EngineVersion = typeof ENGINE_VERSION;

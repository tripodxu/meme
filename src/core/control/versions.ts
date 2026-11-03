/**
 * 版本常量。三个版本轴互不复用：
 * - `rulesVersion` 管社会结算语义（v5：上升持有裕度，见 changes/0005；v4：需求线环境持有人乘子 + θM 再平衡，见 changes/0004）；
 * - `engineVersion` 管结算实现修订（v0.3.0：非法/极端输入的行为修正，见 changes/0006；
 *   v0.2.0：v5 裕度逻辑；v0.1.0：v4 env0 锚定）；
 * - `schemaVersion` 管序列化/导入导出；
 * - `promptVersion` 管 Jev 输入。
 */
export const RULES_VERSION = 'rules-v5' as const;
export const ENGINE_VERSION = 'engine-v0.3.0' as const;
export const DECISION_SCHEMA_VERSION = 'stratify-decision-v1' as const;
/**
 * 配置 schema：v2 起 `openness.updateMode` 为必填（P1-10 开放度消融开关）。
 *
 * 注意与 `HASH_DOMAINS.config`（`'stratify-config-v1'`）区分：后者是 **哈希域前缀**，
 * 属于冻结的哈希契约，不随配置字段变化而改；改它会作废全部历史 `configHash` 向量。
 * v1 配置由 `validateRunConfig` 迁移：缺失的 updateMode 补 `dynamic`
 *（v1 时期 O 恒为动态更新，迁移保持原语义）。
 */
export const CONFIG_SCHEMA_VERSION = 'stratify-config-v2' as const;
export const CONFIG_SCHEMA_VERSION_V1 = 'stratify-config-v1' as const;
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

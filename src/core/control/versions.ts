/**
 * 版本常量。三个版本轴互不复用：
 * - `rulesVersion` 管社会结算语义（v8：位移准入 D-09，见 changes/0010；v7：裕度参照系统一计价，见 changes/0009；v6：需求参照系 A′，见 changes/0008；
 *   v5：上升持有裕度，见 changes/0005；v4：需求线环境持有人乘子 + θM 再平衡，见 changes/0004）；
 * - `engineVersion` 管结算实现修订（v0.6.0：位移准入对决与在位者降级；v0.5.0：裕度参照系分派；v0.4.0：refIncome 宏观状态 + graceDays 判定计时 +
 *   参照系分派；v0.3.0：非法/极端输入的行为修正，见 changes/0006；v0.2.0：v5 裕度逻辑；v0.1.0：v4 env0 锚定）；
 * - `schemaVersion` 管序列化/导入导出；
 * - `promptVersion` 管 Jev 输入。
 */
export const RULES_VERSION = 'rules-v8' as const;
export const ENGINE_VERSION = 'engine-v0.6.0' as const;
export const DECISION_SCHEMA_VERSION = 'stratify-decision-v1' as const;
/**
 * 配置 schema：v3 起 `need.referenceMode/referenceSmoothing/graceDays` 为必填
 *（rules-v6 需求参照系，changes/0008）；v2 起 `openness.updateMode` 为必填（P1-10）。
 *
 * 注意与 `HASH_DOMAINS.config`（`'stratify-config-v1'`）区分：后者是 **哈希域前缀**，
 * 属于冻结的哈希契约，不随配置字段变化而改；改它会作废全部历史 `configHash` 向量。
 * 旧配置由 `validateRunConfig` 迁移（保持原语义，不默认开新机制）：
 * v1 → v2 缺失的 updateMode 补 `dynamic`（v1 时期 O 恒为动态更新）；
 * v2 → v3 缺失的参照系参数补 `referenceMode:'own'`/`referenceSmoothing:0.2`/`graceDays:0`
 *（v2 时期 need 即 'own' 公式，宽限期为 0 才与 v5 判定计时逐位一致）。
 */
export const CONFIG_SCHEMA_VERSION = 'stratify-config-v3' as const;
export const CONFIG_SCHEMA_VERSION_V1 = 'stratify-config-v1' as const;
export const CONFIG_SCHEMA_VERSION_V2 = 'stratify-config-v2' as const;
export const PARAMS_SCHEMA_VERSION = 'stratify-params-v1' as const;
export const INITIAL_POPULATION_SCHEMA_VERSION = 'stratify-initial-population-v1' as const;
export const PREREGISTRATION_SCHEMA_VERSION = 'stratify-preregistration-v1' as const;
/** 权威状态序列化 schema；v2 增补 society.refIncome（rules-v6 需求参照系）。 */
export const STATE_SCHEMA_VERSION = 'stratify-state-v2' as const;
/** 快照封装 schema（02 §7：原子写入由存储适配层负责）。 */
export const SNAPSHOT_SCHEMA_VERSION = 'stratify-snapshot-v1' as const;

export type SnapshotSchemaVersion = typeof SNAPSHOT_SCHEMA_VERSION;
/** run 身份块 schema（02 §10）。 */
export const RUN_IDENTITY_SCHEMA_VERSION = 'stratify-run-identity-v1' as const;

export type RulesVersion = typeof RULES_VERSION;
export type EngineVersion = typeof ENGINE_VERSION;

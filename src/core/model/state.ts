import type { RunConfig } from '../config/types.js';
import type { Seed } from '../control/ids.js';
import type { STATE_SCHEMA_VERSION } from '../control/versions.js';
import type { SocietyState } from './society.js';

/**
 * 权威仿真状态。
 *
 * 03 §2.2 将 `ruleset/config/seed` 列为 SocietyState 的一部分；此处放在 `SimState`
 * 顶层，语义一致：完整不可变输入 + hash 与可变社会状态共同构成权威状态。
 * `seed` 不是 `RunConfig` 字段，不进入 `configHash/paramsHash`（02 §4）。
 */
export interface SimState {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  /** 完整冻结配置（深冻结）。 */
  readonly config: RunConfig;
  readonly configHash: string;
  readonly paramsHash: string;
  readonly seed: Seed;
  readonly society: SocietyState;
}

import { errorCodes, StratifyError } from '../control/errors.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../control/versions.js';
import { computeAuthoritativeStateHash } from '../hash/state-hash.js';
import { decodeSimState, encodeSimState, type SerializedSimState } from '../model/serialize.js';
import type { SimState } from '../model/state.js';

/**
 * 权威快照（02 §7）：包含未来结算所需全部字段；
 * 原子写入（临时文件/对象校验后替换）由存储适配层负责。
 */
export interface Snapshot {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  /** 快照对应权威状态的 hash；恢复时必须一致。 */
  readonly stateHash: string;
  readonly state: SerializedSimState;
}

/** 权威状态 → 快照。 */
export function captureSnapshot(state: SimState): Snapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    stateHash: computeAuthoritativeStateHash(state),
    state: encodeSimState(state),
  };
}

/**
 * 快照 → 权威状态。这是恢复的信任边界：schema、结构、网络与
 * `stateHash` 全部校验，损坏快照不得作为恢复点。
 */
export function restoreSnapshot(value: unknown): SimState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StratifyError(errorCodes.CONFIG_PATH, '快照必须是对象', [{ path: '$' }]);
  }
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== SNAPSHOT_SCHEMA_VERSION) {
    throw new StratifyError(
      errorCodes.CONFIG_UNKNOWN_VERSION,
      `未知快照 schemaVersion: ${String(record['schemaVersion'])}`,
    );
  }
  const state = decodeSimState(record['state']);
  const stateHash = record['stateHash'];
  if (typeof stateHash !== 'string') {
    throw new StratifyError(errorCodes.HASH_INVALID, '快照缺少 stateHash', [
      { path: '$.stateHash' },
    ]);
  }
  const recomputed = computeAuthoritativeStateHash(state);
  if (recomputed !== stateHash) {
    throw new StratifyError(errorCodes.HASH_INVALID, '快照 stateHash 与内容不一致', [
      { path: '$.stateHash' },
    ]);
  }
  return state;
}

/** 重放日志条目（04 §9）：只保存决策层最终 `selectedAction`。 */
export interface DecisionLogEntry {
  readonly tick: number;
  readonly agentId: string;
  readonly selectedAction: string;
}

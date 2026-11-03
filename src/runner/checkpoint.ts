import { errorCodes, StratifyError } from '../core/control/errors.js';
import { computeAuthoritativeStateHash } from '../core/hash/state-hash.js';
import type { SimState } from '../core/model/state.js';
import { captureSnapshot, restoreSnapshot, type Snapshot } from '../core/replay/snapshot.js';

/**
 * P5a-03：原子本地检查点（01 §8.1 G5a）。
 *
 * - 写入先落临时文件，fsync 后 rename 原子替换——临时文件不得被当作有效恢复点；
 * - 恢复校验 schema/stateHash/内容一致，不兼容立即停止（不猜测）；
 * - 保留至少一个上一完整点（`historyDepth`）。
 * I/O 由宿主注入（核心纯度不破坏；runner 层允许 Node）。
 */

export interface CheckpointHost {
  readonly writeTemp: (path: string, payload: string) => Promise<void>;
  readonly promote: (tempPath: string, path: string) => Promise<void>;
  readonly read: (path: string) => Promise<string>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly remove: (path: string) => Promise<void>;
}

export interface CheckpointMeta {
  readonly cellKey: string;
  readonly seed: string;
  readonly tickCompleted: number;
  readonly savedAtSequence: number;
}

export interface CheckpointPayload {
  readonly schemaVersion: 'checkpoint-v1';
  readonly meta: CheckpointMeta;
  readonly snapshot: Snapshot;
}

export function buildCheckpointPayload(meta: CheckpointMeta, state: SimState): CheckpointPayload {
  return {
    schemaVersion: 'checkpoint-v1',
    meta,
    snapshot: captureSnapshot(state),
  };
}

/**
 * 原子写检查点：先写 `<path>.tmp`，成功后 promote（rename）。
 * 写临时文件失败时主检查点不受影响。
 */
export async function saveCheckpoint(
  host: CheckpointHost,
  path: string,
  payload: CheckpointPayload,
): Promise<void> {
  const tempPath = `${path}.tmp`;
  await host.writeTemp(tempPath, JSON.stringify(payload));
  await host.promote(tempPath, path);
}

/** 恢复检查点：schema/哈希/一致性全部校验；损坏抛错（调用方回退上一完整点）。 */
export async function loadCheckpoint(
  host: CheckpointHost,
  path: string,
): Promise<{ payload: CheckpointPayload; state: SimState }> {
  if (!(await host.exists(path))) {
    throw new StratifyError(errorCodes.CONFIG_PATH, `检查点不存在: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await host.read(path));
  } catch {
    throw new StratifyError(errorCodes.CONFIG_PATH, `检查点 JSON 损坏: ${path}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new StratifyError(errorCodes.CONFIG_PATH, `检查点必须是对象: ${path}`);
  }
  const record = raw as Record<string, unknown>;
  if (record['schemaVersion'] !== 'checkpoint-v1') {
    throw new StratifyError(
      errorCodes.CONFIG_UNKNOWN_VERSION,
      `未知检查点版本: ${String(record['schemaVersion'])}`,
    );
  }
  const state = restoreSnapshot(record['snapshot']);
  const meta = record['meta'] as CheckpointMeta;
  const recomputed = computeAuthoritativeStateHash(state);
  if (recomputed !== (record['snapshot'] as Snapshot).stateHash) {
    throw new StratifyError(errorCodes.HASH_INVALID, `检查点 stateHash 不一致: ${path}`);
  }
  void meta;
  return { payload: record as unknown as CheckpointPayload, state };
}

/**
 * 带历史深度的保存：主点 + 上一完整点（`<path>.prev`）。
 * 写失败不覆盖主点；promote 失败由宿主抛出。
 */
export async function saveCheckpointWithHistory(
  host: CheckpointHost,
  path: string,
  payload: CheckpointPayload,
): Promise<void> {
  if (await host.exists(path)) {
    const previous = await host.read(path);
    await host.writeTemp(`${path}.prev.tmp`, previous);
    await host.promote(`${path}.prev.tmp`, `${path}.prev`);
  }
  await saveCheckpoint(host, path, payload);
}

/** G5a 恢复语义：优先主点；损坏/不存在时回退上一完整点；两者皆失败抛错。 */
export async function loadCheckpointWithFallback(
  host: CheckpointHost,
  path: string,
): Promise<{ payload: CheckpointPayload; state: SimState; fromFallback: boolean }> {
  try {
    const loaded = await loadCheckpoint(host, path);
    return { ...loaded, fromFallback: false };
  } catch (primaryError) {
    const prevPath = `${path}.prev`;
    if (!(await host.exists(prevPath))) {
      throw primaryError;
    }
    const loaded = await loadCheckpoint(host, prevPath);
    return { ...loaded, fromFallback: true };
  }
}

/** 内存宿主：测试与无盘环境。 */
export function memoryCheckpointHost(): CheckpointHost & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async writeTemp(path, payload) {
      files.set(path, payload);
    },
    async promote(tempPath, path) {
      const content = files.get(tempPath);
      if (content === undefined) {
        throw new StratifyError(errorCodes.INVARIANT_VIOLATED, `临时文件缺失: ${tempPath}`);
      }
      files.set(path, content);
      files.delete(tempPath);
    },
    async read(path) {
      const content = files.get(path);
      if (content === undefined) {
        throw new StratifyError(errorCodes.CONFIG_PATH, `文件不存在: ${path}`);
      }
      return content;
    },
    async exists(path) {
      return files.has(path);
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

import { errorCodes, StratifyError } from '../core/control/errors.js';
import type { SimState } from '../core/model/state.js';
import { captureSnapshot, restoreSnapshot, type Snapshot } from '../core/replay/snapshot.js';

/**
 * P5a-03：原子本地检查点（01 §8.1 G5a）。
 *
 * 保证（由注入宿主实现）：
 * - 写入先落临时文件并 fsync，再 rename 原子替换；临时文件不得被当作有效恢复点；
 * - `saveCheckpointWithHistory` 先把主点读入校验，只有通过校验的主点才提升为 `.prev`；
 *   损坏主点不会覆盖既有 `.prev`；
 * - 恢复校验 schema/meta/stateHash（`restoreSnapshot` 已重算 stateHash），
 *   不兼容或损坏立即停止（不猜测）；
 * - 保留至少一个上一完整点（`historyDepth`），主点损坏时回退 `.prev`。
 * I/O 由宿主注入（核心纯度不破坏；runner 层允许 Node，见 `checkpoint-fs.ts`）。
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

/** 恢复期望：用于拒绝把另一个 run 的检查点当作本 run 的恢复点。 */
export interface CheckpointExpectation {
  readonly cellKey?: string;
  readonly seed?: string;
  readonly minTickCompleted?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMeta(value: unknown, path: string): CheckpointMeta {
  if (!isPlainObject(value)) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, `检查点 meta 必须是对象: ${path}`);
  }
  const cellKey = value['cellKey'];
  if (typeof cellKey !== 'string' || cellKey.length === 0) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `检查点 meta.cellKey 必须为非空字符串: ${path}`,
    );
  }
  const seed = value['seed'];
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `检查点 meta.seed 必须为非空字符串: ${path}`,
    );
  }
  const tickCompleted = value['tickCompleted'];
  if (typeof tickCompleted !== 'number' || !Number.isInteger(tickCompleted) || tickCompleted < 0) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `检查点 meta.tickCompleted 必须为 >=0 的整数: ${path}`,
    );
  }
  const savedAtSequence = value['savedAtSequence'];
  if (
    typeof savedAtSequence !== 'number' ||
    !Number.isInteger(savedAtSequence) ||
    savedAtSequence < 0
  ) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `检查点 meta.savedAtSequence 必须为 >=0 的整数: ${path}`,
    );
  }
  return { cellKey, seed, tickCompleted, savedAtSequence };
}

function assertExpectation(
  meta: CheckpointMeta,
  expectation: CheckpointExpectation | undefined,
  path: string,
): void {
  if (expectation === undefined) return;
  if (expectation.cellKey !== undefined && meta.cellKey !== expectation.cellKey) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `检查点 cellKey 不匹配: 期望 ${expectation.cellKey}，实际 ${meta.cellKey}（${path}）`,
    );
  }
  if (expectation.seed !== undefined && meta.seed !== expectation.seed) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `检查点 seed 不匹配: 期望 ${expectation.seed}，实际 ${meta.seed}（${path}）`,
    );
  }
  if (
    expectation.minTickCompleted !== undefined &&
    meta.tickCompleted < expectation.minTickCompleted
  ) {
    throw new StratifyError(
      errorCodes.CONFIG_INVALID,
      `检查点 tickCompleted 不足: 期望 >=${expectation.minTickCompleted}，实际 ${meta.tickCompleted}（${path}）`,
    );
  }
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

/** 解析并校验检查点 JSON；`restoreSnapshot` 已重算 stateHash，不重复计算。 */
function parseCheckpoint(
  raw: string,
  path: string,
  expectation: CheckpointExpectation | undefined,
): { payload: CheckpointPayload; state: SimState } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new StratifyError(errorCodes.CONFIG_PATH, `检查点 JSON 损坏: ${path}`);
  }
  if (!isPlainObject(value)) {
    throw new StratifyError(errorCodes.CONFIG_PATH, `检查点必须是对象: ${path}`);
  }
  if (value['schemaVersion'] !== 'checkpoint-v1') {
    throw new StratifyError(
      errorCodes.CONFIG_UNKNOWN_VERSION,
      `未知检查点版本: ${String(value['schemaVersion'])}`,
    );
  }
  const meta = parseMeta(value['meta'], path);
  assertExpectation(meta, expectation, path);
  const state = restoreSnapshot(value['snapshot']);
  return {
    payload: { schemaVersion: 'checkpoint-v1', meta, snapshot: value['snapshot'] as Snapshot },
    state,
  };
}

/** 恢复检查点：schema/meta/哈希全部校验；损坏抛错（调用方回退上一完整点）。 */
export async function loadCheckpoint(
  host: CheckpointHost,
  path: string,
  expectation?: CheckpointExpectation,
): Promise<{ payload: CheckpointPayload; state: SimState }> {
  if (!(await host.exists(path))) {
    throw new StratifyError(errorCodes.CONFIG_PATH, `检查点不存在: ${path}`);
  }
  return parseCheckpoint(await host.read(path), path, expectation);
}

/** 读取并校验一个已有检查点；失败返回 `null`（用于决定能否提升为 `.prev`）。 */
async function tryLoadCheckpoint(
  host: CheckpointHost,
  path: string,
): Promise<{ payload: CheckpointPayload; state: SimState } | null> {
  try {
    return await loadCheckpoint(host, path);
  } catch {
    return null;
  }
}

/**
 * 带历史深度的保存：主点 + 上一完整点（`<path>.prev`）。
 *
 * 先校验现有主点，只有合法的主点才提升为 `.prev`；损坏主点不覆盖既有 `.prev`。
 * 写失败不覆盖主点；promote 失败由宿主抛出。
 */
export async function saveCheckpointWithHistory(
  host: CheckpointHost,
  path: string,
  payload: CheckpointPayload,
): Promise<void> {
  if (await host.exists(path)) {
    const previous = await tryLoadCheckpoint(host, path);
    if (previous !== null) {
      await host.writeTemp(`${path}.prev.tmp`, JSON.stringify(previous.payload));
      await host.promote(`${path}.prev.tmp`, `${path}.prev`);
    }
  }
  await saveCheckpoint(host, path, payload);
}

/** G5a 恢复语义：优先主点；损坏/不存在时回退上一完整点；两者皆失败抛错。 */
export async function loadCheckpointWithFallback(
  host: CheckpointHost,
  path: string,
  expectation?: CheckpointExpectation,
): Promise<{ payload: CheckpointPayload; state: SimState; fromFallback: boolean }> {
  try {
    const loaded = await loadCheckpoint(host, path, expectation);
    return { ...loaded, fromFallback: false };
  } catch (primaryError) {
    const prevPath = `${path}.prev`;
    if (!(await host.exists(prevPath))) {
      throw primaryError;
    }
    const loaded = await loadCheckpoint(host, prevPath, expectation);
    return { ...loaded, fromFallback: true };
  }
}

/** 内存宿主：测试与无盘环境（不提供 fsync/原子性保证）。 */
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

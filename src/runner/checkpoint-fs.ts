import { open, readFile, rename, rm, access } from 'node:fs/promises';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { CheckpointHost, SyncCheckpointHost } from './checkpoint.js';

/**
 * P5a-03：基于 `node:fs/promises` 的检查点宿主（runner 层允许 Node）。
 *
 * - `writeTemp`：打开/截断临时文件，写入后 `FileHandle.sync()` 落盘，再关闭；
 * - `promote`：`rename` 原子替换，随后尽力 `fsync` 目录（Windows 等平台失败忽略）；
 * - `read`/`exists`/`remove`：直通文件系统。
 * 语义保证见 `checkpoint.ts` 头注释；核心层不得导入本模块。
 */

/** 尽力刷新目录项；平台不支持目录句柄时静默忽略。 */
async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // best-effort：不支持目录 fsync 的平台不视为错误。
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
  }
}

export function nodeCheckpointHost(): CheckpointHost {
  return {
    async writeTemp(path, payload) {
      const handle = await open(path, 'w');
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async promote(tempPath, path) {
      await rename(tempPath, path);
      await fsyncDirectoryBestEffort(dirname(path));
    },
    async read(path) {
      return readFile(path, 'utf8');
    },
    async exists(path) {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    async remove(path) {
      await rm(path, { force: true });
    },
  };
}

/**
 * P5-03：基于 `node:fs` 同步 API 的检查点宿主（runSingle 的 tick 循环是同步的）。
 * 语义与异步版相同：writeTemp 写入并 fsync；promote rename 原子替换 + 尽力 fsync 目录。
 */
export function nodeCheckpointHostSync(): SyncCheckpointHost {
  return {
    writeTemp(path, payload) {
      const handle = openSync(path, 'w');
      try {
        writeSync(handle, payload, 0, 'utf8');
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
    },
    promote(tempPath, path) {
      renameSync(tempPath, path);
      fsyncDirectoryBestEffort(dirname(path));
    },
    read(path) {
      return readFileSync(path, 'utf8');
    },
    exists(path) {
      return existsSync(path);
    },
    remove(path) {
      rmSync(path, { force: true });
    },
  };
}

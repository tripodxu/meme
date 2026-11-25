import { existsSync, readFileSync, truncateSync } from 'node:fs';

/**
 * 实验 ledger 的容错 NDJSON 读取（P6 脚本共用）。
 *
 * 大规模搜索/扫描用 `appendFileSync` 追加记录；进程被 kill 时最后一行可能只写了一半。
 * 严格 `JSON.parse` 每一行会让整个 shard 无法恢复，必须人工截断。这里只容忍
 * **文件末尾的半行**：中间行损坏仍然响亮报错（那说明文件被非追加方式改坏了）。
 *
 * `repairTail=true` 时把末尾半行截掉，避免后续 append 把新记录粘在残行后面。
 * 返回 `repairedTail` 供调用方记录 warning；不打印内容（记录可能含大数组）。
 */
export interface NdjsonReadResult<T> {
  readonly records: T[];
  /** true = 末尾存在无法解析的半行，且已按 `repairTail` 处理。 */
  readonly repairedTail: boolean;
}

export function readNdjsonTolerant<T>(
  path: string,
  options: { readonly repairTail?: boolean } = {},
): NdjsonReadResult<T> {
  if (!existsSync(path)) {
    return { records: [], repairedTail: false };
  }
  const text = readFileSync(path, 'utf8');
  if (text.length === 0) {
    return { records: [], repairedTail: false };
  }

  const complete = text.endsWith('\n');
  const lines = text.split('\n');
  // 末尾没有换行时，最后一段可能是完整记录（写入者未补换行）或半行。
  const lastIndex = lines.length - 1;
  let repairedTail = false;
  if (!complete && (lines[lastIndex] ?? '').trim().length > 0) {
    try {
      JSON.parse(lines[lastIndex] as string);
    } catch {
      repairedTail = true;
      if (options.repairTail === true) {
        const lastNewline = text.lastIndexOf('\n');
        const keep =
          lastNewline < 0 ? 0 : Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');
        truncateSync(path, keep);
      }
    }
  }

  const records: T[] = [];
  const limit = complete ? lines.length : lastIndex;
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index] as string;
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      throw new Error(`NDJSON 第 ${index + 1} 行损坏（非末尾半行）: ${path}`);
    }
  }
  // 末尾无换行但可解析：保留最后一条完整记录。
  if (!complete && !repairedTail) {
    const last = lines[lastIndex] as string;
    if (last.trim().length > 0) {
      records.push(JSON.parse(last) as T);
    }
  }
  return { records, repairedTail };
}

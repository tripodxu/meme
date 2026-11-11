/**
 * D1 导出备份的静态校验（09 §7）。
 *
 * 只做“文件非空、关键表存在、语句看起来完整、包含数据”的快速检查；
 * 不能替代在隔离 D1 中真实恢复。任何失败都必须阻止发布，而不是打印警告后继续。
 */
export interface BackupCheckResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly bytes: number;
  readonly tables: readonly string[];
  readonly insertStatements: number;
}

const REQUIRED_TABLES = [
  'runs',
  'tick_stats',
  'agent_final',
  'experiments',
  'experiment_runs',
  'artifacts',
  'rate_limits',
] as const;

/** 少于该字节数几乎不可能是包含 schema 的 D1 导出。 */
export const MIN_BACKUP_BYTES = 512;

export function verifyD1Export(text: string): BackupCheckResult {
  const issues: string[] = [];
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes < MIN_BACKUP_BYTES) {
    issues.push(`备份过小：${bytes} 字节 < ${MIN_BACKUP_BYTES}`);
  }
  const tables: string[] = [];
  for (const table of REQUIRED_TABLES) {
    const pattern = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ["'\`]?${table}["'\`]?\\b`, 'i');
    if (pattern.test(text)) {
      tables.push(table);
    } else {
      issues.push(`缺少表定义：${table}`);
    }
  }
  const insertStatements = (text.match(/INSERT INTO\b/gi) ?? []).length;
  if (insertStatements === 0) {
    issues.push('备份没有任何 INSERT 语句（可能为空库或导出被截断）');
  }
  const lines = text.trimEnd().split('\n');
  while (lines.length > 0) {
    const last = (lines[lines.length - 1] ?? '').trim();
    if (last.length === 0 || last.startsWith('--')) {
      lines.pop();
      continue;
    }
    break;
  }
  const tail = lines.join('\n').trimEnd();
  if (tail.length > 0 && !tail.endsWith(';')) {
    issues.push('备份末尾不是完整 SQL 语句（可能被截断）');
  }
  return { ok: issues.length === 0, issues, bytes, tables, insertStatements };
}

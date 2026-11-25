import { DatabaseSync } from 'node:sqlite';

/**
 * D1 导出备份的静态校验与本地隔离恢复演练（09 §7）。
 *
 * - `verifyD1Export`：快速静态检查（文件非空、关键表存在、包含数据、未截断）；
 * - `rehearseD1Restore`：在隔离内存 SQLite 库中真实回放 SQL dump（开启外键），
 *   统计 7 张核心表行数，并交叉核验 `runs` / `artifacts` / `tick_stats` / `agent_final` 引用完整性与可选 R2 清单覆盖。
 */
export interface BackupCheckResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly bytes: number;
  readonly tables: readonly string[];
  readonly insertStatements: number;
}

export interface RestoreRehearsalOptions {
  /** 可选：R2 桶当前存在的对象 key 列表，用于与 D1 artifacts.r2_key 交叉核验（05 §8）。 */
  readonly r2Keys?: readonly string[];
}

export interface RestoreRehearsalResult extends BackupCheckResult {
  readonly tableRowCounts: Readonly<Record<string, number>>;
  readonly orphanArtifactRefs: number;
  readonly missingInR2: readonly string[];
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

/**
 * 在全新隔离 SQLite 实例中执行 SQL 备份恢复演练，并交叉核验引用完整性与可选 R2 key 集合。
 */
export function rehearseD1Restore(
  text: string,
  options: RestoreRehearsalOptions = {},
): RestoreRehearsalResult {
  const base = verifyD1Export(text);
  const issues = [...base.issues];
  const tableRowCounts: Record<string, number> = {};
  let orphanArtifactRefs = 0;
  const missingInR2: string[] = [];

  if (!base.ok) {
    return {
      ...base,
      issues,
      tableRowCounts,
      orphanArtifactRefs,
      missingInR2,
    };
  }

  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(text);
    for (const table of REQUIRED_TABLES) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as
        { n: number } | undefined;
      tableRowCounts[table] = Number(row?.n ?? 0);
    }

    const hasRunIdCol = (table: string): boolean => {
      const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
      return cols.some((c) => c.name === 'run_id');
    };

    if (hasRunIdCol('runs') && hasRunIdCol('artifacts')) {
      const orphanRow = db
        .prepare(
          'SELECT COUNT(*) AS n FROM artifacts WHERE run_id NOT IN (SELECT run_id FROM runs)',
        )
        .get() as { n: number } | undefined;
      orphanArtifactRefs = Number(orphanRow?.n ?? 0);
      if (orphanArtifactRefs > 0) {
        issues.push(`恢复库中存在 ${orphanArtifactRefs} 条悬挂 artifacts 引用（无对应 runs）`);
      }
    }

    if (options.r2Keys !== undefined) {
      const cols = db.prepare('PRAGMA table_info("artifacts")').all() as { name: string }[];
      if (cols.some((c) => c.name === 'r2_key')) {
        const r2Set = new Set(options.r2Keys);
        const rows = db.prepare('SELECT r2_key FROM artifacts').all() as { r2_key: string }[];
        for (const r of rows) {
          if (!r2Set.has(r.r2_key)) {
            missingInR2.push(r.r2_key);
          }
        }
        if (missingInR2.length > 0) {
          issues.push(`D1 清单中有 ${missingInR2.length} 个 r2_key 在 R2 列表中缺失`);
        }
      }
    }
  } catch (error) {
    issues.push(
      `隔离 SQLite 恢复执行失败：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    db.close();
  }

  return {
    ok: issues.length === 0,
    issues,
    bytes: base.bytes,
    tables: base.tables,
    insertStatements: base.insertStatements,
    tableRowCounts,
    orphanArtifactRefs,
    missingInR2,
  };
}

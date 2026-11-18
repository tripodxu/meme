import { describe, expect, it } from 'vitest';

import { MIN_BACKUP_BYTES, rehearseD1Restore, verifyD1Export } from '../../../src/ops/backup.js';

function backupText(overrides: { omit?: string; inserts?: number; tail?: string } = {}): string {
  const tables = [
    'runs',
    'tick_stats',
    'agent_final',
    'experiments',
    'experiment_runs',
    'artifacts',
    'rate_limits',
  ].filter((table) => table !== overrides.omit);
  const schema = tables.map((table) => `CREATE TABLE ${table} (id TEXT);`).join('\n');
  const inserts = Array.from(
    { length: overrides.inserts ?? 2 },
    (_, index) => `INSERT INTO tick_stats VALUES (${index});`,
  ).join('\n');
  const padding = '-- backup padding '.repeat(40);
  return `${schema}\n${inserts}\n${padding}\n${overrides.tail ?? ''}`;
}

describe('D1 导出备份校验', () => {
  it('接受完整备份并统计表与 INSERT', () => {
    const result = verifyD1Export(backupText());
    expect(result.ok).toBe(true);
    expect(result.tables).toHaveLength(7);
    expect(result.insertStatements).toBe(2);
    expect(result.bytes).toBeGreaterThan(MIN_BACKUP_BYTES);
  });

  it('拒绝缺表、空数据和过小文件', () => {
    const missing = verifyD1Export(backupText({ omit: 'runs' }));
    expect(missing.ok).toBe(false);
    expect(missing.issues.join('\n')).toContain('缺少表定义：runs');

    const noInserts = verifyD1Export(backupText({ inserts: 0 }));
    expect(noInserts.ok).toBe(false);
    expect(noInserts.issues.join('\n')).toContain('没有任何 INSERT');

    const tiny = verifyD1Export('CREATE TABLE runs (id TEXT);');
    expect(tiny.ok).toBe(false);
    expect(tiny.issues.join('\n')).toContain('备份过小');
  });

  it('拒绝末尾截断的 SQL', () => {
    const result = verifyD1Export(backupText({ tail: 'INSERT INTO runs VALUES (' }));
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toContain('末尾不是完整 SQL');
  });

  it('rehearseD1Restore 在隔离 SQLite 中真实回放 SQL 并交叉核验 R2 清单与语法错误', () => {
    const validDump = [
      'CREATE TABLE runs (run_id TEXT PRIMARY KEY);',
      'CREATE TABLE tick_stats (run_id TEXT, tick INTEGER);',
      'CREATE TABLE agent_final (run_id TEXT, agent_id TEXT);',
      'CREATE TABLE experiments (experiment_id TEXT PRIMARY KEY);',
      'CREATE TABLE experiment_runs (experiment_id TEXT, run_id TEXT);',
      'CREATE TABLE artifacts (run_id TEXT, r2_key TEXT);',
      'CREATE TABLE rate_limits (bucket TEXT, window_start INTEGER, count INTEGER);',
      "INSERT INTO runs VALUES ('run_1');",
      "INSERT INTO tick_stats VALUES ('run_1', 0);",
      "INSERT INTO artifacts VALUES ('run_1', 'runs/run_1/metrics/m0.ndjson.gz');",
      '-- padding '.repeat(40),
    ].join('\n');

    const ok = rehearseD1Restore(validDump, {
      r2Keys: ['runs/run_1/metrics/m0.ndjson.gz'],
    });
    expect(ok.ok).toBe(true);
    expect(ok.tableRowCounts['runs']).toBe(1);
    expect(ok.tableRowCounts['artifacts']).toBe(1);
    expect(ok.missingInR2).toEqual([]);

    const missingR2 = rehearseD1Restore(validDump, { r2Keys: [] });
    expect(missingR2.ok).toBe(false);
    expect(missingR2.missingInR2).toEqual(['runs/run_1/metrics/m0.ndjson.gz']);

    const badSql = `${validDump}\nINSERT INTO non_existent_table VALUES (1);`;
    const failedExec = rehearseD1Restore(badSql);
    expect(failedExec.ok).toBe(false);
    expect(failedExec.issues.some((i) => i.includes('隔离 SQLite 恢复执行失败'))).toBe(true);
  });
});

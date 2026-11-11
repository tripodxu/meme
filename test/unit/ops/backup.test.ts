import { describe, expect, it } from 'vitest';

import { MIN_BACKUP_BYTES, verifyD1Export } from '../../../src/ops/backup.js';

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
});

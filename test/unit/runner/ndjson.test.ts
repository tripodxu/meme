import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readNdjsonTolerant } from '../../../src/runner/ndjson.js';

describe('容错 NDJSON 读取', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratify-ndjson-'));
    path = join(dir, 'runs.ndjson');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('文件不存在返回空数组', () => {
    expect(readNdjsonTolerant(path)).toEqual({ records: [], repairedTail: false });
  });

  it('读取完整行与无末尾换行的完整记录', () => {
    writeFileSync(path, '{"a":1}\n{"a":2}\n{"a":3}', 'utf8');
    expect(readNdjsonTolerant<{ a: number }>(path).records.map((row) => row.a)).toEqual([1, 2, 3]);
  });

  it('末尾半行被丢弃且可修复截断', () => {
    writeFileSync(path, '{"a":1}\n{"a":', 'utf8');
    const first = readNdjsonTolerant<{ a: number }>(path, { repairTail: true });
    expect(first.records.map((row) => row.a)).toEqual([1]);
    expect(first.repairedTail).toBe(true);
    // 截断后文件只剩完整行；再读不会把下一条追加粘到残行上。
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
    expect(readNdjsonTolerant<{ a: number }>(path).records.map((row) => row.a)).toEqual([1]);
  });

  it('不修复时仍只返回完整行，文件保持原样', () => {
    writeFileSync(path, '{"a":1}\n{"a":', 'utf8');
    const result = readNdjsonTolerant<{ a: number }>(path);
    expect(result.records.map((row) => row.a)).toEqual([1]);
    expect(result.repairedTail).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('{"a":');
  });

  it('中间行损坏必须响亮报错', () => {
    writeFileSync(path, '{"a":1}\nnot-json\n{"a":3}\n', 'utf8');
    expect(() => readNdjsonTolerant(path)).toThrowError(/第 2 行损坏/);
  });
});

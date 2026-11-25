import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeCheckpointHost, nodeCheckpointHostSync } from '../../../src/runner/checkpoint-fs.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stratify-ckpt-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('nodeCheckpointHost（异步宿主）', () => {
  it('writeTemp → promote → read/exists/remove 原子往返', async () => {
    const host = nodeCheckpointHost();
    const path = join(tempDir(), 'state.json');
    const tempPath = `${path}.tmp`;

    expect(await host.exists(path)).toBe(false);
    await host.writeTemp(tempPath, '{"ok":true}');
    await host.promote(tempPath, path);
    expect(await host.exists(path)).toBe(true);
    expect(await host.read(path)).toBe('{"ok":true}');

    await host.remove(path);
    expect(await host.exists(path)).toBe(false);
    // remove 为 force 语义：缺失路径不抛错。
    await expect(host.remove(path)).resolves.toBeUndefined();
  });
});

describe('nodeCheckpointHostSync（同步宿主）', () => {
  it('writeTemp → promote → read/exists/remove 原子往返', () => {
    const host = nodeCheckpointHostSync();
    const path = join(tempDir(), 'state.json');
    const tempPath = `${path}.tmp`;

    expect(host.exists(path)).toBe(false);
    host.writeTemp(tempPath, '{"ok":true}');
    host.promote(tempPath, path);
    expect(host.exists(path)).toBe(true);
    expect(host.read(path)).toBe('{"ok":true}');

    host.remove(path);
    expect(host.exists(path)).toBe(false);
    expect(() => host.remove(path)).not.toThrow();
  });
});

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { createSimulation } from '../../../src/core/init/simulation.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { errorCodes } from '../../../src/core/control/errors.js';
import { step } from '../../../src/core/engine/engine.js';
import { nodeCheckpointHost } from '../../../src/runner/checkpoint-fs.js';
import {
  buildCheckpointPayload,
  loadCheckpoint,
  loadCheckpointWithFallback,
  memoryCheckpointHost,
  saveCheckpoint,
  saveCheckpointWithHistory,
  type CheckpointMeta,
  type CheckpointPayload,
} from '../../../src/runner/checkpoint.js';

const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const directory = scratchDirs.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function scratchDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stratify-ckpt-'));
  scratchDirs.push(directory);
  return directory;
}

function makeState() {
  const config = createDemoConfig({ population: { initialPopulation: 4 } });
  let state = createSimulation(config, asSeed('ckpt-fs-seed'));
  const decisions = new Map(
    state.society.agents
      .filter((agent) => agent.alive)
      .map((agent) => [agent.id, { selectedAction: 'accumulate' }]),
  );
  state = step(state, decisions, { runId: 'ckpt' }).state;
  return state;
}

function makePayload(meta: CheckpointMeta): CheckpointPayload {
  return buildCheckpointPayload(meta, makeState());
}

const VALID_META: CheckpointMeta = {
  cellKey: 'baseline',
  seed: 'ckpt-seed',
  tickCompleted: 7,
  savedAtSequence: 3,
};

async function corrupt(
  host: ReturnType<typeof memoryCheckpointHost>,
  path: string,
  content: string,
): Promise<void> {
  await host.writeTemp(`${path}.tmp`, content);
  await host.promote(`${path}.tmp`, path);
}

describe('检查点结构校验与期望', () => {
  it('损坏主点不覆盖合法 .prev，且保存后回退 .prev', async () => {
    const host = memoryCheckpointHost();
    const path = '/ckpt/run.json';
    const first = makePayload({ ...VALID_META, savedAtSequence: 1 });
    await saveCheckpointWithHistory(host, path, first);
    // 损坏主点后保存：不得把损坏内容提升为 .prev（.prev 仍不存在）。
    await corrupt(host, path, 'not-json');
    const second = makePayload({ ...VALID_META, savedAtSequence: 2 });
    await saveCheckpointWithHistory(host, path, second);
    expect(host.files.has('/ckpt/run.json.prev')).toBe(false);
    const loaded = await loadCheckpoint(host, path);
    expect(loaded.payload.meta.savedAtSequence).toBe(2);

    // 再保存一次：合法主点才提升为 .prev。
    const third = makePayload({ ...VALID_META, savedAtSequence: 3 });
    await saveCheckpointWithHistory(host, path, third);
    const recovered = await loadCheckpoint(host, '/ckpt/run.json.prev');
    expect(recovered.payload.meta.savedAtSequence).toBe(2);
  });

  it('损坏主点不会覆盖已有的合法 .prev', async () => {
    const host = memoryCheckpointHost();
    const path = '/ckpt/keep-prev.json';
    await saveCheckpointWithHistory(host, path, makePayload({ ...VALID_META, savedAtSequence: 1 }));
    await saveCheckpointWithHistory(host, path, makePayload({ ...VALID_META, savedAtSequence: 2 }));
    const prevBefore = host.files.get('/ckpt/keep-prev.json.prev');
    expect(prevBefore).toBeDefined();

    await corrupt(host, path, '{"schemaVersion":"checkpoint-v1","meta":{}}');
    await saveCheckpointWithHistory(host, path, makePayload({ ...VALID_META, savedAtSequence: 3 }));

    expect(host.files.get('/ckpt/keep-prev.json.prev')).toBe(prevBefore);
    const recovered = await loadCheckpointWithFallback(host, path);
    expect(recovered.fromFallback).toBe(false);
    expect(recovered.payload.meta.savedAtSequence).toBe(3);
  });

  it('非法 meta 被拒绝（缺失/负数 tickCompleted、空 seed、非整数 sequence）', async () => {
    const payload = makePayload(VALID_META);
    const cases: Record<string, unknown>[] = [
      { tickCompleted: undefined },
      { tickCompleted: -1 },
      { tickCompleted: 1.5 },
      { seed: '' },
      { seed: undefined },
      { cellKey: '' },
      { savedAtSequence: -1 },
      { savedAtSequence: 2.5 },
    ];
    for (const patch of cases) {
      const host = memoryCheckpointHost();
      const path = '/ckpt/bad.json';
      await corrupt(host, path, JSON.stringify({ ...payload, meta: patch }));
      await expect(loadCheckpoint(host, path)).rejects.toMatchObject({
        code: errorCodes.CONFIG_INVALID,
      });
    }
    const host = memoryCheckpointHost();
    await corrupt(host, '/ckpt/null-meta.json', JSON.stringify({ ...payload, meta: null }));
    await expect(loadCheckpoint(host, '/ckpt/null-meta.json')).rejects.toMatchObject({
      code: errorCodes.CONFIG_INVALID,
    });
  });

  it('期望不匹配时拒绝恢复另一个 run 的检查点', async () => {
    const host = memoryCheckpointHost();
    const path = '/ckpt/expect.json';
    await saveCheckpoint(host, path, makePayload(VALID_META));
    await expect(loadCheckpoint(host, path, { cellKey: 'other' })).rejects.toThrowError(/cellKey/);
    await expect(loadCheckpoint(host, path, { seed: 'other' })).rejects.toThrowError(/seed/);
    await expect(
      loadCheckpoint(host, path, { minTickCompleted: VALID_META.tickCompleted + 1 }),
    ).rejects.toThrowError(/tickCompleted/);
    const ok = await loadCheckpoint(host, path, {
      cellKey: 'baseline',
      seed: 'ckpt-seed',
      minTickCompleted: 0,
    });
    expect(ok.payload.meta.tickCompleted).toBe(VALID_META.tickCompleted);
    // 回退路径同样应用期望。
    await expect(
      loadCheckpointWithFallback(host, '/missing.json', { seed: 'x' }),
    ).rejects.toThrowError(/不存在/);
  });
});

describe('node:fs 检查点宿主', () => {
  it('写入/提升/读取/删除往返（tmp 不残留）', async () => {
    const directory = await scratchDir();
    const host = nodeCheckpointHost();
    const path = join(directory, 'run.json');
    const payload = makePayload(VALID_META);
    await saveCheckpointWithHistory(host, path, payload);
    expect(await host.exists(path)).toBe(true);
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(raw['schemaVersion']).toBe('checkpoint-v1');
    const loaded = await loadCheckpoint(host, path);
    expect(loaded.state.society.tick).toBe(1);
    expect(await host.exists(`${path}.tmp`)).toBe(false);
    await host.remove(path);
    expect(await host.exists(path)).toBe(false);
    await host.remove(path);
  });

  it('writeTemp 失败时保留既有主点', async () => {
    const directory = await scratchDir();
    const host = nodeCheckpointHost();
    const path = join(directory, 'keep.json');
    await saveCheckpoint(host, path, makePayload(VALID_META));
    const before = await readFile(path, 'utf8');
    // 目标父目录不存在，writeTemp 的 open 必然失败。
    const brokenPath = join(directory, 'missing-subdir', 'keep.json');
    await expect(saveCheckpoint(host, brokenPath, makePayload(VALID_META))).rejects.toThrowError();
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await host.exists(path)).toBe(true);
  });

  it('只读目录下写入失败时主点不变（仅 POSIX）', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const directory = await scratchDir();
    const readonlyDir = join(directory, 'readonly');
    await mkdir(readonlyDir);
    const host = nodeCheckpointHost();
    const path = join(readonlyDir, 'run.json');
    await saveCheckpoint(host, path, makePayload(VALID_META));
    const before = await readFile(path, 'utf8');
    await chmod(readonlyDir, 0o555);
    try {
      await expect(saveCheckpoint(host, path, makePayload(VALID_META))).rejects.toThrowError();
    } finally {
      await chmod(readonlyDir, 0o755);
    }
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('fs 宿主回退：损坏主点 + 合法 .prev', async () => {
    const directory = await scratchDir();
    const host = nodeCheckpointHost();
    const path = join(directory, 'fallback.json');
    await saveCheckpointWithHistory(host, path, makePayload({ ...VALID_META, savedAtSequence: 1 }));
    await saveCheckpointWithHistory(host, path, makePayload({ ...VALID_META, savedAtSequence: 2 }));
    await writeFile(path, '{"schemaVersion":"checkpoint-v1"}', 'utf8');
    const recovered = await loadCheckpointWithFallback(host, path);
    expect(recovered.fromFallback).toBe(true);
    expect(recovered.payload.meta.savedAtSequence).toBe(1);
  });
});

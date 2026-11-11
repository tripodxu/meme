import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { runSingle } from '../../../src/runner/run-cell.js';
import { loadUploadBundle } from '../../../src/runner/upload-bundle.js';
import { writeUploadBundle } from '../../../src/runner/upload-export.js';
import { uploadRun } from '../../../src/runner/uploader.js';
import { app } from '../../../src/worker/index.js';
import type { Env } from '../../../src/worker/types.js';
import { BASE, createTestEnv } from '../../helpers/worker-env.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stratify-export-'));
  dirs.push(dir);
  return dir;
}

function workerFetch(env: Env): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => app.request(url, init, env);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('P5b 批跑上传 bundle 导出', () => {
  it('导出 metrics-only bundle 并可被加载与上传 complete', async () => {
    const config = createDemoConfig({ schedule: { totalTicks: 20 } });
    const seed = 'seed-export-1';
    const outcome = runSingle(config, asSeed(seed), { policy: 'mock-weighted-v1' });
    const outDir = tempDir();
    const written = writeUploadBundle({
      outDir,
      cellKey: 'baseline',
      seed: asSeed(seed),
      config,
      outcome,
      runtimeVersion: 'test-runtime',
      codeSha: 'test-code-sha',
    });
    expect(written.finalTick).toBe(19);
    expect(written.endReason).toBe('scheduled');
    expect(written.metricsRows).toBe(outcome.stats.length);
    expect(written.agents).toBe(outcome.finalState.society.agents.length);

    const bundle = loadUploadBundle(written.bundlePath);
    expect(bundle.artifacts.map((artifact) => artifact.kind)).toEqual(['metrics', 'final_state']);
    expect(bundle.artifactProfile).toBe('metrics-only');
    expect(bundle.expectedDueDecisions).toBe(outcome.decisions.length);
    expect(bundle.finalAliveCount).toBe(outcome.report.aliveAtEnd);
    expect(bundle.agents).toHaveLength(outcome.finalState.society.agents.length);

    const env = createTestEnv();
    const result = await uploadRun(bundle, { baseUrl: BASE, fetchImpl: workerFetch(env) });
    expect(result.status).toBe('completed');
    const detail = await app.request(`${BASE}/api/runs/${result.runId}`, {}, env);
    const body = (await detail.json()) as {
      status: string;
      progress: { tickRows: number; agentRows: number };
      runtimeAuthority: string;
    };
    expect(body.status).toBe('completed');
    expect(body.progress).toEqual({ tickRows: 3, agentRows: 40 });
    expect(body.runtimeAuthority).toBe('authoritative');
  });

  it('full profile 导出 decisions/events/snapshot 并完成 full complete', async () => {
    const config = createDemoConfig({ schedule: { totalTicks: 20 } });
    const seed = 'seed-export-full';
    const outcome = runSingle(config, asSeed(seed), {
      policy: 'mock-weighted-v1',
      captureArtifacts: true,
    });
    expect(outcome.events?.length).toBeGreaterThan(0);
    expect(outcome.snapshots?.length).toBeGreaterThan(1);
    const outDir = tempDir();
    const written = writeUploadBundle({
      outDir,
      cellKey: 'full',
      seed: asSeed(seed),
      config,
      outcome,
      runtimeVersion: 'test-runtime',
      artifactProfile: 'full',
    });
    expect(written.artifactProfile).toBe('full');
    const bundle = loadUploadBundle(written.bundlePath);
    expect(bundle.artifactProfile).toBe('full');
    const kinds = new Set(bundle.artifacts.map((artifact) => artifact.kind));
    for (const kind of ['metrics', 'final_state', 'decisions', 'events', 'snapshot']) {
      expect(kinds.has(kind as never)).toBe(true);
    }

    const decisions = bundle.artifacts.find((artifact) => artifact.kind === 'decisions');
    const lines = (decisions?.ndjson ?? '')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBe(outcome.decisions.length);
    expect(lines[0]?.['tickSettled']).toBe(true);
    expect(lines[0]?.['execution']).not.toBeNull();

    const env = createTestEnv();
    const result = await uploadRun(bundle, { baseUrl: BASE, fetchImpl: workerFetch(env) });
    expect(result.status).toBe('completed');
    const detail = await app.request(`${BASE}/api/runs/${result.runId}`, {}, env);
    const body = (await detail.json()) as {
      status: string;
      artifactProfile: string;
      artifacts: unknown[];
    };
    expect(body.status).toBe('completed');
    expect(body.artifactProfile).toBe('full');
    expect(body.artifacts.length).toBeGreaterThanOrEqual(5);
  });

  it('bundle 文件可读且 metrics 行含完整字段', () => {
    const config = createDemoConfig({ schedule: { totalTicks: 20 } });
    const outcome = runSingle(config, asSeed('seed-export-2'), { policy: 'mock-weighted-v1' });
    const outDir = tempDir();
    const written = writeUploadBundle({
      outDir,
      cellKey: 'cell/with spaces',
      seed: asSeed('seed-export-2'),
      config,
      outcome,
      runtimeVersion: 'test-runtime',
    });
    expect(written.dir.endsWith('cell_with_spaces-seed-export-2')).toBe(true);
    const metrics = readFileSync(join(written.dir, 'metrics.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(metrics).toHaveLength(20);
    expect(metrics[0]).toMatchObject({ schemaVersion: 'metrics-v1', tick: 0 });
    expect(metrics[0]?.['payloadHash']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(metrics[0]).toHaveProperty('top10Share');
    const agents = JSON.parse(readFileSync(join(written.dir, 'agents.json'), 'utf8')) as unknown[];
    expect(agents).toHaveLength(40);
  });

  it('extinct run 的 endReason/finalTick 符合 complete 规则', () => {
    const config = createDemoConfig({
      schedule: { totalTicks: 20 },
      lifespan: { hardLifeFactor: 0.0001, hardLifeFloor: 0.0001 },
      population: { initialAgeMode: 'newborn' },
    });
    const outcome = runSingle(config, asSeed('seed-export-extinct'), {
      policy: 'mock-weighted-v1',
    });
    const outDir = tempDir();
    const written = writeUploadBundle({
      outDir,
      cellKey: 'extinct',
      seed: asSeed('seed-export-extinct'),
      config,
      outcome,
      runtimeVersion: 'test-runtime',
    });
    if (outcome.report.aliveAtEnd === 0 && written.finalTick < 19) {
      expect(written.endReason).toBe('extinct');
    } else {
      expect(written.endReason).toBe('scheduled');
    }
  });
});

import { describe, expect, it } from 'vitest';

import { buildSmokeRunBody, runRemoteSmoke } from '../../../src/ops/smoke.js';
import app from '../../../src/worker/index.js';
import type { Env } from '../../../src/worker/types.js';
import { BASE, createTestEnv } from '../../helpers/worker-env.js';

function smokeFetch(env: Env): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    if (url === `${BASE}/`) {
      return new Response('<!doctype html><title>Stratify</title>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    return app.request(url, init, env);
  };
}

describe('部署冒烟', () => {
  it('健康、首页、创建、读取、取消全链路', async () => {
    const env = createTestEnv();
    const result = await runRemoteSmoke({
      baseUrl: BASE,
      runtimeVersion: 'test-runtime',
      fetchImpl: smokeFetch(env),
    });
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual([
      'health',
      'static-index',
      'create-run',
      'read-run',
      'cancel-run',
    ]);
    expect(result.runId).toMatch(/^run_/);

    const detail = await app.request(`${BASE}/api/runs/${result.runId}`, {}, env);
    const body = (await detail.json()) as { status: string };
    expect(body.status).toBe('cancelled');
  });

  it('冒烟 run 使用显式运行时并可通过创建校验', () => {
    const body = buildSmokeRunBody('custom-runtime', 'seed-smoke');
    const identity = body['identity'] as Record<string, unknown>;
    expect(identity['runtimeVersion']).toBe('custom-runtime');
    expect(identity['seed']).toBe('seed-smoke');
    expect(body['artifactProfile']).toBe('metrics-only');
    expect((body['config'] as { schedule: { totalTicks: number } }).schedule.totalTicks).toBe(20);
  });

  it('健康失败时短路为 ok=false', async () => {
    const result = await runRemoteSmoke({
      baseUrl: BASE,
      runtimeVersion: 'test-runtime',
      fetchImpl: async () => new Response('down', { status: 503 }),
    });
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: 'health', ok: false });
  });
});

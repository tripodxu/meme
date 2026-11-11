import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../../src/worker/http.js';
import { app, runMaintenance } from '../../../src/worker/index.js';
import { retentionCutoffs } from '../../../src/worker/maintenance.js';
import type { Env } from '../../../src/worker/types.js';
import {
  BASE,
  TEST_RUNNER_TOKEN,
  createTestD1,
  createTestEnv,
  makeRunBody,
} from '../../helpers/worker-env.js';

const SHA_ZERO = `sha256:${'0'.repeat(64)}`;

async function createRun(
  env: Env,
  headers: Record<string, string> = {},
): Promise<{ runId: string; writeToken: string }> {
  const response = await app.request(
    `${BASE}/api/runs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(makeRunBody({ artifactProfile: 'metrics-only' })),
    },
    env,
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { runId: string; writeToken: string };
}

async function uploadMetrics(env: Env, run: { runId: string; writeToken: string }): Promise<void> {
  const body = new TextEncoder().encode('metrics');
  const response = await app.request(
    `${BASE}/api/runs/${run.runId}/artifacts/metrics-0`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${run.writeToken}`,
        'x-artifact-kind': 'metrics',
        'x-uncompressed-sha256': SHA_ZERO.slice(7),
        'x-compressed-sha256': await sha256Hex(body),
      },
      body: body.slice().buffer,
    },
    env,
  );
  expect(response.status).toBe(200);
}

describe('P4-06 保留策略', () => {
  it('删除过期 browser/runner run、artifact 与旧限流行，保留新 run', async () => {
    const db = createTestD1();
    const artifacts = createTestEnv().ARTIFACTS;
    const env = createTestEnv({ DB: db, ARTIFACTS: artifacts });
    const browser = await createRun(env);
    const runner = await createRun(env, { authorization: `Bearer ${TEST_RUNNER_TOKEN}` });
    const fresh = await createRun(env);
    await uploadMetrics(env, browser);
    await uploadMetrics(env, runner);
    await uploadMetrics(env, fresh);

    db.raw
      .prepare('UPDATE runs SET created_at = ? WHERE run_id = ?')
      .run('2020-01-01T00:00:00.000Z', browser.runId);
    db.raw
      .prepare('UPDATE runs SET created_at = ? WHERE run_id = ?')
      .run('2020-01-01T00:00:00.000Z', runner.runId);
    db.raw
      .prepare('INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)')
      .run('old', 1);
    const recentWindow = Math.floor(Date.now() / 1000);
    db.raw
      .prepare('INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)')
      .run('recent', recentWindow);

    const result = await runMaintenance(env, Date.now());
    expect(result).toMatchObject({
      browserRunsDeleted: 1,
      runnerRunsDeleted: 1,
      artifactsDeleted: 2,
      rateLimitRowsDeleted: 1,
    });

    const rows = db.raw.prepare('SELECT run_id FROM runs ORDER BY run_id').all() as {
      run_id: string;
    }[];
    expect(rows.map((row) => row.run_id)).toEqual([fresh.runId]);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toEqual({ n: 1 });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM tick_stats').get()).toEqual({ n: 0 });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM agent_final').get()).toEqual({ n: 0 });
    expect((artifacts as typeof artifacts & { size: number }).size).toBe(1);
    const buckets = (
      db.raw.prepare('SELECT bucket FROM rate_limits').all() as {
        bucket: string;
      }[]
    ).map((row) => row.bucket);
    expect(buckets).not.toContain('old');
    expect(buckets).toContain('recent');
  });

  it('retentionCutoffs 使用环境覆盖并回退默认值', () => {
    const now = Date.parse('2026-11-11T00:00:00.000Z');
    expect(retentionCutoffs({}, now)).toEqual({
      browser: '2026-11-04T00:00:00.000Z',
      runner: '2026-08-13T00:00:00.000Z',
    });
    expect(
      retentionCutoffs({ BROWSER_RUN_RETENTION_DAYS: '1', RUNNER_RUN_RETENTION_DAYS: '30' }, now),
    ).toEqual({ browser: '2026-11-10T00:00:00.000Z', runner: '2026-10-12T00:00:00.000Z' });
    expect(
      retentionCutoffs({ BROWSER_RUN_RETENTION_DAYS: 'bad', RUNNER_RUN_RETENTION_DAYS: '-1' }, now),
    ).toEqual({ browser: '2026-11-04T00:00:00.000Z', runner: '2026-08-13T00:00:00.000Z' });
  });
});

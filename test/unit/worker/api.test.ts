import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { computeConfigHash } from '../../../src/core/config/hash.js';
import { HASH_DOMAINS } from '../../../src/core/hash/domains.js';
import { hashValue } from '../../../src/core/hash/hash.js';
import { plannedStatsTicks } from '../../../src/worker/contracts.js';
import { sha256Hex, checkRateLimit } from '../../../src/worker/http.js';
import app from '../../../src/worker/index.js';
import type { Env } from '../../../src/worker/types.js';
import {
  BASE,
  TEST_RUNNER_TOKEN,
  createTestD1,
  createTestEnv,
  makeRunBody,
  type RunBodyOptions,
} from '../../helpers/worker-env.js';

const SHA_ZERO = `sha256:${'0'.repeat(64)}`;

function runnerHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TEST_RUNNER_TOKEN}` };
}

async function createRun(
  env: Env,
  options: RunBodyOptions = {},
  headers: Record<string, string> = {},
): Promise<{ runId: string; writeToken: string }> {
  const response = await app.request(
    `${BASE}/api/runs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(makeRunBody(options)),
    },
    env,
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { runId: string; writeToken: string };
}

function tickRow(tick: number): Record<string, unknown> {
  return {
    tick,
    aliveCount: 40,
    classCounts: [18, 12, 6, 3, 1],
    gini: 0.42,
    medianValue: 10,
    top10Share: 0.5,
    mUp: 0.1,
    mDown: 0.1,
    segregation: 0.2,
    edgeCount: 80,
    openness: 0.3,
    deathCount: 0,
    competitionLoss: 0.1,
    competitionGain: 0.1,
    fallbackRate: 0,
    payloadHash: SHA_ZERO,
  };
}

function agentRow(agentId: string): Record<string, unknown> {
  return {
    agentId,
    alive: true,
    classIndex: 0,
    maxClassIndex: 4,
    value: 12,
    ge: 10,
    hard: 40,
    initialLife: 25550,
    remainingLife: 20000,
    deathTick: null,
    payloadHash: SHA_ZERO,
  };
}

async function uploadArtifact(
  env: Env,
  run: { runId: string; writeToken: string },
  kind: string,
  chunkId: string,
  content: Uint8Array,
): Promise<Response> {
  const compressed = await sha256Hex(content);
  return app.request(
    `${BASE}/api/runs/${run.runId}/artifacts/${chunkId}`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${run.writeToken}`,
        'x-artifact-kind': kind,
        'x-uncompressed-sha256': await sha256Hex(`${kind}:${chunkId}`),
        'x-compressed-sha256': compressed,
      },
      body: content.slice().buffer,
    },
    env,
  );
}

async function completeBody(
  env: Env,
  run: { runId: string; writeToken: string },
  expectedAgentRows: number,
  expectedDueDecisions = 0,
): Promise<Record<string, unknown>> {
  void env;
  void run;
  const config = createDemoConfig();
  const finalTick = config.schedule.totalTicks - 1;
  const planned = plannedStatsTicks(config.schedule.totalTicks, config.schedule.statsStride);
  return {
    finalTick,
    finalAliveCount: 40,
    expectedTickRows: planned.length,
    expectedAgentRows,
    expectedDueDecisions,
    endReason: 'scheduled',
    finalStateHash: SHA_ZERO,
    summaryHash: SHA_ZERO,
    artifactManifestHash: SHA_ZERO,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('P4 Worker API', () => {
  it('health 报告 D1 状态', async () => {
    const env = createTestEnv();
    const response = await app.request(`${BASE}/api/health`, {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', db: 'ok' });
  });

  it('创建 run 重算哈希并回显 writeToken 前缀', async () => {
    const env = createTestEnv();
    const run = await createRun(env);
    expect(run.runId).toMatch(/^run_/);
    expect(run.writeToken).toHaveLength(64);
    const listed = await app.request(`${BASE}/api/runs`, {}, env);
    const body = (await listed.json()) as { runs: { runId: string; configHash: string }[] };
    expect(body.runs[0]?.runId).toBe(run.runId);
    expect(body.runs[0]?.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('拒绝自报 roster 与错误 configHash', async () => {
    const env = createTestEnv();
    const body = makeRunBody();
    const identity = body['identity'] as Record<string, unknown>;
    identity['initialPopulationHash'] = SHA_ZERO;
    let response = await app.request(
      `${BASE}/api/runs`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain('initialPopulationHash');

    const second = makeRunBody();
    const secondIdentity = second['identity'] as Record<string, unknown>;
    secondIdentity['configHash'] = computeConfigHash(
      createDemoConfig({ schedule: { totalTicks: 5 } } as never),
    );
    response = await app.request(
      `${BASE}/api/runs`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(second),
      },
      env,
    );
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain('configHash');
  });

  it('跨 runtimeVersion 不复算 initialPopulationHash，并标记 non-authoritative', async () => {
    const env = createTestEnv();
    const body = makeRunBody();
    const identity = body['identity'] as Record<string, unknown>;
    identity['runtimeVersion'] = 'node-v22.21.0';
    identity['initialPopulationHash'] = SHA_ZERO;
    const response = await app.request(
      `${BASE}/api/runs`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { runId: string };
    const detail = await app.request(`${BASE}/api/runs/${created.runId}`, {}, env);
    const detailBody = (await detail.json()) as { runtimeAuthority: string };
    expect(detailBody.runtimeAuthority).toBe('non-authoritative');
  });

  it('tick 批次幂等且冲突时拒绝', async () => {
    const env = createTestEnv();
    const run = await createRun(env, { artifactProfile: 'metrics-only' });
    const headers = {
      authorization: `Bearer ${run.writeToken}`,
      'content-type': 'application/json',
    };
    const body = { ticks: [tickRow(0), tickRow(10)] };
    const first = await app.request(
      `${BASE}/api/runs/${run.runId}/ticks:batch`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      env,
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ accepted: 2, inserted: 2, duplicates: 0 });

    const replay = await app.request(
      `${BASE}/api/runs/${run.runId}/ticks:batch`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      env,
    );
    expect(await replay.json()).toMatchObject({ inserted: 0, duplicates: 2 });

    const conflict = { ticks: [{ ...tickRow(0), payloadHash: `sha256:${'1'.repeat(64)}` }] };
    const rejected = await app.request(
      `${BASE}/api/runs/${run.runId}/ticks:batch`,
      { method: 'POST', headers, body: JSON.stringify(conflict) },
      env,
    );
    expect(rejected.status).toBe(409);
  });

  it('agent 批次幂等', async () => {
    const env = createTestEnv();
    const run = await createRun(env, { artifactProfile: 'metrics-only' });
    const headers = {
      authorization: `Bearer ${run.writeToken}`,
      'content-type': 'application/json',
    };
    const body = { agents: [agentRow('agent_0')] };
    const first = await app.request(
      `${BASE}/api/runs/${run.runId}/agents:batch`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      env,
    );
    expect(await first.json()).toMatchObject({ inserted: 1, duplicates: 0 });
    const replay = await app.request(
      `${BASE}/api/runs/${run.runId}/agents:batch`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      env,
    );
    expect(await replay.json()).toMatchObject({ inserted: 0, duplicates: 1 });
  });

  it('artifact 校验压缩哈希、8 MiB 上限与幂等', async () => {
    const env = createTestEnv();
    const run = await createRun(env, { artifactProfile: 'metrics-only' });
    const content = new TextEncoder().encode('metrics');
    const ok = await uploadArtifact(env, run, 'metrics', 'chunk-1', content);
    expect(ok.status).toBe(200);
    const duplicate = await uploadArtifact(env, run, 'metrics', 'chunk-1', content);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });

    const badHash = await app.request(
      `${BASE}/api/runs/${run.runId}/artifacts/chunk-2`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${run.writeToken}`,
          'x-artifact-kind': 'events',
          'x-uncompressed-sha256': 'a'.repeat(64),
          'x-compressed-sha256': 'b'.repeat(64),
        },
        body: content.slice().buffer,
      },
      env,
    );
    expect(badHash.status).toBe(422);

    const tooLarge = await app.request(
      `${BASE}/api/runs/${run.runId}/artifacts/chunk-3`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${run.writeToken}`,
          'x-artifact-kind': 'events',
          'x-uncompressed-sha256': 'a'.repeat(64),
          'x-compressed-sha256': 'b'.repeat(64),
          'content-length': String(8 * 1024 * 1024 + 1),
        },
        body: content.slice().buffer,
      },
      env,
    );
    expect(tooLarge.status).toBe(413);
  });

  it('complete 校验 artifact 集合与行数，并支持幂等重放', async () => {
    const env = createTestEnv();
    const run = await createRun(env, { artifactProfile: 'metrics-only' });
    const headers = {
      authorization: `Bearer ${run.writeToken}`,
      'content-type': 'application/json',
    };
    const config = createDemoConfig();
    const planned = plannedStatsTicks(config.schedule.totalTicks, config.schedule.statsStride);
    const ticks = await app.request(
      `${BASE}/api/runs/${run.runId}/ticks:batch`,
      { method: 'POST', headers, body: JSON.stringify({ ticks: planned.map(tickRow) }) },
      env,
    );
    expect(ticks.status).toBe(200);
    await app.request(
      `${BASE}/api/runs/${run.runId}/agents:batch`,
      { method: 'POST', headers, body: JSON.stringify({ agents: [agentRow('agent_0')] }) },
      env,
    );

    const missing = await app.request(
      `${BASE}/api/runs/${run.runId}/complete`,
      { method: 'POST', headers, body: JSON.stringify(await completeBody(env, run, 1)) },
      env,
    );
    expect(missing.status).toBe(409);

    await uploadArtifact(env, run, 'metrics', 'metrics-1', new TextEncoder().encode('m'));
    await uploadArtifact(env, run, 'final_state', 'final-1', new TextEncoder().encode('f'));
    const complete = await app.request(
      `${BASE}/api/runs/${run.runId}/complete`,
      { method: 'POST', headers, body: JSON.stringify(await completeBody(env, run, 1)) },
      env,
    );
    expect(complete.status).toBe(200);
    expect(await complete.json()).toMatchObject({ status: 'completed' });

    const replay = await app.request(
      `${BASE}/api/runs/${run.runId}/complete`,
      { method: 'POST', headers, body: JSON.stringify(await completeBody(env, run, 1)) },
      env,
    );
    expect(await replay.json()).toMatchObject({ status: 'completed', duplicate: true });

    const late = await app.request(
      `${BASE}/api/runs/${run.runId}/ticks:batch`,
      { method: 'POST', headers, body: JSON.stringify({ ticks: [tickRow(1)] }) },
      env,
    );
    expect(late.status).toBe(409);
  });

  it('experiment 需要 runner token 且预注册哈希可复算', async () => {
    const env = createTestEnv();
    const manifest: Record<string, unknown> = {
      hypothesis: 'h1',
      cells: [{ cellKey: 'A' }],
      seeds: ['seed-0001'],
      windows: [{ start: 0, end: 119 }],
      labelThresholdsHash: 'label-hash',
      baseConfigHash: 'base-hash',
      createdBy: 'runner',
    };
    const preregistrationHash = hashValue(HASH_DOMAINS.preregistration, manifest);
    const request = (headers: Record<string, string>, body: Record<string, unknown>) =>
      app.request(
        `${BASE}/api/experiments`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        },
        env,
      );
    const payload = {
      ...manifest,
      preregistrationHash,
    };
    expect((await request({}, payload)).status).toBe(401);
    expect((await request({ authorization: 'Bearer wrong' }, payload)).status).toBe(403);
    const created = await request(runnerHeaders(), payload);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { experimentId: string };

    const fetched = await app.request(
      `${BASE}/api/experiments/${createdBody.experimentId}`,
      {},
      env,
    );
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({ preregistrationHash });

    const bound = await createRun(
      env,
      {
        experiment: { experimentId: createdBody.experimentId, cellKey: 'A', seed: 'seed-0001' },
        artifactProfile: 'metrics-only',
      },
      runnerHeaders(),
    );
    expect(bound.runId).toMatch(/^run_/);
    const duplicate = await app.request(
      `${BASE}/api/runs`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...runnerHeaders() },
        body: JSON.stringify(
          makeRunBody({
            experiment: { experimentId: createdBody.experimentId, cellKey: 'A', seed: 'seed-0001' },
            artifactProfile: 'metrics-only',
          }),
        ),
      },
      env,
    );
    expect(duplicate.status).toBe(409);
  });

  it('keyset 分页与过滤', async () => {
    const env = createTestEnv();
    for (let i = 0; i < 3; i += 1) await createRun(env, { seed: `seed-page-${i}` });
    const first = await app.request(`${BASE}/api/runs?limit=2`, {}, env);
    const firstBody = (await first.json()) as {
      runs: { runId: string }[];
      nextCursor: string | null;
    };
    expect(firstBody.runs).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();
    const second = await app.request(
      `${BASE}/api/runs?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      {},
      env,
    );
    const secondBody = (await second.json()) as {
      runs: { runId: string }[];
      nextCursor: string | null;
    };
    expect(secondBody.runs).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();
    expect(secondBody.runs[0]?.runId).not.toBe(firstBody.runs[0]?.runId);

    const badFilter = await app.request(
      `${BASE}/api/runs?source=runner&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      {},
      env,
    );
    expect(badFilter.status).toBe(400);
  });

  it('verification 仅 runner 可写，verified 不可回退', async () => {
    const env = createTestEnv();
    const run = await createRun(env, { artifactProfile: 'metrics-only' });
    const headers = {
      authorization: `Bearer ${run.writeToken}`,
      'content-type': 'application/json',
    };
    const config = createDemoConfig();
    const planned = plannedStatsTicks(config.schedule.totalTicks, config.schedule.statsStride);
    await app.request(
      `${BASE}/api/runs/${run.runId}/ticks:batch`,
      { method: 'POST', headers, body: JSON.stringify({ ticks: planned.map(tickRow) }) },
      env,
    );
    await app.request(
      `${BASE}/api/runs/${run.runId}/agents:batch`,
      { method: 'POST', headers, body: JSON.stringify({ agents: [agentRow('agent_0')] }) },
      env,
    );
    await uploadArtifact(env, run, 'metrics', 'metrics-1', new TextEncoder().encode('m'));
    await uploadArtifact(env, run, 'final_state', 'final-1', new TextEncoder().encode('f'));
    await app.request(
      `${BASE}/api/runs/${run.runId}/complete`,
      { method: 'POST', headers, body: JSON.stringify(await completeBody(env, run, 1)) },
      env,
    );

    const reportHash = `sha256:${'a'.repeat(64)}`;
    const denied = await app.request(
      `${BASE}/api/runs/${run.runId}/verification`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'verified', reportHash }),
      },
      env,
    );
    expect(denied.status).toBe(401);

    const wrongToken = await app.request(
      `${BASE}/api/runs/${run.runId}/verification`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...runnerHeaders(),
          authorization: 'Bearer wrong',
        },
        body: JSON.stringify({ status: 'verified', reportHash }),
      },
      env,
    );
    expect(wrongToken.status).toBe(403);

    const verified = await app.request(
      `${BASE}/api/runs/${run.runId}/verification`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...runnerHeaders() },
        body: JSON.stringify({ status: 'verified', reportHash }),
      },
      env,
    );
    expect(verified.status).toBe(200);

    const rollback = await app.request(
      `${BASE}/api/runs/${run.runId}/verification`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...runnerHeaders() },
        body: JSON.stringify({ status: 'rejected', reportHash }),
      },
      env,
    );
    expect(rollback.status).toBe(409);
  });

  it('无 writeToken 不能写入任何 run', async () => {
    const env = createTestEnv();
    const run = await createRun(env, { artifactProfile: 'metrics-only' });
    const response = await app.request(
      `${BASE}/api/runs/${run.runId}/ticks:batch`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticks: [tickRow(0)] }),
      },
      env,
    );
    expect(response.status).toBe(401);
  });

  it('Jev 代理强制模型白名单、单位置拒绝与上游透传', async () => {
    const env = createTestEnv();
    const payload = {
      model: 'jev-unknown',
      state: {},
      questions: [{ type: 'action', choices: ['a'] }],
    };
    const request = (apiKey: string | null, body: unknown) =>
      app.request(
        `${BASE}/api/jev`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey === null ? {} : { 'x-api-key': apiKey }),
          },
          body: JSON.stringify(body),
        },
        env,
      );
    expect((await request(null, payload)).status).toBe(401);
    expect((await request('key-123', payload)).status).toBe(422);

    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ choice: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const ok = await request('key-123', { ...payload, model: 'jev-small' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ choice: 0 });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer key-123');
    expect(init?.body).not.toContain('key-123');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const upstream = await request('key-123', { ...payload, model: 'jev-small' });
    expect(upstream.status).toBe(502);
    const upstreamBody = (await upstream.json()) as {
      error: { code: string; details: { upstreamStatus: number | null } };
    };
    expect(upstreamBody.error.code).toBe('upstream_error');
    expect(upstreamBody.error.details.upstreamStatus).toBe(500);
    expect(JSON.stringify(upstreamBody)).not.toContain('key-123');
  });

  it('固定窗口限流', async () => {
    const db = createTestD1();
    expect(await checkRateLimit(db, 'ip:1', 2, 60, 1_000)).toBe(true);
    expect(await checkRateLimit(db, 'ip:1', 2, 60, 1_001)).toBe(true);
    expect(await checkRateLimit(db, 'ip:1', 2, 60, 1_002)).toBe(false);
    expect(await checkRateLimit(db, 'ip:2', 2, 60, 1_003)).toBe(true);
  });

  it('404 统一错误体并带 requestId', async () => {
    const env = createTestEnv();
    const response = await app.request(`${BASE}/api/nope`, {}, env);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string }; requestId: string };
    expect(body.error.code).toBe('not_found');
    expect(response.headers.get('x-request-id')).toBe(body.requestId);
  });
});

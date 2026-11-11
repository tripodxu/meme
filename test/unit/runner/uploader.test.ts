import { describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { computeConfigHash, computeParamsHash } from '../../../src/core/config/hash.js';
import {
  DECISION_SCHEMA_VERSION,
  ENGINE_VERSION,
  RULES_VERSION,
} from '../../../src/core/control/versions.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { computeInitialPopulationHash } from '../../../src/core/hash/state-hash.js';
import { deriveInitialPopulation } from '../../../src/core/init/population.js';
import { memoryCheckpointHost } from '../../../src/runner/checkpoint.js';
import {
  UPLOAD_LEDGER_SCHEMA,
  plannedStatsTicks,
  uploadRun,
  type RunUploadBundle,
  type UploadAgent,
} from '../../../src/runner/uploader.js';
import { app } from '../../../src/worker/index.js';
import type { Env } from '../../../src/worker/types.js';
import {
  BASE,
  TEST_RUNNER_TOKEN,
  createTestEnv,
  type CreatedRun,
} from '../../helpers/worker-env.js';

const SHA_ZERO = `sha256:${'0'.repeat(64)}`;
const TOKEN = 'seed-upload-1';

function tickLine(tick: number): string {
  return JSON.stringify({
    tick,
    aliveCount: 1,
    classCounts: [1, 0, 0, 0, 0],
    gini: 0,
    medianValue: 0,
    top10Share: 0,
    mUp: 0,
    mDown: 0,
    segregation: 0,
    edgeCount: 0,
    openness: 0.5,
    deathCount: 0,
    competitionLoss: 0,
    competitionGain: 0,
    fallbackRate: 0,
    payloadHash: SHA_ZERO,
  });
}

function makeAgent(seed: string): UploadAgent {
  return {
    agentId: `agent-${seed}`,
    alive: true,
    classIndex: 0,
    maxClassIndex: 4,
    value: 0,
    ge: 1,
    hard: 10,
    initialLife: 25550,
    remainingLife: 20000,
    deathTick: null,
    payloadHash: SHA_ZERO,
  };
}

function makeBundle(overrides: Partial<RunUploadBundle> = {}): RunUploadBundle {
  const config = createDemoConfig();
  const population = deriveInitialPopulation(config, asSeed(TOKEN));
  const ticks = plannedStatsTicks(config, config.schedule.totalTicks - 1, false);
  return {
    schemaVersion: 'run-upload-bundle-v1',
    config,
    identity: {
      rulesVersion: RULES_VERSION,
      engineVersion: ENGINE_VERSION,
      decisionSchemaVersion: DECISION_SCHEMA_VERSION,
      policyVersion: config.decision.policy,
      promptVersion: null,
      requestedModel: null,
      seed: TOKEN,
      runtimeVersion: 'test-runtime',
      configHash: computeConfigHash(config),
      paramsHash: computeParamsHash(config),
      initialPopulationHash: computeInitialPopulationHash(asSeed(TOKEN), population),
      codeSha: 'test-code-sha',
    },
    experiment: null,
    artifactProfile: 'metrics-only',
    finalTick: config.schedule.totalTicks - 1,
    endReason: 'scheduled',
    finalAliveCount: 1,
    agents: [makeAgent(TOKEN)],
    expectedDueDecisions: 0,
    finalStateHash: SHA_ZERO,
    summaryHash: SHA_ZERO,
    artifacts: [
      {
        kind: 'metrics',
        chunkId: 'metrics-0',
        ndjson: `${ticks.map(tickLine).join('\n')}\n`,
        startTick: 0,
        endTick: config.schedule.totalTicks - 1,
      },
      {
        kind: 'final_state',
        chunkId: 'final-0',
        ndjson: `${JSON.stringify({ schemaVersion: 'final-state-v1', hash: SHA_ZERO })}\n`,
      },
    ],
    ...overrides,
  };
}

function workerFetch(env: Env): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => app.request(url, init, env);
}

async function listRuns(env: Env): Promise<CreatedRun[]> {
  const response = await app.request(`${BASE}/api/runs`, {}, env);
  const body = (await response.json()) as { runs: { runId: string }[] };
  return body.runs.map((run) => ({ runId: run.runId, writeToken: '' }));
}

describe('P5b 上传器', () => {
  it('创建 run、上传块、写 tick/agent 并 complete', async () => {
    const env = createTestEnv();
    const host = memoryCheckpointHost();
    const urls: string[] = [];
    const result = await uploadRun(makeBundle(), {
      baseUrl: BASE,
      fetchImpl: (url, init) => {
        urls.push(url);
        return workerFetch(env)(url, init);
      },
      ledger: { host, path: 'upload-ledger.json' },
      runnerToken: TEST_RUNNER_TOKEN,
      now: () => '2026-11-11T00:00:00.000Z',
    });
    expect(result.status).toBe('completed');
    expect(result.chunksUploaded).toBe(2);
    expect(result.chunksSkipped).toBe(0);

    const detail = await app.request(`${BASE}/api/runs/${result.runId}`, {}, env);
    const detailBody = (await detail.json()) as {
      status: string;
      progress: { tickRows: number; agentRows: number };
      artifacts: unknown[];
    };
    expect(detailBody.status).toBe('completed');
    expect(detailBody.progress).toEqual({ tickRows: 13, agentRows: 1 });
    expect(detailBody.artifacts).toHaveLength(2);

    const ledger = JSON.parse(host.files.get('upload-ledger.json') ?? '{}') as {
      schemaVersion: string;
      runId: string;
      writeToken: string;
      complete: { summaryHash: string } | null;
    };
    expect(ledger.schemaVersion).toBe(UPLOAD_LEDGER_SCHEMA);
    expect(ledger.runId).toBe(result.runId);
    expect(ledger.writeToken).toHaveLength(64);
    expect(ledger.complete?.summaryHash).toBe(SHA_ZERO);
    expect(urls.some((url) => url.includes(ledger.writeToken))).toBe(false);
    expect(urls.some((url) => url.includes(TEST_RUNNER_TOKEN))).toBe(false);
  });

  it('同一 ledger 重跑只补传未确认块，不新建 run', async () => {
    const env = createTestEnv();
    const host = memoryCheckpointHost();
    const first = await uploadRun(makeBundle(), {
      baseUrl: BASE,
      fetchImpl: workerFetch(env),
      ledger: { host, path: 'ledger.json' },
    });
    const second = await uploadRun(makeBundle(), {
      baseUrl: BASE,
      fetchImpl: workerFetch(env),
      ledger: { host, path: 'ledger.json' },
    });
    expect(second.runId).toBe(first.runId);
    expect(second.chunksSkipped).toBe(2);
    expect(second.chunksUploaded).toBe(0);
    expect(second.duplicateComplete).toBe(true);
    expect(await listRuns(env)).toHaveLength(1);
  });

  it('单块网络失败后按幂等重试补齐', async () => {
    const env = createTestEnv();
    const host = memoryCheckpointHost();
    let failed = false;
    let attempts = 0;
    const result = await uploadRun(makeBundle(), {
      baseUrl: BASE,
      fetchImpl: async (url, init) => {
        attempts += 1;
        if (!failed && url.endsWith('/artifacts/final-0')) {
          failed = true;
          throw new TypeError('socket hang up');
        }
        return app.request(url, init, env);
      },
      ledger: { host, path: 'ledger.json' },
      retryDelayMs: 1,
      maxAttempts: 3,
    });
    expect(result.status).toBe('completed');
    expect(attempts).toBeGreaterThan(4);
    const ledger = JSON.parse(host.files.get('ledger.json') ?? '{}') as {
      chunks: Record<string, { compressedSha256: string }>;
    };
    expect(Object.keys(ledger.chunks).sort()).toEqual(['final_state/final-0', 'metrics/metrics-0']);
  });

  it('bundle 改变时拒绝复用 ledger', async () => {
    const env = createTestEnv();
    const host = memoryCheckpointHost();
    await uploadRun(makeBundle(), {
      baseUrl: BASE,
      fetchImpl: workerFetch(env),
      ledger: { host, path: 'ledger.json' },
    });
    const changed = makeBundle({ summaryHash: `sha256:${'1'.repeat(64)}` });
    await expect(
      uploadRun(changed, {
        baseUrl: BASE,
        fetchImpl: workerFetch(env),
        ledger: { host, path: 'ledger.json' },
      }),
    ).rejects.toMatchObject({ code: 'ledger_mismatch' });
  });

  it('metrics 缺计划行、agent 计数不一致与非法 kind 在本地拒绝', async () => {
    const env = createTestEnv();
    const base = makeBundle();
    const missingTick = makeBundle({
      artifacts: [
        {
          kind: 'metrics',
          chunkId: 'metrics-0',
          ndjson: `${tickLine(0)}\n`,
        },
        ...base.artifacts.slice(1),
      ],
    });
    await expect(
      uploadRun(missingTick, { baseUrl: BASE, fetchImpl: workerFetch(env) }),
    ).rejects.toMatchObject({ code: 'bundle_invalid' });

    await expect(
      uploadRun(makeBundle({ finalAliveCount: 2 }), {
        baseUrl: BASE,
        fetchImpl: workerFetch(env),
      }),
    ).rejects.toMatchObject({ code: 'bundle_invalid' });

    const badKind = makeBundle({
      artifacts: [
        { kind: 'raw' as never, chunkId: 'x', ndjson: '{"tick":0}\n' },
        ...base.artifacts,
      ],
    });
    await expect(
      uploadRun(badKind, { baseUrl: BASE, fetchImpl: workerFetch(env) }),
    ).rejects.toMatchObject({
      code: 'bundle_invalid',
    });
  });

  it('plannedStatsTicks 与 Worker 口径一致（scheduled/extinct）', () => {
    const config = createDemoConfig();
    expect(plannedStatsTicks(config, 119, false)).toEqual([
      0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 119,
    ]);
    expect(plannedStatsTicks(config, 7, true)).toEqual([0, 7]);
  });

  it('创建 run 失败不盲目重试', async () => {
    let calls = 0;
    await expect(
      uploadRun(makeBundle(), {
        baseUrl: BASE,
        fetchImpl: async () => {
          calls += 1;
          throw new TypeError('timeout');
        },
      }),
    ).rejects.toMatchObject({ code: 'create_ambiguous' });
    expect(calls).toBe(1);
  });
});

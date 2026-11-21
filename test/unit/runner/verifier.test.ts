import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { createDemoConfig } from '../../../src/core/config/defaults.js';
import { asSeed } from '../../../src/core/control/ids.js';
import { runSingle } from '../../../src/runner/run-cell.js';
import { loadUploadBundle } from '../../../src/runner/upload-bundle.js';
import { writeUploadBundle } from '../../../src/runner/upload-export.js';
import { uploadRun, type RunUploadBundle } from '../../../src/runner/uploader.js';
import { verifyRemoteRun, verifyUploadBundle } from '../../../src/runner/verifier.js';
import { sha256Hex } from '../../../src/worker/http.js';
import { app } from '../../../src/worker/index.js';
import { BASE, TEST_RUNNER_TOKEN, createTestEnv } from '../../helpers/worker-env.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stratify-verifier-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function buildSampleBundle(profile: 'full' | 'metrics-only'): RunUploadBundle {
  const dir = makeTempDir();
  const config = createDemoConfig({
    population: { initialPopulation: 8 },
    schedule: { totalTicks: 6, statsStride: 2, snapshotStride: 2 },
    decision: { interval: 2 },
  });
  const seed = asSeed('verifier-seed-01');
  const outcome = runSingle(config, seed, {
    policy: 'mock-weighted-v1',
    captureArtifacts: profile === 'full',
  });
  const written = writeUploadBundle({
    outDir: dir,
    cellKey: 'cellA',
    seed,
    config,
    outcome,
    runtimeVersion: `node-${process.versions.node}`,
    artifactProfile: profile,
  });
  return loadUploadBundle(written.bundlePath);
}

describe('P5b / P4-05 独立验证器 verifier', () => {
  it('full profile 本地导出包通过 schema、哈希、连续性与完整确定性回放验证', () => {
    const bundle = buildSampleBundle('full');
    const result = verifyUploadBundle(bundle);
    expect(result.status).toBe('verified');
    expect(result.report.reasons).toEqual([]);
    expect(result.report.replayable).toBe(true);
    expect(result.report.replayFinalStateHash).toBe(bundle.finalStateHash);
    expect(result.report.checkedCounts.replayedTicks).toBe(6);
    expect(result.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('metrics-only profile 本地导出包验证通过且诚实标记 replayable=false', () => {
    const bundle = buildSampleBundle('metrics-only');
    const result = verifyUploadBundle(bundle);
    expect(result.status).toBe('verified');
    expect(result.report.replayable).toBe(false);
    expect(result.report.replayFinalStateHash).toBeNull();
    expect(result.report.checkedCounts.metricsRows).toBe(6);
  });

  it('精确拦截各类篡改：哈希失配、metrics 篡改、快照损坏、决策缺失与未结算行', () => {
    const base = buildSampleBundle('full');

    // 1. configHash / paramsHash / initialPopulationHash 失配
    const badIdentity = verifyUploadBundle({
      ...base,
      identity: {
        ...base.identity,
        configHash: `sha256:${'0'.repeat(64)}`,
        paramsHash: `sha256:${'1'.repeat(64)}`,
        initialPopulationHash: `sha256:${'2'.repeat(64)}`,
      },
    });
    expect(badIdentity.status).toBe('rejected');
    expect(badIdentity.report.reasons.length).toBeGreaterThanOrEqual(3);

    // 2. agent payloadHash 篡改
    const firstAgent = base.agents[0];
    if (firstAgent === undefined) throw new Error('缺少 agent');
    const badAgent = verifyUploadBundle({
      ...base,
      agents: [{ ...firstAgent, value: firstAgent.value + 999 }, ...base.agents.slice(1)],
    });
    expect(badAgent.status).toBe('rejected');
    expect(badAgent.report.reasons.some((r) => r.includes('payloadHash'))).toBe(true);

    // 3. metrics 行篡改（破坏 payloadHash 与回放指标一致性）
    const badMetrics = verifyUploadBundle({
      ...base,
      artifacts: base.artifacts.map((art) =>
        art.kind === 'metrics'
          ? { ...art, ndjson: art.ndjson.replace('"gini":', '"gini":0.99999999, "oldGini":') }
          : art,
      ),
    });
    expect(badMetrics.status).toBe('rejected');

    // 4. 缺失一行到期决策
    const badDecisions = verifyUploadBundle({
      ...base,
      artifacts: base.artifacts.map((art) => {
        if (art.kind !== 'decisions') return art;
        const lines = art.ndjson.trim().split('\n');
        return { ...art, ndjson: `${lines.slice(1).join('\n')}\n` };
      }),
    });
    expect(badDecisions.status).toBe('rejected');
    expect(badDecisions.report.reasons.some((r) => r.includes('expectedDueDecisions'))).toBe(true);

    // 5. 快照 stateHash 损坏
    const badSnapshot = verifyUploadBundle({
      ...base,
      artifacts: base.artifacts.map((art) =>
        art.kind === 'snapshot'
          ? {
              ...art,
              ndjson: art.ndjson.replace(/sha256:[0-9a-f]{64}/, `sha256:${'f'.repeat(64)}`),
            }
          : art,
      ),
    });
    expect(badSnapshot.status).toBe('rejected');
  });

  it('远端全链路：uploadRun 上传到 Worker 后由 verifyRemoteRun 解压回放并置为 verified', async () => {
    const runtimeVersion = `node-${process.versions.node}`;
    const env = createTestEnv({ RUNTIME_VERSION: runtimeVersion });
    const fetchWorker = async (url: string, init?: RequestInit) => app.request(url, init, env);
    const bundle = buildSampleBundle('full');

    const uploaded = await uploadRun(bundle, {
      baseUrl: BASE,
      runnerToken: TEST_RUNNER_TOKEN,
      fetchImpl: fetchWorker,
    });
    expect(uploaded.status).toBe('completed');

    // complete 后初始状态为 uploaded
    const beforeResp = await fetchWorker(`${BASE}/api/runs/${uploaded.runId}`);
    const beforeBody = (await beforeResp.json()) as { verificationStatus: string };
    expect(beforeBody.verificationStatus).toBe('uploaded');

    const verified = await verifyRemoteRun({
      baseUrl: BASE,
      runId: uploaded.runId,
      runnerToken: TEST_RUNNER_TOKEN,
      submit: true,
      fetchImpl: fetchWorker,
    });
    expect(verified.status).toBe('verified');
    expect(verified.submitted).toBe(true);
    expect(verified.serverStatus).toBe('verified');

    const afterResp = await fetchWorker(`${BASE}/api/runs/${uploaded.runId}`);
    const afterBody = (await afterResp.json()) as { verificationStatus: string };
    expect(afterBody.verificationStatus).toBe('verified');
  });

  it('远端检测到未压缩内容与 X-Uncompressed-SHA256 不符时判定 rejected，且禁止改回 verified', async () => {
    const runtimeVersion = `node-${process.versions.node}`;
    const env = createTestEnv({ RUNTIME_VERSION: runtimeVersion });
    const fetchWorker = async (url: string, init?: RequestInit) => app.request(url, init, env);
    const bundle = buildSampleBundle('metrics-only');

    const uploaded = await uploadRun(bundle, {
      baseUrl: BASE,
      runnerToken: TEST_RUNNER_TOKEN,
      fetchImpl: fetchWorker,
    });

    // 模拟生产者谎报 uncompressed_sha256（Worker 上传阶段不解压大块，靠独立验证器拦截！）
    const forgedGz = gzipSync(
      Buffer.from('{"schemaVersion":"metrics-v1","forged":true}\n', 'utf8'),
    );
    const forgedCompressedSha = await sha256Hex(forgedGz);
    await env.ARTIFACTS.put(`runs/${uploaded.runId}/metrics/metrics-0.ndjson.gz`, forgedGz.buffer);
    await env.DB.prepare(
      'UPDATE artifacts SET compressed_sha256 = ?, bytes = ? WHERE run_id = ? AND kind = ?',
    )
      .bind(forgedCompressedSha, forgedGz.byteLength, uploaded.runId, 'metrics')
      .run();

    const rejected = await verifyRemoteRun({
      baseUrl: BASE,
      runId: uploaded.runId,
      runnerToken: TEST_RUNNER_TOKEN,
      submit: true,
      fetchImpl: fetchWorker,
    });
    expect(rejected.status).toBe('rejected');
    expect(
      rejected.report.reasons.some(
        (r) => r.includes('未压缩 SHA-256 不匹配') || r.includes('artifactManifestHash'),
      ),
    ).toBe(true);

    // 05 §4.6：rejected 不能被后续请求洗白为 verified
    const illegalOverride = await fetchWorker(`${BASE}/api/runs/${uploaded.runId}/verification`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_RUNNER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'verified',
        reportHash: `sha256:${'9'.repeat(64)}`,
      }),
    });
    expect(illegalOverride.status).toBe(409);
  });

  it('覆盖 NDJSON 破损行、非单调事件序、未结算决策、重复决策与远端异常分支', async () => {
    const base = buildSampleBundle('full');

    // 非法 schemaVersion / 非法 config / 非法 seed / 缺失 final_state / extinct 冲突
    const badMeta = verifyUploadBundle({
      ...base,
      schemaVersion: 'wrong-v0' as never,
      config: { ...base.config, population: { ...base.config.population, initialPopulation: 0 } },
      endReason: 'extinct',
      finalAliveCount: 5,
      artifacts: [
        { kind: 'metrics', chunkId: 'm0', ndjson: 'not-json\n123\n{"schemaVersion":"bad"}\n' },
      ],
    });
    expect(badMeta.status).toBe('rejected');
    expect(badMeta.report.reasons.length).toBeGreaterThanOrEqual(4);

    // seed 非法 + metrics 非单调 tick + 缺失计划 tick + final_state 解码失败
    const badSeedAndFinal = verifyUploadBundle({
      ...base,
      identity: { ...base.identity, seed: '' },
      artifacts: [
        {
          kind: 'metrics',
          chunkId: 'm0',
          ndjson:
            '{"schemaVersion":"metrics-v1","tick":2,"payloadHash":"bad"}\n{"schemaVersion":"metrics-v1","tick":1,"payloadHash":"bad"}\n',
        },
        {
          kind: 'final_state',
          chunkId: 'f0',
          ndjson: '{"schemaVersion":"wrong","finalState":"nope"}\n',
        },
        { kind: 'snapshot', chunkId: 's0', ndjson: '{"schemaVersion":"wrong"}\n' },
        {
          kind: 'events',
          chunkId: 'e0',
          ndjson:
            '{"schemaVersion":"event-v1","tick":2,"seq":2}\n{"schemaVersion":"event-v1","tick":2,"seq":1}\n',
        },
        {
          kind: 'decisions',
          chunkId: 'd0',
          ndjson: '{"schemaVersion":"decision-v1","tickSettled":false}\n',
        },
      ],
    });
    expect(badSeedAndFinal.status).toBe('rejected');

    // 重复决策主键 & 非决策周期多余决策
    const decArt = base.artifacts.find((a) => a.kind === 'decisions');
    const firstDecLine = decArt?.ndjson.trim().split('\n')[0] ?? '';
    const dupDecision = verifyUploadBundle({
      ...base,
      artifacts: base.artifacts.map((a) =>
        a.kind === 'decisions' ? { ...a, ndjson: `${firstDecLine}\n${firstDecLine}\n` } : a,
      ),
    });
    expect(dupDecision.status).toBe('rejected');

    const extraNonDueLine = firstDecLine.replace('"tick":0', '"tick":1');
    const extraNonDue = verifyUploadBundle({
      ...base,
      expectedDueDecisions: base.expectedDueDecisions + 1,
      artifacts: base.artifacts.map((a) =>
        a.kind === 'decisions' ? { ...a, ndjson: `${a.ndjson.trim()}\n${extraNonDueLine}\n` } : a,
      ),
    });
    expect(extraNonDue.status).toBe('rejected');
    expect(extraNonDue.report.reasons.some((r) => r.includes('非决策周期'))).toBe(true);

    // 远端异常护栏：404、缺少 runnerToken、gzip 损坏
    const env = createTestEnv({ RUNTIME_VERSION: `node-${process.versions.node}` });
    const fetchWorker = async (url: string, init?: RequestInit) => app.request(url, init, env);
    await expect(
      verifyRemoteRun({ baseUrl: BASE, runId: 'run_missing0001', fetchImpl: fetchWorker }),
    ).rejects.toThrow('HTTP 404');

    const uploaded = await uploadRun(buildSampleBundle('metrics-only'), {
      baseUrl: BASE,
      runnerToken: TEST_RUNNER_TOKEN,
      fetchImpl: fetchWorker,
    });
    await expect(
      verifyRemoteRun({
        baseUrl: BASE,
        runId: uploaded.runId,
        submit: true,
        fetchImpl: fetchWorker,
      }),
    ).rejects.toThrow('runnerToken');

    const badBytes = new Uint8Array([1, 2, 3, 4]);
    const badSha = await sha256Hex(badBytes);
    await env.ARTIFACTS.put(`runs/${uploaded.runId}/metrics/metrics-0.ndjson.gz`, badBytes.buffer);
    await env.DB.prepare('UPDATE artifacts SET compressed_sha256 = ? WHERE run_id = ? AND kind = ?')
      .bind(badSha, uploaded.runId, 'metrics')
      .run();
    const corruptGz = await verifyRemoteRun({
      baseUrl: BASE,
      runId: uploaded.runId,
      submit: false,
      fetchImpl: fetchWorker,
    });
    expect(corruptGz.status).toBe('rejected');
    expect(corruptGz.report.reasons.some((r) => r.includes('gzip 解压损坏'))).toBe(true);

    // 篡改已记录决策的 selectedAction（schema 与行数合法，但确定性回放轨迹与周期快照/终态哈希偏离）
    const forgedActionBundle: RunUploadBundle = {
      ...base,
      artifacts: base.artifacts.map((a) => {
        if (a.kind !== 'decisions') return a;
        const lines = a.ndjson.trim().split('\n');
        const first = JSON.parse(lines[0] ?? '{}') as {
          agentId: string;
          decision: { selectedAction: string };
        };
        first.decision.selectedAction =
          first.decision.selectedAction === 'accumulate' ? 'descend' : 'accumulate';
        lines[0] = JSON.stringify(first);
        return { ...a, ndjson: `${lines.join('\n')}\n` };
      }),
    };
    const replayMismatch = verifyUploadBundle(forgedActionBundle);
    expect(replayMismatch.status).toBe('rejected');
    expect(
      replayMismatch.report.reasons.some(
        (r) =>
          r.includes('回放统计指标') ||
          r.includes('stateHash 与回放状态不一致') ||
          r.includes('回放产生事件总数') ||
          r.includes('回放终局哈希'),
      ),
    ).toBe(true);

    // 远端 R2 对象缺失（404）与压缩 SHA-256 失配
    await env.ARTIFACTS.delete(`runs/${uploaded.runId}/final_state/final-state-0.ndjson.gz`);
    await env.DB.prepare('UPDATE artifacts SET compressed_sha256 = ? WHERE run_id = ? AND kind = ?')
      .bind('0'.repeat(64), uploaded.runId, 'metrics')
      .run();
    const missingR2 = await verifyRemoteRun({
      baseUrl: BASE,
      runId: uploaded.runId,
      submit: false,
      fetchImpl: fetchWorker,
    });
    expect(missingR2.status).toBe('rejected');
    expect(missingR2.report.reasons.some((r) => r.includes('HTTP 404'))).toBe(true);
    expect(missingR2.report.reasons.some((r) => r.includes('压缩 SHA-256 不匹配'))).toBe(true);

    // 覆盖远端非 completed 状态、agents 500、验证回写 403 以及缺初始快照/破损字段分支
    await expect(
      verifyRemoteRun({
        baseUrl: BASE,
        runId: 'run_running',
        fetchImpl: async () => new Response(JSON.stringify({ status: 'running' }), { status: 200 }),
      }),
    ).rejects.toThrow('completed run');

    await expect(
      verifyRemoteRun({
        baseUrl: BASE,
        runId: 'run_agent_err',
        fetchImpl: async (url) =>
          url.endsWith('/agents')
            ? new Response('err', { status: 500 })
            : new Response(JSON.stringify({ status: 'completed' }), { status: 200 }),
      }),
    ).rejects.toThrow('读取远端 agents 失败');

    await expect(
      verifyRemoteRun({
        baseUrl: BASE,
        runId: uploaded.runId,
        runnerToken: 'wrong-runner-token',
        submit: true,
        fetchImpl: fetchWorker,
      }),
    ).rejects.toThrow('回写验证结果失败: HTTP 403');

    const malformedFields = verifyUploadBundle({
      ...base,
      finalAliveCount: 999,
      artifacts: [
        ...base.artifacts.filter((a) => a.kind === 'metrics' || a.kind === 'final_state'),
        {
          kind: 'snapshot',
          chunkId: 's0',
          ndjson: '{"schemaVersion":"snapshot-v1","stateHash":"x","snapshot":{}}\n',
        },
        { kind: 'events', chunkId: 'e0', ndjson: '{"schemaVersion":"event-v1","tick":"bad"}\n' },
        {
          kind: 'decisions',
          chunkId: 'd0',
          ndjson: '{"schemaVersion":"decision-v1","tickSettled":true,"tick":"bad"}\n',
        },
      ],
    });
    expect(malformedFields.status).toBe('rejected');
    expect(malformedFields.report.reasons.some((r) => r.includes('缺少 tick=0'))).toBe(true);
  });
});

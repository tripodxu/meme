import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import type { RunConfig } from '../core/config/types.js';
import { StratifyError, errorCodes } from '../core/control/errors.js';
import type { CheckpointHost } from './checkpoint.js';

/**
 * P5-05 / P5-07：单 run 上传器。
 *
 * 只负责把**已经算完**的 run artifact 交给 P4 Worker：创建 run、分块上传、
 * 逐块落盘确认、幂等重试与 complete。不得在上传失败时重跑实验或新建 run。
 *
 * 输入是 `run-upload-bundle-v1`（本地 artifact 的非压缩 NDJSON 文本），
 * 输出是服务器 runId 与 complete 响应。writeToken 与已确认块写入本地
 * `upload-ledger-v1`，断网恢复后只补传未确认块；ledger 含 writeToken，
 * 调用方必须限制文件权限（Node 默认宿主用 0600）。
 */

export const UPLOAD_BUNDLE_SCHEMA = 'run-upload-bundle-v1' as const;
export const UPLOAD_LEDGER_SCHEMA = 'upload-ledger-v1' as const;

export type UploadArtifactKind =
  'decisions' | 'events' | 'snapshot' | 'final_state' | 'metrics' | 'manifest';

export const UPLOAD_ARTIFACT_KINDS: readonly UploadArtifactKind[] = [
  'decisions',
  'events',
  'snapshot',
  'final_state',
  'metrics',
  'manifest',
];

const CHUNK_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface UploadArtifact {
  readonly kind: UploadArtifactKind;
  /** 服务器 chunkId；同一 kind 下唯一。 */
  readonly chunkId: string;
  /** 未压缩 NDJSON 全文；每行一个合法 JSON 对象。 */
  readonly ndjson: string;
  readonly startTick?: number | null;
  readonly endTick?: number | null;
}

export interface UploadIdentity {
  readonly rulesVersion: string;
  readonly engineVersion: string;
  readonly decisionSchemaVersion: string;
  readonly policyVersion: string;
  readonly promptVersion: string | null;
  readonly requestedModel: string | null;
  readonly seed: string;
  readonly runtimeVersion: string;
  readonly configHash: string;
  readonly paramsHash: string;
  readonly initialPopulationHash: string;
  readonly codeSha: string;
}

export interface UploadExperiment {
  readonly experimentId: string;
  readonly cellKey: string;
  readonly seed: string;
}

/** 最终个体行；与 Worker `agents:batch` 字段一致。 */
export interface UploadAgent {
  readonly agentId: string;
  readonly alive: boolean;
  readonly classIndex: number;
  readonly maxClassIndex: number;
  readonly value: number;
  readonly ge: number;
  readonly hard: number;
  readonly initialLife: number;
  readonly remainingLife: number;
  readonly deathTick: number | null;
  readonly deathReason?: string | null;
  readonly payloadHash: string;
}

export interface RunUploadBundle {
  readonly schemaVersion: typeof UPLOAD_BUNDLE_SCHEMA;
  readonly config: RunConfig;
  readonly identity: UploadIdentity;
  readonly experiment?: UploadExperiment | null;
  readonly artifactProfile: 'full' | 'metrics-only';
  readonly finalTick: number;
  readonly endReason: 'scheduled' | 'extinct';
  readonly finalAliveCount: number;
  readonly agents: readonly UploadAgent[];
  readonly expectedDueDecisions: number;
  readonly finalStateHash: string;
  readonly summaryHash: string;
  readonly artifacts: readonly UploadArtifact[];
}

export interface UploadLedgerChunk {
  readonly compressedSha256: string;
  readonly uncompressedSha256: string;
  readonly bytes: number;
  readonly confirmedAt: string;
}

export interface UploadLedger {
  readonly schemaVersion: typeof UPLOAD_LEDGER_SCHEMA;
  readonly baseUrl: string;
  readonly bundleHash: string;
  readonly runId: string;
  readonly writeToken: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly chunks: Readonly<Record<string, UploadLedgerChunk>>;
  readonly complete: {
    readonly status: 'completed';
    readonly summaryHash: string;
    readonly completedAt: string;
  } | null;
}

export interface UploaderOptions {
  readonly baseUrl: string;
  /** 默认全局 fetch；测试注入 Worker app.request。 */
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** ledger 原子写宿主；提供时启用断点续传。 */
  readonly ledger?: { readonly host: CheckpointHost; readonly path: string };
  /** 正式 runner 需 RUNNER_TOKEN；匿名浏览器上传缺省。 */
  readonly runnerToken?: string;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => string;
}

export interface UploadResult {
  readonly runId: string;
  readonly status: 'completed';
  readonly chunksUploaded: number;
  readonly chunksSkipped: number;
  readonly duplicateComplete: boolean;
}

export class UploadError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { code?: string; status?: number | null; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'UploadError';
    this.code = options.code ?? 'upload_failed';
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateBundle(bundle: RunUploadBundle): void {
  if (bundle.schemaVersion !== UPLOAD_BUNDLE_SCHEMA) {
    throw new UploadError('bundle schemaVersion 必须为 run-upload-bundle-v1', {
      code: 'bundle_invalid',
    });
  }
  if (!isRecord(bundle.config) || !isRecord(bundle.identity)) {
    throw new UploadError('bundle 缺少 config/identity', { code: 'bundle_invalid' });
  }
  if (bundle.artifactProfile !== 'full' && bundle.artifactProfile !== 'metrics-only') {
    throw new UploadError('artifactProfile 非法', { code: 'bundle_invalid' });
  }
  if (!Number.isInteger(bundle.finalTick) || bundle.finalTick < 0) {
    throw new UploadError('finalTick 必须是非负整数', { code: 'bundle_invalid' });
  }
  if (bundle.endReason !== 'scheduled' && bundle.endReason !== 'extinct') {
    throw new UploadError('endReason 非法', { code: 'bundle_invalid' });
  }
  if (!Number.isInteger(bundle.expectedDueDecisions) || bundle.expectedDueDecisions < 0) {
    throw new UploadError('expectedDueDecisions 必须是非负整数', { code: 'bundle_invalid' });
  }
  if (!Array.isArray(bundle.agents)) {
    throw new UploadError('agents 必须是数组', { code: 'bundle_invalid' });
  }
  const agentIds = new Set<string>();
  for (const agent of bundle.agents) {
    if (typeof agent.agentId !== 'string' || agent.agentId.length === 0) {
      throw new UploadError('agent.agentId 必须是非空字符串', { code: 'bundle_invalid' });
    }
    if (agentIds.has(agent.agentId)) {
      throw new UploadError(`agent 重复: ${agent.agentId}`, { code: 'bundle_invalid' });
    }
    agentIds.add(agent.agentId);
    if (typeof agent.alive !== 'boolean' || !SHA256_PATTERN.test(agent.payloadHash)) {
      throw new UploadError(`agent ${agent.agentId} 字段非法`, { code: 'bundle_invalid' });
    }
  }
  if (bundle.finalAliveCount !== bundle.agents.filter((agent) => agent.alive).length) {
    throw new UploadError('finalAliveCount 与 agents 中存活数不一致', {
      code: 'bundle_invalid',
    });
  }
  for (const key of ['finalStateHash', 'summaryHash'] as const) {
    if (!SHA256_PATTERN.test(bundle[key])) {
      throw new UploadError(`${key} 必须为 sha256:hex`, { code: 'bundle_invalid' });
    }
  }
  if (!Array.isArray(bundle.artifacts) || bundle.artifacts.length === 0) {
    throw new UploadError('bundle.artifacts 不得为空', { code: 'bundle_invalid' });
  }
  const keys = new Set<string>();
  for (const artifact of bundle.artifacts) {
    if (!UPLOAD_ARTIFACT_KINDS.includes(artifact.kind)) {
      throw new UploadError(`artifact kind 非法: ${String(artifact.kind)}`, {
        code: 'bundle_invalid',
      });
    }
    if (!CHUNK_ID_PATTERN.test(artifact.chunkId)) {
      throw new UploadError(`chunkId 非法: ${artifact.chunkId}`, { code: 'bundle_invalid' });
    }
    if (typeof artifact.ndjson !== 'string' || artifact.ndjson.length === 0) {
      throw new UploadError(`artifact ${artifact.kind}/${artifact.chunkId} 内容为空`, {
        code: 'bundle_invalid',
      });
    }
    const key = `${artifact.kind}/${artifact.chunkId}`;
    if (keys.has(key)) {
      throw new UploadError(`artifact 重复: ${key}`, { code: 'bundle_invalid' });
    }
    keys.add(key);
  }
  if (!bundle.artifacts.some((artifact) => artifact.kind === 'metrics')) {
    throw new UploadError('metrics-only/full 都必须包含 metrics artifact', {
      code: 'bundle_invalid',
    });
  }
  if (!bundle.artifacts.some((artifact) => artifact.kind === 'final_state')) {
    throw new UploadError('必须包含 final_state artifact', { code: 'bundle_invalid' });
  }
  if (bundle.artifactProfile === 'full') {
    for (const required of ['decisions', 'events', 'snapshot'] as const) {
      if (!bundle.artifacts.some((artifact) => artifact.kind === required)) {
        throw new UploadError(`full profile 缺少 ${required} artifact`, {
          code: 'bundle_invalid',
        });
      }
    }
  }
}

function parseMetricRows(bundle: RunUploadBundle): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  for (const artifact of bundle.artifacts) {
    if (artifact.kind !== 'metrics') continue;
    for (const [index, line] of artifact.ndjson.split('\n').entries()) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new UploadError(`metrics ${artifact.chunkId} 第 ${index + 1} 行不是合法 JSON`, {
          code: 'bundle_invalid',
        });
      }
      if (
        !isRecord(parsed) ||
        typeof parsed['tick'] !== 'number' ||
        !Number.isInteger(parsed['tick'])
      ) {
        throw new UploadError(`metrics ${artifact.chunkId} 第 ${index + 1} 行缺少整数 tick`, {
          code: 'bundle_invalid',
        });
      }
      const tick = parsed['tick'];
      if (seen.has(tick)) {
        throw new UploadError(`metrics tick ${tick} 重复`, { code: 'bundle_invalid' });
      }
      seen.add(tick);
      rows.push(parsed);
    }
  }
  rows.sort((a, b) => (a['tick'] as number) - (b['tick'] as number));
  return rows;
}

/** 与 Worker `plannedStatsTicks` 同一口径。 */
export function plannedStatsTicks(
  config: RunConfig,
  finalTick: number,
  extinct: boolean,
): number[] {
  const last = extinct ? finalTick : config.schedule.totalTicks - 1;
  const ticks = new Set<number>();
  for (let tick = 0; tick < config.schedule.totalTicks; tick += config.schedule.statsStride) {
    if (tick <= last) ticks.add(tick);
  }
  ticks.add(last);
  return [...ticks].sort((a, b) => a - b);
}

function selectTickRows(
  bundle: RunUploadBundle,
  metricRows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const planned = new Set(
    plannedStatsTicks(bundle.config, bundle.finalTick, bundle.endReason === 'extinct'),
  );
  const selected = metricRows.filter((row) => planned.has(row['tick'] as number));
  if (selected.length !== planned.size) {
    throw new UploadError(
      `metrics 缺少计划 stats 行：需要 ${planned.size}，找到 ${selected.length}`,
      { code: 'bundle_invalid' },
    );
  }
  return selected;
}

async function sendTickRows(
  bundle: RunUploadBundle,
  rows: readonly Record<string, unknown>[],
  options: UploaderOptions,
  baseUrl: string,
  ledger: UploadLedger,
): Promise<void> {
  for (let index = 0; index < rows.length; index += 100) {
    const batch = rows.slice(index, index + 100);
    await requestWithRetry(
      options,
      `${baseUrl}/api/runs/${ledger.runId}/ticks:batch`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ledger.writeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ticks: batch }),
      },
      '上传 tick 批次',
    );
  }
}

async function sendAgentRows(
  bundle: RunUploadBundle,
  options: UploaderOptions,
  baseUrl: string,
  ledger: UploadLedger,
): Promise<void> {
  for (let index = 0; index < bundle.agents.length; index += 500) {
    const batch = bundle.agents.slice(index, index + 500);
    await requestWithRetry(
      options,
      `${baseUrl}/api/runs/${ledger.runId}/agents:batch`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ledger.writeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ agents: batch }),
      },
      '上传 agent 批次',
    );
  }
}

export function computeBundleHash(bundle: RunUploadBundle): string {
  const normalized = {
    config: bundle.config,
    identity: bundle.identity,
    experiment: bundle.experiment ?? null,
    artifactProfile: bundle.artifactProfile,
    finalTick: bundle.finalTick,
    endReason: bundle.endReason,
    finalAliveCount: bundle.finalAliveCount,
    expectedDueDecisions: bundle.expectedDueDecisions,
    agents: bundle.agents.map((agent) => ({
      agentId: agent.agentId,
      alive: agent.alive,
      payloadHash: agent.payloadHash,
    })),
    finalStateHash: bundle.finalStateHash,
    summaryHash: bundle.summaryHash,
    artifacts: bundle.artifacts.map((artifact) => ({
      kind: artifact.kind,
      chunkId: artifact.chunkId,
      startTick: artifact.startTick ?? null,
      endTick: artifact.endTick ?? null,
      sha256: sha256Hex(artifact.ndjson),
    })),
  };
  return `sha256:${sha256Hex(JSON.stringify(normalized))}`;
}

interface RequestResult {
  readonly status: number;
  readonly body: unknown;
}

async function readBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (text.length === 0) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function requestWithRetry(
  options: UploaderOptions,
  url: string,
  init: RequestInit,
  label: string,
): Promise<RequestResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = options.maxAttempts ?? 3;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      const body = await readBody(response);
      if (response.status >= 200 && response.status < 300) {
        return { status: response.status, body };
      }
      if (!isRetryableStatus(response.status)) {
        throw new UploadError(`${label} 失败: HTTP ${response.status}`, {
          code: 'http_error',
          status: response.status,
          retryable: false,
        });
      }
      lastError = new UploadError(`${label} 失败: HTTP ${response.status}`, {
        code: 'http_error',
        status: response.status,
        retryable: true,
      });
    } catch (error) {
      if (error instanceof UploadError) {
        if (!error.retryable || attempt >= maxAttempts) throw error;
        lastError = error;
      } else {
        if (attempt >= maxAttempts) {
          throw new UploadError(`${label} 网络失败`, {
            code: 'network_error',
            retryable: true,
            cause: error,
          });
        }
        lastError = error;
      }
    }
    await sleep((options.retryDelayMs ?? 250) * 2 ** (attempt - 1));
  }
  throw lastError instanceof UploadError
    ? lastError
    : new UploadError(`${label} 重试耗尽`, { code: 'network_error', retryable: true });
}

function ledgerKey(artifact: UploadArtifact): string {
  return `${artifact.kind}/${artifact.chunkId}`;
}

async function loadLedger(
  ledger: NonNullable<UploaderOptions['ledger']>,
  baseUrl: string,
  bundleHash: string,
): Promise<UploadLedger | null> {
  if (!(await ledger.host.exists(ledger.path))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await ledger.host.read(ledger.path)) as unknown;
  } catch (error) {
    throw new UploadError('upload ledger 损坏；不得当作有效恢复点', {
      code: 'ledger_corrupt',
      cause: error,
    });
  }
  if (!isRecord(parsed) || parsed['schemaVersion'] !== UPLOAD_LEDGER_SCHEMA) {
    throw new UploadError('upload ledger 版本未知', { code: 'ledger_corrupt' });
  }
  if (parsed['baseUrl'] !== baseUrl || parsed['bundleHash'] !== bundleHash) {
    throw new UploadError(
      'upload ledger 与当前 bundle/baseUrl 不一致；换 bundle 请换 ledger 路径',
      {
        code: 'ledger_mismatch',
      },
    );
  }
  return parsed as unknown as UploadLedger;
}

async function saveLedger(
  ledger: NonNullable<UploaderOptions['ledger']>,
  value: UploadLedger,
): Promise<void> {
  const tempPath = `${ledger.path}.tmp`;
  await ledger.host.writeTemp(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await ledger.host.promote(tempPath, ledger.path);
}

export async function uploadRun(
  bundle: RunUploadBundle,
  options: UploaderOptions,
): Promise<UploadResult> {
  validateBundle(bundle);
  const metricRows = parseMetricRows(bundle);
  const tickRows = selectTickRows(bundle, metricRows);
  const expectedTickRows = tickRows.length;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const bundleHash = computeBundleHash(bundle);
  const now = options.now ?? (() => new Date().toISOString());
  let ledger =
    options.ledger === undefined ? null : await loadLedger(options.ledger, baseUrl, bundleHash);

  if (ledger === null) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.runnerToken !== undefined) {
      headers['authorization'] = `Bearer ${options.runnerToken}`;
    }
    // 创建失败不做盲目重试：网络超时可能已建 run，客户端没有 runId/writeToken，
    // 重试会复制实验。此处保留明确错误，由人工核对服务器列表。
    const fetchImpl = options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          schemaVersion: 'run-v1',
          config: bundle.config,
          identity: bundle.identity,
          schedule: {
            totalTicks: bundle.config.schedule.totalTicks,
            statsStride: bundle.config.schedule.statsStride,
            snapshotStride: bundle.config.schedule.snapshotStride,
          },
          experiment: bundle.experiment ?? null,
          artifactProfile: bundle.artifactProfile,
        }),
      });
    } catch (error) {
      throw new UploadError('创建 run 网络失败；结果不确定，禁止盲目重试', {
        code: 'create_ambiguous',
        cause: error,
      });
    }
    const body = await readBody(response);
    if (response.status !== 201 || !isRecord(body)) {
      throw new UploadError(`创建 run 失败: HTTP ${response.status}`, {
        code: 'create_failed',
        status: response.status,
      });
    }
    const runId = body['runId'];
    const writeToken = body['writeToken'];
    if (typeof runId !== 'string' || typeof writeToken !== 'string') {
      throw new UploadError('创建 run 响应缺少 runId/writeToken', { code: 'create_failed' });
    }
    ledger = {
      schemaVersion: UPLOAD_LEDGER_SCHEMA,
      baseUrl,
      bundleHash,
      runId,
      writeToken,
      createdAt: now(),
      updatedAt: now(),
      chunks: {},
      complete: null,
    };
    if (options.ledger !== undefined) await saveLedger(options.ledger, ledger);
  }

  let chunksUploaded = 0;
  let chunksSkipped = 0;
  for (const artifact of bundle.artifacts) {
    const key = ledgerKey(artifact);
    const compressed = gzipSync(Buffer.from(artifact.ndjson, 'utf8'));
    const compressedSha256 = sha256Hex(compressed);
    const uncompressedSha256 = sha256Hex(artifact.ndjson);
    const confirmed: UploadLedgerChunk | undefined = ledger.chunks[key];
    if (confirmed !== undefined && confirmed.compressedSha256 === compressedSha256) {
      chunksSkipped += 1;
      continue;
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${ledger.writeToken}`,
      'content-type': 'application/gzip',
      'x-artifact-kind': artifact.kind,
      'x-uncompressed-sha256': uncompressedSha256,
      'x-compressed-sha256': compressedSha256,
    };
    if (artifact.startTick !== undefined && artifact.startTick !== null) {
      headers['x-start-tick'] = String(artifact.startTick);
    }
    if (artifact.endTick !== undefined && artifact.endTick !== null) {
      headers['x-end-tick'] = String(artifact.endTick);
    }
    const body = new Uint8Array(compressed.byteLength);
    body.set(compressed);
    const result = await requestWithRetry(
      options,
      `${baseUrl}/api/runs/${ledger.runId}/artifacts/${artifact.chunkId}`,
      { method: 'PUT', headers, body: body.buffer },
      `上传 ${key}`,
    );
    const responseBody = result.body;
    if (!isRecord(responseBody) || responseBody['compressedSha256'] !== compressedSha256) {
      throw new UploadError(`上传 ${key} 后服务器返回的压缩哈希不一致`, {
        code: 'artifact_mismatch',
      });
    }
    ledger = {
      ...ledger,
      updatedAt: now(),
      chunks: {
        ...ledger.chunks,
        [key]: {
          compressedSha256,
          uncompressedSha256,
          bytes: compressed.byteLength,
          confirmedAt: now(),
        },
      },
    };
    if (options.ledger !== undefined) await saveLedger(options.ledger, ledger);
    chunksUploaded += 1;
  }

  if (ledger.complete !== null && ledger.complete.summaryHash === bundle.summaryHash) {
    return {
      runId: ledger.runId,
      status: 'completed',
      chunksUploaded,
      chunksSkipped,
      duplicateComplete: true,
    };
  }

  // tick/agent 写入按主键幂等；恢复时重发不会重复计数，也不需要额外 ledger。
  await sendTickRows(bundle, tickRows, options, baseUrl, ledger);
  await sendAgentRows(bundle, options, baseUrl, ledger);

  const manifest = Object.entries(ledger.chunks)
    .map(([key, chunk]) => ({
      key,
      sha256: chunk.compressedSha256,
      bytes: chunk.bytes,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const artifactManifestHash = `sha256:${sha256Hex(JSON.stringify(manifest))}`;
  const completeHeaders: Record<string, string> = {
    authorization: `Bearer ${ledger.writeToken}`,
    'content-type': 'application/json',
  };
  const completeResult = await requestWithRetry(
    options,
    `${baseUrl}/api/runs/${ledger.runId}/complete`,
    {
      method: 'POST',
      headers: completeHeaders,
      body: JSON.stringify({
        finalTick: bundle.finalTick,
        endReason: bundle.endReason,
        finalAliveCount: bundle.finalAliveCount,
        finalStateHash: bundle.finalStateHash,
        summaryHash: bundle.summaryHash,
        expectedTickRows,
        expectedAgentRows: bundle.agents.length,
        expectedDueDecisions: bundle.expectedDueDecisions,
        artifactManifestHash,
      }),
    },
    'complete run',
  );
  if (!isRecord(completeResult.body) || completeResult.body['status'] !== 'completed') {
    throw new UploadError('complete 响应缺少 completed 状态', { code: 'complete_failed' });
  }
  const duplicateComplete = completeResult.body['duplicate'] === true;
  ledger = {
    ...ledger,
    updatedAt: now(),
    complete: {
      status: 'completed',
      summaryHash: bundle.summaryHash,
      completedAt: now(),
    },
  };
  if (options.ledger !== undefined) await saveLedger(options.ledger, ledger);
  return {
    runId: ledger.runId,
    status: 'completed',
    chunksUploaded,
    chunksSkipped,
    duplicateComplete,
  };
}

/** 供 CLI/测试构造统一的领域错误，保留 `code` 便于退出码映射。 */
export function asUploadError(error: unknown): UploadError {
  if (error instanceof UploadError) return error;
  if (error instanceof StratifyError) {
    return new UploadError(error.message, { code: error.code, cause: error });
  }
  return new UploadError(error instanceof Error ? error.message : String(error), {
    code: errorCodes.CONFIG_INVALID,
    cause: error,
  });
}

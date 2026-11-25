import type { Context, Next } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { D1Database, WorkerBindings } from './types.js';

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'state_conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'upstream_error'
  | 'internal_error'
  | 'unsupported_version';

export interface Issue {
  readonly path: string;
  readonly reason: string;
}

export type ErrorDetails = readonly Issue[] | { readonly upstreamStatus: number | null };

export function errorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
  details: ErrorDetails = [],
): {
  error: { code: ErrorCode; message: string; details: ErrorDetails };
  requestId: string;
} {
  return { error: { code, message, details }, requestId };
}

export function fail(
  c: Context<WorkerBindings>,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  details: ErrorDetails = [],
): Response {
  return c.json(errorBody(code, message, c.get('requestId'), details), status);
}

/** 429 统一带标准 Retry-After 秒数响应头（05 §9）。 */
export function rateLimited(
  c: Context<WorkerBindings>,
  message: string,
  retryAfterSeconds: number,
): Response {
  c.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds))));
  return fail(c, 429, 'rate_limited', message);
}

export async function requestIdMiddleware(c: Context<WorkerBindings>, next: Next): Promise<void> {
  const id = `req_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  c.header('Cache-Control', 'no-store');
  await next();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readJson(
  c: Context<WorkerBindings>,
  maxBytes: number,
): Promise<unknown | Response> {
  const length = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(length) && length > maxBytes) {
    return fail(c, 413, 'payload_too_large', `请求体超过 ${maxBytes} 字节`);
  }
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return fail(c, 400, 'bad_request', '无法读取请求体');
  }
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return fail(c, 413, 'payload_too_large', `请求体超过 ${maxBytes} 字节`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail(c, 400, 'bad_request', '请求体不是合法 JSON');
  }
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * 常量时间字符串比较（长度差异并入结果位，不提前返回）。
 * token / 哈希比较必须用它，避免 `!==` 的短路时序泄露前缀信息。
 */
export function timingSafeStringEqual(left: string, right: string): boolean {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes =
    typeof input === 'string'
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  const buffer = new Uint8Array(bytes.byteLength);
  buffer.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buffer.buffer);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export function parseBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? null;
}

export async function requireWriteToken(
  c: Context<WorkerBindings>,
  runId: string,
): Promise<{ ok: true; row: RunRow } | { ok: false; response: Response }> {
  const token = parseBearer(c.req.header('authorization'));
  if (token === null) {
    return { ok: false, response: fail(c, 401, 'unauthorized', '缺少 writeToken') };
  }
  const row = await c.env.DB.prepare('SELECT * FROM runs WHERE run_id = ?')
    .bind(runId)
    .first<RunRow>();
  if (row === null) {
    return { ok: false, response: fail(c, 404, 'not_found', 'run 不存在') };
  }
  const hash = await sha256Hex(token);
  if (!timingSafeStringEqual(hash, row.write_token_hash)) {
    return { ok: false, response: fail(c, 403, 'forbidden', 'writeToken 不属于该 run') };
  }
  return { ok: true, row };
}

export function requireRunner(c: Context<WorkerBindings>): Response | null {
  const token = parseBearer(c.req.header('authorization'));
  if (token === null) return fail(c, 401, 'unauthorized', '需要 RUNNER_TOKEN');
  const expected = c.env.RUNNER_TOKEN;
  if (expected === undefined || expected.length === 0 || !timingSafeStringEqual(token, expected)) {
    return fail(c, 403, 'forbidden', 'RUNNER_TOKEN 无效');
  }
  return null;
}

export function clientBucket(c: Context<WorkerBindings>): string {
  const ip =
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';
  return `ip:${ip}`;
}

/**
 * 固定窗口计数；返回 false 表示超限。
 *
 * 计数与判定必须是**同一条语句**：先 SELECT 再 INSERT 的写法在并发下会让
 * 多个请求同时读到旧值而一起放行。这里用条件 UPSERT，
 * `WHERE count < limit` 不成立时 `meta.changes` 为 0，即为超限。
 */
export async function checkRateLimit(
  db: D1Database,
  bucket: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): Promise<boolean> {
  if (!Number.isInteger(limit) || limit < 1) return false;
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds;
  const result = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1 WHERE count < ?`,
    )
    .bind(bucket, windowStart, limit)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export interface RunRow {
  readonly run_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly source: 'browser' | 'runner';
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly end_reason: 'scheduled' | 'extinct' | null;
  readonly config_json: string;
  readonly rules_version: string;
  readonly engine_version: string;
  readonly decision_schema_version: string;
  readonly policy_version: string;
  readonly prompt_version: string | null;
  readonly requested_model: string | null;
  readonly seed: string;
  readonly runtime_version: string;
  readonly config_hash: string;
  readonly params_hash: string;
  readonly initial_population_hash: string;
  readonly code_sha: string;
  readonly write_token_hash: string;
  readonly write_token_prefix: string;
  readonly artifact_profile: 'full' | 'metrics-only';
  readonly runtime_authority: 'authoritative' | 'non-authoritative';
  readonly verification_status: 'pending' | 'uploaded' | 'verified' | 'rejected';
  readonly verification_report_hash: string | null;
  readonly response_models_json: string;
  readonly budget_json: string | null;
  readonly final_tick: number | null;
  readonly final_alive_count: number | null;
  readonly final_state_hash: string | null;
  readonly summary_hash: string | null;
  readonly complete_json: string | null;
  readonly diagnostics_hash: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
}

export function publicRun(row: RunRow): Record<string, unknown> {
  return {
    runId: row.run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: row.source,
    status: row.status,
    endReason: row.end_reason,
    rulesVersion: row.rules_version,
    engineVersion: row.engine_version,
    decisionSchemaVersion: row.decision_schema_version,
    policyVersion: row.policy_version,
    promptVersion: row.prompt_version,
    requestedModel: row.requested_model,
    seed: row.seed,
    runtimeVersion: row.runtime_version,
    configHash: row.config_hash,
    paramsHash: row.params_hash,
    initialPopulationHash: row.initial_population_hash,
    codeSha: row.code_sha,
    artifactProfile: row.artifact_profile,
    runtimeAuthority: row.runtime_authority,
    verificationStatus: row.verification_status,
    responseModels: JSON.parse(row.response_models_json) as unknown,
    finalTick: row.final_tick,
    finalAliveCount: row.final_alive_count,
    finalStateHash: row.final_state_hash,
    summaryHash: row.summary_hash,
    diagnosticsHash: row.diagnostics_hash,
    error: row.error_code === null ? null : { code: row.error_code, message: row.error_message },
  };
}

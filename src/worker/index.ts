import { Hono } from 'hono';

import type { RunConfig } from '../core/config/types.js';
import {
  ARTIFACT_KINDS,
  CHUNK_ID_PATTERN,
  RUN_ID_PATTERN,
  plannedStatsTicks,
  validateAgentBatch,
  validateCompleteBody,
  validateExperimentCreate,
  validateRunCreate,
  validateTickBatch,
  type ArtifactKind,
} from './contracts.js';
import {
  checkRateLimit,
  clientBucket,
  errorBody,
  fail,
  isRecord,
  publicRun,
  randomToken,
  readJson,
  requestIdMiddleware,
  requireRunner,
  requireWriteToken,
  sha256Hex,
  type RunRow,
} from './http.js';
import type { Env, ExecutionContext, ScheduledEvent, WorkerBindings } from './types.js';
import { runMaintenance } from './maintenance.js';

const app = new Hono<WorkerBindings>();

app.use('/api/*', requestIdMiddleware);

app.get('/api/health', async (c) => {
  let db = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1 AS ok').first();
  } catch {
    db = 'unavailable';
  }
  return c.json({
    status: db === 'ok' ? 'ok' : 'degraded',
    version: c.env.VERSION ?? 'dev',
    time: new Date().toISOString(),
    db,
  });
});

/** P4-08：同源 BYOK 代理；仅允许白名单字段与模型，不记录 Key/body。 */
app.post('/api/jev', async (c) => {
  const allowed = await checkRateLimit(c.env.DB, `${clientBucket(c)}:jev`, 60, 60);
  if (!allowed) return fail(c, 429, 'rate_limited', 'Jev 代理请求过于频繁');
  const globalLimit = Number(c.env.JEV_GLOBAL_HOURLY_LIMIT ?? '1000');
  const globalAllowed = await checkRateLimit(
    c.env.DB,
    'jev:global',
    Number.isInteger(globalLimit) && globalLimit > 0 ? globalLimit : 1000,
    3600,
  );
  if (!globalAllowed) {
    return fail(c, 429, 'rate_limited', 'Jev 代理全局小时配额已耗尽');
  }
  const apiKey = c.req.header('x-api-key');
  if (apiKey === undefined || apiKey.length === 0) {
    return fail(c, 401, 'unauthorized', '缺少 X-Api-Key');
  }
  const body = await readJson(c, 256 * 1024);
  if (body instanceof Response) return body;
  if (!isRecord(body)) return fail(c, 400, 'bad_request', 'body 必须是对象');
  if (!isRecord(body['state'])) return fail(c, 422, 'validation_failed', 'state 必须是对象');
  if (typeof body['model'] !== 'string') {
    return fail(c, 422, 'validation_failed', 'model 必须是字符串');
  }
  const questions = body['questions'];
  if (!Array.isArray(questions) || questions.length !== 1 || !isRecord(questions[0])) {
    return fail(c, 422, 'validation_failed', 'questions 只允许一个问题');
  }
  const question = questions[0];
  const choices = question['choices'];
  if (
    question['type'] !== 'action' ||
    !Array.isArray(choices) ||
    choices.length < 1 ||
    choices.length > 9
  ) {
    return fail(c, 422, 'validation_failed', 'questions 只允许一个 action choice，选项 1–9 个');
  }
  const allowlist = (c.env.JEV_ALLOWED_MODELS ?? 'jev-1.13.0')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!allowlist.includes(body['model'])) {
    return fail(c, 422, 'validation_failed', 'model 不在服务端 allowlist');
  }
  const upstream = c.env.JEV_UPSTREAM_URL ?? 'https://api.typesafe.ai/v1/systemone';
  let target: URL;
  try {
    target = new URL(upstream);
  } catch {
    return fail(c, 500, 'internal_error', 'JEV_UPSTREAM_URL 非法');
  }
  if (target.protocol !== 'https:' || target.username !== '' || target.password !== '') {
    return fail(c, 500, 'internal_error', 'JEV_UPSTREAM_URL 必须是 https 且不得内嵌凭据');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(target.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ state: body['state'], model: body['model'], questions }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const status = response.status === 429 || response.status === 529 ? response.status : 502;
      const payload = errorBody(
        'upstream_error',
        `Jev 上游返回 ${response.status}`,
        c.get('requestId'),
        { upstreamStatus: response.status },
      );
      const headers = new Headers({ 'content-type': 'application/json' });
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter !== null) headers.set('retry-after', retryAfter);
      return new Response(JSON.stringify(payload), { status, headers });
    }
    const json = (await response.json()) as unknown;
    return c.json(json);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return fail(c, 502, 'upstream_error', 'Jev 上游超时', { upstreamStatus: null });
    }
    return fail(c, 502, 'upstream_error', 'Jev 上游网络失败', { upstreamStatus: null });
  } finally {
    clearTimeout(timeout);
  }
});

app.post('/api/experiments', async (c) => {
  const auth = requireRunner(c);
  if (auth !== null) return auth;
  const body = await readJson(c, 1024 * 1024);
  if (body instanceof Response) return body;
  const parsed = validateExperimentCreate(body, 'runner');
  if (!parsed.ok)
    return fail(c, 422, 'validation_failed', 'experiment manifest 非法', parsed.issues);
  const experimentId = `exp_${randomToken(12)}`;
  const createdAt = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO experiments
      (experiment_id, created_at, source, status, manifest_json, preregistration_hash,
       label_thresholds_hash, base_config_hash, created_by)
     VALUES (?, ?, 'runner', 'created', ?, ?, ?, ?, 'runner')`,
  )
    .bind(
      experimentId,
      createdAt,
      JSON.stringify(parsed.value.manifest),
      parsed.value.preregistrationHash,
      parsed.value.labelThresholdsHash,
      parsed.value.baseConfigHash,
    )
    .run();
  return c.json({ experimentId, createdAt }, 201);
});

app.get('/api/experiments/:id', async (c) => {
  const id = c.req.param('id');
  if (!RUN_ID_PATTERN.test(id)) return fail(c, 400, 'bad_request', 'experimentId 非法');
  const row = await c.env.DB.prepare('SELECT * FROM experiments WHERE experiment_id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  if (row === null) return fail(c, 404, 'not_found', 'experiment 不存在');
  const runs = await c.env.DB.prepare(
    `SELECT r.run_id, r.status, r.created_at, er.cell_key, er.seed
     FROM experiment_runs er JOIN runs r ON r.run_id = er.run_id
     WHERE er.experiment_id = ? ORDER BY r.created_at DESC LIMIT 1000`,
  )
    .bind(id)
    .all<Record<string, unknown>>();
  return c.json({
    experimentId: id,
    createdAt: row['created_at'],
    manifest: JSON.parse(String(row['manifest_json'])),
    preregistrationHash: row['preregistration_hash'],
    labelThresholdsHash: row['label_thresholds_hash'],
    baseConfigHash: row['base_config_hash'],
    runs: runs.results ?? [],
  });
});

app.post('/api/runs', async (c) => {
  const bearer = c.req.header('authorization');
  let source: 'browser' | 'runner' = 'browser';
  if (bearer !== undefined) {
    const auth = requireRunner(c);
    if (auth !== null) return auth;
    source = 'runner';
  }
  if (source === 'browser') {
    const allowed = await checkRateLimit(c.env.DB, `${clientBucket(c)}:runs`, 30, 3600);
    if (!allowed) return fail(c, 429, 'rate_limited', '匿名创建 run 频率超限');
  }
  const body = await readJson(c, 2 * 1024 * 1024);
  if (body instanceof Response) return body;
  const parsed = validateRunCreate(body, source, {
    authoritativeRuntime: c.env.RUNTIME_VERSION ?? null,
  });
  if (!parsed.ok) return fail(c, 422, 'validation_failed', 'run 创建参数非法', parsed.issues);

  const experiment = parsed.value.experiment;
  if (experiment !== null) {
    const exp = await c.env.DB.prepare(
      'SELECT manifest_json FROM experiments WHERE experiment_id = ?',
    )
      .bind(experiment.experimentId)
      .first<{ manifest_json: string }>();
    if (exp === null) return fail(c, 422, 'validation_failed', 'experiment 不存在');
    const manifest = JSON.parse(exp.manifest_json) as Record<string, unknown>;
    const seeds = Array.isArray(manifest['seeds']) ? manifest['seeds'] : [];
    const cells = Array.isArray(manifest['cells']) ? manifest['cells'] : [];
    if (!seeds.includes(experiment.seed)) {
      return fail(c, 422, 'validation_failed', 'seed 未在 experiment 中声明');
    }
    const cellFound = cells.some(
      (cell) => isRecord(cell) && cell['cellKey'] === experiment.cellKey,
    );
    if (!cellFound) return fail(c, 422, 'validation_failed', 'cellKey 未在 experiment 中声明');
  }

  const runId = `run_${randomToken(12)}`;
  const writeToken = randomToken(32);
  const writeTokenHash = await sha256Hex(writeToken);
  const createdAt = new Date().toISOString();
  const identity = parsed.value.identity;
  const config = parsed.value.config;
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO runs
        (run_id, created_at, updated_at, source, status, config_json, rules_version,
         engine_version, decision_schema_version, policy_version, prompt_version,
         requested_model, seed, runtime_version, config_hash, params_hash,
         initial_population_hash, code_sha, write_token_hash, write_token_prefix,
         artifact_profile, runtime_authority)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      createdAt,
      createdAt,
      source,
      JSON.stringify(config),
      identity.rulesVersion,
      identity.engineVersion,
      identity.decisionSchemaVersion,
      identity.policyVersion,
      identity.promptVersion,
      identity.requestedModel,
      identity.seed,
      identity.runtimeVersion,
      identity.configHash,
      identity.paramsHash,
      identity.initialPopulationHash,
      identity.codeSha,
      writeTokenHash,
      writeToken.slice(0, 8),
      parsed.value.artifactProfile,
      parsed.value.runtimeAuthority,
    ),
  ];
  if (experiment !== null) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO experiment_runs (experiment_id, run_id, cell_key, seed, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(experiment.experimentId, runId, experiment.cellKey, experiment.seed, createdAt),
    );
  }
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    if (experiment !== null) {
      return fail(c, 409, 'conflict', 'experiment cell/seed 已被占用');
    }
    throw error;
  }
  return c.json({ runId, writeToken, status: 'running' }, 201);
});

app.get('/api/runs', async (c) => {
  const limitRaw = Number(c.req.query('limit') ?? '50');
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
  const source = c.req.query('source');
  const status = c.req.query('status');
  if (source !== undefined && source !== 'browser' && source !== 'runner') {
    return fail(c, 400, 'bad_request', 'source 非法');
  }
  if (
    status !== undefined &&
    status !== 'running' &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'cancelled'
  ) {
    return fail(c, 400, 'bad_request', 'status 非法');
  }
  const filter = `${source ?? ''}|${status ?? ''}`;
  const cursor = c.req.query('cursor');
  let createdAt: string | null = null;
  let runId: string | null = null;
  if (cursor !== undefined) {
    try {
      const parsed = JSON.parse(atob(cursor)) as Record<string, unknown>;
      if (parsed['filter'] !== filter) {
        return fail(c, 400, 'bad_request', '游标与当前过滤条件不匹配');
      }
      createdAt = typeof parsed['createdAt'] === 'string' ? parsed['createdAt'] : null;
      runId = typeof parsed['runId'] === 'string' ? parsed['runId'] : null;
    } catch {
      return fail(c, 400, 'bad_request', '游标非法');
    }
  }
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (source !== undefined) {
    clauses.push('source = ?');
    values.push(source);
  }
  if (status !== undefined) {
    clauses.push('status = ?');
    values.push(status);
  }
  if (createdAt !== null && runId !== null) {
    clauses.push('(created_at < ? OR (created_at = ? AND run_id < ?))');
    values.push(createdAt, createdAt, runId);
  }
  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
  const rows = await c.env.DB.prepare(
    `SELECT * FROM runs ${where} ORDER BY created_at DESC, run_id DESC LIMIT ?`,
  )
    .bind(...values, limit + 1)
    .all<RunRow>();
  const list = rows.results ?? [];
  const hasMore = list.length > limit;
  const page = hasMore ? list.slice(0, limit) : list;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? btoa(JSON.stringify({ filter, createdAt: last.created_at, runId: last.run_id }))
      : null;
  return c.json({ runs: page.map(publicRun), nextCursor });
});

app.get('/api/runs/:id', async (c) => {
  const id = c.req.param('id');
  if (!RUN_ID_PATTERN.test(id)) return fail(c, 400, 'bad_request', 'runId 非法');
  const row = await c.env.DB.prepare('SELECT * FROM runs WHERE run_id = ?')
    .bind(id)
    .first<RunRow>();
  if (row === null) return fail(c, 404, 'not_found', 'run 不存在');
  const ticks = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM tick_stats WHERE run_id = ?')
    .bind(id)
    .first<{ n: number }>();
  const agents = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM agent_final WHERE run_id = ?')
    .bind(id)
    .first<{ n: number }>();
  const artifacts = await c.env.DB.prepare(
    'SELECT kind, chunk_id, bytes, start_tick, end_tick, compressed_sha256 FROM artifacts WHERE run_id = ? ORDER BY kind, chunk_id',
  )
    .bind(id)
    .all<Record<string, unknown>>();
  return c.json({
    ...publicRun(row),
    progress: {
      tickRows: ticks?.n ?? 0,
      agentRows: agents?.n ?? 0,
    },
    artifacts: artifacts.results ?? [],
  });
});

app.post('/api/runs/:id/ticks:batch', async (c) => {
  const id = c.req.param('id');
  if (!RUN_ID_PATTERN.test(id)) return fail(c, 400, 'bad_request', 'runId 非法');
  const auth = await requireWriteToken(c, id);
  if (!auth.ok) return auth.response;
  if (auth.row.status !== 'running') {
    return fail(c, 409, 'state_conflict', 'run 已进入终态，不能继续写 tick');
  }
  const body = await readJson(c, 1024 * 1024);
  if (body instanceof Response) return body;
  const config = JSON.parse(auth.row.config_json) as RunConfig;
  const parsed = validateTickBatch(
    body,
    config,
    auth.row.final_tick,
    auth.row.end_reason === 'extinct',
  );
  if (!parsed.ok) return fail(c, 422, 'validation_failed', 'tick 批次非法', parsed.issues);
  let inserted = 0;
  let duplicates = 0;
  const statements = [];
  for (const row of parsed.value) {
    const tick = row['tick'] as number;
    const existing = await c.env.DB.prepare(
      'SELECT payload_hash FROM tick_stats WHERE run_id = ? AND tick = ?',
    )
      .bind(id, tick)
      .first<{ payload_hash: string }>();
    if (existing !== null) {
      if (existing.payload_hash !== row['payloadHash']) {
        return fail(c, 409, 'conflict', `tick ${tick} 已存在且 payloadHash 不同`);
      }
      duplicates += 1;
      continue;
    }
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO tick_stats
          (run_id, tick, alive_count, class_counts_json, gini, median_value, top10_share,
           m_up, m_down, segregation, edge_count, openness, death_count,
           competition_loss, competition_gain, fallback_rate, payload_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        tick,
        row['aliveCount'],
        JSON.stringify(row['classCounts']),
        row['gini'],
        row['medianValue'],
        row['top10Share'],
        row['mUp'],
        row['mDown'],
        row['segregation'],
        row['edgeCount'],
        row['openness'],
        row['deathCount'],
        row['competitionLoss'],
        row['competitionGain'],
        row['fallbackRate'] ?? null,
        row['payloadHash'],
        new Date().toISOString(),
      ),
    );
    inserted += 1;
  }
  if (statements.length > 0) await c.env.DB.batch(statements);
  await c.env.DB.prepare('UPDATE runs SET updated_at = ? WHERE run_id = ?')
    .bind(new Date().toISOString(), id)
    .run();
  return c.json({ accepted: parsed.value.length, inserted, duplicates });
});

app.post('/api/runs/:id/agents:batch', async (c) => {
  const id = c.req.param('id');
  if (!RUN_ID_PATTERN.test(id)) return fail(c, 400, 'bad_request', 'runId 非法');
  const auth = await requireWriteToken(c, id);
  if (!auth.ok) return auth.response;
  if (auth.row.status !== 'running') {
    return fail(c, 409, 'state_conflict', 'run 已进入终态，不能继续写 agent');
  }
  const body = await readJson(c, 1024 * 1024);
  if (body instanceof Response) return body;
  const parsed = validateAgentBatch(body);
  if (!parsed.ok) return fail(c, 422, 'validation_failed', 'agent 批次非法', parsed.issues);
  let inserted = 0;
  let duplicates = 0;
  const statements = [];
  for (const row of parsed.value) {
    const agentId = row['agentId'] as string;
    const existing = await c.env.DB.prepare(
      'SELECT payload_hash FROM agent_final WHERE run_id = ? AND agent_id = ?',
    )
      .bind(id, agentId)
      .first<{ payload_hash: string }>();
    if (existing !== null) {
      if (existing.payload_hash !== row['payloadHash']) {
        return fail(c, 409, 'conflict', `agent ${agentId} 已存在且 payloadHash 不同`);
      }
      duplicates += 1;
      continue;
    }
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO agent_final
          (run_id, agent_id, alive, class_index, max_class_index, value, ge, hard,
           initial_life, remaining_life, death_tick, death_reason, payload_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        agentId,
        row['alive'] === true ? 1 : 0,
        row['classIndex'],
        row['maxClassIndex'],
        row['value'],
        row['ge'],
        row['hard'],
        row['initialLife'],
        row['remainingLife'],
        row['deathTick'] ?? null,
        row['deathReason'] ?? null,
        row['payloadHash'],
        new Date().toISOString(),
      ),
    );
    inserted += 1;
  }
  if (statements.length > 0) await c.env.DB.batch(statements);
  await c.env.DB.prepare('UPDATE runs SET updated_at = ? WHERE run_id = ?')
    .bind(new Date().toISOString(), id)
    .run();
  return c.json({ accepted: parsed.value.length, inserted, duplicates });
});

app.put('/api/runs/:id/artifacts/:chunkId', async (c) => {
  const id = c.req.param('id');
  const chunkId = c.req.param('chunkId');
  if (!RUN_ID_PATTERN.test(id)) return fail(c, 400, 'bad_request', 'runId 非法');
  if (!CHUNK_ID_PATTERN.test(chunkId)) return fail(c, 400, 'bad_request', 'chunkId 非法');
  const auth = await requireWriteToken(c, id);
  if (!auth.ok) return auth.response;
  if (auth.row.status !== 'running') {
    return fail(c, 409, 'state_conflict', 'run 已进入终态，不能继续上传 artifact');
  }
  const kind = c.req.header('x-artifact-kind');
  if (kind === undefined || !ARTIFACT_KINDS.includes(kind as ArtifactKind)) {
    return fail(c, 400, 'bad_request', 'X-Artifact-Kind 非法');
  }
  const uncompressed = c.req.header('x-uncompressed-sha256');
  const expectedCompressed = c.req.header('x-compressed-sha256');
  if (
    uncompressed === undefined ||
    !/^[0-9a-f]{64}$/.test(uncompressed) ||
    expectedCompressed === undefined ||
    !/^[0-9a-f]{64}$/.test(expectedCompressed)
  ) {
    return fail(c, 400, 'bad_request', '缺少或非法的 sha256 头');
  }
  const startTick = parseOptionalInt(c.req.header('x-start-tick'));
  const endTick = parseOptionalInt(c.req.header('x-end-tick'));
  const declaredLength = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > 8 * 1024 * 1024) {
    return fail(c, 413, 'payload_too_large', 'artifact 压缩块不得超过 8 MiB');
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await c.req.arrayBuffer();
  } catch {
    return fail(c, 400, 'bad_request', '无法读取 artifact');
  }
  if (buffer.byteLength > 8 * 1024 * 1024) {
    return fail(c, 413, 'payload_too_large', 'artifact 压缩块不得超过 8 MiB');
  }
  const actualCompressed = await sha256Hex(buffer);
  if (actualCompressed !== expectedCompressed) {
    return fail(c, 422, 'validation_failed', 'X-Compressed-SHA256 与请求体不一致');
  }
  const existing = await c.env.DB.prepare(
    'SELECT compressed_sha256, bytes FROM artifacts WHERE run_id = ? AND kind = ? AND chunk_id = ?',
  )
    .bind(id, kind, chunkId)
    .first<{ compressed_sha256: string; bytes: number }>();
  if (existing !== null) {
    if (existing.compressed_sha256 !== actualCompressed) {
      return fail(c, 409, 'conflict', '同 run/kind/chunkId 已存在不同内容');
    }
    return c.json({
      etag: existing.compressed_sha256,
      bytes: existing.bytes,
      compressedSha256: existing.compressed_sha256,
      duplicate: true,
    });
  }
  const key = `runs/${id}/${kind}/${chunkId}.ndjson.gz`;
  const object = await c.env.ARTIFACTS.put(key, buffer, {
    httpMetadata: { contentType: 'application/gzip' },
  });
  await c.env.DB.prepare(
    `INSERT INTO artifacts
      (run_id, kind, chunk_id, r2_key, uncompressed_sha256, compressed_sha256, bytes,
       start_tick, end_tick, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      kind,
      chunkId,
      key,
      uncompressed,
      actualCompressed,
      buffer.byteLength,
      startTick,
      endTick,
      new Date().toISOString(),
    )
    .run();
  await c.env.DB.prepare('UPDATE runs SET updated_at = ? WHERE run_id = ?')
    .bind(new Date().toISOString(), id)
    .run();
  return c.json({
    etag: object?.etag ?? actualCompressed,
    bytes: buffer.byteLength,
    compressedSha256: actualCompressed,
  });
});

app.get('/api/runs/:id/artifacts/:kind/:chunkId', async (c) => {
  const id = c.req.param('id');
  const kind = c.req.param('kind');
  const chunkId = c.req.param('chunkId');
  if (!RUN_ID_PATTERN.test(id)) return fail(c, 400, 'bad_request', 'runId 非法');
  if (!ARTIFACT_KINDS.includes(kind as ArtifactKind)) {
    return fail(c, 400, 'bad_request', 'kind 非法');
  }
  if (!CHUNK_ID_PATTERN.test(chunkId)) return fail(c, 400, 'bad_request', 'chunkId 非法');
  const row = await c.env.DB.prepare(
    'SELECT r2_key, compressed_sha256 FROM artifacts WHERE run_id = ? AND kind = ? AND chunk_id = ?',
  )
    .bind(id, kind, chunkId)
    .first<{ r2_key: string; compressed_sha256: string }>();
  if (row === null) return fail(c, 404, 'not_found', 'artifact 不存在');
  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch !== undefined && ifNoneMatch.replaceAll('"', '') === row.compressed_sha256) {
    return new Response(null, { status: 304 });
  }
  const object = await c.env.ARTIFACTS.get(row.r2_key);
  if (object === null) return fail(c, 404, 'not_found', 'R2 内容缺失');
  return new Response(object.body, {
    headers: {
      'content-type': 'application/gzip',
      etag: `"${row.compressed_sha256}"`,
      'x-request-id': c.get('requestId'),
    },
  });
});

app.post('/api/runs/:id/complete', async (c) => {
  const id = c.req.param('id');
  if (!RUN_ID_PATTERN.test(id)) return fail(c, 400, 'bad_request', 'runId 非法');
  const auth = await requireWriteToken(c, id);
  if (!auth.ok) return auth.response;
  if (auth.row.status === 'failed' || auth.row.status === 'cancelled') {
    return fail(c, 409, 'state_conflict', `run 已为 ${auth.row.status}`);
  }
  const body = await readJson(c, 64 * 1024);
  if (body instanceof Response) return body;
  const parsed = validateCompleteBody(body);
  if (!parsed.ok) return fail(c, 422, 'validation_failed', 'complete body 非法', parsed.issues);
  const complete = parsed.value;
  const config = JSON.parse(auth.row.config_json) as RunConfig;
  const finalTick = complete['finalTick'] as number;
  const endReason = complete['endReason'] as 'scheduled' | 'extinct';
  const planned = plannedStatsTicks(
    config.schedule.totalTicks,
    config.schedule.statsStride,
    finalTick,
    endReason === 'extinct',
  );
  if (planned[planned.length - 1] !== finalTick) {
    return fail(c, 422, 'validation_failed', 'finalTick 与 stats 计划不一致');
  }
  const tickCount = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM tick_stats WHERE run_id = ?')
    .bind(id)
    .first<{ n: number }>();
  const agentCount = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM agent_final WHERE run_id = ?',
  )
    .bind(id)
    .first<{ n: number }>();
  if ((tickCount?.n ?? 0) !== complete['expectedTickRows']) {
    return fail(c, 409, 'state_conflict', 'tick 行数与 complete 声明不一致');
  }
  if ((agentCount?.n ?? 0) !== complete['expectedAgentRows']) {
    return fail(c, 409, 'state_conflict', 'agent 行数与 complete 声明不一致');
  }
  if (
    endReason === 'extinct' &&
    (finalTick >= config.schedule.totalTicks - 1 || complete['finalAliveCount'] !== 0)
  ) {
    return fail(c, 422, 'validation_failed', 'extinct 的 finalTick/finalAliveCount 非法');
  }
  const artifactKinds = await c.env.DB.prepare(
    'SELECT DISTINCT kind FROM artifacts WHERE run_id = ?',
  )
    .bind(id)
    .all<{ kind: string }>();
  const kinds = new Set((artifactKinds.results ?? []).map((row) => row.kind));
  if (!kinds.has('metrics')) {
    return fail(c, 409, 'state_conflict', '缺少 metrics artifact');
  }
  if (!kinds.has('final_state')) {
    return fail(c, 409, 'state_conflict', '缺少 final_state artifact');
  }
  if (auth.row.artifact_profile === 'full') {
    for (const required of ['decisions', 'events', 'snapshot']) {
      if (!kinds.has(required)) {
        return fail(c, 409, 'state_conflict', `full profile 缺少 ${required} artifact`);
      }
    }
  }
  if (auth.row.status === 'completed') {
    if (auth.row.summary_hash === complete['summaryHash']) {
      return c.json({ runId: id, status: 'completed', duplicate: true });
    }
    return fail(c, 409, 'state_conflict', 'run 已 complete 且摘要不同');
  }
  // artifactManifestHash 由服务器从已上传清单复算：只证明调用方看到的块集合
  // 与 D1 清单一致，不证明内容已解压/回放验证。
  const manifestRows = await c.env.DB.prepare(
    'SELECT kind, chunk_id, compressed_sha256, bytes FROM artifacts WHERE run_id = ?',
  )
    .bind(id)
    .all<{ kind: string; chunk_id: string; compressed_sha256: string; bytes: number }>();
  const manifestList = (manifestRows.results ?? [])
    .map((row) => ({
      key: `${row.kind}/${row.chunk_id}`,
      sha256: row.compressed_sha256,
      bytes: row.bytes,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const expectedManifestHash = `sha256:${await sha256Hex(JSON.stringify(manifestList))}`;
  if (complete['artifactManifestHash'] !== expectedManifestHash) {
    return fail(c, 409, 'state_conflict', 'artifactManifestHash 与已上传清单不一致');
  }
  await c.env.DB.prepare(
    `UPDATE runs SET status = 'completed', end_reason = ?, final_tick = ?, final_alive_count = ?,
       final_state_hash = ?, summary_hash = ?, complete_json = ?, verification_status = 'uploaded',
       updated_at = ? WHERE run_id = ? AND status = 'running'`,
  )
    .bind(
      endReason,
      finalTick,
      complete['finalAliveCount'],
      complete['finalStateHash'],
      complete['summaryHash'],
      JSON.stringify(complete),
      new Date().toISOString(),
      id,
    )
    .run();
  return c.json({ runId: id, status: 'completed' });
});

app.post('/api/runs/:id/cancel', async (c) => {
  return terminateRun(c, 'cancelled');
});

app.post('/api/runs/:id/fail', async (c) => {
  return terminateRun(c, 'failed');
});

async function terminateRun(
  c: Parameters<typeof fail>[0],
  status: 'cancelled' | 'failed',
): Promise<Response> {
  const id = c.req.param('id') ?? '';
  if (!RUN_ID_PATTERN.test(id)) return fail(c, 400, 'bad_request', 'runId 非法');
  const auth = await requireWriteToken(c, id);
  if (!auth.ok) return auth.response;
  if (auth.row.status === 'completed') {
    return fail(c, 409, 'state_conflict', 'completed run 不能取消/失败');
  }
  if (auth.row.status === status) {
    return c.json({ runId: id, status, duplicate: true });
  }
  if (auth.row.status !== 'running') {
    return fail(c, 409, 'state_conflict', `run 已为 ${auth.row.status}`);
  }
  const body = await readJson(c, 16 * 1024);
  if (body instanceof Response) return body;
  if (!isRecord(body) || typeof body['reason'] !== 'string' || body['reason'].length === 0) {
    return fail(c, 422, 'validation_failed', '缺少 reason');
  }
  const finalTick = body['finalTick'];
  if (finalTick !== null && (typeof finalTick !== 'number' || !Number.isInteger(finalTick))) {
    return fail(c, 422, 'validation_failed', 'finalTick 必须是整数或 null');
  }
  const diagnosticsHash = body['diagnosticsHash'] ?? null;
  if (
    diagnosticsHash !== null &&
    (typeof diagnosticsHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(diagnosticsHash))
  ) {
    return fail(c, 422, 'validation_failed', 'diagnosticsHash 必须为 sha256:hex 或 null');
  }
  await c.env.DB.prepare(
    `UPDATE runs SET status = ?, end_reason = NULL, final_tick = ?, error_code = ?,
       error_message = ?, diagnostics_hash = ?, updated_at = ?
       WHERE run_id = ? AND status = 'running'`,
  )
    .bind(status, finalTick, status, body['reason'], diagnosticsHash, new Date().toISOString(), id)
    .run();
  return c.json({ runId: id, status });
}

app.post('/api/runs/:id/verification', async (c) => {
  const id = c.req.param('id');
  if (!RUN_ID_PATTERN.test(id)) return fail(c, 400, 'bad_request', 'runId 非法');
  const auth = requireRunner(c);
  if (auth !== null) return auth;
  const body = await readJson(c, 16 * 1024);
  if (body instanceof Response) return body;
  if (!isRecord(body) || (body['status'] !== 'verified' && body['status'] !== 'rejected')) {
    return fail(c, 422, 'validation_failed', 'status 必须为 verified 或 rejected');
  }
  const row = await c.env.DB.prepare(
    'SELECT status, verification_status, verification_report_hash FROM runs WHERE run_id = ?',
  )
    .bind(id)
    .first<Pick<RunRow, 'status' | 'verification_status' | 'verification_report_hash'>>();
  if (row === null) return fail(c, 404, 'not_found', 'run 不存在');
  if (row.status !== 'completed') {
    return fail(c, 409, 'state_conflict', '只有 completed run 可以验证');
  }
  if (
    row.verification_status === body['status'] &&
    row.verification_report_hash === body['reportHash']
  ) {
    return c.json({ runId: id, verificationStatus: body['status'], duplicate: true });
  }
  if (row.verification_status === 'verified' && body['status'] !== 'verified') {
    return fail(c, 409, 'state_conflict', 'verified 不能改为其他状态');
  }
  if (typeof body['reportHash'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(body['reportHash'])) {
    return fail(c, 422, 'validation_failed', 'reportHash 必须为 sha256:hex');
  }
  await c.env.DB.prepare(
    'UPDATE runs SET verification_status = ?, verification_report_hash = ?, updated_at = ? WHERE run_id = ?',
  )
    .bind(body['status'], body['reportHash'], new Date().toISOString(), id)
    .run();
  return c.json({ runId: id, verificationStatus: body['status'] });
});

app.get('/api/runs/:id/stats', async (c) => {
  const id = c.req.param('id');
  if (!RUN_ID_PATTERN.test(id)) return fail(c, 400, 'bad_request', 'runId 非法');
  const from = Number(c.req.query('from') ?? '0');
  const to = Number(c.req.query('to') ?? String(Number.MAX_SAFE_INTEGER));
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    return fail(c, 400, 'bad_request', 'from/to 非法');
  }
  const rows = await c.env.DB.prepare(
    `SELECT * FROM tick_stats WHERE run_id = ? AND tick >= ? AND tick <= ?
     ORDER BY tick ASC LIMIT 2001`,
  )
    .bind(id, from, Math.min(to, from + 2000))
    .all<Record<string, unknown>>();
  return c.json({
    runId: id,
    from,
    to,
    truncated: (rows.results ?? []).length > 2000,
    ticks: (rows.results ?? []).slice(0, 2000).map((row) => ({
      tick: row['tick'],
      aliveCount: row['alive_count'],
      classCounts: JSON.parse(String(row['class_counts_json'])),
      gini: row['gini'],
      medianValue: row['median_value'],
      top10Share: row['top10_share'],
      mUp: row['m_up'],
      mDown: row['m_down'],
      segregation: row['segregation'],
      edgeCount: row['edge_count'],
      openness: row['openness'],
      deathCount: row['death_count'],
      competitionLoss: row['competition_loss'],
      competitionGain: row['competition_gain'],
      fallbackRate: row['fallback_rate'],
      payloadHash: row['payload_hash'],
    })),
  });
});

app.get('/api/runs/:id/export.ndjson', async (c) => {
  const id = c.req.param('id');
  if (!RUN_ID_PATTERN.test(id)) return fail(c, 400, 'bad_request', 'runId 非法');
  const row = await c.env.DB.prepare('SELECT * FROM runs WHERE run_id = ?')
    .bind(id)
    .first<RunRow>();
  if (row === null) return fail(c, 404, 'not_found', 'run 不存在');
  const artifacts = await c.env.DB.prepare(
    'SELECT kind, chunk_id, bytes, compressed_sha256, start_tick, end_tick FROM artifacts WHERE run_id = ? ORDER BY kind, chunk_id',
  )
    .bind(id)
    .all<Record<string, unknown>>();
  const lines = [
    JSON.stringify({ type: 'manifest', run: publicRun(row), artifacts: artifacts.results ?? [] }),
  ];
  const ticks = await c.env.DB.prepare(
    'SELECT * FROM tick_stats WHERE run_id = ? ORDER BY tick ASC LIMIT 100000',
  )
    .bind(id)
    .all<Record<string, unknown>>();
  for (const tick of ticks.results ?? []) {
    lines.push(JSON.stringify({ type: 'tick_stats', ...tick }));
  }
  return new Response(`${lines.join('\n')}\n`, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'x-request-id': c.get('requestId'),
    },
  });
});

app.notFound((c) => fail(c, 404, 'not_found', '路由不存在'));
app.onError((error, c) => {
  return fail(c, 500, 'internal_error', error instanceof Error ? error.message : '内部错误');
});

function parseOptionalInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

const worker = {
  fetch: (request: Request, env: Env, ctx: Parameters<typeof app.fetch>[2]) =>
    app.fetch(request, env, ctx),
  /** P4-06：Cron 保留策略；失败由平台重试，下一轮幂等继续清理。 */
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> => {
    ctx.waitUntil(runMaintenance(env));
  },
};

export default worker;
export { app };
export { runMaintenance } from './maintenance.js';

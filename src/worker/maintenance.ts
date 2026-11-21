import type { Env } from './types.js';

/**
 * P4-06 保留策略与静默巡检（05 §8 / 09 §3）：
 * 1. 将超过静默窗口无写入的 `running` run 标记为 `failed (error_code=abandoned_timeout)`；
 * 2. 按 source 删除过期 run 及其 R2 artifact（先删 R2 对象，再删 D1 run 触发外键级联）；
 * 3. 分页扫描 R2 `runs/` 前缀，清理超过宽限期且不在 D1 `artifacts` 清单中的孤儿对象；
 * 4. 清理 2 天前的固定窗口限流计数行。
 */

export interface MaintenanceResult {
  readonly abandonedRunsMarked: number;
  readonly browserRunsDeleted: number;
  readonly runnerRunsDeleted: number;
  readonly artifactsDeleted: number;
  readonly orphanObjectsDeleted: number;
  readonly rateLimitRowsDeleted: number;
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_BROWSER_DAYS = 7;
const DEFAULT_RUNNER_DAYS = 90;
const DEFAULT_BROWSER_IDLE_MINUTES = 60;
const DEFAULT_RUNNER_IDLE_MINUTES = 720;
const DEFAULT_ORPHAN_GRACE_MINUTES = 120;
const MAX_RUNS_PER_SOURCE = 1000;
const MAX_ORPHAN_SCAN = 1000;

function parsePositiveInt(value: string | undefined, fallback: number, allowZero = false): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  const min = allowZero ? 0 : 1;
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

export function retentionCutoffs(
  env: Pick<Env, 'BROWSER_RUN_RETENTION_DAYS' | 'RUNNER_RUN_RETENTION_DAYS'>,
  now: number,
): { browser: string; runner: string } {
  const browserDays = parsePositiveInt(env.BROWSER_RUN_RETENTION_DAYS, DEFAULT_BROWSER_DAYS, true);
  const runnerDays = parsePositiveInt(env.RUNNER_RUN_RETENTION_DAYS, DEFAULT_RUNNER_DAYS, true);
  return {
    browser: new Date(now - browserDays * DAY_MS).toISOString(),
    runner: new Date(now - runnerDays * DAY_MS).toISOString(),
  };
}

export function idleTimeoutCutoffs(
  env: Pick<Env, 'BROWSER_IDLE_TIMEOUT_MINUTES' | 'RUNNER_IDLE_TIMEOUT_MINUTES'>,
  now: number,
): { browser: string; runner: string } {
  const browserMins = parsePositiveInt(
    env.BROWSER_IDLE_TIMEOUT_MINUTES,
    DEFAULT_BROWSER_IDLE_MINUTES,
  );
  const runnerMins = parsePositiveInt(env.RUNNER_IDLE_TIMEOUT_MINUTES, DEFAULT_RUNNER_IDLE_MINUTES);
  return {
    browser: new Date(now - browserMins * MINUTE_MS).toISOString(),
    runner: new Date(now - runnerMins * MINUTE_MS).toISOString(),
  };
}

async function deleteRun(env: Env, runId: string): Promise<number> {
  const artifacts = await env.DB.prepare('SELECT r2_key FROM artifacts WHERE run_id = ?')
    .bind(runId)
    .all<{ r2_key: string }>();
  let deleted = 0;
  for (const artifact of artifacts.results ?? []) {
    await env.ARTIFACTS.delete(artifact.r2_key);
    deleted += 1;
  }
  await env.DB.prepare('DELETE FROM runs WHERE run_id = ?').bind(runId).run();
  return deleted;
}

async function markAbandonedRuns(env: Env, now: number): Promise<number> {
  const idleCutoffs = idleTimeoutCutoffs(env, now);
  const nowIso = new Date(now).toISOString();
  let marked = 0;
  for (const source of ['browser', 'runner'] as const) {
    const cutoff = source === 'browser' ? idleCutoffs.browser : idleCutoffs.runner;
    const staleRows = await env.DB.prepare(
      `SELECT run_id FROM runs
       WHERE status = 'running' AND source = ? AND updated_at < ?
       ORDER BY updated_at ASC LIMIT ?`,
    )
      .bind(source, cutoff, MAX_RUNS_PER_SOURCE)
      .all<{ run_id: string }>();
    for (const row of staleRows.results ?? []) {
      const res = await env.DB.prepare(
        `UPDATE runs
         SET status = 'failed', error_code = 'abandoned_timeout',
             error_message = '超过静默窗口无写入，维护任务标记超时终止',
             updated_at = ?
         WHERE run_id = ? AND status = 'running'`,
      )
        .bind(nowIso, row.run_id)
        .run();
      marked += res.meta?.changes ?? 0;
    }
  }
  return marked;
}

async function cleanOrphanR2Objects(env: Env, now: number): Promise<number> {
  if (typeof env.ARTIFACTS.list !== 'function') return 0;
  const graceMins = parsePositiveInt(env.ORPHAN_GRACE_MINUTES, DEFAULT_ORPHAN_GRACE_MINUTES, true);
  const cutoffMs = now - graceMins * MINUTE_MS;
  let deleted = 0;
  let scanned = 0;
  let cursor: string | undefined;

  while (scanned < MAX_ORPHAN_SCAN) {
    const batchLimit = Math.min(250, MAX_ORPHAN_SCAN - scanned);
    const listed = await env.ARTIFACTS.list({
      prefix: 'runs/',
      limit: batchLimit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const obj of listed.objects) {
      scanned += 1;
      if (obj.uploaded.getTime() > cutoffMs) continue;
      const inDb = await env.DB.prepare('SELECT 1 AS ok FROM artifacts WHERE r2_key = ?')
        .bind(obj.key)
        .first<{ ok: number }>();
      if (inDb === null) {
        await env.ARTIFACTS.delete(obj.key);
        deleted += 1;
      }
    }
    if (!listed.truncated || listed.cursor === undefined) break;
    cursor = listed.cursor;
  }
  return deleted;
}

export async function runMaintenance(env: Env, now = Date.now()): Promise<MaintenanceResult> {
  const abandonedRunsMarked = await markAbandonedRuns(env, now);

  const cutoffs = retentionCutoffs(env, now);
  let browserRunsDeleted = 0;
  let runnerRunsDeleted = 0;
  let artifactsDeleted = 0;

  for (const source of ['browser', 'runner'] as const) {
    const cutoff = source === 'browser' ? cutoffs.browser : cutoffs.runner;
    const rows = await env.DB.prepare(
      'SELECT run_id FROM runs WHERE source = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?',
    )
      .bind(source, cutoff, MAX_RUNS_PER_SOURCE)
      .all<{ run_id: string }>();
    for (const row of rows.results ?? []) {
      artifactsDeleted += await deleteRun(env, row.run_id);
      if (source === 'browser') browserRunsDeleted += 1;
      else runnerRunsDeleted += 1;
    }
  }

  const orphanObjectsDeleted = await cleanOrphanR2Objects(env, now);

  // 固定窗口只保留最近 2 天；更早的计数不再有任何用途。
  const rateWindowCutoff = Math.floor((now - 2 * DAY_MS) / 1000);
  const rateResult = await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(rateWindowCutoff)
    .run();
  const rateLimitRowsDeleted = rateResult.meta?.changes ?? 0;

  return {
    abandonedRunsMarked,
    browserRunsDeleted,
    runnerRunsDeleted,
    artifactsDeleted,
    orphanObjectsDeleted,
    rateLimitRowsDeleted,
  };
}

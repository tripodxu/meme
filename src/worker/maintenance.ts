import type { Env } from './types.js';

/**
 * P4-06 保留策略（09 §7）：按 source 删除过期 run 及其 R2 artifact，并清理
 * 固定窗口限流的历史行。由 Cron 触发，也可通过管理脚本/测试直接调用。
 *
 * D1 是 run/artifact 的清单，R2 是内容权威：先删 R2 对象，再删 D1 run
 * （tick/agent/artifact 行由外键级联）。单个 run 的 R2 删除失败时保留 D1
 * 行，下一轮重试，避免出现“清单元数据已删、对象仍收费”的不可追踪状态。
 */

export interface MaintenanceResult {
  readonly browserRunsDeleted: number;
  readonly runnerRunsDeleted: number;
  readonly artifactsDeleted: number;
  readonly rateLimitRowsDeleted: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BROWSER_DAYS = 7;
const DEFAULT_RUNNER_DAYS = 90;
const MAX_RUNS_PER_SOURCE = 1000;

function retentionDays(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function retentionCutoffs(
  env: Pick<Env, 'BROWSER_RUN_RETENTION_DAYS' | 'RUNNER_RUN_RETENTION_DAYS'>,
  now: number,
): { browser: string; runner: string } {
  const browserDays = retentionDays(env.BROWSER_RUN_RETENTION_DAYS, DEFAULT_BROWSER_DAYS);
  const runnerDays = retentionDays(env.RUNNER_RUN_RETENTION_DAYS, DEFAULT_RUNNER_DAYS);
  return {
    browser: new Date(now - browserDays * DAY_MS).toISOString(),
    runner: new Date(now - runnerDays * DAY_MS).toISOString(),
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

export async function runMaintenance(env: Env, now = Date.now()): Promise<MaintenanceResult> {
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

  // 固定窗口只保留最近 2 天；更早的计数不再有任何用途。
  const rateWindowCutoff = Math.floor((now - 2 * DAY_MS) / 1000);
  const rateResult = await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(rateWindowCutoff)
    .run();
  const rateLimitRowsDeleted = rateResult.meta?.changes ?? 0;

  return {
    browserRunsDeleted,
    runnerRunsDeleted,
    artifactsDeleted,
    rateLimitRowsDeleted,
  };
}

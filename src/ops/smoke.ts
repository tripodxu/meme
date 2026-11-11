import { createDemoConfig } from '../core/config/defaults.js';
import { computeConfigHash, computeParamsHash } from '../core/config/hash.js';
import { asSeed } from '../core/control/ids.js';
import {
  DECISION_SCHEMA_VERSION,
  ENGINE_VERSION,
  RULES_VERSION,
} from '../core/control/versions.js';
import { computeInitialPopulationHash } from '../core/hash/state-hash.js';
import { deriveInitialPopulation } from '../core/init/population.js';

/**
 * 部署冒烟（P7）：健康 → 静态首页 → 创建 run → 读取 → 取消。
 *
 * 只触碰一个 20 tick 的临时 run，不上传 artifact、不调用 Jev；用于每次
 * preview/production 发布后的最小连通性验证。`runtimeVersion` 必须由调用方
 * 显式提供（部署目标的运行时），不能悄悄使用执行脚本机器的版本。
 */

export interface SmokeCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SmokeResult {
  readonly ok: boolean;
  readonly baseUrl: string;
  readonly runId: string | null;
  readonly checks: readonly SmokeCheck[];
}

export interface SmokeOptions {
  readonly baseUrl: string;
  readonly runtimeVersion: string;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly seed?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

export function buildSmokeRunBody(
  runtimeVersion: string,
  seed = 'deploy-smoke-1',
): Record<string, unknown> {
  const config = createDemoConfig({ schedule: { totalTicks: 20 } });
  const population = deriveInitialPopulation(config, asSeed(seed));
  return {
    schemaVersion: 'run-v1',
    config,
    identity: {
      rulesVersion: RULES_VERSION,
      engineVersion: ENGINE_VERSION,
      decisionSchemaVersion: DECISION_SCHEMA_VERSION,
      policyVersion: config.decision.policy,
      promptVersion: null,
      requestedModel: null,
      seed,
      runtimeVersion,
      configHash: computeConfigHash(config),
      paramsHash: computeParamsHash(config),
      initialPopulationHash: computeInitialPopulationHash(asSeed(seed), population),
      codeSha: 'deploy-smoke',
    },
    schedule: {
      totalTicks: config.schedule.totalTicks,
      statsStride: config.schedule.statsStride,
      snapshotStride: config.schedule.snapshotStride,
    },
    experiment: null,
    artifactProfile: 'metrics-only',
  };
}

export async function runRemoteSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const checks: SmokeCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  let runId: string | null = null;
  try {
    const health = await fetchImpl(`${baseUrl}/api/health`);
    const healthBody = await readJson(health);
    const healthOk =
      health.status === 200 &&
      isRecord(healthBody) &&
      healthBody['status'] === 'ok' &&
      healthBody['db'] === 'ok';
    add('health', healthOk, `HTTP ${health.status} ${JSON.stringify(healthBody)}`);

    const index = await fetchImpl(`${baseUrl}/`);
    add('static-index', index.status === 200, `HTTP ${index.status}`);

    const seed = options.seed ?? 'deploy-smoke-1';
    const body = buildSmokeRunBody(options.runtimeVersion, seed);
    const created = await fetchImpl(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const createdBody = await readJson(created);
    const createdOk =
      created.status === 201 &&
      isRecord(createdBody) &&
      typeof createdBody['runId'] === 'string' &&
      typeof createdBody['writeToken'] === 'string';
    add('create-run', createdOk, `HTTP ${created.status}`);
    if (createdOk) {
      runId = createdBody['runId'] as string;
      const token = createdBody['writeToken'] as string;

      const detail = await fetchImpl(`${baseUrl}/api/runs/${runId}`);
      const detailBody = await readJson(detail);
      const detailOk =
        detail.status === 200 && isRecord(detailBody) && detailBody['status'] === 'running';
      add('read-run', detailOk, `HTTP ${detail.status}`);

      const cancelled = await fetchImpl(`${baseUrl}/api/runs/${runId}/cancel`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'deploy-smoke', finalTick: null }),
      });
      const cancelBody = await readJson(cancelled);
      const cancelOk =
        cancelled.status === 200 && isRecord(cancelBody) && cancelBody['status'] === 'cancelled';
      add('cancel-run', cancelOk, `HTTP ${cancelled.status}`);
    }
  } catch (error) {
    add('exception', false, error instanceof Error ? error.message : String(error));
  }
  return { ok: checks.every((check) => check.ok), baseUrl, runId, checks };
}

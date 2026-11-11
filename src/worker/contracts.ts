import { computeConfigHash, computeParamsHash } from '../core/config/hash.js';
import type { RunConfig } from '../core/config/types.js';
import { validateRunConfig } from '../core/config/validate.js';
import { asSeed } from '../core/control/ids.js';
import { HASH_DOMAINS } from '../core/hash/domains.js';
import { hashValue } from '../core/hash/hash.js';
import { computeInitialPopulationHash } from '../core/hash/state-hash.js';
import { deriveInitialPopulation } from '../core/init/population.js';
import type { Issue } from './http.js';
import { isRecord } from './http.js';

export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const CHUNK_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export const ARTIFACT_KINDS = [
  'decisions',
  'events',
  'snapshot',
  'final_state',
  'metrics',
  'manifest',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface RunIdentity {
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

export interface RunCreateInput {
  readonly config: RunConfig;
  readonly identity: RunIdentity;
  readonly experiment: { experimentId: string; cellKey: string; seed: string } | null;
  readonly artifactProfile: 'full' | 'metrics-only';
}

export interface ValidationOutcome<T> {
  readonly ok: true;
  readonly value: T;
}

export type ValidationFailure = { readonly ok: false; readonly issues: readonly Issue[] };

export function validateRunCreate(
  body: unknown,
  source: 'browser' | 'runner',
): ValidationOutcome<RunCreateInput> | ValidationFailure {
  const issues: Issue[] = [];
  if (!isRecord(body)) return { ok: false, issues: [{ path: '$', reason: '必须是对象' }] };
  if (body['schemaVersion'] !== 'run-v1') {
    issues.push({ path: '$.schemaVersion', reason: '必须为 run-v1' });
  }
  if (body['source'] !== undefined && body['source'] !== source) {
    issues.push({ path: '$.source', reason: `服务端认证来源为 ${source}，不得自报其他来源` });
  }
  const configResult = validateRunConfig(body['config']);
  if (!configResult.ok) {
    for (const issue of configResult.issues) {
      issues.push({ path: `$.config${issue.path.slice(1)}`, reason: issue.message });
    }
  }
  const identity = body['identity'];
  if (!isRecord(identity)) {
    issues.push({ path: '$.identity', reason: '必须是对象' });
  }
  const schedule = body['schedule'];
  if (!isRecord(schedule)) {
    issues.push({ path: '$.schedule', reason: '必须是对象' });
  }
  if (issues.length > 0 || !configResult.ok || !isRecord(identity) || !isRecord(schedule)) {
    return { ok: false, issues };
  }
  const config = configResult.config;
  const seed = identity['seed'];
  if (typeof seed !== 'string' || seed.length === 0 || seed.length > 256) {
    issues.push({ path: '$.identity.seed', reason: '必须是非空字符串（<=256）' });
  }
  for (const key of [
    'rulesVersion',
    'engineVersion',
    'decisionSchemaVersion',
    'policyVersion',
    'runtimeVersion',
    'configHash',
    'paramsHash',
    'initialPopulationHash',
    'codeSha',
  ]) {
    if (typeof identity[key] !== 'string' || (identity[key] as string).length === 0) {
      issues.push({ path: `$.identity.${key}`, reason: '必须是非空字符串' });
    }
  }
  for (const key of ['promptVersion', 'requestedModel']) {
    if (identity[key] !== null && typeof identity[key] !== 'string') {
      issues.push({ path: `$.identity.${key}`, reason: '必须是字符串或 null' });
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const expectedConfigHash = computeConfigHash(config);
  if (identity['configHash'] !== expectedConfigHash) {
    issues.push({ path: '$.identity.configHash', reason: '与 config 重算结果不一致' });
  }
  const expectedParamsHash = computeParamsHash(config);
  if (identity['paramsHash'] !== expectedParamsHash) {
    issues.push({ path: '$.identity.paramsHash', reason: '与 config 重算结果不一致' });
  }
  if (identity['rulesVersion'] !== config.rulesVersion) {
    issues.push({ path: '$.identity.rulesVersion', reason: '必须等于 config.rulesVersion' });
  }
  if (identity['policyVersion'] !== config.decision.policy) {
    issues.push({ path: '$.identity.policyVersion', reason: '必须等于 config.decision.policy' });
  }
  for (const key of ['totalTicks', 'statsStride', 'snapshotStride'] as const) {
    if (schedule[key] !== config.schedule[key]) {
      issues.push({ path: `$.schedule.${key}`, reason: '必须与 config.schedule 完全一致' });
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  try {
    const population = deriveInitialPopulation(config, asSeed(seed as string));
    const initialHash = computeInitialPopulationHash(asSeed(seed as string), population);
    if (identity['initialPopulationHash'] !== initialHash) {
      issues.push({
        path: '$.identity.initialPopulationHash',
        reason: '(config, seed) 重算结果不一致，禁止自报 roster',
      });
    }
  } catch (error) {
    issues.push({
      path: '$.identity.seed',
      reason: `初始人口派生失败: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const experiment = body['experiment'];
  let parsedExperiment: RunCreateInput['experiment'] = null;
  if (experiment !== undefined && experiment !== null) {
    if (!isRecord(experiment)) {
      issues.push({ path: '$.experiment', reason: '必须是对象或 null' });
    } else {
      const experimentId = experiment['experimentId'];
      const cellKey = experiment['cellKey'];
      const experimentSeed = experiment['seed'];
      if (typeof experimentId !== 'string' || !RUN_ID_PATTERN.test(experimentId)) {
        issues.push({ path: '$.experiment.experimentId', reason: 'ID 字符集/长度非法' });
      }
      if (typeof cellKey !== 'string' || cellKey.length === 0 || cellKey.length > 128) {
        issues.push({ path: '$.experiment.cellKey', reason: '必须是非空字符串（<=128）' });
      }
      if (typeof experimentSeed !== 'string' || experimentSeed !== seed) {
        issues.push({ path: '$.experiment.seed', reason: '必须与 identity.seed 一致' });
      }
      if (source === 'browser' && experiment !== null) {
        issues.push({ path: '$.experiment', reason: 'browser run 不得绑定 experiment' });
      }
      if (issues.length === 0) {
        parsedExperiment = {
          experimentId: experimentId as string,
          cellKey: cellKey as string,
          seed: experimentSeed as string,
        };
      }
    }
  }
  const artifactProfile = body['artifactProfile'] ?? 'full';
  if (artifactProfile !== 'full' && artifactProfile !== 'metrics-only') {
    issues.push({ path: '$.artifactProfile', reason: '必须为 full 或 metrics-only' });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      config,
      identity: identity as unknown as RunIdentity,
      experiment: parsedExperiment,
      artifactProfile: artifactProfile as 'full' | 'metrics-only',
    },
  };
}

export interface ExperimentCreateInput {
  readonly manifest: Record<string, unknown>;
  readonly preregistrationHash: string;
  readonly labelThresholdsHash: string;
  readonly baseConfigHash: string;
}

export function validateExperimentCreate(
  body: unknown,
  runnerId: string,
): ValidationOutcome<ExperimentCreateInput> | ValidationFailure {
  if (!isRecord(body)) return { ok: false, issues: [{ path: '$', reason: '必须是对象' }] };
  const issues: Issue[] = [];
  if (body['schemaVersion'] !== undefined && typeof body['schemaVersion'] !== 'string') {
    issues.push({ path: '$.schemaVersion', reason: '必须是字符串' });
  }
  for (const key of [
    'hypothesis',
    'preregistrationHash',
    'labelThresholdsHash',
    'baseConfigHash',
  ]) {
    if (typeof body[key] !== 'string' || (body[key] as string).length === 0) {
      issues.push({ path: `$.${key}`, reason: '必须是非空字符串' });
    }
  }
  for (const key of ['cells', 'seeds', 'windows']) {
    if (!Array.isArray(body[key])) issues.push({ path: `$.${key}`, reason: '必须是数组' });
  }
  if (issues.length > 0) return { ok: false, issues };
  const manifest: Record<string, unknown> = { ...body };
  manifest['createdBy'] = runnerId;
  delete manifest['experimentId'];
  delete manifest['createdAt'];
  delete manifest['preregistrationHash'];
  const recomputed = hashValue(HASH_DOMAINS.preregistration, manifest);
  if (recomputed !== body['preregistrationHash']) {
    issues.push({
      path: '$.preregistrationHash',
      reason: '与 manifest 重算结果不一致（排除 experimentId/createdAt）',
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      manifest,
      preregistrationHash: body['preregistrationHash'] as string,
      labelThresholdsHash: body['labelThresholdsHash'] as string,
      baseConfigHash: body['baseConfigHash'] as string,
    },
  };
}

export function plannedStatsTicks(
  totalTicks: number,
  statsStride: number,
  finalTick: number | null = null,
  extinct = false,
): number[] {
  const last = extinct && finalTick !== null ? finalTick : totalTicks - 1;
  const ticks = new Set<number>();
  for (let tick = 0; tick < totalTicks; tick += statsStride) {
    if (tick <= last) ticks.add(tick);
  }
  ticks.add(last);
  if (!extinct) ticks.add(totalTicks - 1);
  return [...ticks].sort((a, b) => a - b);
}

const RATIO_KEYS = ['gini', 'top10Share', 'mUp', 'mDown', 'openness'] as const;

export function validateTickBatch(
  body: unknown,
  config: RunConfig,
  finalTick: number | null,
  extinct: boolean,
): ValidationOutcome<Record<string, unknown>[]> | ValidationFailure {
  if (!isRecord(body) || !Array.isArray(body['ticks'])) {
    return { ok: false, issues: [{ path: '$.ticks', reason: '必须是数组' }] };
  }
  const ticks = body['ticks'];
  if (ticks.length < 1 || ticks.length > 100) {
    return { ok: false, issues: [{ path: '$.ticks', reason: '每批 1–100 条' }] };
  }
  const allowed = new Set(
    plannedStatsTicks(config.schedule.totalTicks, config.schedule.statsStride, finalTick, extinct),
  );
  const seen = new Set<number>();
  const issues: Issue[] = [];
  ticks.forEach((row, index) => {
    const path = `$.ticks[${index}]`;
    if (!isRecord(row)) {
      issues.push({ path, reason: '必须是对象' });
      return;
    }
    const tick = row['tick'];
    if (typeof tick !== 'number' || !Number.isInteger(tick) || !allowed.has(tick)) {
      issues.push({ path: `${path}.tick`, reason: '必须属于计划 stats 序列' });
    } else if (seen.has(tick)) {
      issues.push({ path: `${path}.tick`, reason: '同批内不得重复' });
    } else {
      seen.add(tick);
    }
    for (const key of ['aliveCount', 'edgeCount', 'deathCount'] as const) {
      if (typeof row[key] !== 'number' || !Number.isInteger(row[key]) || (row[key] as number) < 0) {
        issues.push({ path: `${path}.${key}`, reason: '必须是非负整数' });
      }
    }
    if (
      !Array.isArray(row['classCounts']) ||
      row['classCounts'].length !== config.population.classCount
    ) {
      issues.push({
        path: `${path}.classCounts`,
        reason: `必须为长度 ${config.population.classCount} 的数组`,
      });
    }
    for (const key of RATIO_KEYS) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key])) {
        issues.push({ path: `${path}.${key}`, reason: '必须是有限数' });
      }
    }
    if (typeof row['segregation'] !== 'number' || !Number.isFinite(row['segregation'])) {
      issues.push({ path: `${path}.segregation`, reason: '必须是有限数' });
    }
    for (const key of ['medianValue', 'competitionLoss', 'competitionGain'] as const) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key])) {
        issues.push({ path: `${path}.${key}`, reason: '必须是有限数' });
      }
    }
    if (
      row['fallbackRate'] !== null &&
      (typeof row['fallbackRate'] !== 'number' || !Number.isFinite(row['fallbackRate']))
    ) {
      issues.push({ path: `${path}.fallbackRate`, reason: '必须是有限数或 null' });
    }
    if (
      typeof row['payloadHash'] !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(row['payloadHash'])
    ) {
      issues.push({ path: `${path}.payloadHash`, reason: '必须为 sha256:hex' });
    }
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: ticks as Record<string, unknown>[] };
}

export function validateAgentBatch(
  body: unknown,
): ValidationOutcome<Record<string, unknown>[]> | ValidationFailure {
  if (!isRecord(body) || !Array.isArray(body['agents'])) {
    return { ok: false, issues: [{ path: '$.agents', reason: '必须是数组' }] };
  }
  const agents = body['agents'];
  if (agents.length < 1 || agents.length > 500) {
    return { ok: false, issues: [{ path: '$.agents', reason: '每批 1–500 条' }] };
  }
  const issues: Issue[] = [];
  const seen = new Set<string>();
  agents.forEach((row, index) => {
    const path = `$.agents[${index}]`;
    if (!isRecord(row)) {
      issues.push({ path, reason: '必须是对象' });
      return;
    }
    const id = row['agentId'];
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
      issues.push({ path: `${path}.agentId`, reason: '必须是长度 1–64 的字符串' });
    } else if (seen.has(id)) {
      issues.push({ path: `${path}.agentId`, reason: '同批内不得重复' });
    } else {
      seen.add(id);
    }
    for (const key of ['classIndex', 'maxClassIndex'] as const) {
      if (typeof row[key] !== 'number' || !Number.isInteger(row[key]) || (row[key] as number) < 0) {
        issues.push({ path: `${path}.${key}`, reason: '必须是非负整数' });
      }
    }
    for (const key of ['value', 'ge', 'hard', 'initialLife', 'remainingLife'] as const) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key])) {
        issues.push({ path: `${path}.${key}`, reason: '必须是有限数' });
      }
    }
    if (typeof row['alive'] !== 'boolean') {
      issues.push({ path: `${path}.alive`, reason: '必须是布尔值' });
    }
    if (
      row['deathTick'] !== null &&
      (typeof row['deathTick'] !== 'number' || !Number.isInteger(row['deathTick']))
    ) {
      issues.push({ path: `${path}.deathTick`, reason: '必须是整数或 null' });
    }
    if (
      typeof row['payloadHash'] !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(row['payloadHash'])
    ) {
      issues.push({ path: `${path}.payloadHash`, reason: '必须为 sha256:hex' });
    }
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: agents as Record<string, unknown>[] };
}

export function validateCompleteBody(
  body: unknown,
): ValidationOutcome<Record<string, unknown>> | ValidationFailure {
  if (!isRecord(body)) return { ok: false, issues: [{ path: '$', reason: '必须是对象' }] };
  const issues: Issue[] = [];
  for (const key of [
    'finalTick',
    'finalAliveCount',
    'expectedTickRows',
    'expectedAgentRows',
    'expectedDueDecisions',
  ] as const) {
    if (
      typeof body[key] !== 'number' ||
      !Number.isInteger(body[key]) ||
      (body[key] as number) < 0
    ) {
      issues.push({ path: `$.${key}`, reason: '必须是非负整数' });
    }
  }
  if (body['endReason'] !== 'scheduled' && body['endReason'] !== 'extinct') {
    issues.push({ path: '$.endReason', reason: '必须为 scheduled 或 extinct' });
  }
  for (const key of ['finalStateHash', 'summaryHash', 'artifactManifestHash'] as const) {
    if (typeof body[key] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(body[key])) {
      issues.push({ path: `$.${key}`, reason: '必须为 sha256:hex' });
    }
  }
  return issues.length === 0 ? { ok: true, value: body } : { ok: false, issues };
}

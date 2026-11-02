import { StratifyError, errorCodes } from './errors.js';

declare const brandSymbol: unique symbol;

/** 名义类型：防止把任意字符串当作 ID 或 seed 传递。 */
export type Brand<T, B extends string> = T & { readonly [brandSymbol]: B };

export type RunId = Brand<string, 'RunId'>;
export type LocalRunId = Brand<string, 'LocalRunId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type ChunkId = Brand<string, 'ChunkId'>;
export type Seed = Brand<string, 'Seed'>;
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;

export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const LOCAL_RUN_ID_PREFIX = 'local-';
export const LOCAL_RUN_ID_PATTERN = /^local-[0-9A-HJKMNP-TV-Z]{26}$/;
export const CHUNK_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export const AGENT_ID_PATTERN = /^a-\d{4,}$/;

function assertString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new StratifyError(errorCodes.ID_INVALID, `${name} 必须是字符串`);
  }
}

export function asRunId(value: unknown): RunId {
  assertString('runId', value);
  if (!RUN_ID_PATTERN.test(value)) {
    throw new StratifyError(errorCodes.ID_INVALID, 'runId 必须匹配 [A-Za-z0-9_-]{1,64}');
  }
  return value as RunId;
}

export function asLocalRunId(value: unknown): LocalRunId {
  assertString('localRunId', value);
  if (!LOCAL_RUN_ID_PATTERN.test(value)) {
    throw new StratifyError(errorCodes.ID_INVALID, 'localRunId 必须匹配 local-<ULID>');
  }
  return value as LocalRunId;
}

export function asAgentId(value: unknown): AgentId {
  assertString('agentId', value);
  if (!AGENT_ID_PATTERN.test(value)) {
    throw new StratifyError(errorCodes.ID_INVALID, 'agentId 必须匹配 a-<至少 4 位数字>');
  }
  return value as AgentId;
}

export function asChunkId(value: unknown): ChunkId {
  assertString('chunkId', value);
  if (!CHUNK_ID_PATTERN.test(value)) {
    throw new StratifyError(errorCodes.ID_INVALID, 'chunkId 必须匹配 [A-Za-z0-9._-]{1,128}');
  }
  return value as ChunkId;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function asSeed(value: unknown): Seed {
  assertString('seed', value);
  if (value.length === 0) {
    throw new StratifyError(errorCodes.ID_INVALID, 'seed 不得为空');
  }
  if (value.length > 256) {
    throw new StratifyError(errorCodes.ID_INVALID, 'seed 长度不得超过 256');
  }
  if (value.includes('\0') || LONE_SURROGATE.test(value)) {
    throw new StratifyError(errorCodes.ID_INVALID, 'seed 不得包含 NUL 或未配对的代理项');
  }
  return value as Seed;
}

export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

export function isLocalRunId(value: string): boolean {
  return LOCAL_RUN_ID_PATTERN.test(value);
}

export function isAgentId(value: string): boolean {
  return AGENT_ID_PATTERN.test(value);
}

export function isChunkId(value: string): boolean {
  return CHUNK_ID_PATTERN.test(value);
}

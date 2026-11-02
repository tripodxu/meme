import type { RunConfig } from '../config/types.js';
import { computeConfigHash, computeParamsHash } from '../config/hash.js';
import type { Seed } from './ids.js';
import {
  DECISION_SCHEMA_VERSION,
  ENGINE_VERSION,
  RUN_IDENTITY_SCHEMA_VERSION,
  type EngineVersion,
  type RulesVersion,
} from './versions.js';

/**
 * run 创建时固定的身份块（02 §10）。
 * `runtimeVersion` 记录实际执行端与版本（如 `node@22.21.0`），决定哈希权威性；
 * `seed` 不进入任何 config/params hash。
 */
export interface RunIdentity {
  readonly schemaVersion: typeof RUN_IDENTITY_SCHEMA_VERSION;
  readonly rulesVersion: RulesVersion;
  readonly engineVersion: EngineVersion;
  readonly decisionSchemaVersion: typeof DECISION_SCHEMA_VERSION;
  readonly policyVersion: string;
  readonly promptVersion: string | null;
  readonly requestedModel: string;
  readonly seed: Seed;
  readonly runtimeVersion: string;
  readonly configHash: string;
  readonly paramsHash: string;
  readonly initialPopulationHash: string;
  readonly codeSha: string;
}

/** 冻结的规则集：版本 + 完整 RunConfig；校准预设以它的 JSON 与 hash 为载体（07 §12）。 */
export interface Ruleset {
  readonly rulesVersion: RulesVersion;
  readonly config: RunConfig;
}

export interface RunIdentityInput {
  readonly config: RunConfig;
  readonly configHash: string;
  readonly paramsHash: string;
  readonly initialPopulationHash: string;
  readonly seed: Seed;
  readonly policyVersion: string;
  readonly promptVersion: string | null;
  readonly requestedModel: string;
  readonly runtimeVersion: string;
  readonly codeSha: string;
}

/** 由已计算的 hash 组装 run 身份块；hash 重算一致性由调用方（服务端/验证器）负责。 */
export function buildRunIdentity(input: RunIdentityInput): RunIdentity {
  return {
    schemaVersion: RUN_IDENTITY_SCHEMA_VERSION,
    rulesVersion: input.config.rulesVersion,
    engineVersion: ENGINE_VERSION,
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    policyVersion: input.policyVersion,
    promptVersion: input.promptVersion,
    requestedModel: input.requestedModel,
    seed: input.seed,
    runtimeVersion: input.runtimeVersion,
    configHash: input.configHash,
    paramsHash: input.paramsHash,
    initialPopulationHash: input.initialPopulationHash,
    codeSha: input.codeSha,
  };
}

/** 便捷封装：从 config/seed 计算三 hash 并组装身份块。 */
export function buildRunIdentityFromConfig(
  config: RunConfig,
  seed: Seed,
  options: Omit<RunIdentityInput, 'config' | 'configHash' | 'paramsHash' | 'seed'>,
): RunIdentity {
  return buildRunIdentity({
    ...options,
    config,
    seed,
    configHash: computeConfigHash(config),
    paramsHash: computeParamsHash(config),
  });
}

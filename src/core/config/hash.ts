import type { RunConfig } from './types.js';
import { HASH_DOMAINS } from '../hash/domains.js';
import { hashValue } from '../hash/hash.js';
import { PARAM_DEFINITIONS, readPath } from '../params.js';

/**
 * `configHash`：覆盖完整冻结的 `RunConfig`。
 * `seed` 不是 RunConfig 字段，因此天然被排除；Key/token、wall-clock 与上传状态也不得进入。
 */
export function computeConfigHash(config: RunConfig): string {
  return hashValue(HASH_DOMAINS.config, config);
}

export interface ParamSnapshotEntry {
  readonly name: string;
  readonly unit: string;
  readonly value: unknown;
}

/**
 * 参数注册表的解析快照。按注册名排序，排除 seed、Key/token 与 wall-clock。
 * `guardOnly` 参数同样进入快照：它们仍会改变配置的数值语义。
 */
export function buildParamSnapshot(config: RunConfig): readonly ParamSnapshotEntry[] {
  return [...PARAM_DEFINITIONS]
    .sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name))
    .map((definition) => ({
      name: definition.name,
      unit: definition.unit,
      value: readPath(config, definition.name),
    }));
}

/** `paramsHash`：覆盖参数注册表解析后的全部业务参数名、值与单位。 */
export function computeParamsHash(config: RunConfig): string {
  return hashValue(HASH_DOMAINS.params, buildParamSnapshot(config));
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG } from '../../src/core/config/defaults.js';
import {
  buildParamSnapshot,
  computeConfigHash,
  computeParamsHash,
} from '../../src/core/config/hash.js';
import type { RunConfig } from '../../src/core/config/types.js';
import { validateRunConfig } from '../../src/core/config/validate.js';
import { errorCodes } from '../../src/core/control/errors.js';
import { HASH_DOMAINS } from '../../src/core/hash/domains.js';
import { hashValue } from '../../src/core/hash/hash.js';

interface GoldenHashes {
  readonly rulesVersion: string;
  readonly fixture: string;
  readonly configHash: string;
  readonly paramsHash: string;
}

function readJson(relativePath: string): unknown {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

const fixture = readJson('../fixtures/config/default-rules-v5.json');
const golden = readJson('../fixtures/config/default-rules-v5.hashes.json') as GoldenHashes;

describe('golden: rules-v5 default config', () => {
  it('round-trips the fixture through validation and JSON without changing the hash', () => {
    expect(validateRunConfig(fixture).ok).toBe(true);
    const roundTripped = JSON.parse(JSON.stringify(fixture)) as unknown;
    expect(validateRunConfig(roundTripped).ok).toBe(true);
    expect(computeConfigHash(roundTripped as RunConfig)).toBe(golden.configHash);
    expect(computeParamsHash(roundTripped as RunConfig)).toBe(golden.paramsHash);
  });

  it('validates the fixture', () => {
    const result = validateRunConfig(fixture);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.issues, null, 2)).toBe(true);
  });

  it('keeps the fixture and DEFAULT_RUN_CONFIG in sync', () => {
    expect(fixture).toEqual(DEFAULT_RUN_CONFIG);
    expect(golden.fixture).toBe('test/fixtures/config/default-rules-v5.json');
    expect(golden.rulesVersion).toBe(DEFAULT_RUN_CONFIG.rulesVersion);
  });

  it('matches the pinned configHash', () => {
    expect(computeConfigHash(DEFAULT_RUN_CONFIG)).toBe(golden.configHash);
  });

  it('matches the pinned paramsHash', () => {
    expect(computeParamsHash(DEFAULT_RUN_CONFIG)).toBe(golden.paramsHash);
  });

  it('binds hashes to the versioned domains', () => {
    expect(golden.configHash).toBe(hashValue(HASH_DOMAINS.config, DEFAULT_RUN_CONFIG));
    expect(golden.paramsHash).toBe(
      hashValue(HASH_DOMAINS.params, buildParamSnapshot(DEFAULT_RUN_CONFIG)),
    );
  });

  it('detects a tampered fixture as a hash mismatch', () => {
    const tampered = structuredClone(fixture) as RunConfig;
    (tampered.need as { threshold: number }).threshold = 0.51;
    expect(computeConfigHash(tampered)).not.toBe(golden.configHash);
    expect(computeParamsHash(tampered)).not.toBe(golden.paramsHash);
  });
});

describe('golden: 历史 fixture（v3/v4 只读）', () => {
  const v3Fixture = readJson('../fixtures/config/default-rules-v3.json');
  const v3Golden = readJson('../fixtures/config/default-rules-v3.hashes.json') as GoldenHashes;
  const v4Fixture = readJson('../fixtures/config/default-rules-v4.json');
  const v4Golden = readJson('../fixtures/config/default-rules-v4.hashes.json') as GoldenHashes;

  it('v3/v4 fixture configHash 仍与冻结记录一致（历史证据不被篡改）', () => {
    expect(v3Golden.rulesVersion).toBe('rules-v3');
    expect(v4Golden.rulesVersion).toBe('rules-v4');
    // configHash 只覆盖配置 JSON 本身，不受注册表增长影响。
    expect(computeConfigHash(v3Fixture as RunConfig)).toBe(v3Golden.configHash);
    expect(computeConfigHash(v4Fixture as RunConfig)).toBe(v4Golden.configHash);
    // paramsHash 由参数注册表驱动：注册表随新参数增长后，缺字段的旧配置不再可哈希
    //（canonicalize 拒绝 undefined）；冻结历史值保留在各自记录中供审计。
    expect(() => computeParamsHash(v3Fixture as RunConfig)).toThrowError(/undefined/);
    expect(() => computeParamsHash(v4Fixture as RunConfig)).toThrowError(/undefined/);
  });

  it('v3/v4 fixture 不再被当前版本接受（config_unknown_version）', () => {
    for (const stale of [v3Fixture, v4Fixture]) {
      const result = validateRunConfig(stale);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.issues.some((issue) => issue.code === errorCodes.CONFIG_UNKNOWN_VERSION),
        ).toBe(true);
      }
    }
  });
});

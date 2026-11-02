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

const fixture = readJson('../fixtures/config/default-rules-v3.json');
const golden = readJson('../fixtures/config/default-rules-v3.hashes.json') as GoldenHashes;

describe('golden: rules-v3 default config', () => {
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
    expect(golden.fixture).toBe('test/fixtures/config/default-rules-v3.json');
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

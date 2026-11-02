import { describe, expect, it } from 'vitest';

import {
  buildParamSnapshot,
  computeConfigHash,
  computeParamsHash,
} from '../../../src/core/config/hash.js';
import { DEFAULT_RUN_CONFIG, createDemoConfig } from '../../../src/core/config/defaults.js';
import type { RunConfig } from '../../../src/core/config/types.js';
import { PARAM_DEFINITIONS, readPath } from '../../../src/core/params.js';

const HASH_SHAPE = /^sha256:[0-9a-f]{64}$/;

describe('computeConfigHash', () => {
  it('produces a well-formed, deterministic hash', () => {
    const first = computeConfigHash(DEFAULT_RUN_CONFIG);
    const second = computeConfigHash(DEFAULT_RUN_CONFIG);
    expect(first).toMatch(HASH_SHAPE);
    expect(first).toBe(second);
  });

  it('is stable across a JSON round-trip', () => {
    const roundTripped = JSON.parse(JSON.stringify(DEFAULT_RUN_CONFIG));
    expect(computeConfigHash(roundTripped)).toBe(computeConfigHash(DEFAULT_RUN_CONFIG));
  });

  it('changes when a business parameter changes', () => {
    const changed = createDemoConfig({ need: { threshold: 0.6 } });
    expect(computeConfigHash(changed)).not.toBe(computeConfigHash(DEFAULT_RUN_CONFIG));
  });

  it('covers schedule and metrics windows per 05 §4.2', () => {
    const schedule = createDemoConfig({ schedule: { totalTicks: 121 } });
    expect(computeConfigHash(schedule)).not.toBe(computeConfigHash(createDemoConfig()));

    const metrics = createDemoConfig({ metrics: { flowWindowDays: 364 } });
    expect(computeConfigHash(metrics)).not.toBe(computeConfigHash(createDemoConfig()));
  });

  it('covers every registered parameter', () => {
    const snapshot = buildParamSnapshot(DEFAULT_RUN_CONFIG);
    const hashes = new Set<string>();
    for (const definition of PARAM_DEFINITIONS) {
      const mutated = structuredClone(DEFAULT_RUN_CONFIG);
      mutatePath(mutated, definition.name);
      const hash = computeConfigHash(mutated);
      expect(hash, `${definition.name} did not change configHash`).not.toBe(
        computeConfigHash(DEFAULT_RUN_CONFIG),
      );
      hashes.add(hash);
    }
    expect(hashes.size).toBe(PARAM_DEFINITIONS.length);
    expect(snapshot).toHaveLength(PARAM_DEFINITIONS.length);
  });
});

describe('buildParamSnapshot', () => {
  it('is sorted by registration name', () => {
    const names = buildParamSnapshot(DEFAULT_RUN_CONFIG).map((entry) => entry.name);
    expect(names).toEqual([...names].sort());
  });

  it('captures name, unit and the resolved value', () => {
    const entry = buildParamSnapshot(DEFAULT_RUN_CONFIG).find(
      (item) => item.name === 'need.needMultiplier',
    );
    expect(entry).toEqual({
      name: 'need.needMultiplier',
      unit: 'dimensionless',
      value: [1, 1.3, 1.8, 2.5, 3.5],
    });
  });

  it('matches direct path reads for every entry', () => {
    for (const entry of buildParamSnapshot(DEFAULT_RUN_CONFIG)) {
      expect(entry.value).toEqual(readPath(DEFAULT_RUN_CONFIG, entry.name));
    }
  });
});

describe('computeParamsHash', () => {
  it('produces a well-formed, deterministic hash distinct from configHash', () => {
    const params = computeParamsHash(DEFAULT_RUN_CONFIG);
    expect(params).toMatch(HASH_SHAPE);
    expect(params).toBe(computeParamsHash(DEFAULT_RUN_CONFIG));
    expect(params).not.toBe(computeConfigHash(DEFAULT_RUN_CONFIG));
  });

  it('tracks parameter changes', () => {
    const changed = createDemoConfig({ competition: { lossRate: 0.09 } });
    expect(computeParamsHash(changed)).not.toBe(computeParamsHash(DEFAULT_RUN_CONFIG));
  });

  it('ignores non-registered config fields such as schemaVersion', () => {
    const copy = { ...structuredClone(DEFAULT_RUN_CONFIG), schemaVersion: 'stratify-config-v2' };
    expect(computeParamsHash(copy as unknown as RunConfig)).toBe(
      computeParamsHash(DEFAULT_RUN_CONFIG),
    );
  });
});

function mutatePath(target: RunConfig, path: string): void {
  const segments = path.split('.');
  const last = segments.pop() as string;
  let current = target as unknown as Record<string, unknown>;
  for (const segment of segments) {
    current = current[segment] as Record<string, unknown>;
  }
  const original = current[last];
  if (Array.isArray(original)) {
    current[last] = original.map((item, index) => (index === 0 ? (item as number) + 0.01 : item));
  } else if (typeof original === 'number') {
    current[last] = original + 0.01;
  } else {
    current[last] = 'newborn';
  }
}

import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG } from '../../../src/core/config/defaults.js';
import { computeParamsHash } from '../../../src/core/config/hash.js';
import { validateRunConfig } from '../../../src/core/config/validate.js';
import { maybeUpdateOpenness } from '../../../src/core/feedback/slow-variables.js';
import { stableSigmoid } from '../../../src/core/engine/settlement.js';
import { getParamDefinition } from '../../../src/core/params.js';
import { CONFIG_SCHEMA_VERSION } from '../../../src/core/control/versions.js';
import type { RunConfig } from '../../../src/core/config/types.js';

function withOpenness(overrides: Partial<RunConfig['openness']>): RunConfig {
  return {
    ...DEFAULT_RUN_CONFIG,
    openness: { ...DEFAULT_RUN_CONFIG.openness, ...overrides },
  };
}

const input = {
  tick: 10,
  lastOpennessUpdateTick: 0,
  mUp: 0.5,
  gini: 0.25,
  segregation: 0.3,
  regime: 'closed' as const,
};

describe('rules-v12 openness.selfReinforcement', () => {
  it('θH=0 与 rules-v11 公式逐位一致', () => {
    const config = withOpenness({ selfReinforcement: 0 });
    for (const openness of [0.05, 0.2, 0.5, 0.8, 0.95]) {
      const expectedTarget = stableSigmoid(
        config.openness.intercept +
          config.openness.mobilityWeight * (input.mUp - config.openness.mobilityReference) -
          config.openness.giniWeight * (input.gini - config.dynamics.giniReference) -
          config.openness.segregationWeight *
            (input.segregation - config.openness.segregationReference),
      );
      const factor = 1 - Math.exp(-10 / config.openness.timeConstantDays);
      const expected = openness + (expectedTarget - openness) * factor;
      expect(maybeUpdateOpenness(config, { ...input, openness }).openness).toBeCloseTo(
        Math.min(1, Math.max(0, expected)),
        12,
      );
    }
  });

  it('θH>0 在相同输入下把低 O 推低、高 O 推高', () => {
    const config = withOpenness({ selfReinforcement: 10 });
    const low = maybeUpdateOpenness(config, { ...input, openness: 0.2 }).openness;
    const high = maybeUpdateOpenness(config, { ...input, openness: 0.8 }).openness;
    expect(low).toBeLessThan(0.2);
    expect(high).toBeGreaterThan(0.8);
  });

  it('θH=0 时低 O 与高 O 被拉向同一目标', () => {
    const config = withOpenness({ selfReinforcement: 0 });
    const low = maybeUpdateOpenness(config, { ...input, openness: 0.2 }).openness;
    const high = maybeUpdateOpenness(config, { ...input, openness: 0.8 }).openness;
    expect(low).toBeGreaterThan(0.2);
    expect(high).toBeLessThan(0.8);
  });

  it('updateMode=fixed 时忽略 θH', () => {
    const config = withOpenness({ updateMode: 'fixed', initial: 0.4, selfReinforcement: 10 });
    expect(maybeUpdateOpenness(config, { ...input, openness: 0.9 }).openness).toBe(0.4);
  });

  it('参数注册表包含 θH，域为 [0,20]，且进入 paramsHash', () => {
    const definition = getParamDefinition('openness.selfReinforcement');
    expect(definition).toBeDefined();
    expect(definition?.domain).toEqual({ kind: 'number', min: 0, max: 20 });
    const base = computeParamsHash(DEFAULT_RUN_CONFIG);
    const changed = computeParamsHash(withOpenness({ selfReinforcement: 1 }));
    expect(changed).not.toBe(base);
  });

  it('v6 配置迁移补 selfReinforcement=0 并通过校验', () => {
    const v6 = structuredClone(DEFAULT_RUN_CONFIG) as unknown as Record<string, unknown>;
    v6['schemaVersion'] = 'stratify-config-v6';
    const openness = { ...(v6['openness'] as Record<string, unknown>) };
    delete openness['selfReinforcement'];
    v6['openness'] = openness;
    const result = validateRunConfig(v6);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.issues)).toBe(true);
    if (result.ok) {
      expect(result.config.openness.selfReinforcement).toBe(0);
      expect(result.config.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
      expect(result.config.behavior).toEqual(DEFAULT_RUN_CONFIG.behavior);
      expect(result.config.openness.regimeMode).toBe('continuous');
    }
  });
});

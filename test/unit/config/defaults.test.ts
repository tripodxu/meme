import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RUN_CONFIG,
  createDemoConfig,
  mergeConfig,
} from '../../../src/core/config/defaults.js';
import { validateRunConfig } from '../../../src/core/config/validate.js';
import { CONFIG_SCHEMA_VERSION, RULES_VERSION } from '../../../src/core/control/versions.js';

describe('DEFAULT_RUN_CONFIG', () => {
  it('matches the current rules-v11 defaults in 03 §3', () => {
    expect(DEFAULT_RUN_CONFIG.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    expect(DEFAULT_RUN_CONFIG.rulesVersion).toBe(RULES_VERSION);
    expect(DEFAULT_RUN_CONFIG.population).toEqual({
      initialPopulation: 40,
      classCount: 5,
      classShares: [0.45, 0.3, 0.15, 0.08, 0.02],
      initialValue: 0,
      initialAgeMode: 'uniform',
    });
    expect(DEFAULT_RUN_CONFIG.opportunity).toEqual({
      dailyBase: 2,
      env0: [1, 1.5, 2.2, 3.2, 4.5],
    });
    expect(DEFAULT_RUN_CONFIG.lifespan).toEqual({
      decay: [1.3, 1.15, 1.0, 0.88, 0.75],
      initialLife: { mean: 25550, sigma: 1825, min: 3650, max: 43800 },
      hardLifeFactor: 0.15,
      hardLifeFloor: 0.5,
    });
    expect(DEFAULT_RUN_CONFIG.need.needMultiplier).toEqual([1.0, 1.3, 1.8, 2.5, 3.5]);
    expect(DEFAULT_RUN_CONFIG.ascent).toEqual({
      crossDays: [30, 40, 50, 60],
      returnDiscount: [0, 0.2, 0.4],
      holdingCushionDays: 30,
      displacementShare: 1,
      scarcityWeight: 0,
      occupancyMemoryDays: 0,
    });
    expect(DEFAULT_RUN_CONFIG.schedule).toEqual({
      totalTicks: 3650,
      statsStride: 10,
      snapshotStride: 100,
    });
    expect(DEFAULT_RUN_CONFIG.metrics).toEqual({
      flowWindowDays: 365,
      mobilityWindowDays: 365,
      topWealthShareFraction: 0.1,
    });
  });

  it('keeps array lengths consistent with classCount', () => {
    const classCount = DEFAULT_RUN_CONFIG.population.classCount;
    expect(DEFAULT_RUN_CONFIG.population.classShares).toHaveLength(classCount);
    expect(DEFAULT_RUN_CONFIG.opportunity.env0).toHaveLength(classCount);
    expect(DEFAULT_RUN_CONFIG.lifespan.decay).toHaveLength(classCount);
    expect(DEFAULT_RUN_CONFIG.need.needMultiplier).toHaveLength(classCount);
    expect(DEFAULT_RUN_CONFIG.ascent.crossDays).toHaveLength(classCount - 1);
    const shareSum = DEFAULT_RUN_CONFIG.population.classShares.reduce((a, b) => a + b, 0);
    expect(Math.abs(shareSum - 1)).toBeLessThanOrEqual(1e-12);
  });

  it('does not include seed anywhere in the config tree', () => {
    expect(JSON.stringify(DEFAULT_RUN_CONFIG)).not.toContain('"seed"');
  });

  it('deep-freezes the default config to prevent cross-run mutation', () => {
    expect(Object.isFrozen(DEFAULT_RUN_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RUN_CONFIG.population.classShares)).toBe(true);
    expect(() => {
      (DEFAULT_RUN_CONFIG.need as unknown as { threshold: number }).threshold = 0.6;
    }).toThrow(TypeError);
  });
});

describe('createDemoConfig', () => {
  it('shortens totalTicks to 120 without mutating the default config', () => {
    const demo = createDemoConfig();
    expect(demo.schedule.totalTicks).toBe(120);
    expect(demo.schedule.statsStride).toBe(DEFAULT_RUN_CONFIG.schedule.statsStride);
    expect(DEFAULT_RUN_CONFIG.schedule.totalTicks).toBe(3650);
  });

  it('applies nested overrides and replaces arrays wholesale', () => {
    const demo = createDemoConfig({
      population: { classCount: 3, classShares: [0.5, 0.3, 0.2] },
      schedule: { totalTicks: 30 },
    });
    expect(demo.population.classCount).toBe(3);
    expect(demo.population.classShares).toEqual([0.5, 0.3, 0.2]);
    expect(demo.population.initialPopulation).toBe(40);
    expect(demo.schedule.totalTicks).toBe(30);
    expect(DEFAULT_RUN_CONFIG.population.classCount).toBe(5);
  });

  it('ignores undefined overrides', () => {
    const demo = createDemoConfig({ schedule: { totalTicks: undefined } as never });
    expect(demo.schedule.totalTicks).toBe(120);
  });

  it('deep-merges nested spec overrides instead of dropping siblings', () => {
    const merged = mergeConfig(DEFAULT_RUN_CONFIG, {
      lifespan: { initialLife: { mean: 26000 } },
    });
    expect(merged.lifespan.initialLife).toEqual({
      mean: 26000,
      sigma: 1825,
      min: 3650,
      max: 43800,
    });
    expect(merged.lifespan.hardLifeFactor).toBe(DEFAULT_RUN_CONFIG.lifespan.hardLifeFactor);

    const demo = createDemoConfig({ attributes: { ge: { sigma: 0.6 } } });
    expect(demo.attributes.ge).toEqual({ sigma: 0.6, median: 1, min: 0.2, max: 3 });
    expect(demo.attributes.hard).toEqual(DEFAULT_RUN_CONFIG.attributes.hard);
    expect(validateRunConfig(demo).ok).toBe(true);
  });

  it('does not pollute Object.prototype through a __proto__ patch key', () => {
    const patch = JSON.parse('{"__proto__":{"polluted":true}}') as never;
    mergeConfig(DEFAULT_RUN_CONFIG, patch);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('mergeConfig', () => {
  it('shallow-merges config groups', () => {
    const merged = mergeConfig(DEFAULT_RUN_CONFIG, { need: { threshold: 0.65 } });
    expect(merged.need.threshold).toBe(0.65);
    expect(merged.need.bufferDays).toBe(DEFAULT_RUN_CONFIG.need.bufferDays);
    expect(merged.population).toBe(DEFAULT_RUN_CONFIG.population);
  });

  it('does not mutate the base config', () => {
    mergeConfig(DEFAULT_RUN_CONFIG, { decision: { interval: 5 } });
    expect(DEFAULT_RUN_CONFIG.decision.interval).toBe(10);
  });

  it('ignores undefined top-level entries', () => {
    const merged = mergeConfig(DEFAULT_RUN_CONFIG, { metrics: undefined } as never);
    expect(merged.metrics).toBe(DEFAULT_RUN_CONFIG.metrics);
  });

  it('replaces non-plain values instead of merging into them', () => {
    const scalar = mergeConfig(DEFAULT_RUN_CONFIG, { schemaVersion: 'custom' } as never);
    expect(scalar.schemaVersion).toBe('custom');

    const nulled = mergeConfig(DEFAULT_RUN_CONFIG, { metrics: null } as never);
    expect(nulled.metrics).toBeNull();

    const array = mergeConfig(DEFAULT_RUN_CONFIG, { opportunity: [] } as never);
    expect(array.opportunity).toEqual([]);

    const intoScalar = mergeConfig(DEFAULT_RUN_CONFIG, { rulesVersion: {} } as never);
    expect(intoScalar.rulesVersion).toEqual({});
  });
});

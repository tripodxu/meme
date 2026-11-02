import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_CONFIG } from '../../../src/core/config/defaults.js';
import { isValidRunConfig, validateRunConfig } from '../../../src/core/config/validate.js';
import { errorCodes } from '../../../src/core/control/errors.js';

type Mutable = Record<string, any>;

function cloneConfig(): Mutable {
  return structuredClone(DEFAULT_RUN_CONFIG) as Mutable;
}

function codesOf(config: unknown): string[] {
  const result = validateRunConfig(config);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

function pathsOf(config: unknown): string[] {
  const result = validateRunConfig(config);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

describe('validateRunConfig', () => {
  it('accepts the default config and returns it unchanged', () => {
    const result = validateRunConfig(DEFAULT_RUN_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toBe(DEFAULT_RUN_CONFIG);
      expect(result.issues).toEqual([]);
    }
    expect(isValidRunConfig(DEFAULT_RUN_CONFIG)).toBe(true);
  });

  it('survives a JSON round-trip without losing fields', () => {
    const roundTripped = JSON.parse(JSON.stringify(DEFAULT_RUN_CONFIG)) as unknown;
    expect(validateRunConfig(roundTripped).ok).toBe(true);
  });

  it('reports missing top-level and nested fields with paths', () => {
    const missingTop = cloneConfig();
    delete missingTop['need'];
    expect(pathsOf(missingTop)).toContain('$.need');

    const missingNested = cloneConfig();
    delete missingNested['lifespan']['hardLifeFloor'];
    expect(pathsOf(missingNested)).toContain('$.lifespan.hardLifeFloor');
  });

  it('rejects unknown fields instead of silently accepting them', () => {
    const config = cloneConfig();
    config['seed'] = 'leaked';
    const issues = validateRunConfig(config);
    expect(issues.ok).toBe(false);
    if (!issues.ok) {
      expect(issues.issues.some((issue) => issue.path === '$.seed')).toBe(true);
    }
  });

  it('rejects NaN and Infinity with a distinct code', () => {
    const config = cloneConfig();
    config['need']['threshold'] = Number.NaN;
    expect(codesOf(config)).toContain(errorCodes.CONFIG_NON_FINITE);

    const other = cloneConfig();
    other['openness']['initial'] = Number.POSITIVE_INFINITY;
    expect(codesOf(other)).toContain(errorCodes.CONFIG_NON_FINITE);
  });

  it('rejects unknown schema and rules versions', () => {
    const schema = cloneConfig();
    schema['schemaVersion'] = 'stratify-config-v0';
    expect(codesOf(schema)).toContain(errorCodes.CONFIG_UNKNOWN_VERSION);

    const rules = cloneConfig();
    rules['rulesVersion'] = 'rules-v4';
    expect(codesOf(rules)).toContain(errorCodes.CONFIG_UNKNOWN_VERSION);
  });

  it('enforces returnDiscount length and monotonicity', () => {
    const short = cloneConfig();
    short['ascent']['returnDiscount'] = [0, 0.2];
    expect(codesOf(short)).toContain(errorCodes.CONFIG_INVALID);

    const decreasing = cloneConfig();
    decreasing['ascent']['returnDiscount'] = [0, 0.5, 0.4];
    expect(codesOf(decreasing)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);
  });

  it('enforces the initialAgeMode enum', () => {
    const config = cloneConfig();
    config['population']['initialAgeMode'] = 'oldest';
    expect(codesOf(config)).toContain(errorCodes.CONFIG_INVALID);
  });

  it('enforces class-array lengths against classCount', () => {
    const config = cloneConfig();
    config['population']['classShares'] = [0.5, 0.5];
    expect(codesOf(config)).toContain(errorCodes.CONFIG_INVALID);

    const env = cloneConfig();
    env['opportunity']['env0'] = [1, 2, 3];
    expect(codesOf(env)).toContain(errorCodes.CONFIG_INVALID);

    const cross = cloneConfig();
    cross['ascent']['crossDays'] = [30, 40, 50, 60, 70];
    expect(codesOf(cross)).toContain(errorCodes.CONFIG_INVALID);
  });

  it('enforces classShares summing to one within tolerance', () => {
    const config = cloneConfig();
    config['population']['classShares'] = [0.45, 0.3, 0.15, 0.08, 0.03];
    expect(codesOf(config)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);

    const withinTolerance = cloneConfig();
    withinTolerance['population']['classShares'] = [0.45, 0.3, 0.15, 0.08, 0.02 + 1e-13];
    expect(codesOf(withinTolerance)).toEqual([]);
  });

  it('enforces needMultiplier non-decreasing and first element 1', () => {
    const decreasing = cloneConfig();
    decreasing['need']['needMultiplier'] = [1, 1.4, 1.3, 2.5, 3.5];
    expect(codesOf(decreasing)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);

    const wrongFirst = cloneConfig();
    wrongFirst['need']['needMultiplier'] = [1.1, 1.3, 1.8, 2.5, 3.5];
    expect(codesOf(wrongFirst)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);
  });

  it('enforces distribution ordering', () => {
    const lognormal = cloneConfig();
    lognormal['attributes']['ge']['min'] = 2;
    expect(codesOf(lognormal)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);

    const normal = cloneConfig();
    normal['lifespan']['initialLife']['mean'] = 100;
    expect(codesOf(normal)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);
  });

  it('enforces transfer efficiency times direction multiplier <= 1', () => {
    const config = cloneConfig();
    config['competition']['baseTransferEfficiency'] = 0.9;
    config['competition']['highToLowWinMultiplier'] = 1.2;
    expect(codesOf(config)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);

    const boundary = cloneConfig();
    boundary['competition']['baseTransferEfficiency'] = 0.8;
    boundary['competition']['lowToHighWinMultiplier'] = 1.25;
    expect(codesOf(boundary)).toEqual([]);
  });

  it('enforces known ranges for every scalar group', () => {
    const cases: Array<[string, string, unknown]> = [
      ['population', 'initialPopulation', 1],
      ['population', 'classCount', 9],
      ['population', 'initialValue', -1],
      ['opportunity', 'dailyBase', 0],
      ['lifespan', 'hardLifeFloor', 0],
      ['effort', 'shape', 0],
      ['need', 'threshold', 1.1],
      ['need', 'belowNeedLimit', 0],
      ['need', 'bufferDays', 1],
      ['descent', 'days', 0],
      ['competition', 'lossRate', 0.6],
      ['competition', 'candidateCount', 7],
      ['network', 'maxDegree', 7],
      ['network', 'initialDegree', -1],
      ['network', 'rewireProb', 1.1],
      ['networkOpportunity', 'beta', -1],
      ['dynamics', 'classSmoothing', 0],
      ['dynamics', 'giniReference', 1.5],
      ['openness', 'initial', 1.5],
      ['openness', 'timeConstantDays', 0],
      ['openness', 'intercept', 21],
      ['decision', 'interval', 0],
      ['decision', 'topK', 10],
      ['schedule', 'totalTicks', 0],
      ['schedule', 'snapshotStride', 0],
      ['schedule', 'statsStride', 0],
      ['metrics', 'topWealthShareFraction', 0],
    ];
    for (const [group, key, value] of cases) {
      const config = cloneConfig();
      config[group][key] = value;
      expect(codesOf(config), `${group}.${key}=${String(value)}`).toContain(
        errorCodes.CONFIG_OUT_OF_RANGE,
      );
    }
  });

  it('enforces cross-field ordering', () => {
    const network = cloneConfig();
    network['network']['maxDegree'] = 3;
    expect(codesOf(network)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);

    const schedule = cloneConfig();
    schedule['schedule']['statsStride'] = 200;
    schedule['schedule']['totalTicks'] = 100;
    expect(codesOf(schedule)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);

    const opportunity = cloneConfig();
    opportunity['networkOpportunity']['min'] = 2;
    opportunity['networkOpportunity']['max'] = 1;
    expect(codesOf(opportunity)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);

    const dynamics = cloneConfig();
    dynamics['dynamics']['congestionMin'] = 2;
    dynamics['dynamics']['congestionMax'] = 1;
    expect(codesOf(dynamics)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);

    const openness = cloneConfig();
    openness['openness']['multiplierMin'] = 3;
    openness['openness']['multiplierMax'] = 2;
    expect(codesOf(openness)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);
  });

  it('rejects unknown decision policies', () => {
    const config = cloneConfig();
    config['decision']['policy'] = 'gpt-please-decide';
    expect(codesOf(config)).toContain(errorCodes.CONFIG_INVALID);
  });

  it('rejects non-object roots and non-array groups', () => {
    expect(validateRunConfig(null).ok).toBe(false);
    expect(validateRunConfig([]).ok).toBe(false);
    expect(validateRunConfig('config').ok).toBe(false);

    const config = cloneConfig();
    config['population'] = [];
    expect(codesOf(config)).toContain(errorCodes.CONFIG_INVALID);
  });

  it('reports all issues at once instead of stopping at the first', () => {
    const config = cloneConfig();
    config['need']['threshold'] = 2;
    config['decision']['interval'] = 0;
    const result = validateRunConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThanOrEqual(2);
      expect(result.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(['$.need.threshold', '$.decision.interval']),
      );
    }
  });

  it('rejects non-object config groups by path', () => {
    const groups = [
      'population',
      'opportunity',
      'lifespan',
      'attributes',
      'effort',
      'need',
      'descent',
      'ascent',
      'competition',
      'network',
      'networkOpportunity',
      'dynamics',
      'openness',
      'decision',
      'schedule',
      'metrics',
    ];
    for (const group of groups) {
      const config = cloneConfig();
      config[group] = null;
      expect(pathsOf(config), `${group} should be rejected`).toContain(`$.${group}`);
    }
  });

  it('skips class-dependent checks when classCount itself is invalid', () => {
    const config = cloneConfig();
    config['population']['classCount'] = 9;
    config['opportunity']['env0'] = 'high';
    const paths = pathsOf(config);
    expect(paths).toContain('$.population.classCount');
    expect(paths).not.toContain('$.opportunity.env0');
  });

  it('rejects non-array class-dependent fields', () => {
    const shares = cloneConfig();
    shares['population']['classShares'] = 0.45;
    expect(pathsOf(shares)).toContain('$.population.classShares');

    const env0 = cloneConfig();
    env0['opportunity']['env0'] = 'high';
    expect(pathsOf(env0)).toContain('$.opportunity.env0');

    const discount = cloneConfig();
    discount['ascent']['returnDiscount'] = 0.9;
    expect(pathsOf(discount)).toContain('$.ascent.returnDiscount');
  });

  it('rejects non-integer counts', () => {
    for (const [path, mutate] of [
      ['$.decision.interval', (config: Mutable) => (config['decision']['interval'] = 2.5)],
      [
        '$.competition.candidateCount',
        (config: Mutable) => (config['competition']['candidateCount'] = 3.5),
      ],
      ['$.schedule.totalTicks', (config: Mutable) => (config['schedule']['totalTicks'] = 12.5)],
    ] as const) {
      const config = cloneConfig();
      mutate(config);
      expect(pathsOf(config), path).toContain(path);
      expect(codesOf(config), path).toContain(errorCodes.CONFIG_INVALID);
    }
  });

  it('reports the offending index inside class-dependent arrays', () => {
    const negative = cloneConfig();
    negative['opportunity']['env0'] = [-1, 1.5, 2.2, 3.2, 4.5];
    expect(pathsOf(negative)).toContain('$.opportunity.env0[0]');

    const nonNumeric = cloneConfig();
    nonNumeric['opportunity']['env0'] = [1, 1.5, 'x', 3.2, 4.5];
    expect(pathsOf(nonNumeric)).toContain('$.opportunity.env0[2]');
  });

  it('rejects malformed or mis-ordered distributions', () => {
    const notObject = cloneConfig();
    notObject['attributes']['ge'] = null;
    expect(pathsOf(notObject)).toContain('$.attributes.ge');

    const negativeSigma = cloneConfig();
    negativeSigma['attributes']['ge']['sigma'] = -1;
    expect(codesOf(negativeSigma)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);

    const medianAboveMax = cloneConfig();
    medianAboveMax['attributes']['ge']['max'] = 0.5;
    expect(codesOf(medianAboveMax)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);

    const notObjectNormal = cloneConfig();
    notObjectNormal['lifespan']['initialLife'] = null;
    expect(pathsOf(notObjectNormal)).toContain('$.lifespan.initialLife');

    const negativeLifeSigma = cloneConfig();
    negativeLifeSigma['lifespan']['initialLife']['sigma'] = -1;
    expect(codesOf(negativeLifeSigma)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);

    const meanBelowMin = cloneConfig();
    meanBelowMin['lifespan']['initialLife']['mean'] = 1000;
    expect(codesOf(meanBelowMin)).toContain(errorCodes.CONFIG_OUT_OF_RANGE);
  });

  it('skips the transfer-efficiency cross-check when a factor is invalid', () => {
    const efficiency = cloneConfig();
    efficiency['competition']['baseTransferEfficiency'] = 2;
    expect(pathsOf(efficiency)).toContain('$.competition.baseTransferEfficiency');

    const multiplier = cloneConfig();
    multiplier['competition']['highToLowWinMultiplier'] = 2;
    expect(pathsOf(multiplier)).toContain('$.competition.highToLowWinMultiplier');
  });

  it('skips cross-field ordering when one side is not a number', () => {
    const network = cloneConfig();
    network['network']['maxDegree'] = 'six';
    expect(pathsOf(network)).toContain('$.network.maxDegree');

    const schedule = cloneConfig();
    schedule['schedule']['statsStride'] = 'weekly';
    expect(pathsOf(schedule)).toContain('$.schedule.statsStride');
  });

  it('rejects non-string versions and policies', () => {
    const version = cloneConfig();
    version['rulesVersion'] = 3;
    expect(codesOf(version)).toContain(errorCodes.CONFIG_UNKNOWN_VERSION);

    const policy = cloneConfig();
    policy['decision']['policy'] = 123;
    expect(codesOf(policy)).toContain(errorCodes.CONFIG_INVALID);
  });
});

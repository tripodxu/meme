import { describe, expect, it } from 'vitest';

import {
  NUMERIC_CONSTANTS,
  PARAM_DEFINITIONS,
  getNumericConstant,
  getParamDefinition,
  listParamDefinitions,
  readNumberArrayPath,
  readNumberPath,
  readPath,
  readNumericConstant,
} from '../../src/core/params.js';
import { DEFAULT_RUN_CONFIG } from '../../src/core/config/defaults.js';

describe('parameter registry', () => {
  it('has unique registration names that are valid config paths', () => {
    const names = PARAM_DEFINITIONS.map((definition) => definition.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-zA-Z]+\.[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$/);
    }
  });

  it('resolves every registered path against the default config', () => {
    for (const definition of PARAM_DEFINITIONS) {
      const value = readPath(DEFAULT_RUN_CONFIG, definition.name);
      expect(value, `missing value for ${definition.name}`).toBeDefined();
    }
  });

  it('accepts every default value under the registered domain', () => {
    for (const definition of PARAM_DEFINITIONS) {
      const value = readPath(DEFAULT_RUN_CONFIG, definition.name);
      if (definition.domain.kind === 'enum') {
        expect(definition.domain.values).toContain(value);
        continue;
      }
      if (definition.domain.kind === 'array') {
        const numbers = value as readonly number[];
        expect(Array.isArray(numbers), `${definition.name} must be an array`).toBe(true);
        if (definition.domain.length === 'classCount') {
          expect(numbers).toHaveLength(DEFAULT_RUN_CONFIG.population.classCount);
        } else if (definition.domain.length === 'classCountMinus1') {
          expect(numbers).toHaveLength(DEFAULT_RUN_CONFIG.population.classCount - 1);
        } else {
          expect(numbers).toHaveLength(definition.domain.length);
        }
        for (const element of numbers) {
          checkNumberInDomain(definition.name, element, definition.domain.element);
        }
        continue;
      }
      checkNumberInDomain(definition.name, value as number, definition.domain);
    }
  });

  it('marks guardOnly parameters as not affecting behavior', () => {
    const guardOnly = PARAM_DEFINITIONS.filter((definition) => definition.guardOnly);
    expect(guardOnly.map((definition) => definition.name).sort()).toEqual([
      'lifespan.hardLifeFloor',
    ]);
    for (const definition of guardOnly) {
      expect(definition.affectsBehavior).toBe(false);
    }
    expect(getParamDefinition('dynamics.emptyClassPopulationFloor')?.affectsBehavior).toBe(true);
  });

  it('requires a wiring test description for every parameter', () => {
    for (const definition of PARAM_DEFINITIONS) {
      expect(definition.wireTest.length).toBeGreaterThan(0);
      expect(definition.formulaRef.length).toBeGreaterThan(0);
    }
  });

  it('exposes lookups by name', () => {
    expect(getParamDefinition('need.needMultiplier')?.unit).toBe('dimensionless');
    expect(getParamDefinition('missing.param')).toBeUndefined();
    expect(listParamDefinitions()).toBe(PARAM_DEFINITIONS);
  });

  it('registers implementation constants outside the config hash', () => {
    const names = NUMERIC_CONSTANTS.map((constant) => constant.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'TWO_POW_NEG_53',
        'CONFIG_SHARE_TOLERANCE',
        'MAX_TOP_K',
        'MAX_COMPETITION_CANDIDATES',
      ]),
    );
    for (const constant of NUMERIC_CONSTANTS) {
      expect(Number.isFinite(constant.value)).toBe(true);
      expect(constant.reason.length).toBeGreaterThan(0);
      expect(PARAM_DEFINITIONS.some((definition) => definition.name === constant.name)).toBe(false);
    }
    expect(getNumericConstant('CONFIG_SHARE_TOLERANCE')?.value).toBe(1e-12);
    expect(getNumericConstant('NOPE')).toBeUndefined();
    expect(readNumericConstant('CONFIG_SHARE_TOLERANCE')).toBe(1e-12);
    expect(() => readNumericConstant('NOPE')).toThrow(/缺少登记项/);
  });

  it('reads numbers and number arrays only for the matching shape', () => {
    expect(readNumberPath(DEFAULT_RUN_CONFIG, 'need.threshold')).toBe(0.5);
    expect(readNumberPath(DEFAULT_RUN_CONFIG, 'need.needMultiplier')).toBeUndefined();
    expect(readNumberArrayPath(DEFAULT_RUN_CONFIG, 'need.needMultiplier')).toEqual([
      1, 1.3, 1.8, 2.5, 3.5,
    ]);
    expect(readNumberArrayPath(DEFAULT_RUN_CONFIG, 'need.threshold')).toBeUndefined();
    expect(readPath(DEFAULT_RUN_CONFIG, 'missing.path')).toBeUndefined();
  });
});

function checkNumberInDomain(
  name: string,
  value: number,
  domain: {
    readonly min?: number;
    readonly max?: number;
    readonly exclusiveMin?: number;
    readonly exclusiveMax?: number;
    readonly integer?: boolean;
  },
): void {
  expect(Number.isFinite(value), `${name} must be finite`).toBe(true);
  if (domain.integer) expect(Number.isInteger(value), `${name} must be integer`).toBe(true);
  if (domain.min !== undefined)
    expect(value, `${name} >= ${domain.min}`).toBeGreaterThanOrEqual(domain.min);
  if (domain.max !== undefined)
    expect(value, `${name} <= ${domain.max}`).toBeLessThanOrEqual(domain.max);
  if (domain.exclusiveMin !== undefined)
    expect(value, `${name} > ${domain.exclusiveMin}`).toBeGreaterThan(domain.exclusiveMin);
  if (domain.exclusiveMax !== undefined)
    expect(value, `${name} < ${domain.exclusiveMax}`).toBeLessThan(domain.exclusiveMax);
}

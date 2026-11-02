import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PARAM_DEFINITIONS } from '../../src/core/params.js';

interface ParamSnapshot {
  readonly definitions: readonly unknown[];
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/config/param-definitions.json', import.meta.url)),
    'utf8',
  ),
) as ParamSnapshot;

function projectDefinitions(): unknown[] {
  return PARAM_DEFINITIONS.map(
    ({ name, unit, formulaRef, domain, guardOnly, affectsBehavior }) => ({
      name,
      unit,
      formulaRef,
      domain,
      guardOnly,
      affectsBehavior,
    }),
  );
}

describe('golden: parameter registry contract', () => {
  it('matches the frozen definition snapshot', () => {
    expect(projectDefinitions()).toEqual(fixture.definitions);
  });

  it('keeps definition names unique', () => {
    const names = fixture.definitions.map((definition) => (definition as { name: string }).name);
    expect(new Set(names).size).toBe(names.length);
  });
});

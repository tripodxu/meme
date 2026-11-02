import { describe, expect, it } from 'vitest';

import { canonicalize, isJsonValue } from '../../../src/core/hash/jcs.js';
import { StratifyError, errorCodes } from '../../../src/core/control/errors.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof StratifyError) return error.code;
    throw error;
  }
  return undefined;
}

describe('RFC 8785 canonicalize', () => {
  it('matches the RFC 8785 worked example', () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: '€$\u000f\nA\'B"\\"/',
      literals: [null, true, false],
    };
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\"/"}',
    );
  });

  it('sorts object keys by UTF-16 code unit, not locale order', () => {
    const input = { '\u{1F600}': 1, '\u20ac': 2, b: 3, B: 4, a: 5 };
    expect(canonicalize(input)).toBe('{"B":4,"a":5,"b":3,"€":2,"😀":1}');
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('normalizes -0 to 0 and keeps other number formatting stable', () => {
    expect(canonicalize({ n: -0 })).toBe('{"n":0}');
    expect(canonicalize(1.5)).toBe('1.5');
    expect(canonicalize(1e21)).toBe('1e+21');
  });

  it('accepts primitive JSON values', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize('x')).toBe('"x"');
  });

  it('is independent of insertion order for object keys', () => {
    expect(canonicalize({ a: 1, b: { c: 2, d: 3 } })).toBe(
      canonicalize({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects non-finite number %s with hash_non_canonical', (_label, value) => {
    expect(codeOf(() => canonicalize({ v: value }))).toBe(errorCodes.HASH_NON_CANONICAL);
  });

  it('rejects undefined, bigint, function and symbol', () => {
    expect(codeOf(() => canonicalize({ v: undefined }))).toBe(errorCodes.HASH_NON_CANONICAL);
    expect(codeOf(() => canonicalize({ v: 1n }))).toBe(errorCodes.HASH_NON_CANONICAL);
    expect(codeOf(() => canonicalize({ v: () => 1 }))).toBe(errorCodes.HASH_NON_CANONICAL);
    expect(codeOf(() => canonicalize({ v: Symbol('s') }))).toBe(errorCodes.HASH_NON_CANONICAL);
  });

  it('rejects non-plain objects such as Date and Map', () => {
    expect(codeOf(() => canonicalize(new Date(0)))).toBe(errorCodes.HASH_NON_CANONICAL);
    expect(codeOf(() => canonicalize(new Map()))).toBe(errorCodes.HASH_NON_CANONICAL);
    expect(codeOf(() => canonicalize(new Uint8Array([1])))).toBe(errorCodes.HASH_NON_CANONICAL);
  });

  it('rejects sparse arrays instead of emitting invalid JSON', () => {
    const sparse = [1, 2, 3];
    delete sparse[1];
    expect(codeOf(() => canonicalize(sparse))).toBe(errorCodes.HASH_NON_CANONICAL);
    expect(codeOf(() => canonicalize(new Array<number>(3)))).toBe(errorCodes.HASH_NON_CANONICAL);
    expect(isJsonValue(sparse)).toBe(false);
  });

  it('rejects lone surrogates but accepts paired surrogates', () => {
    expect(codeOf(() => canonicalize('\ud800'))).toBe(errorCodes.HASH_NON_CANONICAL);
    expect(codeOf(() => canonicalize('\udc00'))).toBe(errorCodes.HASH_NON_CANONICAL);
    expect(canonicalize('\ud83d\ude00')).toBe('"😀"');
  });

  it('reports the offending path in details', () => {
    try {
      canonicalize({ a: { b: [1, Number.NaN] } });
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(StratifyError);
      expect((error as StratifyError).details).toEqual([{ path: '$.a.b[1]' }]);
    }
  });

  it('accepts null-prototype objects', () => {
    const value = Object.create(null) as Record<string, unknown>;
    value['a'] = 1;
    expect(canonicalize(value)).toBe('{"a":1}');
  });

  it('isJsonValue mirrors canonicalize acceptance', () => {
    expect(isJsonValue({ a: [1, 'x', null] })).toBe(true);
    expect(isJsonValue({ a: undefined })).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
  });
});

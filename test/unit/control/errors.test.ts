import { describe, expect, it } from 'vitest';

import { StratifyError, errorCodes, isStratifyError } from '../../../src/core/control/errors.js';

describe('error codes', () => {
  it('expose a stable lowercase snake_case vocabulary', () => {
    for (const code of Object.values(errorCodes)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(Object.values(errorCodes)).toEqual(
      expect.arrayContaining([
        'config_invalid',
        'config_unknown_version',
        'config_non_finite',
        'config_out_of_range',
        'hash_non_canonical',
        'invariant_violated',
      ]),
    );
  });
});

describe('StratifyError', () => {
  it('carries code, message and details', () => {
    const error = new StratifyError(errorCodes.CONFIG_INVALID, '字段缺失', [
      { path: '$.need.threshold' },
    ]);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StratifyError');
    expect(error.code).toBe('config_invalid');
    expect(error.message).toBe('字段缺失');
    expect(error.details).toEqual([{ path: '$.need.threshold' }]);
  });

  it('defaults details to an empty list', () => {
    expect(new StratifyError(errorCodes.INVARIANT_VIOLATED, 'boom').details).toEqual([]);
  });

  it('is recognised by isStratifyError', () => {
    expect(isStratifyError(new StratifyError(errorCodes.INVARIANT_VIOLATED, 'boom'))).toBe(true);
    expect(isStratifyError(new Error('boom'))).toBe(false);
    expect(isStratifyError('boom')).toBe(false);
  });
});

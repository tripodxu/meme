import { describe, expect, it } from 'vitest';

import {
  asAgentId,
  asChunkId,
  asLocalRunId,
  asRunId,
  asSeed,
  isAgentId,
  isChunkId,
  isLocalRunId,
  isRunId,
} from '../../../src/core/control/ids.js';

const ULID = '01JZ6R2V8N4Q3S5T7W9Y0AB1CD';

describe('run and chunk ids', () => {
  it('accepts documented id shapes', () => {
    expect(asRunId('run_01')).toBe('run_01');
    expect(asRunId('A'.repeat(64))).toBe('A'.repeat(64));
    expect(asLocalRunId(`local-${ULID}`)).toBe(`local-${ULID}`);
    expect(asAgentId('a-0001')).toBe('a-0001');
    expect(asAgentId('a-123456')).toBe('a-123456');
    expect(asChunkId('events-0-1000.jsonl')).toBe('events-0-1000.jsonl');
    expect(() => asChunkId('events/0.jsonl')).toThrow(RangeError);
  });

  it('checks chunk ids without throwing', () => {
    expect(isChunkId('events-0-1000.jsonl')).toBe(true);
    expect(isChunkId('')).toBe(false);
    expect(isChunkId('events/0.jsonl')).toBe(false);
    expect(isChunkId('x'.repeat(129))).toBe(false);
  });

  it('rejects ids that violate the R2/sessionStorage-safe charset', () => {
    expect(() => asRunId('run 01')).toThrow(RangeError);
    expect(() => asRunId('a/b')).toThrow(RangeError);
    expect(() => asRunId('')).toThrow(RangeError);
    expect(() => asRunId('x'.repeat(65))).toThrow(RangeError);
    expect(isRunId('ok_id-1')).toBe(true);
    expect(isRunId('bad id')).toBe(false);
  });

  it('requires local-<26 Crockford ULID> for local runs', () => {
    expect(isLocalRunId(`local-${ULID}`)).toBe(true);
    expect(isLocalRunId(`local-${ULID.toLowerCase()}`)).toBe(false);
    expect(isLocalRunId(`local-${ULID.slice(0, 25)}`)).toBe(false);
    expect(() => asLocalRunId(`run-${ULID}`)).toThrow(RangeError);
  });

  it('requires at least four digits for agent ids', () => {
    expect(isAgentId('a-001')).toBe(false);
    expect(isAgentId('a-0001')).toBe(true);
    expect(isAgentId('b-0001')).toBe(false);
    expect(() => asAgentId('a-1')).toThrow(RangeError);
  });

  it('rejects non-string values', () => {
    expect(() => asRunId(1)).toThrow(TypeError);
    expect(() => asSeed(null)).toThrow(TypeError);
  });
});

describe('seed', () => {
  it('accepts ordinary seeds', () => {
    expect(asSeed('demo')).toBe('demo');
    expect(asSeed('种子-2026')).toBe('种子-2026');
    expect(asSeed('x'.repeat(256))).toBe('x'.repeat(256));
  });

  it('rejects empty, overlong, NUL and lone-surrogate seeds', () => {
    expect(() => asSeed('')).toThrow(/不得为空/);
    expect(() => asSeed('x'.repeat(257))).toThrow(/长度/);
    expect(() => asSeed('a\0b')).toThrow(/NUL/);
    expect(() => asSeed('\ud800')).toThrow(/代理项/);
  });
});

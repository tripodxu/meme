import { describe, expect, it } from 'vitest';

import { hashValue, parseHash, sha256Hex } from '../../../src/core/hash/hash.js';
import { HASH_DOMAINS } from '../../../src/core/hash/domains.js';

const utf8 = new TextEncoder();

describe('sha256Hex', () => {
  it('matches the SHA-256 test vector for "abc"', () => {
    expect(sha256Hex(utf8.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('returns lowercase hex', () => {
    expect(sha256Hex(utf8.encode(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('hashValue', () => {
  it('hashes domain + NUL + canonical JSON with a fixed vector', () => {
    expect(hashValue('stratify-test-v1', null)).toBe(
      'sha256:923f96702ea6297a29319e7aadf26dca087a9936e8c81975463195673ac1886c',
    );
  });

  it('hashes object values with a fixed vector', () => {
    expect(hashValue('stratify-test-v1', { b: [true, null], a: 1 })).toBe(
      'sha256:8f2026e502b9cb79200fd6e6d2f8cf828e1ffdbe194a0bd1d73b4fccbc1add86',
    );
  });

  it('is key-order independent', () => {
    expect(hashValue('stratify-test-v1', { a: 1, b: 2 })).toBe(
      hashValue('stratify-test-v1', { b: 2, a: 1 }),
    );
  });

  it('distinguishes domains', () => {
    expect(hashValue('stratify-test-v1', 1)).not.toBe(hashValue('stratify-test-v2', 1));
  });

  it('rejects domains without the stratify- prefix and embedded NUL', () => {
    expect(() => hashValue('config-v1', {})).toThrow(/非法 hash domain/);
    expect(() => hashValue('stratify-a\0b', {})).toThrow(/非法 hash domain/);
  });

  it('declares every documented hash domain with the versioned prefix', () => {
    expect(Object.values(HASH_DOMAINS)).toEqual(
      expect.arrayContaining([
        'stratify-config-v1',
        'stratify-params-v1',
        'stratify-initial-population-v1',
        'stratify-decision-state-v1',
        'stratify-action-set-v1',
        'stratify-tick-row-v1',
        'stratify-agent-row-v1',
        'stratify-authoritative-state-v1',
        'stratify-summary-v1',
        'stratify-artifact-manifest-v1',
        'stratify-preregistration-v1',
      ]),
    );
    for (const domain of Object.values(HASH_DOMAINS)) {
      expect(domain.startsWith('stratify-')).toBe(true);
    }
    expect(new Set(Object.values(HASH_DOMAINS)).size).toBe(Object.values(HASH_DOMAINS).length);
  });
});

describe('parseHash', () => {
  it('round-trips a produced hash', () => {
    const hash = hashValue('stratify-test-v1', { a: 1 });
    const parsed = parseHash(hash);
    expect(parsed.algorithm).toBe('sha256');
    expect(hash).toBe(`sha256:${parsed.digest}`);
  });

  it('rejects malformed hashes', () => {
    expect(() => parseHash('sha1:abc')).toThrow(/前缀/);
    expect(() => parseHash('sha256:ABC')).toThrow(/64 位小写十六进制/);
    expect(() => parseHash('sha256:zz')).toThrow(/64 位小写十六进制/);
  });
});

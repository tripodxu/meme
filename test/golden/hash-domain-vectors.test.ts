import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HASH_DOMAINS } from '../../src/core/hash/domains.js';
import { hashValue } from '../../src/core/hash/hash.js';
import { canonicalize } from '../../src/core/hash/jcs.js';

interface DomainVector {
  readonly domain: string;
  readonly value: unknown;
  readonly hash: string;
}

interface DomainVectorsFixture {
  readonly description: string;
  readonly canonicalization: string;
  readonly vectors: readonly DomainVector[];
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/hash/domain-vectors.json', import.meta.url)),
    'utf8',
  ),
) as DomainVectorsFixture;

const declaredDomains = Object.values(HASH_DOMAINS);

function tamper(value: unknown): unknown {
  const clone = JSON.parse(canonicalize(value)) as unknown;
  if (Array.isArray(clone)) {
    return [...clone, '__tampered__'];
  }
  if (typeof clone === 'object' && clone !== null) {
    return { ...(clone as Record<string, unknown>), __tampered__: true };
  }
  throw new Error('测试向量必须是对象或数组，才能构造篡改用例');
}

describe('golden: per-domain hash test vectors', () => {
  it('pins exactly one vector for every declared hash domain', () => {
    const fixtureDomains = fixture.vectors.map((vector) => vector.domain);
    expect(new Set(fixtureDomains).size).toBe(fixtureDomains.length);
    expect([...fixtureDomains].sort()).toEqual([...declaredDomains].sort());
  });

  it('uses the documented canonicalization', () => {
    expect(fixture.canonicalization).toContain('RFC 8785');
    expect(fixture.canonicalization).toContain('SHA-256');
  });

  for (const vector of fixture.vectors) {
    describe(vector.domain, () => {
      it('matches the pinned hash', () => {
        expect(hashValue(vector.domain, vector.value)).toBe(vector.hash);
        expect(vector.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      });

      it('survives a JSON round-trip of the vector value', () => {
        expect(hashValue(vector.domain, JSON.parse(JSON.stringify(vector.value)) as unknown)).toBe(
          vector.hash,
        );
      });

      it('detects tampering with the vector value', () => {
        expect(hashValue(vector.domain, tamper(vector.value))).not.toBe(vector.hash);
      });
    });
  }

  it('keeps the same value distinct across domains', () => {
    const first = fixture.vectors[0];
    const second = fixture.vectors[1];
    if (first === undefined || second === undefined) {
      throw new Error('测试向量不足');
    }
    expect(hashValue(first.domain, first.value)).not.toBe(hashValue(second.domain, first.value));
  });
});

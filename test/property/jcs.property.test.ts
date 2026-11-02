import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalize } from '../../src/core/hash/jcs.js';
import { hashValue } from '../../src/core/hash/hash.js';

describe('JCS properties', () => {
  it('round-trips every JSON value through canonicalize + JSON.parse', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const canonical = canonicalize(value);
        const parsed = JSON.parse(canonical) as unknown;
        expect(canonicalize(parsed)).toBe(canonical);
      }),
    );
  });

  it('is invariant under object key insertion order', () => {
    const entry = fc.tuple(
      fc.constantFrom('a', 'b', 'c', 'Z', '0', 'é'),
      fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.constant(null)),
    );
    const entries = fc.uniqueArray(entry, {
      minLength: 0,
      maxLength: 6,
      selector: ([key]) => key,
    });
    fc.assert(
      fc.property(entries, (pairs) => {
        const forward = Object.fromEntries(pairs) as Record<string, unknown>;
        const reversed = Object.fromEntries([...pairs].reverse()) as Record<string, unknown>;
        expect(canonicalize(reversed)).toBe(canonicalize(forward));
      }),
    );
  });

  it('emits no whitespace outside string literals', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const canonical = canonicalize(value);
        // 不能直接比较 JSON.stringify(JSON.parse(canonical))：JS 对象会把整数样键排到前面，
        // 与 JCS 的 UTF-16 码元排序无关。结构分隔符才是这里的不变量。
        const skeleton = canonical.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        expect(skeleton).not.toMatch(/\s/);
        expect(skeleton).not.toContain(', ,');
      }),
    );
  });
});

describe('semantic hash properties', () => {
  it('is deterministic and order-independent', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.jsonValue(), {
          maxKeys: 5,
        }),
        (value) => {
          expect(hashValue('stratify-property-v1', value)).toBe(
            hashValue('stratify-property-v1', value),
          );
          const reversed = Object.fromEntries(Object.entries(value).reverse());
          expect(hashValue('stratify-property-v1', reversed)).toBe(
            hashValue('stratify-property-v1', value),
          );
        },
      ),
    );
  });

  it('always emits the sha256 prefix and 64 lowercase hex characters', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(hashValue('stratify-property-v1', value)).toMatch(/^sha256:[0-9a-f]{64}$/);
      }),
    );
  });
});

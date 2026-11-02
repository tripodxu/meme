import { sha256 } from '@noble/hashes/sha2.js';

import { canonicalize, utf8Bytes } from './jcs.js';

export type HashAlgorithm = 'sha256';

/** 解析后的 hash 摘要；`"sha256:<64 hex>"`。 */
export interface ParsedHash {
  readonly algorithm: HashAlgorithm;
  readonly digest: string;
}

const HASH_PREFIX = 'sha256:';

function toRequestedHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** 对原始字节做 SHA-256，返回小写十六进制。不得用于语义 hash。 */
export function sha256Hex(bytes: Uint8Array): string {
  return toRequestedHex(sha256(bytes));
}

/**
 * 语义 hash：`"sha256:" + lowercaseHex(SHA-256(UTF-8(domain + "\0" + JCS(value))))`。
 *
 * domain 必须以 `stratify-` 开头并带版本号；任何覆盖字段变化都要升级 domain。
 */
export function hashValue(domain: string, value: unknown): string {
  if (!domain.startsWith('stratify-') || domain.includes('\0')) {
    throw new Error(`非法 hash domain: ${JSON.stringify(domain)}`);
  }
  const payload = `${domain}\0${canonicalize(value)}`;
  return HASH_PREFIX + sha256Hex(utf8Bytes(payload));
}

export function parseHash(hash: string): ParsedHash {
  if (!hash.startsWith(HASH_PREFIX)) {
    throw new Error(`非法 hash 前缀: ${hash.slice(0, 16)}`);
  }
  const digest = hash.slice(HASH_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error('hash 摘要必须为 64 位小写十六进制');
  }
  return { algorithm: 'sha256', digest };
}

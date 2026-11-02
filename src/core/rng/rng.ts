import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { errorCodes, StratifyError } from '../control/errors.js';
import { readNumericConstant } from '../params.js';
import { isRegisteredEventTag } from './tags.js';

/** RNG key 的固定首个分量；变化即破坏全部随机流，必须升级规则版本。 */
const RNG_DOMAIN = 'stratify-rng-v1';

/** 取 SHA-256 摘要高 53 位做归一化，避免接近 2^64 的值被 number 舍入。 */
const TWO_POW_NEG_53 = readNumericConstant('TWO_POW_NEG_53');

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new StratifyError(errorCodes.RNG_ADDRESS_INVALID, `${name} 必须是整数`);
  }
}

/** 03 §4.1 的 decimal()：整数直接十进制字符串（含负号）。 */
function decimal(value: number): string {
  return String(value);
}

/**
 * 03 §4.1 长度前缀：每个 UTF-8 分量前写 4 字节无符号大端字节长度，
 * 保证任意分量拼接无歧义。
 *
 * 调用方分量（seed<=256 字符、`a-` 数字 ID 或 "population"、注册表 tag、
 * 整数十进制）在合法输入下远低于 2^32 字节；4 字节长度前缀不会溢出。
 */
function buildKey(components: readonly string[]): Uint8Array {
  const bytes: number[] = [];
  for (const component of components) {
    const encoded = utf8ToBytes(component);
    const length = encoded.length;
    bytes.push(
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    );
    for (const byte of encoded) {
      bytes.push(byte);
    }
  }
  return Uint8Array.from(bytes);
}

/** 从 SHA-256 摘要前 8 字节读大端 uint64 并取高 53 位；仅供测试与实现内部使用。 */
export function unitFromDigest(digest: Uint8Array): number {
  let u = 0n;
  for (let index = 0; index < 8; index += 1) {
    u = (u << 8n) | BigInt(digest[index] ?? 0);
  }
  return Number(u >> 11n) * TWO_POW_NEG_53;
}

/**
 * 可寻址随机数：`R(seed, tick, agentId, eventTag, counter) -> [0,1)`（03 §4.1）。
 *
 * 每个地址独立：增加其他事件不改变本事件的结果。
 * eventTag 必须在 `RNG_EVENT_TAGS` 注册；初始化使用 `tick = -1`。
 */
export function rngUnit(
  seed: string,
  tick: number,
  agentId: string,
  eventTag: string,
  counter: number,
): number {
  if (seed.length === 0) {
    throw new StratifyError(errorCodes.RNG_ADDRESS_INVALID, 'seed 不得为空');
  }
  assertInteger(tick, 'tick');
  if (agentId.length === 0) {
    throw new StratifyError(errorCodes.RNG_ADDRESS_INVALID, 'agentId 不得为空');
  }
  if (!isRegisteredEventTag(eventTag)) {
    throw new StratifyError(errorCodes.RNG_ADDRESS_INVALID, `eventTag 未注册: ${eventTag}`);
  }
  assertInteger(counter, 'counter');
  if (counter < 0) {
    throw new StratifyError(errorCodes.RNG_ADDRESS_INVALID, 'counter 必须为非负整数');
  }
  const key = buildKey([RNG_DOMAIN, seed, decimal(tick), agentId, eventTag, decimal(counter)]);
  return unitFromDigest(sha256(key));
}

export type RngDraw = (eventTag: string, counter: number) => number;

/** 绑定 `(seed, tick, agentId)` 的 draw 闭包；调用方仍需显式传 eventTag/counter。 */
export function createDraw(seed: string, tick: number, agentId: string): RngDraw {
  return (eventTag, counter) => rngUnit(seed, tick, agentId, eventTag, counter);
}

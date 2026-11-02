import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { createDraw, rngUnit, unitFromDigest } from '../../../src/core/rng/rng.js';
import { RNG_EVENT_TAGS } from '../../../src/core/rng/tags.js';

describe('可寻址随机数 R(seed,tick,agentId,eventTag,counter)', () => {
  it('相同地址重复调用结果相同', () => {
    const a = rngUnit('s1', 0, 'a-0000', RNG_EVENT_TAGS.competitionResolve, 0);
    const b = rngUnit('s1', 0, 'a-0000', RNG_EVENT_TAGS.competitionResolve, 0);
    expect(a).toBe(b);
  });

  it('不同 seed/tick/agent/eventTag/counter 产生不同值', () => {
    const base = rngUnit('s1', 0, 'a-0000', RNG_EVENT_TAGS.competitionResolve, 0);
    expect(rngUnit('s2', 0, 'a-0000', RNG_EVENT_TAGS.competitionResolve, 0)).not.toBe(base);
    expect(rngUnit('s1', 1, 'a-0000', RNG_EVENT_TAGS.competitionResolve, 0)).not.toBe(base);
    expect(rngUnit('s1', 0, 'a-0001', RNG_EVENT_TAGS.competitionResolve, 0)).not.toBe(base);
    expect(rngUnit('s1', 0, 'a-0000', RNG_EVENT_TAGS.networkRewire, 0)).not.toBe(base);
    expect(rngUnit('s1', 0, 'a-0000', RNG_EVENT_TAGS.competitionResolve, 1)).not.toBe(base);
  });

  it('结果始终位于 [0,1)', () => {
    for (let counter = 0; counter < 2000; counter += 1) {
      const r = rngUnit('coverage-seed', counter, 'a-0000', RNG_EVENT_TAGS.actionOrder, counter);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
  });

  it('地址独立：消费其他事件不改变本事件结果', () => {
    const before = rngUnit('s1', 5, 'a-0007', RNG_EVENT_TAGS.networkRewire, 0);
    // 模拟其他事件先发生（任何其他地址被消费）
    rngUnit('s1', 5, 'a-0007', RNG_EVENT_TAGS.competitionResolve, 0);
    rngUnit('s1', 5, 'a-0008', RNG_EVENT_TAGS.networkRewire, 3);
    const after = rngUnit('s1', 5, 'a-0007', RNG_EVENT_TAGS.networkRewire, 0);
    expect(after).toBe(before);
  });

  it('初始化使用 tick=-1 且与 tick=0 区分', () => {
    expect(rngUnit('s1', -1, 'a-0000', RNG_EVENT_TAGS.initGe, 0)).not.toBe(
      rngUnit('s1', 0, 'a-0000', RNG_EVENT_TAGS.initGe, 0),
    );
  });

  it('未注册 eventTag 抛出稳定错误', () => {
    expect(() => rngUnit('s1', 0, 'a-0000', 'unregistered_tag', 0)).toThrowError(/eventTag 未注册/);
  });

  it('非法地址输入抛出稳定错误', () => {
    expect(() => rngUnit('', 0, 'a-0000', RNG_EVENT_TAGS.initGe, 0)).toThrowError(/seed/);
    expect(() => rngUnit('s1', 0.5, 'a-0000', RNG_EVENT_TAGS.initGe, 0)).toThrowError(/tick/);
    expect(() => rngUnit('s1', 0, '', RNG_EVENT_TAGS.initGe, 0)).toThrowError(/agentId/);
    expect(() => rngUnit('s1', 0, 'a-0000', RNG_EVENT_TAGS.initGe, -1)).toThrowError(/counter/);
    expect(() => rngUnit('s1', 0, 'a-0000', RNG_EVENT_TAGS.initGe, 1.5)).toThrowError(/counter/);
  });

  it('与独立实现的 key 构造一致（长度前缀 + 高 53 位）', () => {
    // 测试内独立构造 03 §4.1 的 key，不依赖被测代码的 buildKey。
    const components = ['stratify-rng-v1', 's1', '-1', 'a-0000', 'init_ge', '0'];
    const key: number[] = [];
    for (const component of components) {
      const bytes = utf8ToBytes(component);
      const length = bytes.length;
      key.push(
        (length >>> 24) & 0xff,
        (length >>> 16) & 0xff,
        (length >>> 8) & 0xff,
        length & 0xff,
      );
      for (const byte of bytes) key.push(byte);
    }
    const digest = sha256(Uint8Array.from(key));
    let u = 0n;
    for (let index = 0; index < 8; index += 1) {
      u = (u << 8n) | BigInt(digest[index] ?? 0);
    }
    const expected = Number(u >> 11n) / 2 ** 53;
    expect(rngUnit('s1', -1, 'a-0000', RNG_EVENT_TAGS.initGe, 0)).toBe(expected);
  });

  it('摘要全 1 时 R 仍严格小于 1', () => {
    const allOnes = Uint8Array.from({ length: 32 }, () => 0xff);
    const r = unitFromDigest(allOnes);
    expect(r).toBeLessThan(1);
    expect(r).toBeGreaterThanOrEqual(0);
    // 高 53 位全 1 → (2^53-1)/2^53
    expect(r).toBe((2 ** 53 - 1) / 2 ** 53);
  });

  it('createDraw 绑定地址上下文', () => {
    const draw = createDraw('s1', 3, 'a-0002');
    expect(draw(RNG_EVENT_TAGS.actionOrder, 0)).toBe(
      rngUnit('s1', 3, 'a-0002', RNG_EVENT_TAGS.actionOrder, 0),
    );
  });
});

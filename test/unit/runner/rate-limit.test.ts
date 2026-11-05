import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';

import { defaultSleep, RateLimiter } from '../../../src/runner/rate-limit.js';

describe('RateLimiter（P5-02）', () => {
  it('正常睡眠结束后不残留 abort 监听器', async () => {
    const controller = new AbortController();
    await defaultSleep(1, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('睡眠期间 abort 会拒绝', async () => {
    const controller = new AbortController();
    const sleeping = defaultSleep(1000, controller.signal);
    controller.abort();
    await expect(sleeping).rejects.toThrow(/取消/);
  });

  it('并发上限与最小间隔生效，release 后可再次取得时隙', async () => {
    const limiter = new RateLimiter({
      maxConcurrent: 1,
      minIntervalMs: 0,
      nowMs: () => 0,
      sleep: async () => undefined,
    });
    const first = await limiter.acquire();
    expect(limiter.activeCount).toBe(1);
    const pending = limiter.acquire();
    first();
    const second = await pending;
    expect(limiter.activeCount).toBe(1);
    second();
    expect(limiter.activeCount).toBe(0);
  });

  it('已取消的 signal 在 acquire 时立即拒绝', async () => {
    const controller = new AbortController();
    controller.abort();
    const limiter = new RateLimiter({ maxConcurrent: 1, minIntervalMs: 0 });
    await expect(limiter.acquire(controller.signal)).rejects.toThrow(/取消/);
  });
});

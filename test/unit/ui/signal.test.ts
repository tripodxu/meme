import { describe, expect, it, vi } from 'vitest';

import { batch, computed, effect, signal } from '../../../src/ui/state/signal.js';

describe('signal 响应式原语（F2）', () => {
  it('支持读写、Object.is 去重与 computed 派生', () => {
    const count = signal(1);
    const doubled = computed(() => count.get() * 2);
    expect(doubled.get()).toBe(2);

    const spy = vi.fn();
    doubled.subscribe(spy);

    count.set(1);
    expect(spy).not.toHaveBeenCalled();

    count.set(3);
    expect(doubled.get()).toBe(6);
    expect(spy).toHaveBeenCalledWith(6);
  });

  it('batch 合并多次更新后的 effect 触发', () => {
    const a = signal(1);
    const b = signal(2);
    const spy = vi.fn();
    const stop = effect(() => {
      spy(a.get() + b.get());
    });
    expect(spy).toHaveBeenCalledTimes(1);

    batch(() => {
      a.set(10);
      b.set(20);
    });
    expect(spy).toHaveBeenLastCalledWith(30);
    stop();
  });
});

export interface ReadonlySignal<T> {
  get(): T;
  subscribe(listener: (value: T) => void): () => void;
}

export interface Signal<T> extends ReadonlySignal<T> {
  set(next: T): void;
  update(updater: (prev: T) => T): void;
}

interface TrackingContext {
  readonly deps: Set<SignalNode<unknown>>;
  readonly notify: () => void;
}

let activeContext: TrackingContext | null = null;
let batchDepth = 0;
const pendingEffects = new Set<() => void>();

class SignalNode<T> {
  private value: T;
  private readonly listeners = new Set<(value: T) => void>();
  private readonly observers = new Set<TrackingContext>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    if (activeContext !== null) {
      activeContext.deps.add(this as SignalNode<unknown>);
      this.observers.add(activeContext);
    }
    return this.value;
  }

  set(next: T): void {
    if (Object.is(this.value, next)) return;
    this.value = next;
    this.emit();
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  unsubscribeObserver(ctx: TrackingContext): void {
    this.observers.delete(ctx);
  }

  private emit(): void {
    const observers = [...this.observers];
    const listeners = [...this.listeners];
    const run = (): void => {
      for (const observer of observers) observer.notify();
      for (const listener of listeners) listener(this.value);
    };
    if (batchDepth > 0) {
      pendingEffects.add(run);
    } else {
      run();
    }
  }
}

export function signal<T>(initial: T): Signal<T> {
  const node = new SignalNode(initial);
  return {
    get: () => node.get(),
    set: (next) => node.set(next),
    update: (updater) => node.set(updater(node.get())),
    subscribe: (listener) => node.subscribe(listener),
  };
}

export function batch(fn: () => void): void {
  batchDepth += 1;
  try {
    fn();
  } finally {
    batchDepth -= 1;
    if (batchDepth === 0 && pendingEffects.size > 0) {
      const queue = [...pendingEffects];
      pendingEffects.clear();
      for (const run of queue) run();
    }
  }
}

export function effect(fn: () => void | (() => void)): () => void {
  let cleanup: void | (() => void);
  let disposed = false;
  const ctx: TrackingContext = {
    deps: new Set(),
    notify: () => {
      if (!disposed) execute();
    },
  };

  const clearDeps = (): void => {
    for (const dep of ctx.deps) dep.unsubscribeObserver(ctx);
    ctx.deps.clear();
  };

  const execute = (): void => {
    if (typeof cleanup === 'function') cleanup();
    clearDeps();
    const prev = activeContext;
    activeContext = ctx;
    try {
      cleanup = fn();
    } finally {
      activeContext = prev;
    }
  };

  execute();
  return () => {
    disposed = true;
    if (typeof cleanup === 'function') cleanup();
    clearDeps();
  };
}

export function computed<T>(fn: () => T): ReadonlySignal<T> {
  let initialized = false;
  const out = signal<T>(undefined as unknown as T);
  const stop = effect(() => {
    const next = fn();
    if (!initialized) {
      initialized = true;
      out.set(next);
    } else {
      out.set(next);
    }
  });
  return {
    get: () => out.get(),
    subscribe: (listener) => {
      const unsub = out.subscribe(listener);
      return () => {
        unsub();
        // 保持计算节点活跃直至显式停止；此处仅取消订阅
        void stop;
      };
    },
  };
}

import { errorCodes, StratifyError } from '../core/control/errors.js';

/**
 * P5-02：批内限流（01 §8.1；docs/09 §6 JEV_CONCURRENCY）。
 *
 * 两个正交约束：
 * - `maxConcurrent`：在途 live 调用数上限（信号量）；
 * - `minIntervalMs`：相邻两次调用**开始**时刻的最小间隔（全局限速，
 *   429/5xx 重试语义仍由 P2-04 的 client 负责，本层只管批次级节奏）。
 *
 * 单机单进程内使用；`nowMs`/`sleep` 可注入以便确定性测试
 * （生产路径 `Date.now` + `setTimeout`，sleep 必须响应 AbortSignal）。
 */
export interface RateLimiterOptions {
  /** 在途调用上限；>=1。 */
  readonly maxConcurrent: number;
  /** 相邻调用开始的最小间隔毫秒；>=0（0 = 只限并发不限速）。 */
  readonly minIntervalMs: number;
  /** 时钟与睡眠注入；缺省生产实现。 */
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RateLimitRelease {
  (): void;
}

const defaultNowMs = (): number => Date.now();

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StratifyError(errorCodes.INVARIANT_VIOLATED, 'rate limiter sleep 被取消'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new StratifyError(errorCodes.INVARIANT_VIOLATED, 'rate limiter sleep 被取消'));
      },
      { once: true },
    );
  });

export class RateLimiter {
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private inFlight = 0;
  private lastStartMs = Number.NEGATIVE_INFINITY;
  private readonly waiters: Array<() => void> = [];

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new TypeError('RateLimiter.maxConcurrent 必须为 >=1 的整数');
    }
    if (!Number.isFinite(options.minIntervalMs) || options.minIntervalMs < 0) {
      throw new TypeError('RateLimiter.minIntervalMs 必须为 >=0 的有限数');
    }
    this.maxConcurrent = options.maxConcurrent;
    this.minIntervalMs = options.minIntervalMs;
    this.nowMs = options.nowMs ?? defaultNowMs;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** 当前在途调用数（诊断）。 */
  get activeCount(): number {
    return this.inFlight;
  }

  /**
   * 取得一个调用时隙；返回 release 回调（调用结束必须调用，含失败路径）。
   * 等待期间 signal 取消则拒绝且不占用时隙。
   *
   * 实现注意：睡眠与领用时隙不能在同一轮里做完——睡眠后必须回到循环头重读
   * `inFlight`/`lastStartMs`（另一 acquirer 可能已在我们睡眠期间启动），
   * 领用动作（检查到赋值）之间不得插入 await，保证单线程原子。
   */
  async acquire(signal?: AbortSignal): Promise<RateLimitRelease> {
    if (signal?.aborted) {
      throw new StratifyError(errorCodes.INVARIANT_VIOLATED, 'rate limiter acquire 被取消');
    }
    for (;;) {
      if (signal?.aborted) {
        throw new StratifyError(errorCodes.INVARIANT_VIOLATED, 'rate limiter acquire 被取消');
      }
      if (this.inFlight < this.maxConcurrent) {
        const earliest =
          this.lastStartMs === Number.NEGATIVE_INFINITY ? 0 : this.lastStartMs + this.minIntervalMs;
        const waitMs = Math.max(0, earliest - this.nowMs());
        if (waitMs > 0) {
          await this.sleep(waitMs, signal);
          continue;
        }
        this.inFlight += 1;
        this.lastStartMs = this.nowMs();
        let released = false;
        return () => {
          if (released) {
            return;
          }
          released = true;
          this.inFlight = Math.max(0, this.inFlight - 1);
          this.notifyNext();
        };
      }
      await this.waitForSlot(signal);
    }
  }

  private waitForSlot(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(wake);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new StratifyError(errorCodes.INVARIANT_VIOLATED, 'rate limiter acquire 被取消'));
      };
      const wake = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private notifyNext(): void {
    const wake = this.waiters.shift();
    if (wake !== undefined) {
      wake();
    }
  }
}

/**
 * 将 fetch 包上层限流（P2-04 `JevClientDeps.fetchImpl` 注入缝）：
 * 每次 HTTP 调用先 acquire，完成/失败后 release，使 client 的重试也在批次限速内。
 * acquire 被取消（signal abort）时抛错，client 按 transport 失败处理。
 */
export function rateLimitedFetch(limiter: RateLimiter): (fetchImpl: typeof fetch) => typeof fetch {
  return (fetchImpl: typeof fetch) =>
    (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const signal = init?.signal;
      const release = await limiter.acquire(signal ?? undefined);
      try {
        return await fetchImpl(input, init);
      } finally {
        release();
      }
    }) as typeof fetch;
}

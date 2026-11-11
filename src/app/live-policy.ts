import { StratifyError, errorCodes } from '../core/control/errors.js';
import type { DecisionPolicy } from '../decision/policy.js';
import {
  AttemptBudget,
  JevLivePolicy,
  SlidingCircuitWindow,
  SlidingFallbackRateWindow,
} from '../decision/live.js';

/**
 * 浏览器 live 策略：只经同源 `/api/jev` 代理，Key 仅存在内存与请求头。
 *
 * - 不读 localStorage/IndexedDB，不写日志，不进入导出 bundle；
 * - 端点固定为当前 origin 的 `/api/jev`（测试可注入），不能由用户填写；
 * - 预算/截止时间/熔断/回退率全部启用；jitter 固定 0，避免 Math.random。
 */
export interface BrowserLiveOptions {
  readonly apiKey: string;
  readonly model: string;
  /** 总调用上限（跨 run 内所有个体决策）。 */
  readonly maxCalls: number;
  /** 估算 input token 上限。 */
  readonly maxInputTokens: number;
  /** run 级绝对截止（分钟）；到点停止新调用。 */
  readonly maxRunMinutes: number;
  /** 仅测试使用；生产固定同源 `/api/jev`。 */
  readonly endpoint?: string;
}

export interface BrowserLivePolicyView {
  readonly policy: DecisionPolicy;
  readonly endpoint: string;
  readonly budget: AttemptBudget;
}

export function createBrowserLivePolicy(options: BrowserLiveOptions): BrowserLivePolicyView {
  if (options.apiKey.length === 0) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'live 策略需要 API Key（仅保存在内存）');
  }
  if (!Number.isInteger(options.maxCalls) || options.maxCalls < 1) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'live maxCalls 必须为正整数');
  }
  if (!Number.isInteger(options.maxInputTokens) || options.maxInputTokens < 1) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'live maxInputTokens 必须为正整数');
  }
  if (!Number.isFinite(options.maxRunMinutes) || options.maxRunMinutes <= 0) {
    throw new StratifyError(errorCodes.CONFIG_INVALID, 'live maxRunMinutes 必须为正数');
  }
  const endpoint =
    options.endpoint ??
    (typeof window === 'undefined'
      ? '/api/jev'
      : new URL('/api/jev', window.location.origin).toString());
  const budget = new AttemptBudget(options.maxCalls, options.maxInputTokens);
  const policy = new JevLivePolicy(
    options.apiKey,
    {
      endpoint,
      requestTimeoutMs: 30_000,
      maxTotalAttempts: 2,
      networkRetryLimit: 1,
      rateLimitRetryLimit: 0,
      serverErrorRetryLimit: 0,
      baseBackoffMs: 500,
      jitterMs: () => 0,
      deadlineMs: Date.now() + options.maxRunMinutes * 60_000,
      budget,
      failureWindow: new SlidingCircuitWindow(20),
      fallbackRateWindow: new SlidingFallbackRateWindow(100, 0.2),
    },
    {
      fetchImpl: (input, init) => fetch(input, init),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      nowMs: () => Date.now(),
    },
  );
  return { policy, endpoint, budget };
}

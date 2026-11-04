import { errorCodes, StratifyError } from '../core/control/errors.js';
import type { DecisionInput, DecisionPolicy } from './policy.js';
import {
  callJev,
  type CircuitFailureWindow,
  type FallbackRateWindow,
  type JevBudget,
  type JevClientDeps,
  type JevClientOptions,
} from './jev-client.js';
import type { DecisionRecord } from './types.js';

/**
 * P2-01/05：live 策略适配器——把 `DecisionPolicy` 接到 Jev HTTP 客户端。
 * 共享的熔断/回退率/预算视图由 run 级注入（04 §6/§7：多 worker 共享一套额度）。
 */

export class SlidingCircuitWindow implements CircuitFailureWindow {
  private readonly recent: boolean[] = [];
  private consecutive = 0;

  constructor(private readonly windowSize = 20) {}

  recordTransportFailure(): void {
    this.recent.push(true);
    if (this.recent.length > this.windowSize) {
      this.recent.shift();
    }
    this.consecutive += 1;
  }

  recordSuccess(): void {
    this.recent.push(false);
    if (this.recent.length > this.windowSize) {
      this.recent.shift();
    }
    this.consecutive = 0;
  }

  get open(): boolean {
    const failures = this.recent.filter((failed) => failed).length;
    return failures >= 10 || this.consecutive >= 5;
  }
}

export class SlidingFallbackRateWindow implements FallbackRateWindow {
  private readonly recent: boolean[] = [];

  constructor(
    private readonly windowSize = 100,
    private readonly threshold = 0.2,
  ) {}

  recordFallback(): void {
    this.recent.push(true);
    if (this.recent.length > this.windowSize) {
      this.recent.shift();
    }
  }

  recordDue(): void {
    this.recent.push(false);
    if (this.recent.length > this.windowSize) {
      this.recent.shift();
    }
  }

  get exceeded(): boolean {
    if (this.recent.length === 0) {
      return false;
    }
    const fallbacks = this.recent.filter((fellBack) => fellBack).length;
    return fallbacks / this.recent.length > this.threshold;
  }
}

/**
 * Token 型调用预算（04 §7）：每次 attempt 原子预留 1 call + 估算 input tokens；
 * 成功按实际 usage 核销，失败/取消/usage 缺失保留预留；实际超出估算记 overage
 * 并立即停止新调用。
 */
export class AttemptBudget implements JevBudget {
  private remaining: number;
  private spentTokens = 0;
  private reservedTokens = 0;
  private overageDetected = false;
  usageUnknownCount = 0;

  constructor(
    maxCalls: number,
    private readonly maxInputTokens: number,
  ) {
    this.remaining = maxCalls;
  }

  reserve(estimatedInputTokens: number): boolean {
    if (this.exhausted) {
      return false;
    }
    if (this.spentTokens + this.reservedTokens + estimatedInputTokens > this.maxInputTokens) {
      return false;
    }
    this.remaining -= 1;
    this.reservedTokens += estimatedInputTokens;
    return true;
  }

  settle(reservedInputTokens: number, actualInputTokens: number): void {
    this.releaseReservation(reservedInputTokens);
    this.spentTokens += actualInputTokens;
    if (actualInputTokens > reservedInputTokens) {
      this.overageDetected = true;
    }
  }

  keepReserved(reservedInputTokens: number): void {
    this.releaseReservation(reservedInputTokens);
    this.spentTokens += reservedInputTokens;
  }

  recordUsageUnknown(): void {
    this.usageUnknownCount += 1;
  }

  get exhausted(): boolean {
    return (
      this.remaining <= 0 ||
      this.overageDetected ||
      this.spentTokens + this.reservedTokens >= this.maxInputTokens
    );
  }

  get overage(): boolean {
    return this.overageDetected;
  }

  /** 在途预留（诊断/测试）：必须最终归零，否则说明有 attempt 漏结算。 */
  get inFlightTokens(): number {
    return this.reservedTokens;
  }

  private releaseReservation(tokens: number): void {
    this.reservedTokens = Math.max(0, this.reservedTokens - tokens);
  }
}

export class JevLivePolicy implements DecisionPolicy {
  readonly policyVersion = 'jev-choice-v1';

  constructor(
    private readonly apiKey: string,
    private readonly options: JevClientOptions,
    private readonly deps: JevClientDeps,
  ) {
    if (apiKey.length === 0) {
      throw new StratifyError(errorCodes.CONFIG_INVALID, 'live 策略需要 API Key（不落日志）');
    }
  }

  async decide(input: DecisionInput, signal: AbortSignal): Promise<DecisionRecord> {
    const result = await callJev(
      input,
      this.apiKey,
      this.options,
      this.deps,
      input.promptStyle,
      signal,
    );
    const reason = result.record.fallbackReason;
    if (reason === 'http_401' || reason === 'http_403') {
      // 04 §5/§6：认证/权限失败必须立即停止 live run，不能让所有个体静默 accumulate。
      // 错误消息不得包含 Key 内容。
      throw new StratifyError(
        errorCodes.JEV_AUTH_FAILED,
        `Jev 认证失败（${reason}），已停止 live run；请检查 API Key 与权限`,
      );
    }
    // 04 §6：熔断打开或回退率超阈值时暂停 run，而不是逐个体回退后继续模拟。
    if (this.options.failureWindow.open) {
      throw new StratifyError(
        errorCodes.JEV_CIRCUIT_OPEN,
        'Jev transport 失败熔断已打开，已暂停 live run',
      );
    }
    if (this.options.fallbackRateWindow.exceeded) {
      throw new StratifyError(
        errorCodes.JEV_FALLBACK_RATE_EXCEEDED,
        '最近 100 个到期决策回退率超过阈值，实验无效，已暂停 live run',
      );
    }
    if (reason === 'usage_missing') {
      throw new StratifyError(
        errorCodes.JEV_USAGE_MISSING,
        '上游响应缺少 usage，已按预留结算并暂停 live run',
      );
    }
    if (reason === 'budget_exhausted') {
      throw new StratifyError(
        errorCodes.JEV_BUDGET_EXHAUSTED,
        'Jev 调用/token 预算耗尽，已停止新调用',
      );
    }
    return result.record;
  }
}

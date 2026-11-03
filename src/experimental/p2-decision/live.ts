import { errorCodes, StratifyError } from '../../core/control/errors.js';
import type { DecisionInput, DecisionPolicy } from './policy.js';
import {
  callJev,
  type CircuitFailureWindow,
  type FallbackRateWindow,
  type JevBudget,
  type JevClientDeps,
  type JevClientOptions,
} from './jev-client.js';
import type { DecisionRecord } from '../../decision/types.js';

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

/** Token 型调用预算（04 §7）：按 attempt 计数；input token 预算由累计核销。 */
export class AttemptBudget implements JevBudget {
  private remaining: number;
  private spentTokens = 0;

  constructor(
    maxCalls: number,
    private readonly maxInputTokens: number,
  ) {
    this.remaining = maxCalls;
  }

  reserve(): boolean {
    if (this.remaining <= 0 || this.spentTokens >= this.maxInputTokens) {
      return false;
    }
    this.remaining -= 1;
    return true;
  }

  settle(inputTokens: number): void {
    this.spentTokens += inputTokens;
  }

  keepReserved(): void {}

  get exhausted(): boolean {
    return this.remaining <= 0 || this.spentTokens >= this.maxInputTokens;
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
    return result.record;
  }
}

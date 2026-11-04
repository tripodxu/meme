import { AttemptBudget, type AttemptBudgetUsage } from '../decision/live.js';
import type { JevBudget } from '../decision/jev-client.js';

/**
 * P5-02：批内共享预算（01 §8.1「多 worker 不突破调用/Token/费用上限」）。
 *
 * 与 `AttemptBudget`（run 级，P2-05）的区别：一个批跑进程内的**所有**并发 live run
 * 共用同一记账对象——总调用数与总 input token 不随 run 数放大（04 §7 批量口径）。
 *
 * - MVP 单机单进程：本进程即调度进程（docs/09 §6「由一个调度进程统一记账」），
 *   reserve/settle/keepReserved 是单线程同步操作，无需跨进程锁；
 *   多进程 `budget.sqlite` WAL 记账、多主机分片均不在 MVP（docs/09 §6 明确排除）；
 * - fail-closed 语义与 `AttemptBudget` 完全一致（委托实现，不复制第二套记账逻辑）：
 *   `overageDetected` 后**永久** exhausted（估算器低估即全部估算不可信，04 §7）；
 * - `exhausted` 后批次执行器必须停止发起新 run（G5a「预算耗尽」故障注入口径），
 *   已在途 run 由其自身调用时的 reserve 失败语义停止新调用。
 */
export class SharedBatchBudget implements JevBudget {
  private readonly inner: AttemptBudget;

  constructor(
    readonly maxCalls: number,
    maxInputTokens: number,
  ) {
    if (!Number.isInteger(maxCalls) || maxCalls < 1) {
      throw new TypeError('SharedBatchBudget.maxCalls 必须为 >=1 的整数');
    }
    if (!Number.isInteger(maxInputTokens) || maxInputTokens < 1) {
      throw new TypeError('SharedBatchBudget.maxInputTokens 必须为 >=1 的整数');
    }
    this.inner = new AttemptBudget(maxCalls, maxInputTokens);
  }

  reserve(estimatedInputTokens: number): boolean {
    return this.inner.reserve(estimatedInputTokens);
  }

  settle(reservedInputTokens: number, actualInputTokens: number): void {
    this.inner.settle(reservedInputTokens, actualInputTokens);
  }

  keepReserved(reservedInputTokens: number): void {
    this.inner.keepReserved(reservedInputTokens);
  }

  recordUsageUnknown(): void {
    this.inner.recordUsageUnknown();
  }

  get exhausted(): boolean {
    return this.inner.exhausted;
  }

  /** 在途预留诊断：批结束时必须归零，否则有 attempt 漏结算。 */
  get inFlightTokens(): number {
    return this.inner.inFlightTokens;
  }

  usage(): AttemptBudgetUsage {
    return this.inner.usage();
  }
}

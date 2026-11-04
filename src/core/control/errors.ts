/**
 * 稳定错误码。公共错误包含稳定 code、可读 message 与可选 details。
 * 不得把堆栈、Key、writeToken 放入 details。
 */
export const errorCodes = {
  CONFIG_INVALID: 'config_invalid',
  CONFIG_UNKNOWN_VERSION: 'config_unknown_version',
  CONFIG_NON_FINITE: 'config_non_finite',
  CONFIG_OUT_OF_RANGE: 'config_out_of_range',
  CONFIG_PATH: 'config_path',
  INVARIANT_VIOLATED: 'invariant_violated',
  HASH_NON_CANONICAL: 'hash_non_canonical',
  HASH_INVALID: 'hash_invalid',
  HASH_DOMAIN_INVALID: 'hash_domain_invalid',
  ID_INVALID: 'id_invalid',
  RNG_ADDRESS_INVALID: 'rng_address_invalid',
  PARAM_UNKNOWN: 'param_unknown',
  PARAM_OUT_OF_RANGE: 'param_out_of_range',
  PARAM_READ_ONLY: 'param_read_only',
  /** P2 live：Jev 认证/权限失败；必须停止 live run，不得静默回退（04 §5/§6）。 */
  JEV_AUTH_FAILED: 'jev_auth_failed',
  /** P2 live：transport 失败熔断打开；暂停 run（04 §6）。 */
  JEV_CIRCUIT_OPEN: 'jev_circuit_open',
  /** P2 live：回退率超过阈值；实验无效并暂停（04 §6）。 */
  JEV_FALLBACK_RATE_EXCEEDED: 'jev_fallback_rate_exceeded',
  /** P2 live：响应缺少 usage；按预留结算并暂停（04 §7）。 */
  JEV_USAGE_MISSING: 'jev_usage_missing',
  /** P2 live：调用/token 预算耗尽；停止新调用（04 §7）。 */
  JEV_BUDGET_EXHAUSTED: 'jev_budget_exhausted',
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];

export interface ErrorDetail {
  readonly path?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export class StratifyError extends Error {
  readonly code: ErrorCode;
  readonly details: readonly ErrorDetail[];

  constructor(code: ErrorCode, message: string, details: readonly ErrorDetail[] = []) {
    super(message);
    this.name = 'StratifyError';
    this.code = code;
    this.details = details;
  }
}

export function isStratifyError(error: unknown): error is StratifyError {
  return error instanceof StratifyError;
}

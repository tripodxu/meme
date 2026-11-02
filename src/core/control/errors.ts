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

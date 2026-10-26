export const DOMAIN_ERROR_CODES = [
  "INVALID_INPUT",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "CAPABILITY_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];
export type SafeDetailValue = string | number | boolean | null;
export type SafeErrorDetails = Readonly<Record<string, SafeDetailValue>>;

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly retryable: boolean;
  readonly details?: SafeErrorDetails;

  constructor(
    code: DomainErrorCode,
    message: string,
    retryable = false,
    details?: SafeErrorDetails,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import {
  DomainError,
  type DomainErrorCode,
  type SafeErrorDetails,
  type SafeDetailValue,
} from "../domain/errors.js";
import { isSecretLikeKey } from "../domain/secrets.js";

const safeMessages = {
  INVALID_INPUT: "Invalid input",
  NOT_FOUND: "Resource not found",
  CONFLICT: "Resource conflict",
  IDEMPOTENCY_CONFLICT: "Idempotency conflict",
  CAPABILITY_UNAVAILABLE: "Capability unavailable",
  INTERNAL_ERROR: "Internal server error",
} satisfies Record<DomainErrorCode, string>;

function safeDetails(
  details: SafeErrorDetails | undefined,
): SafeErrorDetails | undefined {
  if (!details) return undefined;

  const safeEntries: [string, SafeDetailValue][] = [];
  for (const [key, value] of Object.entries(details)) {
    if (
      !isSecretLikeKey(key) &&
      (value === null ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && value.length <= 1_024))
    ) {
      safeEntries.push([key, value]);
    }
  }

  return Object.freeze(Object.fromEntries(safeEntries));
}

export function toMcpError(error: unknown): McpError {
  if (error instanceof ZodError) {
    return new McpError(
      ErrorCode.InvalidParams,
      "Input validation error",
      { code: "INVALID_INPUT", retryable: false },
    );
  }
  if (!(error instanceof DomainError) || error.code === "INTERNAL_ERROR") {
    return new McpError(
      ErrorCode.InternalError,
      safeMessages.INTERNAL_ERROR,
      {
        code: "INTERNAL_ERROR",
        retryable: false,
      },
    );
  }

  return new McpError(
    error.code === "INVALID_INPUT"
      ? ErrorCode.InvalidParams
      : ErrorCode.InternalError,
    safeMessages[error.code],
    {
      code: error.code,
      retryable: error.retryable,
      details: safeDetails(error.details),
    },
  );
}

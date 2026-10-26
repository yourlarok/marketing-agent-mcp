import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  DomainError,
  type SafeErrorDetails,
  type SafeDetailValue,
} from "../domain/errors.js";

const internalErrorMessage = "Internal server error";
const secretKeyPattern =
  /(?:^|[^a-z0-9])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credentials?|pass(?:wd|word)|private[_-]?key|secrets?|token)(?:$|[^a-z0-9])/i;

function safeDetails(details: SafeErrorDetails | undefined): SafeErrorDetails | undefined {
  if (!details) return undefined;

  const safeEntries: [string, SafeDetailValue][] = [];
  for (const [key, value] of Object.entries(details)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const secretLike =
      secretKeyPattern.test(key) ||
      /(?:apikey|accesstoken|refreshtoken|authorization|cookie|credentials?|passwd|password|privatekey|secrets?|token)$/.test(
        normalizedKey,
      );

    if (
      !secretLike &&
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
  if (!(error instanceof DomainError) || error.code === "INTERNAL_ERROR") {
    return new McpError(ErrorCode.InternalError, internalErrorMessage, {
      code: "INTERNAL_ERROR",
      retryable: false,
    });
  }

  return new McpError(
    error.code === "INVALID_INPUT"
      ? ErrorCode.InvalidParams
      : ErrorCode.InternalError,
    error.message,
    {
      code: error.code,
      retryable: error.retryable,
      details: safeDetails(error.details),
    },
  );
}

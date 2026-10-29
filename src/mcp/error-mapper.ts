import {
  type CallToolResult,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import {
  DomainError,
  type DomainErrorCode,
  type SafeErrorDetails,
  type SafeDetailValue,
} from "../domain/errors.js";
import { isSecretLikeKey } from "../domain/secrets.js";
import { toolOutputJson } from "./results.js";

const safeMessages = {
  INVALID_INPUT: "Invalid input",
  NOT_FOUND: "Resource not found",
  CONFLICT: "Resource conflict",
  IDEMPOTENCY_CONFLICT: "Idempotency conflict",
  CAPABILITY_UNAVAILABLE: "Capability unavailable",
  INTERNAL_ERROR: "Internal server error",
} satisfies Record<DomainErrorCode, string>;

const ANALYTICS_CONFIGURATION_ACTION =
  "Configure MARKETING_ANALYTICS_MCP_COMMAND and MARKETING_ANALYTICS_MCP_ARGS in the trusted deployment environment";
const BENCHMARK_CONFIGURATION_ACTION =
  "Configure MARKETING_BENCHMARK_MCP_COMMAND and MARKETING_BENCHMARK_MCP_ARGS in the trusted deployment environment";
const MEDIA_CONFIGURATION_ACTION =
  "Configure MARKETING_MEDIA_MCP_COMMAND and MARKETING_MEDIA_MCP_ARGS in the trusted deployment environment";
const PROBE_CONFIGURATION_ACTION =
  "Configure MARKETING_FFPROBE_COMMAND as an absolute deployment-controlled executable path";
const SQLITE_CONFIGURATION_ACTION =
  "Configure MARKETING_DATABASE_ROOT in the trusted deployment environment";
const ANALYTICS_GAP_REASONS = new Set([
  "mcp_not_configured",
  "mcp_cleanup_failed",
  "mcp_timeout",
  "mcp_unavailable",
  "mcp_invalid_response",
  "mcp_input_hash_mismatch",
  "mcp_response_too_large",
  "mcp_result_mismatch",
]);
const BENCHMARK_GAP_REASONS = new Set([
  "mcp_not_configured",
  "mcp_cleanup_failed",
  "mcp_timeout",
  "mcp_unavailable",
  "mcp_invalid_response",
  "mcp_input_hash_mismatch",
  "mcp_response_too_large",
  "image_observation_missing",
  "video_frames_missing",
  "asr_transcript_missing",
  "video_understanding_missing",
]);
const MEDIA_GAP_REASONS = new Set([
  "mcp_not_configured",
  "mcp_cleanup_failed",
  "mcp_timeout",
  "mcp_unavailable",
  "mcp_invalid_response",
  "mcp_input_hash_mismatch",
  "mcp_response_too_large",
  "mcp_result_mismatch",
  "chromium_unavailable",
  "chromium_cleanup_failed",
  "image_decode_failed",
  "media_dimensions_mismatch",
  "media_format_mismatch",
]);
const PROBE_GAP_REASONS = new Set([
  "ffprobe_not_configured",
  "ffprobe_unavailable",
  "ffprobe_timeout",
  "ffprobe_output_too_large",
  "ffprobe_failed",
  "ffprobe_invalid_response",
  "ffprobe_cleanup_failed",
  "media_codec_mismatch",
  "media_dimensions_mismatch",
  "media_format_mismatch",
  "media_duration_mismatch",
]);

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

function safeCapabilityDetails(
  details: SafeErrorDetails | undefined,
): SafeErrorDetails | undefined {
  const safe: Record<string, string> = {};
  if (details?.capability === "professional_analytics") {
    safe.capability = "professional_analytics";
    safe.configurationAction = ANALYTICS_CONFIGURATION_ACTION;
    if (typeof details.reason === "string" && ANALYTICS_GAP_REASONS.has(details.reason)) {
      safe.reason = details.reason;
    }
  } else if (details?.capability === "benchmark_reverse") {
    safe.capability = "benchmark_reverse";
    safe.configurationAction = BENCHMARK_CONFIGURATION_ACTION;
    if (typeof details.reason === "string" && BENCHMARK_GAP_REASONS.has(details.reason)) {
      safe.reason = details.reason;
    }
  } else if (details?.capability === "professional_media") {
    safe.capability = "professional_media";
    safe.configurationAction = MEDIA_CONFIGURATION_ACTION;
    if (typeof details.reason === "string" && MEDIA_GAP_REASONS.has(details.reason)) {
      safe.reason = details.reason;
    }
  } else if (details?.capability === "video_probe") {
    safe.capability = "video_probe";
    safe.configurationAction = PROBE_CONFIGURATION_ACTION;
    if (typeof details.reason === "string" && PROBE_GAP_REASONS.has(details.reason)) {
      safe.reason = details.reason;
    }
  } else if (details?.capability === "sqlite") {
    safe.capability = "sqlite";
    safe.configurationAction = SQLITE_CONFIGURATION_ACTION;
  }
  return Object.keys(safe).length > 0 ? Object.freeze(safe) : undefined;
}

export function toCapabilityGapResult(error: unknown): CallToolResult | undefined {
  if (!(error instanceof DomainError) || error.code !== "CAPABILITY_UNAVAILABLE") {
    return undefined;
  }
  const gap = {
    code: error.code,
    message: safeMessages.CAPABILITY_UNAVAILABLE,
    retryable: error.retryable,
    ...safeCapabilityDetails(error.details),
  };
  return {
    isError: true,
    content: [{ type: "text", text: toolOutputJson(gap) }],
    structuredContent: gap,
  };
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
      details: error.code === "CAPABILITY_UNAVAILABLE"
        ? safeCapabilityDetails(error.details)
        : safeDetails(error.details),
    },
  );
}

import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import {
  computeAnalyticsReference,
  validateAnalyticsOperation,
  validateAnalyticsResult,
  type AnalyticsOperation,
  type AnalyticsResult,
  type AnalyticsRow,
} from "../domain/analytics-model.js";
import { DomainError } from "../domain/errors.js";
import { canonicalJson } from "./sqlite.js";

export const ANALYTICS_PROVIDER_LIMITS = {
  maxRows: 100_000,
  maxResponseBytes: 16 * 1024 * 1024,
  timeoutMs: 15_000,
} as const;

const CONFIGURATION_ACTION =
  "Configure MARKETING_ANALYTICS_MCP_COMMAND and MARKETING_ANALYTICS_MCP_ARGS in the trusted deployment environment";

const responseSchema = z.strictObject({
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.unknown(),
});

export interface AnalyticsProviderRequest {
  operation: AnalyticsOperation;
  rows: readonly AnalyticsRow[];
}

export interface AnalyticsProviderResponse {
  result: AnalyticsResult;
  inputHash: string;
  toolVersion: string;
}

export interface AnalyticsProvider {
  analyze(request: AnalyticsProviderRequest): Promise<AnalyticsProviderResponse>;
}

export interface McpAnalyticsProviderOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  envAllowlist?: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function capabilityGap(reason: string, message: string, retryable = false): DomainError {
  return new DomainError("CAPABILITY_UNAVAILABLE", message, retryable, {
    capability: "professional_analytics",
    reason,
    configurationAction: CONFIGURATION_ACTION,
  });
}

export class McpAnalyticsProvider implements AnalyticsProvider {
  constructor(private readonly options: McpAnalyticsProviderOptions) {
    if (options.command !== undefined && options.command.trim().length === 0) {
      throw new DomainError("INVALID_INPUT", "Professional analytics MCP command must not be empty");
    }
  }

  async analyze(request: AnalyticsProviderRequest): Promise<AnalyticsProviderResponse> {
    if (!this.options.command) {
      throw capabilityGap("mcp_not_configured", "Professional analytics MCP is not configured");
    }
    validateAnalyticsOperation(request.operation);
    if (!Array.isArray(request.rows) || request.rows.length > ANALYTICS_PROVIDER_LIMITS.maxRows) {
      throw new DomainError("INVALID_INPUT", "Professional analytics rows exceed the bounded row limit");
    }
    const expected = computeAnalyticsReference(request.operation, request.rows);
    const input = { operation: request.operation, rows: request.rows };
    const canonicalInput = canonicalJson(input);
    const inputHash = createHash("sha256").update(canonicalInput).digest("hex");
    return this.perform(input, inputHash, expected, request.rows.length);
  }

  private async perform(
    input: { operation: AnalyticsOperation; rows: readonly AnalyticsRow[] },
    inputHash: string,
    expected: AnalyticsResult,
    rowCount: number,
  ): Promise<AnalyticsProviderResponse> {
    const client = new Client({ name: "marketing-professional-analytics", version: "1.0.0" });
    const environment = getDefaultEnvironment();
    const sourceEnvironment = this.options.env ?? process.env;
    for (const name of new Set(this.options.envAllowlist ?? [])) {
      const value = sourceEnvironment[name];
      if (/^[A-Z_][A-Z0-9_]*$/i.test(name) && typeof value === "string") environment[name] = value;
    }
    const transport = new StdioClientTransport({
      command: this.options.command!,
      args: this.options.args ?? [],
      env: environment,
      stderr: "ignore",
    });
    const timeout = this.options.timeoutMs ?? ANALYTICS_PROVIDER_LIMITS.timeoutMs;
    const maxResponseBytes = this.options.maxResponseBytes ?? ANALYTICS_PROVIDER_LIMITS.maxResponseBytes;
    const abort = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
        reject(capabilityGap("mcp_timeout", "Professional analytics MCP timed out", true));
      }, timeout);
    });
    try {
      await Promise.race([client.connect(transport), deadline]);
      const response = await Promise.race([
        client.callTool({ name: "analyze", arguments: input }, undefined, {
          timeout,
          signal: abort.signal,
        }),
        deadline,
      ]);
      const responseBytes = Buffer.byteLength(JSON.stringify(response));
      if (responseBytes > maxResponseBytes) {
        throw capabilityGap("mcp_response_too_large", "Professional analytics MCP response exceeds the byte limit");
      }
      if (response.isError) {
        throw capabilityGap("mcp_unavailable", "Professional analytics MCP analyze failed");
      }
      let parsed: z.infer<typeof responseSchema>;
      try {
        parsed = responseSchema.parse(response.structuredContent);
      } catch {
        throw capabilityGap("mcp_invalid_response", "Professional analytics MCP returned an invalid response schema");
      }
      if (parsed.inputHash !== inputHash) {
        throw capabilityGap("mcp_input_hash_mismatch", "Professional analytics MCP response input hash does not match");
      }
      try {
        validateAnalyticsResult(parsed.result);
      } catch {
        throw capabilityGap("mcp_invalid_response", "Professional analytics MCP returned an invalid analytics result");
      }
      assertBoundedResult(parsed.result, rowCount);
      if (canonicalJson(parsed.result) !== canonicalJson(expected)) {
        throw capabilityGap("mcp_result_mismatch", "Professional analytics MCP result does not match server recomputation");
      }
      return {
        result: parsed.result,
        inputHash,
        toolVersion: client.getServerVersion()?.version ?? "unknown",
      };
    } catch (error) {
      if (error instanceof DomainError && error.code === "CAPABILITY_UNAVAILABLE") throw error;
      if (timedOut || abort.signal.aborted) {
        throw capabilityGap("mcp_timeout", "Professional analytics MCP timed out", true);
      }
      throw capabilityGap("mcp_unavailable", "Professional analytics MCP is unavailable", true);
    } finally {
      if (timer) clearTimeout(timer);
      const closing = client.close().catch(() => undefined);
      if (!timedOut) await closing;
    }
  }
}

function assertBoundedResult(result: AnalyticsResult, rowCount: number): void {
  const exceeds = result.operation === "trend_v1"
    ? result.points.length > ANALYTICS_PROVIDER_LIMITS.maxRows + 1 ||
      result.missingWindows.length > result.points.length
    : result.operation === "anomaly_v1"
      ? result.anomalies.length > rowCount
      : result.stages.length > 500;
  if (exceeds) {
    throw capabilityGap("mcp_invalid_response", "Professional analytics MCP result exceeds the row bound");
  }
}

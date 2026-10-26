import { parseCommaSeparatedList, parseContentMcpArguments } from "../config.js";
import { DomainError } from "../domain/errors.js";
import { acquisitionDeadlineError, acquisitionPayloadBytes, raceWithAcquisitionAbort } from "./acquisition-policy.js";
import { McpAcquisitionProvider } from "./mcp-acquisition.js";
import {
  PlaywrightAcquisitionProvider,
  remainingAcquisitionTimeout,
  type AcquiredPage,
  type AcquireRequest,
  type AcquisitionProvider,
} from "./playwright-acquisition.js";

export interface AcquisitionRouterOptions {
  mcp?: AcquisitionProvider;
  playwright?: AcquisitionProvider;
  allowlist?: string[];
}

export class AcquisitionRouter implements AcquisitionProvider {
  private readonly mcp?: AcquisitionProvider;
  private readonly playwright: AcquisitionProvider;

  constructor(options: AcquisitionRouterOptions = {}) {
    this.mcp = options.mcp;
    this.playwright = options.playwright ?? new PlaywrightAcquisitionProvider({
      ...(options.allowlist ? { allowlist: options.allowlist } : {}),
    });
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): AcquisitionRouter {
    const command = env.MARKETING_CONTENT_MCP_COMMAND;
    const mcp = command
      ? new McpAcquisitionProvider({
        command,
        args: parseContentMcpArguments(env.MARKETING_CONTENT_MCP_ARGS),
        env,
      })
      : undefined;
    return new AcquisitionRouter({
      ...(mcp ? { mcp } : {}),
      allowlist: parseCommaSeparatedList(env.MARKETING_HTTP_ALLOWLIST),
    });
  }

  async acquire(request: AcquireRequest): Promise<AcquiredPage> {
    let lastError: unknown;
    let candidateBytes = 0;
    const acquire = (provider: AcquisitionProvider): Promise<AcquiredPage> => {
      const timeoutMs = remainingAcquisitionTimeout(request);
      return raceWithAcquisitionAbort(provider.acquire({ ...request, timeoutMs }), request.signal);
    };
    const complete = (page: AcquiredPage): AcquiredPage => ({
      ...page,
      payloadBytes: candidateBytes + (page.payloadBytes ?? acquisitionPayloadBytes(page)),
    });
    if (this.mcp) {
      try {
        return complete(await acquire(this.mcp));
      } catch (error) {
        candidateBytes += reportedPayloadBytes(error);
        if (request.signal?.aborted || (error instanceof DomainError && error.details?.reason === "max_duration")) {
          throw acquisitionDeadlineError(candidateBytes);
        }
        if (isAccessGap(error) || isResearchBoundary(error)) {
          throw withPayloadBytes(error, candidateBytes);
        }
        lastError = error;
      }
    }
    try {
      return complete(await acquire(this.playwright));
    } catch (error) {
      candidateBytes += reportedPayloadBytes(error);
      if (request.signal?.aborted || (error instanceof DomainError && error.details?.reason === "max_duration")) {
        throw acquisitionDeadlineError(candidateBytes);
      }
      if (error instanceof DomainError) {
        throw withPayloadBytes(error, candidateBytes);
      }
      lastError = error;
    }
    throw new DomainError(
      "CAPABILITY_UNAVAILABLE",
      "No professional MCP or Chromium acquisition provider is available",
      false,
      { reason: lastError instanceof DomainError ? String(lastError.details?.reason ?? "provider_unavailable") : "provider_unavailable" },
    );
  }
}

function reportedPayloadBytes(error: unknown): number {
  const bytes = error instanceof DomainError ? error.details?.payloadBytes : undefined;
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

function withPayloadBytes(error: unknown, payloadBytes: number): unknown {
  if (!(error instanceof DomainError) || payloadBytes === 0) {
    return error;
  }
  return new DomainError(error.code, error.message, error.retryable, {
    ...error.details,
    payloadBytes,
  });
}

function isResearchBoundary(error: unknown): boolean {
  return error instanceof DomainError &&
    (error.code === "INVALID_INPUT" || ["scope_denied", "max_bytes"].includes(String(error.details?.reason)));
}

function isAccessGap(error: unknown): boolean {
  if (!(error instanceof DomainError)) {
    return false;
  }
  const reason = error.details?.reason;
  return reason === "access_gate" || (typeof reason === "string" && /^http_(?:401|403|429)$/.test(reason));
}

export type { AcquiredPage, AcquireRequest, AcquisitionProvider } from "./playwright-acquisition.js";

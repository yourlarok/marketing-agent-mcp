import { parseCommaSeparatedList, parseContentMcpArguments } from "../config.js";
import { DomainError } from "../domain/errors.js";
import { McpAcquisitionProvider } from "./mcp-acquisition.js";
import {
  PlaywrightAcquisitionProvider,
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
    if (this.mcp) {
      try {
        return await this.mcp.acquire(request);
      } catch (error) {
        if (isAccessGap(error)) {
          throw error;
        }
        lastError = error;
      }
    }
    try {
      return await this.playwright.acquire(request);
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
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

function isAccessGap(error: unknown): boolean {
  if (!(error instanceof DomainError)) {
    return false;
  }
  const reason = error.details?.reason;
  return reason === "access_gate" || (typeof reason === "string" && /^http_(?:401|403|429)$/.test(reason));
}

export type { AcquiredPage, AcquireRequest, AcquisitionProvider } from "./playwright-acquisition.js";

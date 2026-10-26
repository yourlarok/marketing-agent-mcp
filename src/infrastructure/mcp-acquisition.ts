import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PNG } from "pngjs";
import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import type { CapabilityState } from "../domain/model.js";
import {
  acquisitionPayloadBytes,
  assertAcquisitionPayloadBudget,
  assertAcquisitionUrlInScope,
  canonicalAcquisitionUrl,
  isAcquisitionUrlInScope,
  raceWithAcquisitionAbort,
} from "./acquisition-policy.js";
import {
  validateAcquireRequest,
  remainingAcquisitionTimeout,
  type AcquiredPage,
  type AcquireRequest,
  type AcquisitionProvider,
} from "./playwright-acquisition.js";

const acquiredPageSchema = z.object({
  url: z.string().url(),
  finalUrl: z.string().url(),
  title: z.string(),
  text: z.string(),
  fields: z.record(z.string(), z.string()),
  links: z.array(z.string().max(8_192)).max(1_000).optional(),
  screenshotBase64: z.string().max(14_000_000),
});

const accessGapSchema = z.object({
  error: z.object({
    code: z.literal("ACCESS_GAP"),
    reason: z.enum(["http_401", "http_403", "http_429", "access_gate"]),
    message: z.string().max(1_000),
  }),
});

const scopeDenialSchema = z.object({
  error: z.object({
    code: z.literal("SCOPE_DENIED"),
    reason: z.literal("scope_denied"),
    enforcement: z.enum(["provider_pre_request", "proxy_pre_request"]),
    message: z.string().max(1_000),
  }),
});

function scopeEnforcementError(): DomainError {
  return new DomainError(
    "CAPABILITY_UNAVAILABLE",
    "Professional MCP did not prove fail-closed request-scope enforcement",
    false,
    { reason: "mcp_scope_enforcement" },
  );
}

export interface McpAcquisitionOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  envAllowlist?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export class McpAcquisitionProvider implements AcquisitionProvider {
  state: CapabilityState = "configured";
  scopeCanaryHits = 0;

  constructor(private readonly options: McpAcquisitionOptions) {
    if (!options.command.trim()) {
      throw new DomainError("INVALID_INPUT", "Professional MCP command must not be empty");
    }
  }

  async acquire(request: AcquireRequest): Promise<AcquiredPage> {
    validateAcquireRequest(request);
    return raceWithAcquisitionAbort(this.perform(request), request.signal);
  }

  private async perform(request: AcquireRequest): Promise<AcquiredPage> {
    const client = new Client({ name: "marketing-content-acquisition", version: "1.0.0" });
    const sourceEnvironment = this.options.env ?? process.env;
    const environment = getDefaultEnvironment();
    for (const name of new Set(this.options.envAllowlist ?? [])) {
      const value = sourceEnvironment[name];
      if (/^[A-Z_][A-Z0-9_]*$/i.test(name) && typeof value === "string") {
        environment[name] = value;
      }
    }
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args ?? [],
      env: environment,
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      stderr: "ignore",
    });
    try {
      await raceWithAcquisitionAbort(client.connect(transport), request.signal);
      const timeout = Math.min(this.options.timeoutMs ?? 15_000, remainingAcquisitionTimeout(request));
      const deadline = Date.now() + timeout;
      await this.verifyScopeEnforcement(client, request, timeout);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new DomainError("CAPABILITY_UNAVAILABLE", "Research acquisition deadline reached", false, {
          reason: "max_duration",
        });
      }
      const result = await client.callTool({
        name: "acquire_content",
        arguments: {
          url: request.url,
          fields: request.fields ?? {},
          ...(request.scope ? { scope: request.scope } : {}),
          ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
          timeoutMs: remaining,
        },
      }, undefined, { timeout: remaining, ...(request.signal ? { signal: request.signal } : {}) });
      if (result.isError) {
        const gap = accessGapSchema.safeParse(result.structuredContent);
        if (gap.success) {
          throw new DomainError("CAPABILITY_UNAVAILABLE", gap.data.error.message, false, {
            kind: "ACCESS_GAP",
            reason: gap.data.error.reason,
          });
        }
        throw new Error("Professional MCP acquisition failed");
      }
      const parsed = parseSuccess(result.structuredContent, request);
      this.state = "verified";
      return {
        ...parsed,
        provider: "mcp",
        toolVersion: client.getServerVersion()?.version ?? "unknown",
      };
    } catch (error) {
      if (isAccessGap(error)) {
        this.state = "verified";
        throw error;
      }
      this.state = "unavailable";
      if (error instanceof DomainError &&
        ["mcp_invalid_response", "mcp_scope_enforcement", "scope_denied", "max_bytes", "max_duration"].includes(String(error.details?.reason))) {
        throw error;
      }
      throw new DomainError(
        "CAPABILITY_UNAVAILABLE",
        "Professional MCP content acquisition is unavailable",
        false,
        { reason: "mcp_unavailable" },
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async verifyScopeEnforcement(client: Client, request: AcquireRequest, timeout: number): Promise<void> {
    this.scopeCanaryHits = 0;
    if (!request.scope) {
      return;
    }
    const canaryServer = createServer((_request, response) => {
      this.scopeCanaryHits += 1;
      response.writeHead(204).end();
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      canaryServer.once("error", rejectListen);
      canaryServer.listen(0, "127.0.0.1", () => {
        canaryServer.off("error", rejectListen);
        resolveListen();
      });
    });
    const canaryUrl = `http://127.0.0.1:${(canaryServer.address() as AddressInfo).port}/__marketing_mcp_scope_canary__`;
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      canaryServer.closeAllConnections();
      await new Promise<void>((resolveClose) => canaryServer.close(() => resolveClose()));
    };
    try {
      if (isAcquisitionUrlInScope(canaryUrl, request.scope)) {
        throw scopeEnforcementError();
      }
      const result = await client.callTool({
        name: "acquire_content",
        arguments: {
          url: canaryUrl,
          fields: {},
          scope: request.scope,
          maxBytes: 1,
          timeoutMs: timeout,
        },
      }, undefined, { timeout, ...(request.signal ? { signal: request.signal } : {}) });
      await delay(25, undefined, ...(request.signal ? [{ signal: request.signal }] : []));
      await close();
      const denial = scopeDenialSchema.safeParse(result.structuredContent);
      if (this.scopeCanaryHits !== 0 || result.isError !== true || !denial.success) {
        throw scopeEnforcementError();
      }
    } finally {
      await close();
    }
  }
}

function parseSuccess(content: unknown, request: AcquireRequest): Omit<AcquiredPage, "provider" | "toolVersion"> {
  const candidatePayload = { text: "", fields: {} as Record<string, string>, screenshot: Buffer.alloc(0) };
  try {
    const parsed = acquiredPageSchema.parse(content);
    candidatePayload.text = parsed.text;
    candidatePayload.fields = parsed.fields;
    const requestUrl = new URL(canonicalAcquisitionUrl(request.url));
    const responseUrl = new URL(canonicalAcquisitionUrl(parsed.url));
    const finalUrl = new URL(canonicalAcquisitionUrl(parsed.finalUrl));
    if (responseUrl.href !== requestUrl.href || finalUrl.origin !== requestUrl.origin) {
      throw new Error("Professional MCP response URL does not match the request origin");
    }
    assertAcquisitionUrlInScope(finalUrl.href, request.scope);
    const requestedFields = Object.keys(request.fields ?? {}).sort();
    const returnedFields = Object.keys(parsed.fields).sort();
    if (requestedFields.length !== returnedFields.length ||
      requestedFields.some((name, index) => name !== returnedFields[index])) {
      throw new Error("Professional MCP response fields do not match the request");
    }
    assertAcquisitionPayloadBudget({ text: parsed.text, fields: parsed.fields, screenshot: Buffer.alloc(0) }, request.maxBytes);
    const screenshot = Buffer.from(parsed.screenshotBase64, "base64");
    candidatePayload.screenshot = screenshot;
    assertAcquisitionPayloadBudget({ text: parsed.text, fields: parsed.fields, screenshot }, request.maxBytes);
    if (screenshot.length < 24 || screenshot.length > 10 * 1024 * 1024) {
      throw new Error("Professional MCP screenshot size is invalid");
    }
    const declaredWidth = screenshot.readUInt32BE(16);
    const declaredHeight = screenshot.readUInt32BE(20);
    if (declaredWidth === 0 || declaredHeight === 0 || declaredWidth > 10_000 || declaredHeight > 10_000) {
      throw new Error("Professional MCP screenshot dimensions are invalid");
    }
    const decoded = PNG.sync.read(screenshot);
    if (decoded.width !== declaredWidth || decoded.height !== declaredHeight ||
      decoded.data.length !== decoded.width * decoded.height * 4) {
      throw new Error("Professional MCP screenshot did not decode completely");
    }
    return {
      url: parsed.url,
      finalUrl: parsed.finalUrl,
      title: parsed.title,
      text: parsed.text,
      fields: parsed.fields,
      ...(parsed.links ? { links: parsed.links } : {}),
      screenshot,
    };
  } catch (error) {
    const payloadBytes = acquisitionPayloadBytes(candidatePayload);
    const details = {
      ...(error instanceof DomainError ? error.details : {}),
      ...(payloadBytes > 0 ? { payloadBytes } : {}),
    };
    if (error instanceof DomainError && ["scope_denied", "max_bytes"].includes(String(error.details?.reason))) {
      throw new DomainError(error.code, error.message, error.retryable, details);
    }
    throw new DomainError(
      "CAPABILITY_UNAVAILABLE",
      `Professional MCP returned an invalid acquisition response: ${error instanceof Error ? error.message : "unknown error"}`,
      false,
      { ...details, reason: "mcp_invalid_response" },
    );
  }
}

function isAccessGap(error: unknown): boolean {
  return error instanceof DomainError && error.details?.kind === "ACCESS_GAP";
}

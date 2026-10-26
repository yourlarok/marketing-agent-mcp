import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import type { CapabilityState } from "../domain/model.js";
import {
  validateAcquireRequest,
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
  screenshotBase64: z.string().max(14_000_000),
});

export interface McpAcquisitionOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

export class McpAcquisitionProvider implements AcquisitionProvider {
  state: CapabilityState = "configured";

  constructor(private readonly options: McpAcquisitionOptions) {
    if (!options.command.trim()) {
      throw new DomainError("INVALID_INPUT", "Professional MCP command must not be empty");
    }
  }

  async acquire(request: AcquireRequest): Promise<AcquiredPage> {
    validateAcquireRequest(request);
    const client = new Client({ name: "marketing-content-acquisition", version: "1.0.0" });
    const environment = Object.fromEntries(
      Object.entries(optionsEnvironment(this.options.env)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args ?? [],
      env: environment,
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      stderr: "ignore",
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "acquire_content",
        arguments: { url: request.url, fields: request.fields ?? {} },
      }, undefined, { timeout: this.options.timeoutMs ?? 15_000 });
      if (result.isError) {
        throw new Error("Professional MCP acquisition failed");
      }
      const parsed = acquiredPageSchema.parse(result.structuredContent);
      const screenshot = Buffer.from(parsed.screenshotBase64, "base64");
      if (screenshot.length === 0 || screenshot.length > 10 * 1024 * 1024 ||
        !screenshot.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        throw new Error("Professional MCP screenshot is invalid");
      }
      this.state = "verified";
      return {
        url: parsed.url,
        finalUrl: parsed.finalUrl,
        title: parsed.title,
        text: parsed.text,
        fields: parsed.fields,
        screenshot,
        provider: "mcp",
        toolVersion: client.getServerVersion()?.version ?? "unknown",
      };
    } catch {
      this.state = "unavailable";
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
}

function optionsEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return env ?? process.env;
}

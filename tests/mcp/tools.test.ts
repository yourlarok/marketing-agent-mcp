import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { DomainError } from "../../src/domain/errors.js";
import { toMcpError } from "../../src/mcp/error-mapper.js";
import {
  MAX_SERIALIZED_INPUT_BYTES,
  resourceIdInputSchema,
  serializedInputSchema,
  timestampInputSchema,
} from "../../src/mcp/schemas.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTempDir, removeTempDir } from "../helpers.js";

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tempDir);
  });

  it("loads a valid temporary data directory", () => {
    expect(loadConfig({ MARKETING_DATA_DIR: tempDir })).toEqual({
      dataDir: tempDir,
      logLevel: "info",
    });
  });

  it("rejects a missing MARKETING_DATA_DIR", () => {
    expect(() => loadConfig({})).toThrow("MARKETING_DATA_DIR");
  });

  it("rejects a data directory path that is an existing file", async () => {
    const filePath = join(tempDir, "data.txt");
    await writeFile(filePath, "not a directory");

    expect(() => loadConfig({ MARKETING_DATA_DIR: filePath })).toThrow(
      "MARKETING_DATA_DIR",
    );
  });
});

describe("MCP server", () => {
  it("initializes over linked memory transports with an empty tool list", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);

      expect(await client.listTools()).toEqual({ tools: [] });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});

describe("MCP input contracts", () => {
  it("rejects unknown fields in explicit tool inputs", () => {
    expect(
      resourceIdInputSchema.safeParse({ id: "campaign-1", unexpected: true })
        .success,
    ).toBe(false);
  });

  it("rejects empty IDs", () => {
    expect(resourceIdInputSchema.safeParse({ id: "   " }).success).toBe(false);
  });

  it("accepts UTC timestamps and rejects non-UTC timestamps", () => {
    expect(
      timestampInputSchema.safeParse({ timestamp: "2026-10-26T12:30:00Z" })
        .success,
    ).toBe(true);
    expect(
      timestampInputSchema.safeParse({ timestamp: "2026-10-26T12:30:00+08:00" })
        .success,
    ).toBe(false);
  });

  it("rejects serialized inputs over 64 KiB", () => {
    expect(MAX_SERIALIZED_INPUT_BYTES).toBe(64 * 1024);
    expect(
      serializedInputSchema.safeParse({
        payload: "x".repeat(MAX_SERIALIZED_INPUT_BYTES),
      }).success,
    ).toBe(false);
  });

  it("rejects secret-like keys at any nesting depth", () => {
    expect(
      serializedInputSchema.safeParse({
        campaign: { credentials: { apiKey: "must-not-enter" } },
        items: [{ access_token: "also-secret" }],
      }).success,
    ).toBe(false);
  });
});

describe("MCP error contracts", () => {
  it("maps domain errors to stable safe error data", () => {
    const mapped = toMcpError(
      new DomainError("NOT_FOUND", "Campaign not found", false, {
        campaignId: "campaign-1",
      }),
    );

    expect(mapped.data).toEqual({
      code: "NOT_FOUND",
      retryable: false,
      details: { campaignId: "campaign-1" },
    });
  });

  it("maps arbitrary exceptions to INTERNAL_ERROR without stacks or secrets", () => {
    const secret = "sk-test-do-not-expose";
    const mapped = toMcpError(
      new Error(`postgres password=${secret} failed`, {
        cause: { connectionString: secret },
      }),
    );
    const serialized = JSON.stringify(mapped);

    expect(mapped.message).toBe("MCP error -32603: Internal server error");
    expect(mapped.data).toEqual({
      code: "INTERNAL_ERROR",
      retryable: false,
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("postgres");
    expect(serialized).not.toContain("Error:");
  });
});

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

  it("measures __proto__ before record reconstruction", () => {
    const input = JSON.parse(
      `{"__proto__":"${"x".repeat(MAX_SERIALIZED_INPUT_BYTES)}"}`,
    ) as Record<string, string>;

    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(65_552);
    expect(serializedInputSchema.safeParse(input).success).toBe(false);
  });

  it("accepts an ASCII input at exactly 64 KiB", () => {
    const input = { payload: "x".repeat(65_522) };

    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(65_536);
    expect(serializedInputSchema.safeParse(input).success).toBe(true);
  });

  it("uses UTF-8 bytes at the multibyte boundary", () => {
    const payload = `${"€".repeat(21_840)}xx`;
    const input = { payload };

    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(65_536);
    expect(serializedInputSchema.safeParse(input).success).toBe(true);
    expect(
      serializedInputSchema.safeParse({ payload: `${payload}x` }).success,
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

  it.each(["secretAccessKey", "secretKey"])(
    "rejects adversarial secret key %s",
    (key) => {
      expect(
        serializedInputSchema.safeParse({ nested: { [key]: "secret" } })
          .success,
      ).toBe(false);
    },
  );

  it("rejects non-finite numbers", () => {
    expect(serializedInputSchema.safeParse({ value: Number.NaN }).success).toBe(
      false,
    );
    expect(
      serializedInputSchema.safeParse({ value: Number.POSITIVE_INFINITY })
        .success,
    ).toBe(false);
  });

  it("enforces array and object collection limits", () => {
    const objectWithTooManyEntries = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, index) => [`key-${index}`, index]),
    );

    expect(
      serializedInputSchema.safeParse({ items: Array(1_001).fill(null) })
        .success,
    ).toBe(false);
    expect(serializedInputSchema.safeParse(objectWithTooManyEntries).success).toBe(
      false,
    );
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

  it.each([
    ["INVALID_INPUT", -32_602, "Invalid input"],
    ["NOT_FOUND", -32_603, "Resource not found"],
    ["CONFLICT", -32_603, "Resource conflict"],
    ["IDEMPOTENCY_CONFLICT", -32_603, "Idempotency conflict"],
    ["CAPABILITY_UNAVAILABLE", -32_603, "Capability unavailable"],
    ["INTERNAL_ERROR", -32_603, "Internal server error"],
  ] as const)(
    "maps %s to a fixed safe message",
    (code, rpcCode, safeMessage) => {
      const mapped = toMcpError(
        new DomainError(
          code,
          "postgres password=synthetic-secret failed",
          true,
        ),
      );

      expect(mapped.code).toBe(rpcCode);
      expect(mapped.message).toBe(`MCP error ${rpcCode}: ${safeMessage}`);
      expect(JSON.stringify(mapped)).not.toContain("synthetic-secret");
      expect(JSON.stringify(mapped)).not.toContain("postgres");
    },
  );

  it("filters secret-like keys from domain error details", () => {
    const mapped = toMcpError(
      new DomainError("CONFLICT", "internal conflict", true, {
        campaignId: "campaign-1",
        secretAccessKey: "synthetic-access-secret",
        secretKey: "synthetic-key-secret",
      }),
    );

    expect(mapped.data).toEqual({
      code: "CONFLICT",
      retryable: true,
      details: { campaignId: "campaign-1" },
    });
    expect(JSON.stringify(mapped)).not.toContain("synthetic-access-secret");
    expect(JSON.stringify(mapped)).not.toContain("synthetic-key-secret");
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

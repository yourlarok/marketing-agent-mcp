import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarketingService } from "../../src/application/marketing-service.js";
import { loadConfig } from "../../src/config.js";
import { DomainError } from "../../src/domain/errors.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import {
  SystemClock,
  SystemIdGenerator,
} from "../../src/infrastructure/system.js";
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

  it("creates and canonically replays commands without duplicate MCP writes", async () => {
    const tempDir = await createTempDir();
    const databasePath = join(tempDir, "store.db");
    const store = openStore(databasePath);
    const service = new MarketingService(
      store,
      new SystemClock(),
      new SystemIdGenerator(),
    );
    const server = createMcpServer(service);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
      expect(
        (await client.listTools()).tools.map((tool) => tool.name).sort(),
      ).toEqual([
        "dataset_register",
        "evidence_record",
        "finding_record",
        "source_register",
        "workspace_create",
      ]);

      const first = await client.callTool({
        name: "workspace_create",
        arguments: {
          id: "workspace-1",
          name: "Northwind",
          actor: "agent-1",
          requestId: "request-1",
          idempotencyKey: "command-1",
        },
      });
      const replay = await client.callTool({
        name: "workspace_create",
        arguments: {
          idempotencyKey: "command-1",
          requestId: "request-1",
          actor: "agent-1",
          name: "Northwind",
          id: "workspace-1",
        },
      });
      expect(replay).toEqual(first);
      expect(first.content[0]).toMatchObject({ type: "text" });
      expect(
        JSON.parse((first.content[0] as { text: string }).text),
      ).toMatchObject({
        id: "workspace-1",
        workspaceId: "workspace-1",
        name: "Northwind",
      });

      const source = await client.callTool({
        name: "source_register",
        arguments: {
          id: "source-1",
          workspaceId: "workspace-1",
          name: "Research",
          type: "manual",
          ownership: "owned",
          actor: "agent-1",
          requestId: "request-2",
          idempotencyKey: "command-2",
        },
      });
      expect(JSON.parse((source.content[0] as { text: string }).text)).toMatchObject({
        id: "source-1",
        workspaceId: "workspace-1",
        type: "manual",
        ownership: "owned",
      });

      const dataset = await client.callTool({
        name: "dataset_register",
        arguments: {
          id: "dataset-1",
          workspaceId: "workspace-1",
          sourceId: "source-1",
          name: "Research observations",
          coverageStart: "2026-01-01T00:00:00.000Z",
          coverageEnd: "2026-01-31T23:59:59.999Z",
          fieldDefinitions: [{ name: "observation", type: "string" }],
          metricDefinitions: [{ name: "mentions", aggregation: "count" }],
          limitations: ["Manual sample"],
          actor: "agent-1",
          requestId: "request-3",
          idempotencyKey: "command-3",
        },
      });
      expect(JSON.parse((dataset.content[0] as { text: string }).text)).toMatchObject({
        id: "dataset-1",
        sourceId: "source-1",
        limitations: ["Manual sample"],
      });

      const evidence = await client.callTool({
        name: "evidence_record",
        arguments: {
          id: "evidence-1",
          workspaceId: "workspace-1",
          sourceId: "source-1",
          sourceLocator: "research/note-1",
          observedAt: "2026-02-01T00:00:00.000Z",
          summary: "A recorded operating observation",
          contentHash: "a".repeat(64),
          classification: "owned_operating",
          actor: "agent-1",
          requestId: "request-4",
          idempotencyKey: "command-4",
        },
      });
      expect(JSON.parse((evidence.content[0] as { text: string }).text)).toMatchObject({
        id: "evidence-1",
        sourceId: "source-1",
        classification: "owned_operating",
      });

      const finding = await client.callTool({
        name: "finding_record",
        arguments: {
          id: "finding-1",
          workspaceId: "workspace-1",
          kind: "fact",
          statement: "The research notes contain an operating observation",
          evidenceIds: ["evidence-1"],
          actor: "agent-1",
          requestId: "request-5",
          idempotencyKey: "command-5",
        },
      });
      expect(JSON.parse((finding.content[0] as { text: string }).text)).toMatchObject({
        id: "finding-1",
        kind: "fact",
        evidenceIds: ["evidence-1"],
      });

      const raw = new DatabaseSync(databasePath);
      try {
        expect(
          raw
            .prepare(
              `SELECT
                (SELECT COUNT(*) FROM workspaces) AS workspaces,
                (SELECT COUNT(*) FROM sources) AS sources,
                (SELECT COUNT(*) FROM datasets) AS datasets,
                (SELECT COUNT(*) FROM evidence) AS evidence,
                (SELECT COUNT(*) FROM findings) AS findings,
                (SELECT COUNT(*) FROM audit_records) AS audits,
                (SELECT COUNT(*) FROM idempotency_records) AS idempotency`,
            )
            .get(),
        ).toEqual({
          workspaces: 1,
          sources: 1,
          datasets: 1,
          evidence: 1,
          findings: 1,
          audits: 5,
          idempotency: 5,
        });
      } finally {
        raw.close();
      }
    } finally {
      await Promise.all([client.close(), server.close()]);
      store.close();
      await removeTempDir(tempDir);
    }
  });

  it("rejects secret-bearing evidence locators without MCP persistence", async () => {
    const tempDir = await createTempDir();
    const databasePath = join(tempDir, "store.db");
    const store = openStore(databasePath);
    const service = new MarketingService(
      store,
      new SystemClock(),
      new SystemIdGenerator(),
    );
    const server = createMcpServer(service);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
      await client.callTool({
        name: "workspace_create",
        arguments: {
          id: "workspace-1",
          name: "Northwind",
          actor: "agent-1",
          requestId: "request-1",
          idempotencyKey: "command-1",
        },
      });
      await client.callTool({
        name: "source_register",
        arguments: {
          id: "source-1",
          workspaceId: "workspace-1",
          name: "Research",
          type: "manual",
          ownership: "owned",
          actor: "agent-1",
          requestId: "request-2",
          idempotencyKey: "command-2",
        },
      });

      const attempts = [
        {
          sourceLocator: "https://user:synthetic-mcp-password@example.test/report",
          secret: "synthetic-mcp-password",
        },
        {
          sourceLocator: "https://example.test/report?Access_Token=synthetic-mcp-token",
          secret: "synthetic-mcp-token",
        },
      ];
      for (const [index, attempt] of attempts.entries()) {
        const result = await client.callTool({
          name: "evidence_record",
          arguments: {
            id: `evidence-${index + 1}`,
            workspaceId: "workspace-1",
            sourceId: "source-1",
            sourceLocator: attempt.sourceLocator,
            observedAt: "2026-02-01T00:00:00.000Z",
            summary: "A recorded operating observation",
            contentHash: "a".repeat(64),
            classification: "owned_operating",
            actor: "agent-1",
            requestId: `request-${index + 3}`,
            idempotencyKey: `command-${index + 3}`,
          },
        });
        expect(result).toMatchObject({ isError: true });
        expect(JSON.stringify(result)).not.toContain(attempt.secret);
      }

      const raw = new DatabaseSync(databasePath);
      try {
        expect(
          raw
            .prepare(
              `SELECT
                (SELECT COUNT(*) FROM evidence) AS evidence,
                (SELECT COUNT(*) FROM audit_records) AS audits,
                (SELECT COUNT(*) FROM idempotency_records) AS idempotency`,
            )
            .get(),
        ).toEqual({ evidence: 0, audits: 2, idempotency: 2 });
      } finally {
        raw.close();
      }
    } finally {
      await Promise.all([client.close(), server.close()]);
      store.close();
      await removeTempDir(tempDir);
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

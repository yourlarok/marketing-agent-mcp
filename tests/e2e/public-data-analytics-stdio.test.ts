import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDir, removeTempDir } from "../helpers.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const serverPath = join(projectRoot, "dist", "index.js");
const analyticsFixture = fileURLToPath(
  new URL("../fixtures/professional-analytics-mcp.mjs", import.meta.url),
);
const workspaceId = "workspace-public-tools-stdio";

type JsonRecord = Record<string, unknown>;

interface RunningClient {
  client: Client;
  stderr: () => string;
}

function context(suffix: string): JsonRecord {
  return {
    actor: "public-tools-stdio",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  };
}

function payload(result: CallToolResult): JsonRecord {
  expect(result.isError).not.toBe(true);
  return JSON.parse((result.content[0] as { text: string }).text) as JsonRecord;
}

function sqliteQuery(): JsonRecord {
  return {
    databaseId: "marketing",
    table: "daily_metrics",
    columns: ["observedAt", "revenue"],
    filters: {},
    order: [{ column: "observedAt", direction: "asc" }],
    limit: 100,
  };
}

describe("built public SQLite and analytics stdio contracts", () => {
  let dataDir: string;
  let databaseRoot: string;
  let artifactDir: string;
  const clients: RunningClient[] = [];

  beforeEach(async () => {
    [dataDir, databaseRoot, artifactDir] = await Promise.all([
      createTempDir(),
      createTempDir(),
      createTempDir(),
    ]);
    const database = new DatabaseSync(join(databaseRoot, "marketing.sqlite"));
    try {
      database.exec(`
        CREATE TABLE daily_metrics (observedAt TEXT, revenue REAL);
        INSERT INTO daily_metrics VALUES
          ('2026-01-01T00:00:00.000Z', 10),
          ('2026-01-03T00:00:00.000Z', 20);
      `);
    } finally {
      database.close();
    }
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(({ client }) => client.close()));
    await Promise.all([dataDir, databaseRoot, artifactDir].map(removeTempDir));
  });

  async function startClient(configured = true): Promise<RunningClient> {
    const client = new Client({ name: "public-tools-stdio", version: "1.0.0" });
    let stderr = "";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: projectRoot,
      env: {
        ...getDefaultEnvironment(),
        MARKETING_DATA_DIR: dataDir,
        MARKETING_ARTIFACT_DIR: artifactDir,
        ...(configured ? {
          MARKETING_DATABASE_ROOT: databaseRoot,
          MARKETING_ANALYTICS_MCP_COMMAND: process.execPath,
          MARKETING_ANALYTICS_MCP_ARGS: JSON.stringify([analyticsFixture]),
        } : {}),
      },
      stderr: "pipe",
    });
    transport.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    await client.connect(transport);
    const running = { client, stderr: () => stderr };
    clients.push(running);
    return running;
  }

  async function stopClient(running: RunningClient): Promise<void> {
    await running.client.close();
    clients.splice(clients.indexOf(running), 1);
    expect(running.stderr()).not.toContain(databaseRoot);
    expect(running.stderr()).not.toContain("MCP shutdown failed");
  }

  it("lists raw schemas and executes discover, ingest, analytics, replay, and audit over real stdio", async () => {
    const running = await startClient();
    const { client } = running;
    const call = async (name: string, arguments_: JsonRecord = {}): Promise<JsonRecord> =>
      payload(await client.callTool({ name, arguments: arguments_ }));
    const { tools } = await client.listTools();
    for (const name of [
      "connector_sqlite_discover",
      "ingest_sqlite",
      "professional_analytics_compute",
    ]) {
      expect(tools.find((tool) => tool.name === name)?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
    expect(client.getInstructions()).toMatch(/connector_sqlite_discover/);
    expect(client.getInstructions()).toMatch(/ingest_sqlite/);
    expect(client.getInstructions()).toMatch(/professional_analytics_compute/);
    const capabilities = await call("marketing_capability_list") as unknown as {
      id: string;
      availability: { state: string };
    }[];
    for (const id of ["connector.sqlite.discover", "ingest.sqlite", "analytics.professional"]) {
      expect(capabilities.find((capability) => capability.id === id)?.availability.state)
        .toBe("available");
    }
    expect(JSON.stringify(capabilities)).not.toContain(databaseRoot);

    await call("workspace_create", {
      id: workspaceId,
      name: "Public tools stdio",
      ...context("workspace"),
    });
    const discovery = await call("connector_sqlite_discover", { databaseId: "marketing" });
    expect(discovery.tables).toHaveLength(1);
    expect(JSON.stringify(discovery)).not.toContain(databaseRoot);

    const ingestArguments = {
      id: "stdio-sqlite-batch",
      workspaceId,
      query: sqliteQuery(),
      ownership: "authorized",
      ...context("sqlite-ingest"),
    };
    const batch = await call("ingest_sqlite", ingestArguments);
    expect(batch).toMatchObject({ state: "completed", failures: [] });
    expect(await call("ingest_sqlite", ingestArguments)).toEqual(batch);
    expect(await client.callTool({
      name: "ingest_sqlite",
      arguments: { ...ingestArguments, query: { ...sqliteQuery(), limit: 1 } },
    })).toMatchObject({ isError: true });

    const lineage = await call("data_research_get", {
      entityType: "ingestion_batch",
      id: batch.id as string,
      workspaceId,
    });
    const evidence = ((lineage.descriptors as JsonRecord).evidence as JsonRecord[])[0]!;
    const assets = evidence.assets as { id: string; kind: string }[];
    const graph = await call("marketing_analysis_start", {
      id: "stdio-analytics-graph",
      workspaceId,
      objective: "Analyze a real SQLite snapshot",
      inputMode: "dataset",
      referenceId: (batch.datasetIds as string[])[0]!,
      ...context("analytics-start"),
    });
    const analyticsArguments = {
      id: graph.id as string,
      workspaceId,
      expectedVersion: graph.version as number,
      batchId: batch.id as string,
      datasetId: (batch.datasetIds as string[])[0]!,
      evidenceId: evidence.id as string,
      assetId: assets.find((asset) => asset.kind === "normalized_jsonl")!.id,
      operation: {
        operation: "trend_v1",
        datasetId: (batch.datasetIds as string[])[0]!,
        parameters: { timeField: "observedAt", valueField: "revenue", grain: "day" },
      },
      ...context("professional-analytics"),
    };
    const analyzed = await call("professional_analytics_compute", analyticsArguments);
    const analyticsNode = (analyzed.nodes as JsonRecord[])
      .find((node) => node.kind === "analytics")!;
    expect(analyticsNode.payload).toMatchObject({
      operation: "trend_v1",
      provenance: { provider: "mcp", toolVersion: "1.0.0", rowCount: 2 },
    });
    expect(await call("professional_analytics_compute", analyticsArguments)).toEqual(analyzed);
    expect(await call("analysis_graph_get", {
      id: graph.id as string,
      workspaceId,
    })).toEqual(analyzed);

    const secret = "synthetic-stdio-public-tool-secret";
    for (const [name, arguments_] of [
      ["connector_sqlite_discover", { databaseId: "marketing", unexpected: true }],
      ["ingest_sqlite", { ...ingestArguments, query: { ...sqliteQuery(), sql: "DROP TABLE daily_metrics" } }],
      ["ingest_sqlite", { ...ingestArguments, query: { ...sqliteQuery(), filters: { apiKey: secret } } }],
      ["professional_analytics_compute", { ...analyticsArguments, operation: { ...analyticsArguments.operation, shell: "id" } }],
    ] as const) {
      const result = await client.callTool({ name, arguments: arguments_ });
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).not.toContain(secret);
    }

    const raw = new DatabaseSync(join(dataDir, "marketing.db"), { readOnly: true });
    try {
      expect(raw.prepare(
        "SELECT action, COUNT(*) AS count FROM audit_records WHERE action IN (?, ?) GROUP BY action",
      ).all("ingestion_batch.connector_sqlite", "analysis_graph.professional_analyze")).toEqual([
        { action: "analysis_graph.professional_analyze", count: 1 },
        { action: "ingestion_batch.connector_sqlite", count: 1 },
      ]);
    } finally {
      raw.close();
    }
    await stopClient(running);
  }, 60_000);

  it("reports both capabilities unavailable over stdio without configuration or writes", async () => {
    const running = await startClient(false);
    const { client } = running;
    const result = await client.callTool({ name: "marketing_capability_list", arguments: {} });
    const capabilities = JSON.parse((result.content[0] as { text: string }).text) as {
      id: string;
      operation: string;
      availability: { state: string };
    }[];
    for (const id of ["connector.sqlite.discover", "ingest.sqlite", "analytics.professional"]) {
      expect(capabilities.find((capability) => capability.id === id)?.availability.state)
        .toBe("unavailable");
    }
    const forbidden = capabilities.filter((capability) =>
      /PostgreSQL|MySQL|GA4|OAuth/i.test(capability.operation) &&
      capability.availability.state === "available");
    expect(forbidden).toEqual([]);

    for (const [name, arguments_] of [
      ["connector_sqlite_discover", { databaseId: "marketing" }],
      ["ingest_sqlite", {
        id: "unconfigured-stdio-batch",
        workspaceId,
        query: sqliteQuery(),
        ownership: "owned",
        ...context("unconfigured-ingest"),
      }],
      ["professional_analytics_compute", {
        id: "unconfigured-stdio-graph",
        workspaceId,
        expectedVersion: 1,
        batchId: "batch",
        datasetId: "dataset",
        evidenceId: "evidence",
        assetId: "asset",
        operation: {
          operation: "anomaly_v1",
          datasetId: "dataset",
          parameters: { valueField: "revenue" },
        },
        ...context("unconfigured-analytics"),
      }],
    ] as const) {
      const unavailable = await client.callTool({ name, arguments: arguments_ });
      expect(unavailable).toMatchObject({ isError: true });
      expect(JSON.stringify(unavailable)).toContain("Capability unavailable");
      expect(JSON.stringify(unavailable)).not.toContain("MARKETING_ANALYTICS_MCP_COMMAND");
    }
    const raw = new DatabaseSync(join(dataDir, "marketing.db"), { readOnly: true });
    try {
      expect(raw.prepare("SELECT COUNT(*) AS count FROM ingestion_batches").get()).toEqual({ count: 0 });
      expect(raw.prepare("SELECT COUNT(*) AS count FROM analysis_graphs").get()).toEqual({ count: 0 });
    } finally {
      raw.close();
    }
    await stopClient(running);
  });

  it("returns controlled stdio errors for output over 64 KiB without malformed JSON", async () => {
    const database = new DatabaseSync(join(databaseRoot, "oversized.sqlite"));
    try {
      for (let table = 0; table < 100; table += 1) {
        const tableName = `t${String(table).padStart(3, "0")}_${"t".repeat(59)}`;
        const columns = Array.from({ length: 10 }, (_, column) =>
          `c${column}_${"c".repeat(60)} TEXT`).join(", ");
        database.exec(`CREATE TABLE "${tableName}" (${columns})`);
      }
    } finally {
      database.close();
    }
    const running = await startClient();
    const result = await running.client.callTool({
      name: "connector_sqlite_discover",
      arguments: { databaseId: "oversized" },
    });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("Resource conflict");
    expect(JSON.stringify(result)).not.toContain(databaseRoot);
    await stopClient(running);
  });
});

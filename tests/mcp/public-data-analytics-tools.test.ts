import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisService } from "../../src/application/analysis-service.js";
import type { CommandContext } from "../../src/application/commands.js";
import { DataResearchService } from "../../src/application/data-research-service.js";
import { MarketingService } from "../../src/application/marketing-service.js";
import type { Store } from "../../src/application/ports.js";
import type { AnalysisGraph } from "../../src/domain/analysis-model.js";
import { computeAnalyticsReference } from "../../src/domain/analytics-model.js";
import type { IngestionBatch } from "../../src/domain/data-research-model.js";
import type { Evidence } from "../../src/domain/model.js";
import type { AnalyticsProvider } from "../../src/infrastructure/analytics-provider.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import { SqliteConnector } from "../../src/infrastructure/sqlite-connector.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import {
  connectorSqliteDiscoverInputSchema,
  connectorSqliteDiscoverToolSchema,
  ingestSqliteInputSchema,
  ingestSqliteToolSchema,
  MAX_SERIALIZED_OUTPUT_BYTES,
  professionalAnalyticsComputeInputSchema,
  professionalAnalyticsComputeToolSchema,
} from "../../src/mcp/schemas.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-28T12:00:00.000Z";
const workspaceId = "workspace-1";

function context(suffix: string): CommandContext {
  return {
    actor: "public-tools-test",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  };
}

function sqliteQuery(databaseId = "marketing") {
  return {
    databaseId,
    table: "daily_metrics",
    columns: ["observedAt", "revenue"],
    filters: {},
    order: [{ column: "observedAt", direction: "asc" }],
    limit: 100,
  };
}

describe("public SQLite and professional analytics MCP tools", () => {
  let tempDir: string;
  let databaseRoot: string;
  let storePath: string;
  let store: Store;
  let artifacts: ArtifactStore;
  let marketing: MarketingService;
  let dataResearch: DataResearchService;
  let analysis: AnalysisService;
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;
  let sequence: number;

  const provider: AnalyticsProvider = {
    analyze: async (request) => ({
      result: computeAnalyticsReference(request.operation, request.rows),
      inputHash: "a".repeat(64),
      toolVersion: "fixture-1",
    }),
  };

  beforeEach(async () => {
    tempDir = await createTempDir();
    databaseRoot = join(tempDir, "databases");
    await mkdir(databaseRoot);
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
    storePath = join(tempDir, "store.db");
    store = openStore(storePath);
    artifacts = new ArtifactStore(join(tempDir, "artifacts"));
    sequence = 0;
    const clock = { now: () => now };
    const ids = { next: () => `generated-${++sequence}` };
    marketing = new MarketingService(store, clock, ids);
    dataResearch = new DataResearchService(
      store,
      clock,
      ids,
      artifacts,
      undefined,
      undefined,
      new SqliteConnector(databaseRoot, clock),
    );
    analysis = new AnalysisService(store, clock, ids, artifacts, provider);
    for (const id of [workspaceId, "workspace-2"]) {
      await marketing.createWorkspace({
        input: { id, name: id },
        context: context(`setup-${id}`),
      });
    }
    server = createMcpServer(marketing, dataResearch, analysis, {
      sqliteConfigured: true,
      professionalAnalyticsConfigured: true,
    });
    client = new Client({ name: "public-tools-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
    store.close();
    await removeTempDir(tempDir);
  });

  async function call<T>(name: string, arguments_: Record<string, unknown> = {}): Promise<T> {
    const result = await client.callTool({ name, arguments: arguments_ });
    expect(result).not.toMatchObject({ isError: true });
    return JSON.parse((result.content[0] as { text: string }).text) as T;
  }

  it("exposes strict raw contracts and synchronized instructions and capabilities", async () => {
    const { tools } = await client.listTools();
    const exposed = tools.filter((tool) => [
      "connector_sqlite_discover",
      "ingest_sqlite",
      "professional_analytics_compute",
    ].includes(tool.name));
    expect(exposed.map((tool) => tool.name).sort()).toEqual([
      "connector_sqlite_discover",
      "ingest_sqlite",
      "professional_analytics_compute",
    ]);
    for (const tool of exposed) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
    for (const name of ["ingest_sqlite", "professional_analytics_compute"]) {
      const required = exposed.find((tool) => tool.name === name)!.inputSchema.required;
      expect(required).toEqual(expect.arrayContaining(["actor", "requestId", "idempotencyKey"]));
    }
    expect(exposed.find((tool) => tool.name === "connector_sqlite_discover")!
      .inputSchema.required).toEqual(["databaseId"]);
    expect(client.getInstructions()).toMatch(/connector_sqlite_discover/);
    expect(client.getInstructions()).toMatch(/ingest_sqlite/);
    expect(client.getInstructions()).toMatch(/professional_analytics_compute/);
    expect(client.getInstructions()).toMatch(/PostgreSQL.*MySQL.*GA4.*OAuth/i);

    const capabilities = await call<{
      id: string;
      operation: string;
      availability: { state: string };
    }[]>("marketing_capability_list");
    for (const [id, operation] of [
      ["connector.sqlite.discover", "connector_sqlite_discover"],
      ["ingest.sqlite", "ingest_sqlite"],
      ["analytics.professional", "professional_analytics_compute"],
    ]) {
      expect(capabilities.find((capability) => capability.id === id)).toMatchObject({
        operation,
        availability: { state: "available" },
      });
    }
    expect(JSON.stringify(capabilities)).not.toContain(databaseRoot);

    const validDiscover = { databaseId: "marketing" };
    const validIngest = {
      id: "strict-schema-batch",
      workspaceId,
      query: sqliteQuery(),
      ownership: "authorized",
      ...context("strict-schema"),
    };
    const validAnalytics = {
      id: "strict-schema-graph",
      workspaceId,
      expectedVersion: 1,
      batchId: "batch",
      datasetId: "dataset",
      evidenceId: "evidence",
      assetId: "asset",
      operation: {
        operation: "trend_v1",
        datasetId: "dataset",
        parameters: { timeField: "observedAt", valueField: "revenue", grain: "day" },
      },
      ...context("strict-schema-analytics"),
    };
    for (const [raw, strict, valid] of [
      [connectorSqliteDiscoverToolSchema, connectorSqliteDiscoverInputSchema, validDiscover],
      [ingestSqliteToolSchema, ingestSqliteInputSchema, validIngest],
      [professionalAnalyticsComputeToolSchema, professionalAnalyticsComputeInputSchema, validAnalytics],
    ] as const) {
      expect(raw.safeParse(valid).success).toBe(true);
      expect(strict.safeParse(valid).success).toBe(true);
      expect(raw.safeParse({ ...valid, unexpected: true }).success).toBe(false);
      expect(strict.safeParse({ ...valid, unexpected: true }).success).toBe(false);
    }
  });

  it("discovers, ingests, analyzes, replays, audits, and isolates workspaces through MCP", async () => {
    const discovery = await call<{ databaseId: string; tables: unknown[] }>(
      "connector_sqlite_discover",
      { databaseId: "marketing" },
    );
    expect(discovery).toMatchObject({ databaseId: "marketing" });
    expect(discovery.tables).toHaveLength(1);
    expect(JSON.stringify(discovery)).not.toContain(databaseRoot);

    const ingestArguments = {
      id: "sqlite-batch",
      workspaceId,
      query: sqliteQuery(),
      ownership: "authorized",
      ...context("sqlite-ingest"),
    };
    const batch = await call<IngestionBatch>("ingest_sqlite", ingestArguments);
    expect(batch).toMatchObject({ state: "completed", failures: [] });
    expect(await call<IngestionBatch>("ingest_sqlite", ingestArguments)).toEqual(batch);
    expect(await client.callTool({
      name: "ingest_sqlite",
      arguments: {
        ...ingestArguments,
        query: { ...sqliteQuery(), limit: 1 },
      },
    })).toMatchObject({ isError: true });

    const evidence = (await store.transaction((repos) =>
      repos.evidence.get(batch.evidenceIds[0]!, workspaceId))) as Evidence;
    const graph = await call<AnalysisGraph>("marketing_analysis_start", {
      id: "analytics-graph",
      workspaceId,
      objective: "Analyze authorized SQLite evidence",
      inputMode: "dataset",
      referenceId: batch.datasetIds[0]!,
      ...context("analytics-start"),
    });
    const analyticsArguments = {
      id: graph.id,
      workspaceId,
      expectedVersion: graph.version,
      batchId: batch.id,
      datasetId: batch.datasetIds[0]!,
      evidenceId: batch.evidenceIds[0]!,
      assetId: evidence.assets!.find((asset) => asset.kind === "normalized_jsonl")!.id,
      operation: {
        operation: "trend_v1",
        datasetId: batch.datasetIds[0]!,
        parameters: { timeField: "observedAt", valueField: "revenue", grain: "day" },
      },
      ...context("professional-analytics"),
    };
    const analyzed = await call<AnalysisGraph>("professional_analytics_compute", analyticsArguments);
    expect(analyzed.nodes.find((node) => node.kind === "analytics")?.payload).toMatchObject({
      operation: "trend_v1",
      points: [
        { window: "2026-01-01", value: 10, rowCount: 1 },
        { window: "2026-01-02", value: null, rowCount: 0 },
        { window: "2026-01-03", value: 20, rowCount: 1 },
      ],
    });
    expect(await call<AnalysisGraph>("professional_analytics_compute", analyticsArguments))
      .toEqual(analyzed);

    const raw = new DatabaseSync(storePath, { readOnly: true });
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
    expect(await client.callTool({
      name: "professional_analytics_compute",
      arguments: { ...analyticsArguments, workspaceId: "workspace-2" },
    })).toMatchObject({ isError: true });
    expect(await client.callTool({
      name: "data_research_get",
      arguments: { entityType: "ingestion_batch", id: batch.id, workspaceId: "workspace-2" },
    })).toMatchObject({ isError: true });
    expect(await call<AnalysisGraph>("analysis_graph_get", {
      id: graph.id,
      workspaceId,
    })).toEqual(analyzed);
  });

  it("rejects unknown, secret, path, SQL, shell, and code inputs before persistence", async () => {
    const secret = "synthetic-public-tool-secret";
    const ingest = {
      id: "forbidden-batch",
      workspaceId,
      query: sqliteQuery(),
      ownership: "authorized",
      ...context("forbidden-ingest"),
    };
    const analytics = {
      id: "forbidden-graph",
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
      ...context("forbidden-analytics"),
    };
    const calls = [
      ["connector_sqlite_discover", { databaseId: "marketing", path: databaseRoot }],
      ["connector_sqlite_discover", { databaseId: "../outside" }],
      ["connector_sqlite_discover", { databaseId: "marketing", apiKey: secret }],
      ["ingest_sqlite", { ...ingest, query: { ...sqliteQuery(), sql: "DELETE FROM daily_metrics" } }],
      ["ingest_sqlite", { ...ingest, query: { ...sqliteQuery(), command: "rm -rf /" } }],
      ["ingest_sqlite", { ...ingest, query: { ...sqliteQuery(), filters: { apiKey: secret } } }],
      ["ingest_sqlite", { ...ingest, unexpected: true }],
      ["professional_analytics_compute", { ...analytics, operation: { ...analytics.operation, python: "print(1)" } }],
      ["professional_analytics_compute", { ...analytics, operation: { ...analytics.operation, code: "process.exit()" } }],
      ["professional_analytics_compute", { ...analytics, token: secret }],
    ] as const;
    for (const [name, arguments_] of calls) {
      const result = await client.callTool({ name, arguments: arguments_ });
      expect(result, name).toMatchObject({ isError: true });
      expect(JSON.stringify(result), name).not.toContain(secret);
      expect(JSON.stringify(result), name).not.toContain(databaseRoot);
    }
    expect(await store.transaction((repos) =>
      repos.ingestionBatches.get("forbidden-batch", workspaceId))).toBeUndefined();
    expect(await store.transaction((repos) =>
      repos.analysisGraphs.get("forbidden-graph", workspaceId))).toBeUndefined();
  });

  it("keeps the old three-argument signature and reports missing configuration without environment leaks", async () => {
    const clock = { now: () => now };
    const unavailableData = new DataResearchService(
      store,
      clock,
      { next: () => `unavailable-${++sequence}` },
      artifacts,
      undefined,
      undefined,
      new SqliteConnector(undefined, clock),
    );
    const unavailableAnalysis = new AnalysisService(
      store,
      clock,
      { next: () => `unavailable-analysis-${++sequence}` },
      artifacts,
    );
    const legacyServer = createMcpServer(marketing, unavailableData, unavailableAnalysis);
    const legacyClient = new Client({ name: "legacy-signature-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        legacyClient.connect(clientTransport),
        legacyServer.connect(serverTransport),
      ]);
      expect((await legacyClient.listTools()).tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "connector_sqlite_discover",
          "ingest_sqlite",
          "professional_analytics_compute",
        ]),
      );
      const capabilities = JSON.parse((await legacyClient.callTool({
        name: "marketing_capability_list",
        arguments: {},
      })).content[0]!.text) as { id: string; availability: { state: string } }[];
      for (const id of ["connector.sqlite.discover", "ingest.sqlite", "analytics.professional"]) {
        expect(capabilities.find((capability) => capability.id === id)?.availability.state)
          .toBe("unavailable");
      }
      for (const [name, arguments_] of [
        ["connector_sqlite_discover", { databaseId: "marketing" }],
        ["ingest_sqlite", {
          id: "unconfigured-batch",
          workspaceId,
          query: sqliteQuery(),
          ownership: "owned",
          ...context("unconfigured-ingest"),
        }],
        ["professional_analytics_compute", {
          id: "unconfigured-graph",
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
        const result = await legacyClient.callTool({ name, arguments: arguments_ });
        expect(result).toMatchObject({ isError: true });
        expect(JSON.stringify(result)).toContain("Capability unavailable");
        expect(JSON.stringify(result)).not.toContain(databaseRoot);
      }
    } finally {
      await Promise.all([legacyClient.close(), legacyServer.close()]);
    }
  });

  it("returns a controlled error instead of truncating output over 64 KiB", async () => {
    expect(MAX_SERIALIZED_OUTPUT_BYTES).toBe(64 * 1024);
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
    const result = await client.callTool({
      name: "connector_sqlite_discover",
      arguments: { databaseId: "oversized" },
    });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("Resource conflict");
    expect(JSON.stringify(result)).not.toContain(databaseRoot);
  });
});

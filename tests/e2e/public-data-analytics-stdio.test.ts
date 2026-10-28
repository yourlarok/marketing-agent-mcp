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
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return JSON.parse((result.content[0] as { text: string }).text) as JsonRecord;
}

function sqliteQuery(): JsonRecord {
  return {
    databaseId: "marketing",
    table: "daily_metrics",
    columns: [
      "observedAt",
      "impressions",
      "likes",
      "saves",
      "comments",
      "clicks",
      "conversions",
      "revenue",
    ],
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
        CREATE TABLE daily_metrics (
          observedAt TEXT,
          impressions INTEGER,
          likes INTEGER,
          saves INTEGER,
          comments INTEGER,
          clicks INTEGER,
          conversions INTEGER,
          revenue REAL
        );
        INSERT INTO daily_metrics VALUES
          ('2026-01-01T00:00:00.000Z', 1000, 50, 10, 5, 100, 10, 10),
          ('2026-01-02T00:00:00.000Z', 1000, 60, 10, 5, 100, 12, 11),
          ('2026-01-03T00:00:00.000Z', 1000, 70, 10, 5, 100, 14, 12),
          ('2026-01-04T00:00:00.000Z', 1000, 80, 10, 5, 100, 16, 13),
          ('2026-01-06T00:00:00.000Z', 1000, 90, 10, 5, 100, 18, 100);
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

  it("runs SQLite metrics, Wilson, real MCP analytics, fork, and restart recovery", async () => {
    const running = await startClient();
    const { client } = running;
    const call = async (name: string, arguments_: JsonRecord = {}, target = client): Promise<JsonRecord> =>
      payload(await target.callTool({ name, arguments: arguments_ }));
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
    expect(discovery).toMatchObject({
      databaseId: "marketing",
      tables: [{
        name: "daily_metrics",
        columns: expect.arrayContaining([
          { name: "impressions", type: "number" },
          { name: "observedAt", type: "string" },
        ]),
      }],
    });
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
    const descriptors = lineage.descriptors as JsonRecord;
    const source = (descriptors.sources as JsonRecord[])[0]!;
    const evidence = (descriptors.evidence as JsonRecord[])[0]!;
    const assets = evidence.assets as {
      id: string;
      kind: string;
      contentHash: string;
      byteLength: number;
    }[];
    const normalizedAsset = assets.find((asset) => asset.kind === "normalized_jsonl")!;
    const snapshotAsset = assets.find((asset) => asset.kind === "snapshot")!;
    const snapshotResult = await call("evidence_asset_get", {
      workspaceId,
      evidenceId: evidence.id as string,
      assetId: snapshotAsset.id,
    });
    const snapshot = JSON.parse(Buffer.from(snapshotResult.content as string, "base64").toString("utf8")) as JsonRecord;
    expect(snapshot).toMatchObject({
      sourceDescriptor: {
        connectorId: "sqlite-readonly",
        databaseId: "marketing",
        table: "daily_metrics",
        query: sqliteQuery(),
      },
      queryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      rows: [
        { observedAt: "2026-01-01T00:00:00.000Z", impressions: 1000, conversions: 10, revenue: 10 },
        { observedAt: "2026-01-02T00:00:00.000Z", impressions: 1000, conversions: 12, revenue: 11 },
        { observedAt: "2026-01-03T00:00:00.000Z", impressions: 1000, conversions: 14, revenue: 12 },
        { observedAt: "2026-01-04T00:00:00.000Z", impressions: 1000, conversions: 16, revenue: 13 },
        { observedAt: "2026-01-06T00:00:00.000Z", impressions: 1000, conversions: 18, revenue: 100 },
      ],
    });
    expect(source).toMatchObject({
      type: "database",
      ownership: "authorized",
      metadata: {
        acquisition: "connector",
        databaseId: "marketing",
        table: "daily_metrics",
        queryHash: snapshot.queryHash,
      },
    });
    expect(JSON.stringify(lineage)).not.toContain(databaseRoot);

    const datasetId = (batch.datasetIds as string[])[0]!;
    const graph = await call("marketing_analysis_start", {
      id: "stdio-analytics-graph",
      workspaceId,
      objective: "Analyze a real SQLite snapshot",
      inputMode: "dataset",
      referenceId: datasetId,
      ...context("analytics-start"),
    });
    const evidenceSelector = {
      id: graph.id as string,
      workspaceId,
      batchId: batch.id as string,
      datasetId,
      evidenceId: evidence.id as string,
      assetId: normalizedAsset.id,
    };
    const engagementGraph = await call("metric_compute", {
      ...evidenceSelector,
      expectedVersion: graph.version as number,
      metricId: "engagement_rate_v1",
      comparability: "comparable",
      ...context("engagement"),
    });
    const engagementMetric = (engagementGraph.nodes as JsonRecord[]).find((node) =>
      node.kind === "metric" && (node.payload as JsonRecord).metricId === "engagement_rate_v1")!;
    expect(engagementMetric.payload).toMatchObject({
      metricId: "engagement_rate_v1",
      formula: "(sum(likes) + sum(saves) + sum(comments)) / sum(impressions)",
      numerator: 425,
      denominator: 5000,
      value: 0.085,
      status: "ok",
      includedRowCount: 5,
      excludedRowCount: 0,
      evidenceId: evidence.id,
      evidenceHash: evidence.contentHash,
      assetContentHash: normalizedAsset.contentHash,
      referenceAssessment: {
        level: "high",
        dimensions: {
          provenance: "authorized",
          sample: { status: "sufficient", denominator: 5000, minimumDenominator: 1000 },
          comparability: "comparable",
        },
      },
      proportionAssessment: {
        status: "not_applicable",
        reason: "METRIC_NOT_BINOMIAL_ELIGIBLE",
        interval: null,
      },
    });

    const conversionGraph = await call("metric_compute", {
      ...evidenceSelector,
      expectedVersion: engagementGraph.version as number,
      metricId: "conversion_rate_v1",
      comparability: "comparable",
      ...context("conversion"),
    });
    const conversionMetric = (conversionGraph.nodes as JsonRecord[]).find((node) =>
      node.kind === "metric" && (node.payload as JsonRecord).metricId === "conversion_rate_v1")!;
    expect(conversionMetric.payload).toMatchObject({
      metricId: "conversion_rate_v1",
      formula: "sum(conversions) / sum(clicks)",
      numerator: 70,
      denominator: 500,
      value: 0.14,
      status: "ok",
      evidenceId: evidence.id,
      evidenceHash: evidence.contentHash,
      assetContentHash: normalizedAsset.contentHash,
      referenceAssessment: {
        level: "high",
        dimensions: {
          provenance: "authorized",
          sample: { status: "sufficient", denominator: 500, minimumDenominator: 100 },
        },
      },
      proportionAssessment: {
        status: "applicable",
        reason: null,
        interval: { method: "wilson_score", confidenceLevel: 0.95 },
      },
    });
    const conversionPayload = conversionMetric.payload as JsonRecord;
    const proportion = conversionPayload.proportionAssessment as JsonRecord;
    const interval = proportion.interval as JsonRecord;
    expect(interval.lower).toBeCloseTo(0.11232266018786358, 14);
    expect(interval.upper).toBeCloseTo(0.17316686494445405, 14);
    expect(proportion.assumptions).toEqual([
      expect.stringMatching(/independent and identically distributed Bernoulli trials/),
      expect.stringMatching(/not a probability of marketing lift or a causal interval/),
    ]);

    const runAnalytics = async (
      current: JsonRecord,
      operation: JsonRecord,
      suffix: string,
    ): Promise<JsonRecord> => call("professional_analytics_compute", {
      ...evidenceSelector,
      expectedVersion: current.version as number,
      operation: { ...operation, datasetId },
      ...context(suffix),
    });
    const trendArguments = {
      ...evidenceSelector,
      expectedVersion: conversionGraph.version as number,
      operation: {
        operation: "trend_v1",
        datasetId,
        parameters: { timeField: "observedAt", valueField: "revenue", grain: "day" },
      },
      ...context("trend"),
    };
    const trendGraph = await call("professional_analytics_compute", trendArguments);
    const trendNode = (trendGraph.nodes as JsonRecord[]).find((node) =>
      node.kind === "analytics" && (node.payload as JsonRecord).operation === "trend_v1")!;
    expect(trendNode.payload).toMatchObject({
      operation: "trend_v1",
      status: "ok",
      points: [
        { window: "2026-01-01", value: 10, rowCount: 1 },
        { window: "2026-01-02", value: 11, rowCount: 1 },
        { window: "2026-01-03", value: 12, rowCount: 1 },
        { window: "2026-01-04", value: 13, rowCount: 1 },
        { window: "2026-01-05", value: null, rowCount: 0 },
        { window: "2026-01-06", value: 100, rowCount: 1 },
      ],
      missingWindows: ["2026-01-05"],
      coverage: 5 / 6,
    });

    const funnelGraph = await runAnalytics(trendGraph, {
      operation: "funnel_v1",
      parameters: { stageFields: ["impressions", "clicks", "conversions"] },
    }, "funnel");
    const funnelNode = (funnelGraph.nodes as JsonRecord[]).find((node) =>
      node.kind === "analytics" && (node.payload as JsonRecord).operation === "funnel_v1")!;
    expect(funnelNode.payload).toMatchObject({
      operation: "funnel_v1",
      status: "ok",
      stages: [
        { field: "impressions", total: 5000, conversionFromPrevious: null },
        { field: "clicks", total: 500, conversionFromPrevious: 0.1 },
        { field: "conversions", total: 70, conversionFromPrevious: 0.14 },
      ],
      overallConversion: 0.014,
      overallUnknownReason: null,
    });

    const analyzed = await runAnalytics(funnelGraph, {
      operation: "anomaly_v1",
      parameters: { valueField: "revenue" },
    }, "anomaly");
    const analyticsNodes = (analyzed.nodes as JsonRecord[]).filter((node) => node.kind === "analytics");
    expect(analyticsNodes).toHaveLength(3);
    const anomalyNode = analyticsNodes.find((node) =>
      (node.payload as JsonRecord).operation === "anomaly_v1")!;
    expect(anomalyNode.payload).toMatchObject({
      operation: "anomaly_v1",
      status: "ok",
      median: 12,
      mad: 1,
      modifiedZScoreThreshold: 3.5,
      anomalies: [{ index: 4, value: 100 }],
    });
    const anomalyPayload = anomalyNode.payload as JsonRecord;
    expect(anomalyPayload.threshold).toBeCloseTo(3.5 / 0.6745, 14);
    expect((anomalyPayload.anomalies as JsonRecord[])[0]!.modifiedZScore).toBeCloseTo(59.356, 12);
    for (const node of analyticsNodes) {
      expect((node.payload as JsonRecord).provenance).toMatchObject({
        provider: "mcp",
        tool: "analyze",
        toolVersion: "1.0.0",
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        rowCount: 5,
        batchId: batch.id,
        datasetId,
        evidenceId: evidence.id,
        assetId: normalizedAsset.id,
        evidenceHash: evidence.contentHash,
        assetContentHash: normalizedAsset.contentHash,
        assetByteLength: normalizedAsset.byteLength,
      });
    }

    const parentBeforeFork = structuredClone(analyzed);
    const forked = await call("analysis_graph_fork", {
      id: "stdio-analytics-graph-fork",
      workspaceId,
      parentGraphId: analyzed.id as string,
      expectedVersion: analyzed.version as number,
      forkNodeId: anomalyNode.id as string,
      ...context("fork"),
    });
    expect(Object.keys(forked).sort()).toEqual([
      "createdAt",
      "edges",
      "forkNodeId",
      "id",
      "nodes",
      "parentGraphId",
      "parentVersion",
      "recommendedActions",
      "updatedAt",
      "version",
      "workspaceId",
    ]);
    expect({
      id: forked.id,
      workspaceId: forked.workspaceId,
      version: forked.version,
      parentGraphId: forked.parentGraphId,
      parentVersion: forked.parentVersion,
      forkNodeId: forked.forkNodeId,
    }).toEqual({
      id: "stdio-analytics-graph-fork",
      workspaceId,
      version: 1,
      parentGraphId: analyzed.id,
      parentVersion: analyzed.version,
      forkNodeId: anomalyNode.id,
    });
    expect(forked.createdAt).toBe(forked.updatedAt);
    expect(forked.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(forked.createdAt as string)).toBeGreaterThanOrEqual(
      Date.parse(parentBeforeFork.updatedAt as string),
    );
    expect(forked.nodes).toEqual(parentBeforeFork.nodes);
    expect(forked.edges).toEqual(parentBeforeFork.edges);

    const parentActions = parentBeforeFork.recommendedActions as JsonRecord[];
    const forkActions = forked.recommendedActions as JsonRecord[];
    const graphScopedTools = new Set([
      "metric_compute",
      "metric_scenario_create",
      "metric_monitor_compare",
    ]);
    const forkNodeIds = new Set((forked.nodes as JsonRecord[]).map((node) => node.id));
    expect(forkActions).toHaveLength(parentActions.length);
    expect(forkActions.length).toBeGreaterThan(0);
    for (const [index, parentAction] of parentActions.entries()) {
      const forkAction = forkActions[index]!;
      expect(graphScopedTools.has(parentAction.tool as string)).toBe(true);
      const { arguments: parentArguments, ...parentMetadata } = parentAction;
      const { arguments: forkArguments, ...forkMetadata } = forkAction;
      expect(forkMetadata).toEqual(parentMetadata);
      const parentArgs = parentArguments as JsonRecord;
      const forkArgs = forkArguments as JsonRecord;
      expect(parentArgs.id).toBe(parentBeforeFork.id);
      expect(parentArgs.expectedVersion).toBe(parentBeforeFork.version);
      expect(forkArgs.id).toBe(forked.id);
      expect(forkArgs.expectedVersion).toBe(1);
      const stableArguments = (args: JsonRecord): JsonRecord => Object.fromEntries(
        Object.entries(args).filter(([key]) =>
          !["id", "expectedVersion", "requestId", "idempotencyKey"].includes(key)),
      );
      expect(stableArguments(forkArgs)).toEqual(stableArguments(parentArgs));
      for (const field of ["requestId", "idempotencyKey"]) {
        expect(forkArgs[field]).toMatch(new RegExp(`^analysis-${field}-[a-f0-9]{64}$`));
        expect(forkArgs[field]).not.toBe(parentArgs[field]);
      }
      for (const field of ["metricNodeId", "baselineMetricNodeId"]) {
        if (Object.hasOwn(forkArgs, field)) {
          expect(forkArgs[field]).toBe(parentArgs[field]);
          expect(forkNodeIds).toContain(forkArgs[field]);
        }
      }
    }
    expect(analyzed).toEqual(parentBeforeFork);
    expect(await call("analysis_graph_get", {
      id: analyzed.id as string,
      workspaceId,
    })).toEqual(parentBeforeFork);

    const secret = "synthetic-stdio-public-tool-secret";
    for (const [name, arguments_] of [
      ["connector_sqlite_discover", { databaseId: "marketing", unexpected: true }],
      ["ingest_sqlite", { ...ingestArguments, query: { ...sqliteQuery(), sql: "DROP TABLE daily_metrics" } }],
      ["ingest_sqlite", { ...ingestArguments, query: { ...sqliteQuery(), filters: { apiKey: secret } } }],
      ["professional_analytics_compute", { ...trendArguments, operation: { ...trendArguments.operation, shell: "id" } }],
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
        { action: "analysis_graph.professional_analyze", count: 3 },
        { action: "ingestion_batch.connector_sqlite", count: 1 },
      ]);
    } finally {
      raw.close();
    }

    await stopClient(running);
    const restarted = await startClient();
    for (const expected of [analyzed, forked]) {
      expect(await call("analysis_graph_get", {
        id: expected.id as string,
        workspaceId,
      }, restarted.client)).toEqual(expected);
    }
    expect(await call("data_research_get", {
      entityType: "ingestion_batch",
      id: batch.id as string,
      workspaceId,
    }, restarted.client)).toEqual(lineage);
    const restoredSnapshot = await call("evidence_asset_get", {
      workspaceId,
      evidenceId: evidence.id as string,
      assetId: snapshotAsset.id,
    }, restarted.client);
    expect(JSON.parse(Buffer.from(restoredSnapshot.content as string, "base64").toString("utf8")))
      .toEqual(snapshot);
    await stopClient(restarted);
  }, 60_000);

  it("reports capability gaps and configuration actions without configuration or writes", async () => {
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
      expect(unavailable.content[0]).toMatchObject({ type: "text" });
      const gap = JSON.parse((unavailable.content[0] as { text: string }).text) as JsonRecord;
      expect(unavailable.structuredContent).toEqual(gap);
      expect(gap).toEqual({
        code: "CAPABILITY_UNAVAILABLE",
        message: "Capability unavailable",
        retryable: false,
        ...(name === "professional_analytics_compute" ? {
          capability: "professional_analytics",
          reason: "mcp_not_configured",
          configurationAction: "Configure MARKETING_ANALYTICS_MCP_COMMAND and MARKETING_ANALYTICS_MCP_ARGS in the trusted deployment environment",
        } : {
          capability: "sqlite",
          configurationAction: "Configure MARKETING_DATABASE_ROOT in the trusted deployment environment",
        }),
      });
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

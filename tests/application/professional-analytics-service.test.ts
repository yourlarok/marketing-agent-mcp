import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisService } from "../../src/application/analysis-service.js";
import type { RunProfessionalAnalytics } from "../../src/application/analysis-commands.js";
import { DataResearchService } from "../../src/application/data-research-service.js";
import type { Command, CommandContext } from "../../src/application/commands.js";
import type { Store } from "../../src/application/ports.js";
import type { AnalysisGraph, AnalysisGraphNode } from "../../src/domain/analysis-model.js";
import type { AnalyticsOperation } from "../../src/domain/analytics-model.js";
import type { IngestionBatch } from "../../src/domain/data-research-model.js";
import type { DomainError } from "../../src/domain/errors.js";
import type { Evidence } from "../../src/domain/model.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import { McpAnalyticsProvider } from "../../src/infrastructure/analytics-provider.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-27T12:00:00.000Z";
const fixture = fileURLToPath(new URL("../fixtures/professional-analytics-mcp.mjs", import.meta.url));

function context(suffix: string): CommandContext {
  return { actor: "agent-1", requestId: `request-${suffix}`, idempotencyKey: `command-${suffix}` };
}

function provider(mode?: string, timeoutMs = 2_000): McpAnalyticsProvider {
  return new McpAnalyticsProvider({
    command: process.execPath,
    args: [fixture],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MARKETING_TEST_BUSINESS_SECRET: "must-not-reach-child",
      ...(mode === undefined ? {} : { ANALYTICS_FIXTURE_MODE: mode }),
    },
    envAllowlist: ["ANALYTICS_FIXTURE_MODE"],
    timeoutMs,
  });
}

describe("AnalysisService professional MCP analytics", () => {
  let tempDir: string;
  let importRoot: string;
  let artifactRoot: string;
  let storePath: string;
  let store: Store;
  let artifacts: ArtifactStore;
  let ingest: DataResearchService;
  let service: AnalysisService;
  let batch: IngestionBatch;
  let graph: AnalysisGraph;
  let evidence: Evidence;
  let assetId: string;
  let sequence: number;
  let originalImportRoot: string | undefined;
  let originalArtifactRoot: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir();
    importRoot = await createTempDir();
    artifactRoot = await createTempDir();
    storePath = join(tempDir, "analysis.db");
    originalImportRoot = process.env.MARKETING_IMPORT_ROOT;
    originalArtifactRoot = process.env.MARKETING_ARTIFACT_DIR;
    process.env.MARKETING_IMPORT_ROOT = importRoot;
    process.env.MARKETING_ARTIFACT_DIR = artifactRoot;
    store = openStore(storePath);
    artifacts = new ArtifactStore(artifactRoot);
    sequence = 0;
    ingest = new DataResearchService(store, { now: () => now }, { next: () => `ingest-${++sequence}` });
    service = createService();
    await store.transaction(async (repos) => {
      await repos.workspaces.insert({
        id: "workspace-1", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now, name: "workspace-1",
      });
    });
    await writeFile(join(importRoot, "analytics.csv"), [
      "observedAt,revenue,impressions,clicks,conversions",
      "2026-01-01T00:00:00.000Z,10,100,20,2",
      "2026-01-01T01:00:00.000Z,11,100,20,2",
      "2026-01-03T00:00:00.000Z,9,100,20,2",
      "2026-01-03T01:00:00.000Z,10,100,20,2",
      "2026-01-04T00:00:00.000Z,12,100,20,2",
      "2026-01-04T01:00:00.000Z,100,100,20,2",
      "",
    ].join("\n"));
    batch = await ingest.importFiles({
      input: { id: "analytics-batch", workspaceId: "workspace-1", paths: ["analytics.csv"] },
      context: context("analytics-batch"),
    });
    expect(batch.failures).toEqual([]);
    graph = await service.start({
      input: {
        id: "analytics-graph",
        workspaceId: "workspace-1",
        objective: "Analyze one imported dataset",
        inputMode: "dataset",
        referenceId: batch.datasetIds[0],
      },
      context: context("analytics-start"),
    });
    evidence = (await store.transaction((repos) =>
      repos.evidence.get(batch.evidenceIds[0]!, "workspace-1")))!;
    assetId = evidence.assets!.find((asset) => asset.kind === "normalized_jsonl")!.id;
  });

  afterEach(async () => {
    store.close();
    if (originalImportRoot === undefined) delete process.env.MARKETING_IMPORT_ROOT;
    else process.env.MARKETING_IMPORT_ROOT = originalImportRoot;
    if (originalArtifactRoot === undefined) delete process.env.MARKETING_ARTIFACT_DIR;
    else process.env.MARKETING_ARTIFACT_DIR = originalArtifactRoot;
    await Promise.all([removeTempDir(tempDir), removeTempDir(importRoot), removeTempDir(artifactRoot)]);
  });

  function createService(currentStore = store, analyticsProvider = provider()): AnalysisService {
    return new AnalysisService(
      currentStore,
      { now: () => now },
      { next: () => `analysis-${++sequence}` },
      artifacts,
      analyticsProvider,
    );
  }

  function command(
    operation: AnalyticsOperation,
    currentGraph = graph,
    suffix = operation.operation,
    patch: Record<string, unknown> = {},
  ): Command<RunProfessionalAnalytics> {
    return {
      input: {
        id: currentGraph.id,
        workspaceId: currentGraph.workspaceId,
        expectedVersion: currentGraph.version,
        batchId: batch.id,
        datasetId: batch.datasetIds[0]!,
        evidenceId: batch.evidenceIds[0]!,
        assetId,
        operation,
        ...patch,
      },
      context: context(`${suffix}-${currentGraph.version}`),
    };
  }

  const trend: AnalyticsOperation = {
    operation: "trend_v1",
    datasetId: "dataset-placeholder",
    parameters: { timeField: "observedAt", valueField: "revenue", grain: "day" },
  };
  const funnel: AnalyticsOperation = {
    operation: "funnel_v1",
    datasetId: "dataset-placeholder",
    parameters: { stageFields: ["impressions", "clicks", "conversions"] },
  };
  const anomaly: AnalyticsOperation = {
    operation: "anomaly_v1",
    datasetId: "dataset-placeholder",
    parameters: { valueField: "revenue" },
  };

  function bound(operation: AnalyticsOperation): AnalyticsOperation {
    return { ...operation, datasetId: batch.datasetIds[0]! } as AnalyticsOperation;
  }

  it("persists verified trend, funnel, and anomaly results as derived nodes with evidence provenance", async () => {
    const trendGraph = await service.analyze(command(bound(trend)));
    const trendNode = trendGraph.nodes.find((node) => node.kind === "analytics")!;
    expect(trendGraph.version).toBe(2);
    expect(trendNode.payload).toMatchObject({
      operation: "trend_v1",
      definitionVersion: 1,
      datasetId: batch.datasetIds[0],
      points: [
        { window: "2026-01-01", value: 21, rowCount: 2 },
        { window: "2026-01-02", value: null, rowCount: 0 },
        { window: "2026-01-03", value: 19, rowCount: 2 },
        { window: "2026-01-04", value: 112, rowCount: 2 },
      ],
      missingWindows: ["2026-01-02"],
      coverage: 0.75,
      provenance: {
        provider: "mcp",
        tool: "analyze",
        toolVersion: "1.0.0",
        batchId: batch.id,
        datasetId: batch.datasetIds[0],
        evidenceId: batch.evidenceIds[0],
        assetId,
        sourceId: batch.sourceIds[0],
        evidenceHash: evidence.contentHash,
        assetContentHash: evidence.contentHash,
        rowCount: 6,
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(trendGraph.edges.at(-1)).toMatchObject({
      fromNodeId: graph.nodes.find((node) => node.kind === "dataset")!.id,
      toNodeId: trendNode.id,
    });

    const funnelGraph = await service.analyze(command(bound(funnel), trendGraph));
    const funnelNode = funnelGraph.nodes.filter((node) => node.kind === "analytics").at(-1)!;
    expect(funnelNode.payload).toMatchObject({
      operation: "funnel_v1",
      stages: [
        { field: "impressions", total: 600, conversionFromPrevious: null },
        { field: "clicks", total: 120, conversionFromPrevious: 0.2 },
        { field: "conversions", total: 12, conversionFromPrevious: 0.1 },
      ],
      overallConversion: 0.02,
    });

    const anomalyGraph = await service.analyze(command(bound(anomaly), funnelGraph));
    const anomalyNode = anomalyGraph.nodes.filter((node) => node.kind === "analytics").at(-1)!;
    expect(anomalyNode.payload).toMatchObject({
      operation: "anomaly_v1",
      median: 10.5,
      mad: 1,
      modifiedZScoreThreshold: 3.5,
      anomalies: [{ index: 5, value: 100 }],
    });

    store.close();
    store = openStore(storePath);
    service = createService(store);
    await expect(service.get({ id: graph.id, workspaceId: graph.workspaceId })).resolves.toEqual(anomalyGraph);
  });

  it.each([
    ["malformed", "mcp_invalid_response"],
    ["wrong-hash", "mcp_input_hash_mismatch"],
    ["mismatch", "mcp_result_mismatch"],
    ["timeout", "mcp_timeout"],
  ])("does not persist a failed provider result for %s", async (mode, reason) => {
    const failing = createService(store, provider(mode, mode === "timeout" ? 100 : 2_000));
    await expect(failing.analyze(command(bound(trend), graph, `failure-${mode}`)))
      .rejects.toMatchObject<DomainError>({ code: "CAPABILITY_UNAVAILABLE", details: { reason } });
    await expect(service.get({ id: graph.id, workspaceId: graph.workspaceId })).resolves.toEqual(graph);
    const audits = await store.transaction((repos) =>
      repos.audit.listForEntity(graph.workspaceId, "analysis_graph", graph.id));
    expect(audits).toHaveLength(1);
  });

  it("returns a configuration gap without a local substitute when no provider is configured", async () => {
    const unavailable = new AnalysisService(
      store,
      { now: () => now },
      { next: () => `unconfigured-${++sequence}` },
      artifacts,
    );
    await expect(unavailable.analyze(command(bound(trend)))).rejects.toMatchObject<DomainError>({
      code: "CAPABILITY_UNAVAILABLE",
      details: { capability: "professional_analytics", reason: "mcp_not_configured" },
    });
    await expect(service.get({ id: graph.id, workspaceId: graph.workspaceId })).resolves.toEqual(graph);
  });

  it("returns an availability gap when the configured provider cannot start", async () => {
    const unavailable = createService(store, new McpAnalyticsProvider({
      command: "/definitely/missing/analytics-provider",
    }));
    await expect(unavailable.analyze(command(bound(trend)))).rejects.toMatchObject<DomainError>({
      code: "CAPABILITY_UNAVAILABLE",
      details: { capability: "professional_analytics", reason: "mcp_unavailable" },
    });
    await expect(service.get({ id: graph.id, workspaceId: graph.workspaceId })).resolves.toEqual(graph);
  });

  it("rejects cross-dataset operations and dynamic command, path, SQL, shell, or code inputs", async () => {
    const cases = [
      command({ ...bound(funnel), datasetId: "another-dataset" }, graph, "cross-dataset"),
      command(bound(trend), graph, "dynamic-command", { command: process.execPath }),
      command(bound(trend), graph, "dynamic-path", { connectorPath: fixture }),
      command(bound(trend), graph, "sql", { sql: "SELECT * FROM secrets" }),
      command(bound(trend), graph, "shell", { shell: "rm -rf /" }),
      command(bound(trend), graph, "python", { code: "print(1)" }),
    ];
    for (const invalid of cases) {
      await expect(service.analyze(invalid)).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    }
    await expect(service.get({ id: graph.id, workspaceId: graph.workspaceId })).resolves.toEqual(graph);
  });

  it("does not allow generic expand to forge an analytics node", async () => {
    const forged = {
      id: "forged-analytics",
      kind: "analytics",
      payload: { operation: "trend_v1", datasetId: batch.datasetIds[0]!, status: "ok" },
    } as AnalysisGraphNode;
    await expect(service.expand({
      input: {
        id: graph.id,
        workspaceId: graph.workspaceId,
        expectedVersion: graph.version,
        nodes: [forged],
        edges: [],
      },
      context: context("forge-analytics"),
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expect(service.get({ id: graph.id, workspaceId: graph.workspaceId })).resolves.toEqual(graph);
  });
});

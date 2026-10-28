import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisService, type AnalysisCapability } from "../../src/application/analysis-service.js";
import type { CommandContext } from "../../src/application/commands.js";
import { DashboardService } from "../../src/application/dashboard-service.js";
import { DataResearchService } from "../../src/application/data-research-service.js";
import { MarketingService } from "../../src/application/marketing-service.js";
import type { Store } from "../../src/application/ports.js";
import { StrategyService } from "../../src/application/strategy-service.js";
import { FUNNEL_V1_FORMULA, TREND_V1_FORMULA } from "../../src/domain/analytics-model.js";
import type { Dashboard } from "../../src/domain/dashboard-model.js";
import { getMetricDefinition } from "../../src/domain/metric-catalog.js";
import type { Recommendation, Task } from "../../src/domain/model.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { canonicalJson } from "../../src/infrastructure/sqlite.js";
import { MAX_SERIALIZED_OUTPUT_BYTES } from "../../src/mcp/schemas.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-28T12:00:00.000Z";
const metric = getMetricDefinition("ctr_v1");
const newToolNames = [
  "dashboard_artifact_get",
  "dashboard_drilldown_get",
  "dashboard_get",
  "dashboard_render",
  "strategy_recommendation_generate",
  "strategy_task_get",
  "strategy_task_list",
  "strategy_task_reject",
  "strategy_task_reorder",
  "strategy_task_supplement",
  "strategy_task_update",
];
const existingToolNames = [
  "analysis_graph_expand", "analysis_graph_fork", "analysis_graph_get",
  "capability_health_record", "capability_list", "capability_register",
  "competitor_confirm", "competitor_diff_create", "connector_sqlite_discover",
  "data_request_decline", "data_request_plan", "data_research_get", "dataset_register",
  "evidence_asset_get", "evidence_record", "finding_record", "ingest_content_links",
  "ingest_files", "ingest_sqlite", "ingest_temporary_api", "lineage_get",
  "marketing_analysis_start", "marketing_capability_list", "metric_compute",
  "metric_monitor_compare", "metric_scenario_create", "professional_analytics_compute",
  "recommendation_create", "research_permission_set", "research_session_create",
  "research_session_run", "source_register", "task_create", "task_transition", "workspace_create",
];
const newWriteToolNames = [
  "dashboard_render",
  "strategy_recommendation_generate",
  "strategy_task_reject",
  "strategy_task_reorder",
  "strategy_task_supplement",
  "strategy_task_update",
];
const newReadToolNames = newToolNames.filter((name) => !newWriteToolNames.includes(name));

function context(suffix: string): CommandContext {
  return {
    actor: "agent-1",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  };
}

function renderArguments(id = "dashboard-1", suffix = "render") {
  return {
    id,
    workspaceId: "workspace-1",
    views: [
      { id: "trend-view", kind: "trend", graphId: "graph-1", nodeIds: ["trend-1"] },
      { id: "structure-view", kind: "structure", graphId: "graph-1", nodeIds: ["metric-1"] },
      { id: "funnel-view", kind: "funnel", graphId: "graph-1", nodeIds: ["funnel-1"] },
      { id: "competitor-view", kind: "competitor_comparison", competitorDiffId: "diff-1" },
      { id: "task-view", kind: "task_effect", graphId: "graph-1", taskIds: ["dashboard-task"], monitorNodeIds: ["monitor-1"] },
    ],
    ...context(suffix),
  };
}

function recommendationArguments(suffix = "generate") {
  return {
    id: "recommendation-1",
    workspaceId: "workspace-1",
    findingIds: ["finding-1"],
    hypothesis: "A clearer opening may increase qualified clicks",
    affectedStage: "click",
    targetChannels: ["search"],
    priority: "p1",
    expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline" }],
    ...context(suffix),
  };
}

function taskArguments(suffix = "supplement") {
  return {
    id: "task-1",
    workspaceId: "workspace-1",
    recommendationIds: ["recommendation-1"],
    title: "Revise the opening",
    assignee: "content-owner",
    priority: "p1",
    rank: 1,
    dependencyIds: [],
    assetRequirements: ["existing approved opening"],
    acceptanceCriteria: ["A user reviews the revised opening"],
    ...context(suffix),
  };
}

describe("dashboard and strategy MCP contracts", () => {
  let tempDir: string;
  let store: Store;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let marketing: MarketingService;
  let dataResearch: DataResearchService;
  let analysis: AnalysisService;
  let dashboard: DashboardService;
  let strategy: StrategyService;
  let artifacts: ArtifactStore;
  const clock = { now: () => now };
  let sequence = 0;
  const ids = { next: () => `audit-${++sequence}` };

  beforeEach(async () => {
    tempDir = await createTempDir();
    store = openStore(":memory:");
    artifacts = new ArtifactStore(join(tempDir, "artifacts"));
    marketing = new MarketingService(store, clock, ids);
    dataResearch = new DataResearchService(store, clock, ids, artifacts);
    analysis = new AnalysisService(store, clock, ids, artifacts);
    dashboard = new DashboardService(store, clock, ids, artifacts);
    strategy = new StrategyService(store, clock, ids);
    await store.transaction(async (repos) => {
      await repos.workspaces.insert({
        id: "workspace-1", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now, name: "Workspace",
      });
      await repos.workspaces.insert({
        id: "workspace-2", workspaceId: "workspace-2", version: 1,
        createdAt: now, updatedAt: now, name: "Other workspace",
      });
      await repos.sources.insert({
        id: "source-1", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now, name: `Owned source ${"x".repeat(8_000)}`,
        type: "database", ownership: "owned",
      });
      await repos.datasets.insert({
        id: "dataset-1", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now, sourceId: "source-1", name: "Dataset",
        coverageStart: "2026-01-01T00:00:00.000Z", coverageEnd: "2026-01-31T00:00:00.000Z",
        fieldDefinitions: [], metricDefinitions: [], limitations: [],
      });
      await repos.evidence.insert({
        id: "evidence-1", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now, sourceId: "source-1", sourceLocator: "warehouse/evidence",
        observedAt: "2026-02-01T00:00:00.000Z", summary: "Owned evidence",
        contentHash: "a".repeat(64), classification: "owned_operating",
        assets: [{ id: "asset-1", kind: "normalized_jsonl", contentHash: "a".repeat(64), byteLength: 123 }],
      });
      await repos.findings.insert({
        id: "finding-1", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now, kind: "fact", statement: "Observed CTR is 0.1",
        evidenceIds: ["evidence-1"],
      });
      const provenance = {
        provider: "mcp", tool: "analyze", toolVersion: "fixture-1", inputHash: "b".repeat(64), rowCount: 2,
        batchId: "batch-1", datasetId: "dataset-1", evidenceId: "evidence-1", assetId: "asset-1", sourceId: "source-1",
      };
      await repos.analysisGraphs.insert({
        id: "graph-1", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now, parentGraphId: null, parentVersion: null, forkNodeId: null,
        edges: [], recommendedActions: [],
        nodes: [
          {
            id: "trend-1", kind: "analytics",
            payload: {
              operation: "trend_v1", datasetId: "dataset-1", status: "ok", unknownReason: null,
              points: [{ window: "2026-01-01", value: 10, rowCount: 2 }], missingWindows: [], coverage: 1,
              definitionVersion: 1, formula: TREND_V1_FORMULA, provenance,
            },
          },
          {
            id: "metric-1", kind: "metric",
            payload: {
              metricId: "ctr_v1", definitionVersion: 1, formula: metric.formula, unit: "ratio", status: "ok",
              numerator: 100, denominator: 1000, value: 0.1, unknownReason: null,
              datasetId: "dataset-1", evidenceId: "evidence-1", sourceId: "source-1",
              referenceAssessment: { level: "high", reasons: [] },
            },
          },
          {
            id: "funnel-1", kind: "analytics",
            payload: {
              operation: "funnel_v1", datasetId: "dataset-1", status: "ok",
              stages: [
                { field: "impressions", total: 1000, conversionFromPrevious: null, conversionUnknownReason: null },
                { field: "clicks", total: 100, conversionFromPrevious: 0.1, conversionUnknownReason: null },
              ],
              overallConversion: 0.1, overallUnknownReason: null,
              definitionVersion: 1, formula: FUNNEL_V1_FORMULA, provenance,
            },
          },
          { id: "scenario-1", kind: "scenario", payload: { metricNodeId: "metric-1", metricId: "ctr_v1", definitionVersion: 1 } },
          {
            id: "monitor-1", kind: "monitor",
            payload: {
              metricId: "ctr_v1", definitionVersion: 1, formula: metric.formula, status: "ok",
              baselineMetricNodeId: "metric-1", scenarioNodeId: "scenario-1",
              datasetId: "dataset-1", evidenceId: "evidence-1",
              baseline: { value: 0.1 },
              current: { value: 0.2, datasetId: "dataset-1", evidenceId: "evidence-1", sourceId: "source-1" },
              absoluteDelta: 0.1, relativeDelta: 1, comparisonUnknownReason: null, relativeDeltaUnknownReason: null,
            },
          },
        ],
      });
      await repos.competitorDiffs.insert({
        id: "diff-1", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now, competitorIds: ["competitor-1"], findingIds: [],
        entries: [{ dimension: "Price", result: "different", evidenceIds: ["evidence-1"] }],
      });
      await repos.recommendations.insert({
        id: "dashboard-recommendation", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now, findingIds: [], hypothesis: "Hypothesis", affectedStage: "click",
        priority: "p0", expectedMetric: "ctr_v1",
      });
      await repos.tasks.insert({
        id: "dashboard-task", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now, recommendationIds: ["dashboard-recommendation"], assignee: "owner",
        dependencyIds: [], assetRequirements: [], acceptanceCriteria: ["done"], state: "completed",
      });
    });
    server = createMcpServer(marketing, dataResearch, analysis, {}, dashboard, strategy);
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
    store.close();
    await removeTempDir(tempDir);
  });

  async function call<T>(name: string, arguments_: Record<string, unknown> = {}): Promise<T> {
    const result = await client.callTool({ name, arguments: arguments_ });
    expect(result).not.toMatchObject({ isError: true });
    const text = (result.content[0] as { text: string }).text;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_SERIALIZED_OUTPUT_BYTES);
    const parsed = JSON.parse(text) as T;
    expect(text).toBe(canonicalJson(parsed));
    return parsed;
  }

  it("registers exactly 46 tools with strict raw schemas and context only on writes", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...existingToolNames, ...newToolNames].sort());
    expect(tools).toHaveLength(46);
    const visit = (schema: unknown): void => {
      if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return;
      const record = schema as Record<string, unknown>;
      if (record.type === "object" && record.properties !== undefined) {
        expect(record.additionalProperties).toBe(false);
      }
      for (const value of Object.values(record)) {
        if (Array.isArray(value)) value.forEach(visit);
        else visit(value);
      }
    };
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      visit(tool.inputSchema);
    }
    for (const name of newWriteToolNames) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      for (const field of ["actor", "requestId", "idempotencyKey"]) {
        expect(tool.inputSchema.required, `${name}.${field}`).toContain(field);
      }
    }
    for (const name of newReadToolNames) {
      const required = tools.find((candidate) => candidate.name === name)!.inputSchema.required ?? [];
      for (const field of ["actor", "requestId", "idempotencyKey"]) expect(required).not.toContain(field);
    }
  });

  it("wires all eleven adapters to real dashboard, artifact, drilldown, recommendation, and task services", async () => {
    const rendered = await call<Dashboard>("dashboard_render", renderArguments());
    expect(rendered).toMatchObject({
      id: "dashboard-1", version: 1,
      renderer: { type: "controlled_renderer", id: "controlled_html_svg_v1", professionalTool: false },
    });
    expect(rendered.views.map((view) => view.kind)).toEqual([
      "trend", "structure", "funnel", "competitor_comparison", "task_effect",
    ]);
    expect(JSON.stringify(rendered)).not.toContain(tempDir);
    expect(await call<Dashboard>("dashboard_get", {
      id: rendered.id, workspaceId: rendered.workspaceId,
    })).toEqual(rendered);

    const drilldown = await call<{ evidence: { evidenceId: string }[]; analysisGraphRefs: unknown[] }>(
      "dashboard_drilldown_get",
      { id: rendered.id, workspaceId: rendered.workspaceId, viewId: "trend-view", datumId: "trend-1/point/0" },
    );
    expect(drilldown.evidence.map((item) => item.evidenceId)).toEqual(["evidence-1"]);
    expect(drilldown.analysisGraphRefs).toHaveLength(1);

    const html = rendered.artifacts.find((artifact) => artifact.kind === "html")!;
    const chunk = await call<{ content: string; length: number; totalBytes: number }>("dashboard_artifact_get", {
      id: rendered.id, workspaceId: rendered.workspaceId, artifactId: html.id, offset: 0, length: 32_768,
    });
    expect(chunk.length).toBe(32_768);
    expect(Buffer.from(chunk.content, "base64").byteLength).toBe(chunk.length);
    expect(chunk.totalBytes).toBe(html.byteLength);

    const lineage = await call<{ nodes: { entityType: string; id: string }[] }>("lineage_get", {
      entityType: "dashboard", id: rendered.id, workspaceId: rendered.workspaceId,
    });
    expect(lineage.nodes).toContainEqual(expect.objectContaining({ entityType: "dashboard", id: rendered.id }));

    const recommendation = await call<Recommendation>("strategy_recommendation_generate", recommendationArguments());
    expect(recommendation).toMatchObject({
      id: "recommendation-1", findingIds: ["finding-1"], evidenceIds: ["evidence-1"],
      impacts: [{ status: "unknown", unknownReason: "BASELINE_NOT_COMPUTED", causality: "not_established" }],
    });
    expect(await call<Recommendation>("strategy_recommendation_generate", recommendationArguments())).toEqual(recommendation);

    const supplemented = await call<Task>("strategy_task_supplement", taskArguments());
    expect(supplemented).toMatchObject({ id: "task-1", state: "draft", version: 1, rank: 1 });
    expect(await call<Task>("strategy_task_get", {
      id: supplemented.id, workspaceId: supplemented.workspaceId,
    })).toEqual(supplemented);
    const listed = await call<{ tasks: { id: string }[]; nextCursor: unknown }>("strategy_task_list", {
      workspaceId: supplemented.workspaceId, limit: 1,
    });
    expect(listed.tasks.map((task) => task.id)).toEqual([supplemented.id]);
    expect(listed.nextCursor).toEqual({ rank: 1, id: supplemented.id });

    const updated = await call<Task>("strategy_task_update", {
      id: supplemented.id, workspaceId: supplemented.workspaceId, expectedVersion: 1,
      title: "A user-controlled revised draft", ...context("update"),
    });
    expect(updated).toMatchObject({ version: 2, title: "A user-controlled revised draft", state: "draft" });
    const reordered = await call<Task>("strategy_task_reorder", {
      id: supplemented.id, workspaceId: supplemented.workspaceId, expectedVersion: 2,
      rank: 3, ...context("reorder"),
    });
    expect(reordered).toMatchObject({ version: 3, rank: 3, state: "draft" });
    const rejected = await call<Task>("strategy_task_reject", {
      id: supplemented.id, workspaceId: supplemented.workspaceId, expectedVersion: 3,
      reason: "The user rejected this draft", ...context("reject"),
    });
    expect(rejected).toMatchObject({ version: 4, state: "rejected", rejectionReason: "The user rejected this draft" });
    expect(await store.transaction((repos) => repos.capabilities.list("workspace-1"))).toEqual([]);
  });

  it("rejects unknown, nested secret-like, malformed union, enum, range, and duplicate inputs", async () => {
    const secret = "synthetic-dashboard-strategy-secret";
    const invalidCalls = [
      ["dashboard_render", { ...renderArguments("bad-dashboard", "bad-dashboard"), unexpected: true }],
      ["dashboard_render", {
        ...renderArguments("bad-nested-secret", "bad-nested-secret"),
        views: [{ id: "secret-view", kind: "trend", graphId: "graph-1", nodeIds: ["trend-1"], apiKey: secret }],
      }],
      ["dashboard_render", {
        ...renderArguments("bad-view-union", "bad-view-union"),
        views: [{ id: "bad-view", kind: "competitor_comparison", graphId: "graph-1", nodeIds: ["trend-1"] }],
      }],
      ["dashboard_render", {
        ...renderArguments("bad-view-duplicate", "bad-view-duplicate"),
        views: [
          { id: "duplicate", kind: "trend", graphId: "graph-1", nodeIds: ["trend-1"] },
          { id: "duplicate", kind: "structure", graphId: "graph-1", nodeIds: ["metric-1"] },
        ],
      }],
      ["dashboard_artifact_get", { id: "dashboard-1", workspaceId: "workspace-1", artifactId: "dashboard-1-html", length: 32_769 }],
      ["strategy_recommendation_generate", { ...recommendationArguments("bad-stage"), affectedStage: "conversion" }],
      ["strategy_recommendation_generate", {
        ...recommendationArguments("bad-acceptance"),
        expectedMetrics: [{ metricId: "ctr_v1", acceptance: "guarantee_outcome" }],
      }],
      ["strategy_recommendation_generate", {
        ...recommendationArguments("bad-reach"),
        expectedMetrics: [{ metricId: "ctr_v1", acceptance: "reach_scenario_target", scenarioNodeId: "scenario-1" }],
      }],
      ["strategy_recommendation_generate", {
        ...recommendationArguments("bad-baseline"),
        expectedMetrics: [{ metricId: "ctr_v1", acceptance: "establish_baseline", baselineMetricNodeId: "metric-1" }],
      }],
      ["strategy_recommendation_generate", {
        ...recommendationArguments("bad-duplicates"),
        expectedMetrics: [
          { metricId: "ctr_v1", acceptance: "establish_baseline" },
          { metricId: "ctr_v1", acceptance: "establish_baseline" },
        ],
      }],
      ["strategy_recommendation_generate", { ...recommendationArguments("bad-channels"), targetChannels: ["search", "search"] }],
      ["strategy_task_supplement", { ...taskArguments("bad-rank"), rank: 0 }],
      ["strategy_task_update", {
        id: "task-1", workspaceId: "workspace-1", expectedVersion: 0,
        title: "Invalid", ...context("bad-version"),
      }],
      ["strategy_task_list", { workspaceId: "workspace-1", limit: 21 }],
      ["strategy_task_list", { workspaceId: "workspace-1", cursor: { rank: 0, id: "task-1" } }],
      ["strategy_task_get", { id: "task-1", workspaceId: "workspace-1", actor: "not-a-write-context" }],
    ] as const;
    for (const [name, arguments_] of invalidCalls) {
      const result = await client.callTool({ name, arguments: arguments_ as Record<string, unknown> });
      expect(result, name).toMatchObject({ isError: true });
      expect(JSON.stringify(result), name).not.toContain(secret);
    }
    expect(await store.transaction((repos) => repos.recommendations.get("recommendation-1", "workspace-1"))).toBeUndefined();
    expect(await store.transaction((repos) => repos.tasks.get("task-1", "workspace-1"))).toBeUndefined();
  });

  it("rejects 65,537-byte input before service writes and keeps errors safe and workspace scoped", async () => {
    const oversized = recommendationArguments("oversized") as Record<string, unknown>;
    oversized.hypothesis = "";
    const padding = 65_537 - Buffer.byteLength(JSON.stringify(oversized), "utf8");
    oversized.hypothesis = "x".repeat(padding);
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBe(65_537);
    const rejected = await client.callTool({ name: "strategy_recommendation_generate", arguments: oversized });
    expect(rejected).toMatchObject({ isError: true });
    expect(JSON.stringify(rejected)).toContain("Invalid input");
    expect(await store.transaction((repos) => repos.recommendations.get("recommendation-1", "workspace-1"))).toBeUndefined();
    expect(await store.transaction((repos) => repos.idempotency.get("workspace-1", "command-oversized"))).toBeUndefined();

    for (const [name, arguments_] of [
      ["dashboard_get", { id: "missing", workspaceId: "workspace-2" }],
      ["dashboard_drilldown_get", { id: "missing", workspaceId: "workspace-2", viewId: "view", datumId: "datum" }],
      ["dashboard_artifact_get", { id: "missing", workspaceId: "workspace-2", artifactId: "artifact" }],
      ["strategy_task_get", { id: "missing", workspaceId: "workspace-2" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: arguments_ });
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain("Resource not found");
      expect(JSON.stringify(result)).not.toContain("Internal server error");
      expect(JSON.stringify(result)).not.toContain(tempDir);
    }
  });

  it("initializes with controlled dashboard and user-controlled task instructions", () => {
    const instructions = client.getInstructions()!;
    expect(instructions).toMatch(/trend, structure, funnel, competitor_comparison, and task_effect/);
    expect(instructions).toMatch(/persisted evidence/);
    expect(instructions).toMatch(/dashboard_drilldown_get/);
    expect(instructions).toMatch(/controlled HTML\/SVG/);
    expect(instructions).toMatch(/Power BI/);
    expect(instructions).toMatch(/user-controlled drafts/);
    expect(instructions).toMatch(/never automatically produce, approve, schedule, or publish/);
  });

  it("omits uninstalled dashboard and strategy instructions for empty and legacy 35-tool servers", async () => {
    const cases = [
      { expectedTools: 0, legacyServer: createMcpServer() },
      { expectedTools: 35, legacyServer: createMcpServer(marketing, dataResearch, analysis) },
    ];
    for (const { expectedTools, legacyServer } of cases) {
      const legacyClient = new Client({ name: "legacy-test-client", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await legacyServer.connect(serverTransport);
        await legacyClient.connect(clientTransport);
        expect((await legacyClient.listTools()).tools).toHaveLength(expectedTools);
        const instructions = legacyClient.getInstructions()!;
        expect(instructions).not.toMatch(/dashboard_drilldown_get/);
        expect(instructions).not.toMatch(/controlled HTML\/SVG/);
        expect(instructions).not.toMatch(/user-controlled drafts/);
        expect(instructions).not.toMatch(/Treat strategy tasks/);
      } finally {
        await Promise.all([legacyClient.close(), legacyServer.close()]);
      }
    }
  });

  it("reports installed availability, required inputs, limits, and honest renderer and task limitations", async () => {
    const capabilities = await call<AnalysisCapability[]>("marketing_capability_list");
    const renderer = capabilities.find((capability) => capability.id === "dashboard.controlled_renderer")!;
    expect(renderer).toMatchObject({
      operation: "dashboard_render / dashboard_get / dashboard_drilldown_get / dashboard_artifact_get",
      availability: { state: "available" },
    });
    expect(renderer.requiredInputs).toEqual(expect.arrayContaining(["id", "workspaceId", "views", "actor", "requestId", "idempotencyKey"]));
    expect(renderer.configuration.join(" ")).toMatch(/controlled_html_svg_v1/);
    expect(renderer.configuration.join(" ")).toMatch(/1 MiB/);
    expect(renderer.configuration.join(" ")).toMatch(/32 KiB/);
    expect(renderer.limitations.join(" ")).toMatch(/not Power BI|not a professional BI/i);
    expect(renderer.limitations.join(" ")).toMatch(/500/);
    const professional = capabilities.find((capability) => capability.id === "analytics.professional")!;
    expect(professional.availability.state).toBe("unavailable");

    const tasks = capabilities.find((capability) => capability.id === "strategy.tasks")!;
    expect(tasks).toMatchObject({ availability: { state: "available" } });
    expect(tasks.requiredInputs).toEqual(expect.arrayContaining(["workspaceId", "actor", "requestId", "idempotencyKey"]));
    expect(tasks.configuration.join(" ")).toMatch(/20/);
    expect(tasks.limitations.join(" ")).toMatch(/draft/);
    expect(tasks.limitations.join(" ")).toMatch(/produce|approve|schedule|publish/);
  });

  it("fails closed when declared dashboard or strategy availability contradicts installed services", () => {
    expect(() => createMcpServer(marketing, dataResearch, analysis, {
      dashboardRendererConfigured: false,
    }, dashboard, strategy)).toThrow("dashboardRendererConfigured");
    expect(() => createMcpServer(marketing, dataResearch, analysis, {
      strategyConfigured: false,
    }, dashboard, strategy)).toThrow("strategyConfigured");
    expect(() => createMcpServer(marketing, dataResearch, analysis, {
      dashboardRendererConfigured: true,
      strategyConfigured: true,
    }, dashboard, strategy)).not.toThrow();
  });
});

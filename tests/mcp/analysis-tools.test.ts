import { writeFile } from "node:fs/promises";
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
import type { IngestionBatch } from "../../src/domain/data-research-model.js";
import type { Evidence } from "../../src/domain/model.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import { canonicalJson } from "../../src/infrastructure/sqlite.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { MAX_SERIALIZED_INPUT_BYTES } from "../../src/mcp/schemas.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-27T12:00:00.000Z";
const priorToolNames = [
  "capability_health_record",
  "capability_list",
  "capability_register",
  "competitor_confirm",
  "competitor_diff_create",
  "data_request_decline",
  "data_request_plan",
  "data_research_get",
  "dataset_register",
  "evidence_asset_get",
  "evidence_record",
  "finding_record",
  "ingest_content_links",
  "ingest_files",
  "ingest_temporary_api",
  "lineage_get",
  "recommendation_create",
  "research_permission_set",
  "research_session_create",
  "research_session_run",
  "source_register",
  "task_create",
  "task_transition",
  "workspace_create",
];
const analysisToolNames = [
  "analysis_graph_expand",
  "analysis_graph_fork",
  "analysis_graph_get",
  "marketing_analysis_start",
  "marketing_capability_list",
  "metric_compute",
  "metric_monitor_compare",
  "metric_scenario_create",
];
const writeToolNames = [
  "analysis_graph_expand",
  "analysis_graph_fork",
  "marketing_analysis_start",
  "metric_compute",
  "metric_monitor_compare",
  "metric_scenario_create",
];

function context(suffix: string): CommandContext {
  return {
    actor: "agent-1",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  };
}

describe("analysis MCP tools and initialization", () => {
  let tempDir: string;
  let store: Store;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let originalImportRoot: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir();
    originalImportRoot = process.env.MARKETING_IMPORT_ROOT;
    process.env.MARKETING_IMPORT_ROOT = tempDir;
    store = openStore(join(tempDir, "store.db"));
    const clock = { now: () => now };
    let sequence = 0;
    const ids = { next: () => `generated-${++sequence}` };
    const artifacts = new ArtifactStore(join(tempDir, "artifacts"));
    const marketing = new MarketingService(store, clock, ids);
    const dataResearch = new DataResearchService(
      store,
      clock,
      ids,
      artifacts,
      {
        get: async (request) => ({
          body: Buffer.from('[{"clicks":1,"impressions":10}]'),
          contentType: "application/json",
          finalUrl: request.url,
        }),
      },
      {
        acquire: async (request) => ({
          url: request.url,
          finalUrl: request.url,
          title: "Public page",
          text: "Public observation",
          fields: request.fields ?? {},
          links: [],
          screenshot: Buffer.from("screenshot"),
          provider: "playwright",
          toolVersion: "fixture-1",
        }),
      },
    );
    const analysis = new AnalysisService(store, clock, ids, artifacts);
    await marketing.createWorkspace({
      input: { id: "workspace-1", name: "Analysis" },
      context: context("setup-workspace"),
    });
    server = createMcpServer(marketing, dataResearch, analysis);
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
    store.close();
    if (originalImportRoot === undefined) delete process.env.MARKETING_IMPORT_ROOT;
    else process.env.MARKETING_IMPORT_ROOT = originalImportRoot;
    await removeTempDir(tempDir);
  });

  async function call<T>(name: string, arguments_: Record<string, unknown> = {}): Promise<T> {
    const result = await client.callTool({ name, arguments: arguments_ });
    expect(result).not.toMatchObject({ isError: true });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as T;
    expect(text).toBe(canonicalJson(parsed));
    return parsed;
  }

  it("returns actionable marketing instructions from a real MCP initialize", () => {
    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions).toMatch(/marketing_analysis_start/);
    expect(instructions).toMatch(/own(?:ed)? (?:business )?data is optional/i);
    expect(instructions).toMatch(/without (?:own(?:ed)? )?(?:business )?data/i);
    expect(instructions).toMatch(/public research/i);
    expect(instructions).toMatch(/links?/i);
    expect(instructions).toMatch(/files?/i);
    expect(instructions).toMatch(/API/);
    expect(instructions).toMatch(/at most one/i);
    expect(instructions).toMatch(/default/i);
    expect(instructions).toMatch(/facts?, inferences?, and unknowns?/i);
    expect(instructions).toMatch(/public engagement/i);
    expect(instructions).toMatch(/CTR|click.through/i);
    expect(instructions).toMatch(/conversion/i);
    expect(instructions).toMatch(/caus/i);
    expect(instructions).toMatch(/not installed|not available|do not claim/i);
  });

  it("registers exactly the prior and eight analysis tools with strict schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...priorToolNames, ...analysisToolNames].sort(),
    );
    expect(tools).toHaveLength(32);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
    for (const name of writeToolNames) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      for (const field of ["actor", "requestId", "idempotencyKey"]) {
        expect(tool.inputSchema.required, `${name}.${field}`).toContain(field);
      }
    }
  });

  it("starts without data, lists honest capabilities, expands, forks, and restores graphs", async () => {
    const started = await call<AnalysisGraph>("marketing_analysis_start", {
      id: "graph-public",
      workspaceId: "workspace-1",
      objective: "Understand how AI education can be marketed",
      ...context("start-public"),
    });
    expect(started).toMatchObject({ id: "graph-public", version: 1 });
    expect(started.nodes.map((node) => node.kind)).toEqual(["question", "research"]);
    expect(started.nodes[0]!.payload.clarification).toMatchObject({ required: false });
    expect(started.recommendedActions.map((action) => action.tool)).toEqual([
      "host.web_search",
      "research_session_create",
    ]);
    expect(started.recommendedActions[0]!.arguments).toEqual({
      query: "Understand how AI education can be marketed",
    });

    const capabilities = await call<{ availability: { state: string }; id: string }[]>(
      "marketing_capability_list",
    );
    expect(capabilities.some((capability) => capability.id === "analysis.start")).toBe(true);
    expect(capabilities.find((capability) => capability.id === "connectors.live"))
      .toMatchObject({ availability: { state: "not_installed" } });

    const expanded = await call<AnalysisGraph>("analysis_graph_expand", {
      id: started.id,
      workspaceId: started.workspaceId,
      expectedVersion: 1,
      nodes: [{ id: "decision-1", kind: "decision", payload: {
        kind: "inference",
        statement: "Compare public positioning before choosing a channel",
        unknowns: ["Conversion performance is unknown"],
      } }],
      edges: [{ id: "edge-decision-1", fromNodeId: "graph-public-research", toNodeId: "decision-1" }],
      ...context("expand-public"),
    });
    expect(expanded).toMatchObject({ version: 2 });
    expect(expanded.nodes.at(-1)).toMatchObject({ id: "decision-1", kind: "decision" });

    const forked = await call<AnalysisGraph>("analysis_graph_fork", {
      id: "graph-public-fork",
      workspaceId: "workspace-1",
      parentGraphId: "graph-public",
      expectedVersion: 2,
      forkNodeId: "decision-1",
      ...context("fork-public"),
    });
    expect(forked).toMatchObject({
      id: "graph-public-fork",
      version: 1,
      parentGraphId: "graph-public",
      parentVersion: 2,
      forkNodeId: "decision-1",
    });
    expect(await call<AnalysisGraph>("analysis_graph_get", {
      id: "graph-public",
      workspaceId: "workspace-1",
    })).toEqual(expanded);
    expect(await call<AnalysisGraph>("analysis_graph_get", {
      id: "graph-public-fork",
      workspaceId: "workspace-1",
    })).toEqual(forked);
  });

  it.each(["links", "api"] as const)("executes %s ready actions verbatim with derived command context", async (inputMode) => {
    const startArguments = {
      id: `graph-ready-${inputMode}`,
      workspaceId: "workspace-1",
      objective: `Execute ${inputMode} action`,
      inputMode,
      ...(inputMode === "links" ? {
        links: [{ url: "https://example.com/public", fields: { price: ".price" } }],
      } : {
        url: "https://example.com/metrics.json",
        ownership: "authorized",
        expiresAt: "2026-10-27T13:00:00.000Z",
      }),
      ...context(`start-ready-${inputMode}`),
    };
    const started = await call<AnalysisGraph>("marketing_analysis_start", startArguments);
    const action = started.recommendedActions.find((candidate) => candidate.status === "ready")!;
    expect(action.arguments).toMatchObject({ actor: "agent-1" });
    for (const field of ["requestId", "idempotencyKey"]) {
      expect(action.arguments?.[field]).toEqual(expect.any(String));
      expect(String(action.arguments?.[field]).length).toBeLessThanOrEqual(256);
      expect(action.arguments?.[field]).not.toBe(startArguments[field]);
    }
    expect(await call<AnalysisGraph>("marketing_analysis_start", startArguments)).toEqual(started);

    const result = await call<IngestionBatch>(action.tool, action.arguments!);
    expect(result).toMatchObject({ state: "completed", failures: [] });
  });

  it.each(["links", "api"] as const)("forks %s actions with independent execution, audit, and replay", async (inputMode) => {
    const started = await call<AnalysisGraph>("marketing_analysis_start", {
      id: `graph-fork-execution-${inputMode}`,
      workspaceId: "workspace-1",
      objective: `Fork ${inputMode} execution`,
      inputMode,
      ...(inputMode === "links" ? {
        links: [{ url: "https://example.com/public", fields: { price: ".price" } }],
      } : {
        url: "https://example.com/metrics.json",
        ownership: "authorized",
        expiresAt: "2026-10-27T13:00:00.000Z",
      }),
      ...context(`start-fork-execution-${inputMode}`),
    });
    const branchNodeId = inputMode === "links" ? `${started.id}-research` : `${started.id}-dataset`;
    const parent = await call<AnalysisGraph>("analysis_graph_expand", {
      id: started.id,
      workspaceId: "workspace-1",
      expectedVersion: 1,
      nodes: [{ id: "expand-decision", kind: "decision", payload: { status: "planned" } }],
      edges: [{ id: "expand-decision-edge", fromNodeId: branchNodeId, toNodeId: "expand-decision" }],
      ...context(`expand-fork-execution-${inputMode}`),
    });
    const child = await call<AnalysisGraph>("analysis_graph_fork", {
      id: `graph-fork-execution-${inputMode}-child`,
      workspaceId: "workspace-1",
      parentGraphId: parent.id,
      expectedVersion: parent.version,
      forkNodeId: branchNodeId,
      ...context(`fork-execution-${inputMode}`),
    });
    const parentAction = parent.recommendedActions.find((action) => action.status === "ready")!;
    const childAction = child.recommendedActions.find((action) => action.status === "ready")!;
    expect(parentAction.arguments).toEqual(started.recommendedActions[0]!.arguments);
    if (inputMode === "links") {
      expect(childAction.arguments?.links).toEqual(parentAction.arguments?.links);
    } else {
      expect(childAction.arguments?.url).toBe(parentAction.arguments?.url);
      expect(childAction.arguments?.ownership).toBe(parentAction.arguments?.ownership);
      expect(childAction.arguments?.expiresAt).toBe(parentAction.arguments?.expiresAt);
    }

    const parentBatch = await call<IngestionBatch>(parentAction.tool, parentAction.arguments!);
    expect(await call<IngestionBatch>(parentAction.tool, parentAction.arguments!)).toEqual(parentBatch);
    const childBatch = await call<IngestionBatch>(childAction.tool, childAction.arguments!);
    expect(await call<IngestionBatch>(childAction.tool, childAction.arguments!)).toEqual(childBatch);
    expect(childBatch.id).not.toBe(parentBatch.id);
    expect(childAction.arguments?.id).toBe(childBatch.id);
    expect(childAction.arguments?.requestId).not.toBe(parentAction.arguments?.requestId);
    expect(childAction.arguments?.idempotencyKey).not.toBe(parentAction.arguments?.idempotencyKey);

    const raw = new DatabaseSync(join(tempDir, "store.db"));
    try {
      const audit = (action: typeof parentAction) => raw.prepare(
        "SELECT entity_id AS entityId FROM audit_records WHERE request_id = ?",
      ).all(action.arguments!.requestId as string);
      expect(audit(parentAction)).toEqual([{ entityId: parentBatch.id }]);
      expect(audit(childAction)).toEqual([{ entityId: childBatch.id }]);
      expect(raw.prepare(
        "SELECT COUNT(*) AS count FROM idempotency_records WHERE key IN (?, ?)",
      ).get(
        parentAction.arguments!.idempotencyKey as string,
        childAction.arguments!.idempotencyKey as string,
      )).toMatchObject({ count: 2 });
    } finally {
      raw.close();
    }
    expect(await call<AnalysisGraph>("analysis_graph_get", {
      id: parent.id,
      workspaceId: "workspace-1",
    })).toEqual(parent);
    expect(await call<AnalysisGraph>("analysis_graph_get", {
      id: child.id,
      workspaceId: "workspace-1",
    })).toEqual(child);
  });

  it("computes, scenarios, and monitors real imported evidence through the public tools", async () => {
    async function importCsv(id: string, fileName: string, content: string): Promise<IngestionBatch> {
      await writeFile(join(tempDir, fileName), content);
      return call<IngestionBatch>("ingest_files", {
        id,
        workspaceId: "workspace-1",
        paths: [fileName],
        ...context(id),
      });
    }
    async function descriptors(batch: IngestionBatch) {
      const evidence = await store.transaction((repos) =>
        repos.evidence.get(batch.evidenceIds[0]!, "workspace-1")) as Evidence;
      return {
        batchId: batch.id,
        datasetId: batch.datasetIds[0]!,
        evidenceId: batch.evidenceIds[0]!,
        assetId: evidence.assets!.find((asset) => asset.kind === "normalized_jsonl")!.id,
      };
    }

    const baseline = await importCsv("batch-baseline", "baseline.csv", "clicks,impressions\n40,400\n60,600\n");
    const current = await importCsv("batch-current", "current.csv", "clicks,impressions\n80,400\n120,600\n");
    const started = await call<AnalysisGraph>("marketing_analysis_start", {
      id: "graph-metric",
      workspaceId: "workspace-1",
      objective: "Measure imported CTR",
      inputMode: "dataset",
      referenceId: baseline.datasetIds[0]!,
      ...context("start-metric"),
    });
    const computeAction = started.recommendedActions.find((action) =>
      action.tool === "metric_compute" && action.status === "ready")!;
    const computed = await call<AnalysisGraph>(computeAction.tool, computeAction.arguments!);
    const metric = computed.nodes.find((node) => node.kind === "metric")!;
    expect(metric.payload).toMatchObject({ numerator: 100, denominator: 1000, value: 0.1, status: "ok" });

    const scenarioGraph = await call<AnalysisGraph>("metric_scenario_create", {
      id: computed.id,
      workspaceId: computed.workspaceId,
      expectedVersion: 2,
      metricNodeId: metric.id,
      targetValue: 0.15,
      projectedDenominator: 1000,
      label: "base",
      ...context("scenario-metric"),
    });
    const scenario = scenarioGraph.nodes.find((node) => node.kind === "scenario")!;
    expect(scenario.payload).toMatchObject({ status: "ok", projectedNumeratorDelta: 50 });

    const monitored = await call<AnalysisGraph>("metric_monitor_compare", {
      id: scenarioGraph.id,
      workspaceId: scenarioGraph.workspaceId,
      expectedVersion: 3,
      baselineMetricNodeId: metric.id,
      scenarioNodeId: scenario.id,
      ...await descriptors(current),
      comparability: "comparable",
      ...context("monitor-metric"),
    });
    const monitor = monitored.nodes.find((node) => node.kind === "monitor")!;
    expect(monitor.payload).toMatchObject({ status: "ok", absoluteDelta: 0.1, relativeDelta: 1 });
    expect(monitored.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: metric.id, toNodeId: monitor.id }),
      expect.objectContaining({ fromNodeId: scenario.id, toNodeId: monitor.id }),
    ]));
  });

  it("rejects a 65,724-byte __proto__ payload without advancing the graph", async () => {
    await call<AnalysisGraph>("marketing_analysis_start", {
      id: "graph-proto",
      workspaceId: "workspace-1",
      objective: "Preserve the raw input boundary",
      ...context("start-proto"),
    });
    const skeleton = JSON.stringify({
      id: "graph-proto",
      workspaceId: "workspace-1",
      expectedVersion: 1,
      nodes: [{ id: "proto-node", kind: "decision", payload: {} }],
      edges: [],
      ...context("expand-proto"),
    });
    const emptyPayload = '"payload":{}';
    const overhead = Buffer.byteLength(
      skeleton.replace(emptyPayload, '"payload":{"__proto__":""}'),
      "utf8",
    );
    const wire = skeleton.replace(
      emptyPayload,
      `"payload":{"__proto__":"${"x".repeat(65_724 - overhead)}"}`,
    );
    expect(Buffer.byteLength(wire, "utf8")).toBe(65_724);
    const arguments_ = JSON.parse(wire) as Record<string, unknown>;

    const result = await client.callTool({ name: "analysis_graph_expand", arguments: arguments_ });
    expect(result).toMatchObject({ isError: true });
    const graph = await call<AnalysisGraph>("analysis_graph_get", {
      id: "graph-proto",
      workspaceId: "workspace-1",
    });
    expect(graph.version).toBe(1);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "graph-proto-question",
      "graph-proto-research",
    ]);
  });

  it("rejects unknown fields, oversized input, and nested secrets before analysis writes", async () => {
    const valid = {
      id: "graph-strict",
      workspaceId: "workspace-1",
      objective: "Strict boundary",
      ...context("strict-start"),
    };
    expect(await client.callTool({
      name: "marketing_analysis_start",
      arguments: { ...valid, unexpected: true },
    })).toMatchObject({ isError: true });

    expect(await client.callTool({
      name: "marketing_analysis_start",
      arguments: { ...valid, objective: "x".repeat(MAX_SERIALIZED_INPUT_BYTES) },
    })).toMatchObject({ isError: true });

    const secret = "synthetic-analysis-secret";
    const nestedSecret = await client.callTool({
      name: "analysis_graph_expand",
      arguments: {
        id: "graph-strict",
        workspaceId: "workspace-1",
        expectedVersion: 1,
        nodes: [{ id: "secret-node", kind: "decision", payload: { apiKey: secret } }],
        edges: [],
        ...context("strict-secret"),
      },
    });
    expect(nestedSecret).toMatchObject({ isError: true });
    expect(JSON.stringify(nestedSecret)).not.toContain(secret);
    const missing = await client.callTool({
      name: "analysis_graph_get",
      arguments: { id: "graph-strict", workspaceId: "workspace-1" },
    });
    expect(missing).toMatchObject({ isError: true });
  });
});

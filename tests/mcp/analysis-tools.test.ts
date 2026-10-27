import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
    const dataResearch = new DataResearchService(store, clock, ids, artifacts);
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
    expect(started.recommendedActions.some((action) => action.tool === "metric_compute" && action.status === "ready")).toBe(true);

    const computed = await call<AnalysisGraph>("metric_compute", {
      id: started.id,
      workspaceId: started.workspaceId,
      expectedVersion: 1,
      ...await descriptors(baseline),
      metricId: "ctr_v1",
      comparability: "comparable",
      ...context("compute-metric"),
    });
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

import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
const workspaceId = "workspace-analysis-stdio-e2e";

type JsonRecord = Record<string, unknown>;

interface AnalysisNode extends JsonRecord {
  id: string;
  kind: string;
  payload: JsonRecord;
}

interface AnalysisAction extends JsonRecord {
  tool: string;
  arguments?: JsonRecord;
  status?: string;
}

interface AnalysisGraph extends JsonRecord {
  id: string;
  workspaceId: string;
  version: number;
  nodes: AnalysisNode[];
  edges: { id: string; fromNodeId: string; toNodeId: string }[];
  recommendedActions: AnalysisAction[];
}

interface IngestionBatch extends JsonRecord {
  id: string;
  datasetIds: string[];
  evidenceIds: string[];
}

interface RunningClient {
  client: Client;
  stderr: () => string;
}

function payload(result: CallToolResult): JsonRecord {
  expect(result.isError).not.toBe(true);
  expect(result.content[0]).toMatchObject({ type: "text" });
  return JSON.parse((result.content[0] as { text: string }).text) as JsonRecord;
}

function context(suffix: string): JsonRecord {
  return {
    actor: "analysis-stdio-acceptance",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  };
}

describe("built analysis network stdio acceptance", () => {
  let dataDir: string;
  let importDir: string;
  let artifactDir: string;
  const clients: RunningClient[] = [];

  beforeEach(async () => {
    [dataDir, importDir, artifactDir] = await Promise.all([
      createTempDir(),
      createTempDir(),
      createTempDir(),
    ]);
    await Promise.all([
      writeFile(join(importDir, "baseline.csv"), "clicks,impressions\n40,400\n60,600\n"),
      writeFile(join(importDir, "current.csv"), "clicks,impressions\n80,400\n120,600\n"),
      writeFile(join(importDir, "zero.csv"), "clicks,impressions\n0,0\n0,0\n1,\n"),
    ]);
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(({ client }) => client.close()));
    await Promise.all([dataDir, importDir, artifactDir].map(removeTempDir));
  });

  async function startClient(): Promise<RunningClient> {
    const client = new Client({ name: "analysis-stdio-acceptance", version: "1.0.0" });
    let stderr = "";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: projectRoot,
      env: {
        ...getDefaultEnvironment(),
        MARKETING_DATA_DIR: dataDir,
        MARKETING_IMPORT_ROOT: importDir,
        MARKETING_ARTIFACT_DIR: artifactDir,
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
    expect(running.stderr()).not.toContain("MCP shutdown failed");
  }

  async function call<T = JsonRecord>(
    client: Client,
    name: string,
    arguments_: JsonRecord = {},
  ): Promise<T> {
    return payload(await client.callTool({ name, arguments: arguments_ })) as T;
  }

  async function descriptors(client: Client, batch: IngestionBatch): Promise<JsonRecord> {
    const lineage = await call(client, "data_research_get", {
      entityType: "ingestion_batch",
      id: batch.id,
      workspaceId,
    });
    const evidence = (lineage.descriptors as JsonRecord).evidence as JsonRecord[];
    const assets = evidence[0]!.assets as { id: string; kind: string }[];
    return {
      batchId: batch.id,
      datasetId: batch.datasetIds[0]!,
      evidenceId: batch.evidenceIds[0]!,
      assetId: assets.find((asset) => asset.kind === "normalized_jsonl")!.id,
    };
  }

  it("runs no-data guidance, public metrics, scenarios, monitoring, forks, and restart recovery", async () => {
    const first = await startClient();
    const { client } = first;
    const instructions = client.getInstructions();
    expect(instructions).toMatch(/marketing_analysis_start/);
    expect(instructions).toMatch(/data is optional/i);
    expect(instructions).toMatch(/public engagement.*CTR.*conversion/i);
    expect(instructions).toMatch(/live connectors/i);

    const workspaceArguments = {
      id: workspaceId,
      name: "Analysis stdio acceptance",
      ...context("workspace"),
    };
    await call(client, "workspace_create", workspaceArguments);
    expect(await call(client, "workspace_create", workspaceArguments))
      .toEqual(await call(client, "workspace_create", workspaceArguments));

    const noDataArguments = {
      id: "graph-no-data",
      workspaceId,
      objective: "我没有业务数据，想了解 AI 教育怎么营销",
      ...context("start-no-data"),
    };
    const noData = await call<AnalysisGraph>(client, "marketing_analysis_start", noDataArguments);
    expect(noData.nodes.map((node) => node.kind)).toEqual(["question", "research"]);
    expect(noData.nodes[1]!.payload).toMatchObject({
      mode: "public_research",
      status: "planned",
      researchCompleted: false,
    });
    expect(noData.recommendedActions[0]).toMatchObject({
      tool: "host.web_search",
      status: "ready",
      arguments: { query: expect.stringContaining("AI 教育") },
    });
    expect(await call(client, "marketing_analysis_start", noDataArguments)).toEqual(noData);

    const capabilities = await call<JsonRecord[]>(client, "marketing_capability_list");
    expect(capabilities.find((capability) => capability.id === "connectors.live"))
      .toMatchObject({ availability: { state: "not_installed" } });
    expect(capabilities.filter((capability) =>
      (capability.availability as JsonRecord).state === "available"
    ).map((capability) => capability.operation)).not.toContain(
      "No live-connector operation is registered",
    );

    const baseline = await call<IngestionBatch>(client, "ingest_files", {
      id: "batch-analysis-baseline",
      workspaceId,
      paths: ["baseline.csv"],
      ownership: "external_public",
      ...context("import-baseline"),
    });
    expect(baseline).toMatchObject({ state: "completed", failures: [] });
    const publicLineage = await call(client, "data_research_get", {
      entityType: "ingestion_batch",
      id: baseline.id,
      workspaceId,
    });
    expect((publicLineage.descriptors as JsonRecord).evidence).toEqual([
      expect.objectContaining({ classification: "external_observation" }),
    ]);
    const started = await call<AnalysisGraph>(client, "marketing_analysis_start", {
      id: "graph-analysis",
      workspaceId,
      objective: "Measure a public CTR snapshot and a conditional scenario",
      inputMode: "dataset",
      referenceId: baseline.datasetIds[0]!,
      ...context("start-dataset"),
    });
    const computeAction = started.recommendedActions.find((action) =>
      action.tool === "metric_compute" && action.arguments?.metricId === "ctr_v1"
    )!;
    expect(computeAction).toMatchObject({ status: "ready", missingInputs: [] });
    const computed = await call<AnalysisGraph>(client, computeAction.tool, computeAction.arguments!);
    const metric = computed.nodes.find((node) => node.kind === "metric")!;
    expect(metric.payload).toMatchObject({
      metricId: "ctr_v1",
      formula: "sum(clicks) / sum(impressions)",
      numerator: 100,
      denominator: 1000,
      value: 0.1,
      status: "ok",
      includedRowCount: 2,
      excludedRowCount: 0,
      precision: "ieee754_compensated_sum",
      referenceAssessment: {
        level: "medium",
        dimensions: {
          provenance: "external_public",
          comparability: "not_assessed",
          sample: { status: "sufficient" },
        },
      },
    });
    expect((metric.payload.referenceAssessment as JsonRecord).reasons)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "EXTERNAL_PUBLIC" }),
        expect.objectContaining({ code: "COMPARABILITY_NOT_ASSESSED" }),
      ]));
    expect(await call(client, computeAction.tool, computeAction.arguments!)).toEqual(computed);

    const scenarioAction = computed.recommendedActions.find((action) =>
      action.tool === "metric_scenario_create"
    )!;
    const scenarioGraph = await call<AnalysisGraph>(client, scenarioAction.tool, {
      ...scenarioAction.arguments,
      label: "base",
      targetValue: 0.15,
      projectedDenominator: 1000,
      ...context("scenario"),
    });
    const scenario = scenarioGraph.nodes.find((node) => node.kind === "scenario")!;
    expect(scenario.payload).toMatchObject({
      status: "ok",
      baselineValue: 0.1,
      targetValue: 0.15,
      projectedNumerator: 150,
      projectedNumeratorDelta: 50,
      assumptions: ["projected_denominator_fixed_for_projection", "other_conditions_unchanged"],
    });

    const expanded = await call<AnalysisGraph>(client, "analysis_graph_expand", {
      id: scenarioGraph.id,
      workspaceId,
      expectedVersion: scenarioGraph.version,
      nodes: [{
        id: "decision-public-review",
        kind: "decision",
        payload: {
          kind: "inference",
          statement: "Review comparable public snapshots before choosing a channel",
          unknowns: ["Conversion and causal lift remain unknown"],
        },
      }],
      edges: [{
        id: "edge-scenario-decision",
        fromNodeId: scenario.id,
        toNodeId: "decision-public-review",
      }],
      ...context("expand"),
    });
    const forkArguments = {
      id: "graph-analysis-fork",
      workspaceId,
      parentGraphId: expanded.id,
      expectedVersion: expanded.version,
      forkNodeId: scenario.id,
      ...context("fork"),
    };
    const forked = await call<AnalysisGraph>(client, "analysis_graph_fork", forkArguments);
    expect(forked).toMatchObject({
      version: 1,
      parentGraphId: expanded.id,
      parentVersion: expanded.version,
      forkNodeId: scenario.id,
    });
    expect(await call(client, "analysis_graph_fork", forkArguments)).toEqual(forked);
    expect(await call<AnalysisGraph>(client, "analysis_graph_get", {
      id: expanded.id,
      workspaceId,
    })).toEqual(expanded);

    const current = await call<IngestionBatch>(client, "ingest_files", {
      id: "batch-analysis-current",
      workspaceId,
      paths: ["current.csv"],
      ownership: "external_public",
      ...context("import-current"),
    });
    const monitorAction = expanded.recommendedActions.find((action) =>
      action.tool === "metric_monitor_compare"
    )!;
    const monitored = await call<AnalysisGraph>(client, monitorAction.tool, {
      ...monitorAction.arguments,
      ...await descriptors(client, current),
      scenarioNodeId: scenario.id,
      comparability: "not_comparable",
      ...context("monitor"),
    });
    const monitor = monitored.nodes.find((node) => node.kind === "monitor")!;
    expect(monitor.payload).toMatchObject({
      status: "ok",
      absoluteDelta: 0.1,
      relativeDelta: 1,
      baseline: { value: 0.1, referenceAssessment: { level: "medium" } },
      current: {
        value: 0.2,
        referenceAssessment: {
          level: "low",
          dimensions: { provenance: "external_public", comparability: "not_comparable" },
        },
      },
      referenceChange: {
        baselineLevel: "medium",
        currentLevel: "low",
        levelChanged: true,
        reasonCodesAdded: expect.arrayContaining(["COMPARABILITY_NOT_COMPARABLE"]),
      },
      monitoring: { scheduling: "not_provided" },
    });
    expect(monitored.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: metric.id, toNodeId: monitor.id }),
      expect.objectContaining({ fromNodeId: scenario.id, toNodeId: monitor.id }),
    ]));

    const zero = await call<IngestionBatch>(client, "ingest_files", {
      id: "batch-analysis-zero",
      workspaceId,
      paths: ["zero.csv"],
      ...context("import-zero"),
    });
    const zeroStarted = await call<AnalysisGraph>(client, "marketing_analysis_start", {
      id: "graph-zero",
      workspaceId,
      objective: "Verify unknown arithmetic for a zero denominator",
      inputMode: "dataset",
      referenceId: zero.datasetIds[0]!,
      ...context("start-zero"),
    });
    const zeroAction = zeroStarted.recommendedActions.find((action) =>
      action.tool === "metric_compute" && action.arguments?.metricId === "ctr_v1"
    )!;
    const zeroGraph = await call<AnalysisGraph>(client, zeroAction.tool, zeroAction.arguments!);
    expect(zeroGraph.nodes.find((node) => node.kind === "metric")!.payload).toMatchObject({
      status: "unknown",
      unknownReason: "ZERO_DENOMINATOR",
      numerator: 0,
      denominator: 0,
      value: null,
      totalRowCount: 3,
      includedRowCount: 2,
      excludedRowCount: 1,
      excludedRows: [{ rowIndex: 2, reasons: ["MISSING_DENOMINATOR"] }],
      referenceAssessment: {
        level: "unknown",
        reasons: [{ code: "ZERO_DENOMINATOR" }],
        dimensions: { provenance: "owned", comparability: "not_assessed" },
      },
    });

    expect((await readdir(artifactDir)).length).toBeGreaterThan(0);
    expect(await readdir(dataDir)).toContain("marketing.db");
    expect(await readdir(dataDir)).not.toContain("artifacts");

    await stopClient(first);
    const second = await startClient();
    for (const expected of [noData, monitored, forked, zeroGraph]) {
      const restored = await call<AnalysisGraph>(second.client, "analysis_graph_get", {
        id: expected.id,
        workspaceId,
      });
      expect(restored).toEqual(expected);
      const nodeIds = new Set(restored.nodes.map((node) => node.id));
      for (const edge of restored.edges) {
        expect(nodeIds).toContain(edge.fromNodeId);
        expect(nodeIds).toContain(edge.toNodeId);
      }
    }
    expect(monitored.nodes.map((node) => node.kind)).toEqual([
      "question",
      "dataset",
      "metric",
      "scenario",
      "decision",
      "monitor",
    ]);
    await stopClient(second);
  }, 60_000);
});

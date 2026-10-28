import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDir, removeTempDir } from "../helpers.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const serverPath = join(projectRoot, "dist", "index.js");
const analyticsFixture = fileURLToPath(
  new URL("../fixtures/professional-analytics-mcp.mjs", import.meta.url),
);
const workspaceId = "workspace-dashboard-strategy-stdio";
const dashboardId = "dashboard-strategy-stdio";
const graphId = "graph-dashboard-strategy-stdio";
const diffId = "diff-dashboard-strategy-stdio";
const taskIds = ["task-strategy-a", "task-strategy-b", "task-strategy-0-c"] as const;

type JsonRecord = Record<string, unknown>;

interface AnalysisNode extends JsonRecord {
  id: string;
  kind: string;
  payload: JsonRecord;
}

interface AnalysisGraph extends JsonRecord {
  id: string;
  version: number;
  nodes: AnalysisNode[];
}

interface IngestionBatch extends JsonRecord {
  id: string;
  datasetIds: string[];
  evidenceIds: string[];
}

interface ArtifactDescriptor extends JsonRecord {
  id: string;
  kind: "html" | "manifest";
  contentHash: string;
  byteLength: number;
}

interface Dashboard extends JsonRecord {
  id: string;
  version: number;
  views: JsonRecord[];
  artifacts: ArtifactDescriptor[];
}

interface RunningClient {
  client: Client;
  stderr: () => string;
  stdout: () => string;
}

function payload(result: CallToolResult): JsonRecord {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.content[0]).toMatchObject({ type: "text" });
  return JSON.parse((result.content[0] as { text: string }).text) as JsonRecord;
}

function context(suffix: string): JsonRecord {
  return {
    actor: "dashboard-strategy-stdio-acceptance",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  };
}

function dailyCsv(current: boolean): string {
  const rows = ["observedAt,impressions,clicks,conversions,revenue"];
  for (let index = 0; index < 40; index += 1) {
    const observedAt = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
    rows.push(`${observedAt},1000,${current ? 200 : 100},${current ? 20 : 10},${index + 1}`);
  }
  return `${rows.join("\n")}\n`;
}

function dashboardViews(taskIdsForView: string[], trendId: string, metricId: string, funnelId: string, monitorId: string): JsonRecord[] {
  return [
    { id: "trend-view", kind: "trend", graphId, nodeIds: [trendId] },
    { id: "structure-view", kind: "structure", graphId, nodeIds: [metricId] },
    { id: "funnel-view", kind: "funnel", graphId, nodeIds: [funnelId] },
    { id: "competitor-view", kind: "competitor_comparison", competitorDiffId: diffId },
    { id: "task-view", kind: "task_effect", graphId, taskIds: taskIdsForView, monitorNodeIds: [monitorId] },
  ];
}

function taskArguments(id: string, rank: number, suffix: string): JsonRecord {
  return {
    id,
    workspaceId,
    recommendationIds: ["recommendation-strategy"],
    title: `Human controlled draft ${id}`,
    assignee: "initial-owner",
    priority: "p1",
    rank,
    dependencyIds: [],
    assetRequirements: ["existing approved material"],
    acceptanceCriteria: ["A human accepts the draft"],
    ...context(suffix),
  };
}

describe("built dashboard and strategy stdio acceptance", () => {
  let dataDir: string;
  let importDir: string;
  let artifactDir: string;
  let fixtureServer: Server;
  let fixtureOrigin: string;
  let fixturePaths: string[];
  const clients: RunningClient[] = [];

  beforeEach(async () => {
    [dataDir, importDir, artifactDir] = await Promise.all([
      createTempDir(),
      createTempDir(),
      createTempDir(),
    ]);
    await Promise.all([
      writeFile(join(importDir, "baseline.csv"), dailyCsv(false)),
      writeFile(join(importDir, "current.csv"), dailyCsv(true)),
    ]);
    fixturePaths = [];
    fixtureServer = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
      fixturePaths.push(path);
      if (path === "/competitors/left" || path === "/competitors/right") {
        const left = path.endsWith("left");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><head><title>${left ? "Left" : "Right"} competitor</title></head><body><main>Authorized public fixture</main><span class="price">${left ? 20 : 30}</span><button class="cta">Buy</button></body></html>`);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolveListen) => {
      fixtureServer.listen(0, "127.0.0.1", resolveListen);
    });
    fixtureOrigin = `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(({ client }) => client.close()));
    fixtureServer.closeAllConnections();
    await new Promise<void>((resolveClose) => {
      fixtureServer.close(() => resolveClose());
    });
    await Promise.all([dataDir, importDir, artifactDir].map(removeTempDir));
  });

  async function startClient(): Promise<RunningClient> {
    const client = new Client({ name: "dashboard-strategy-stdio-acceptance", version: "1.0.0" });
    let stderr = "";
    let stdout = "";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: projectRoot,
      env: {
        ...getDefaultEnvironment(),
        MARKETING_DATA_DIR: dataDir,
        MARKETING_IMPORT_ROOT: importDir,
        MARKETING_ARTIFACT_DIR: artifactDir,
        MARKETING_HTTP_ALLOWLIST: "127.0.0.1",
        MARKETING_ANALYTICS_MCP_COMMAND: process.execPath,
        MARKETING_ANALYTICS_MCP_ARGS: JSON.stringify([analyticsFixture]),
      },
      stderr: "pipe",
    });
    transport.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    transport.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    await client.connect(transport);
    const running = { client, stderr: () => stderr, stdout: () => stdout };
    clients.push(running);
    return running;
  }

  async function stopClient(running: RunningClient): Promise<void> {
    await running.client.close();
    clients.splice(clients.indexOf(running), 1);
    expect(running.stderr()).not.toContain("MCP shutdown failed");
    expect(running.stderr()).not.toContain(dataDir);
    for (const line of running.stdout().split("\n").filter((value) => value.trim().length > 0)) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }
  }

  async function call<T = JsonRecord>(
    client: Client,
    name: string,
    arguments_: JsonRecord = {},
  ): Promise<T> {
    return payload(await client.callTool({ name, arguments: arguments_ })) as T;
  }

  async function expectToolError(client: Client, name: string, arguments_: JsonRecord): Promise<void> {
    const result = await client.callTool({ name, arguments: arguments_ });
    expect(result, `${name} must reject stale or conflicting input`).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain(dataDir);
  }

  async function ingestionDescriptors(client: Client, batch: { id: string }): Promise<JsonRecord> {
    const lineage = await call(client, "data_research_get", {
      entityType: "ingestion_batch",
      id: batch.id,
      workspaceId,
    });
    return lineage.descriptors as JsonRecord;
  }

  async function descriptors(client: Client, batch: IngestionBatch): Promise<JsonRecord> {
    const persisted = await ingestionDescriptors(client, batch);
    const evidence = persisted.evidence as JsonRecord[];
    const assets = evidence[0]!.assets as { id: string; kind: string }[];
    return {
      batchId: batch.id,
      datasetId: batch.datasetIds[0]!,
      evidenceId: batch.evidenceIds[0]!,
      assetId: assets.find((asset) => asset.kind === "normalized_jsonl")!.id,
    };
  }

  async function readArtifact(
    client: Client,
    dashboard: Dashboard,
    descriptor: ArtifactDescriptor,
  ): Promise<{ bytes: Buffer; chunks: number }> {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < descriptor.byteLength;) {
      const length = Math.min(32_768, descriptor.byteLength - offset);
      const chunk = await call(client, "dashboard_artifact_get", {
        id: dashboard.id,
        workspaceId,
        artifactId: descriptor.id,
        offset,
        length,
      });
      const bytes = Buffer.from(chunk.content as string, "base64");
      expect(chunk).toMatchObject({
        offset,
        length,
        totalBytes: descriptor.byteLength,
        contentHash: descriptor.contentHash,
      });
      expect(bytes.byteLength).toBe(length);
      expect(length).toBeLessThanOrEqual(32_768);
      chunks.push(bytes);
      offset += length;
    }
    const bytes = Buffer.concat(chunks);
    expect(bytes.byteLength).toBe(descriptor.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(descriptor.contentHash);
    return { bytes, chunks: chunks.length };
  }

  async function readEvidenceAsset(
    client: Client,
    evidenceId: string,
    asset: JsonRecord,
  ): Promise<Buffer> {
    const totalBytes = asset.byteLength as number;
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < totalBytes;) {
      const length = Math.min(32_768, totalBytes - offset);
      const chunk = await call(client, "evidence_asset_get", {
        workspaceId,
        evidenceId,
        assetId: asset.id as string,
        offset,
        length,
      });
      const bytes = Buffer.from(chunk.content as string, "base64");
      expect(chunk).toMatchObject({ offset, length, totalBytes, contentHash: asset.contentHash });
      expect(bytes.byteLength).toBe(length);
      chunks.push(bytes);
      offset += length;
    }
    const bytes = Buffer.concat(chunks);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.contentHash);
    return bytes;
  }

  it("runs real analytics, Chromium, five views, artifacts, strategy tasks, and restart recovery", async () => {
    const first = await startClient();
    const { client } = first;
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "dashboard_render", "dashboard_get", "dashboard_artifact_get", "dashboard_drilldown_get",
      "strategy_recommendation_generate", "strategy_task_supplement", "strategy_task_update",
      "strategy_task_reject", "strategy_task_reorder", "strategy_task_get", "strategy_task_list",
    ]));
    expect(tools.map((tool) => tool.name).filter((name) => /approve|approval|schedule|publish|produce/i.test(name))).toEqual([]);

    await call(client, "workspace_create", {
      id: workspaceId,
      name: "Dashboard strategy stdio acceptance",
      ...context("workspace"),
    });
    const baseline = await call<IngestionBatch>(client, "ingest_files", {
      id: "batch-dashboard-baseline",
      workspaceId,
      paths: ["baseline.csv"],
      ownership: "owned",
      ...context("baseline-import"),
    });
    const current = await call<IngestionBatch>(client, "ingest_files", {
      id: "batch-dashboard-current",
      workspaceId,
      paths: ["current.csv"],
      ownership: "authorized",
      ...context("current-import"),
    });
    expect(baseline).toMatchObject({ state: "completed", failures: [] });
    expect(current).toMatchObject({ state: "completed", failures: [] });
    const baselineDescriptors = await descriptors(client, baseline);
    const currentDescriptors = await descriptors(client, current);
    const baselineMetadata = await ingestionDescriptors(client, baseline);
    const currentMetadata = await ingestionDescriptors(client, current);

    const started = await call<AnalysisGraph>(client, "marketing_analysis_start", {
      id: graphId,
      workspaceId,
      objective: "Measure owned CTR, external trend/funnel, and a noncausal monitor",
      inputMode: "dataset",
      referenceId: baseline.datasetIds[0]!,
      ...context("analysis-start"),
    });
    const metricGraph = await call<AnalysisGraph>(client, "metric_compute", {
      id: graphId,
      workspaceId,
      expectedVersion: started.version,
      ...baselineDescriptors,
      metricId: "ctr_v1",
      comparability: "comparable",
      ...context("metric"),
    });
    const metric = metricGraph.nodes.find((node) => node.kind === "metric")!;
    expect(metric.payload).toMatchObject({
      metricId: "ctr_v1",
      numerator: 4000,
      denominator: 40_000,
      value: 0.1,
      includedRowCount: 40,
      excludedRowCount: 0,
      status: "ok",
    });
    const scenarioGraph = await call<AnalysisGraph>(client, "metric_scenario_create", {
      id: graphId,
      workspaceId,
      expectedVersion: metricGraph.version,
      metricNodeId: metric.id,
      label: "base",
      targetValue: 0.15,
      projectedDenominator: 40_000,
      ...context("scenario"),
    });
    const scenario = scenarioGraph.nodes.find((node) => node.kind === "scenario")!;
    expect(scenario.payload).toMatchObject({
      baselineValue: 0.1,
      targetValue: 0.15,
      projectedNumerator: 6000,
      projectedNumeratorDelta: 2000,
      status: "ok",
    });

    const trendGraph = await call<AnalysisGraph>(client, "professional_analytics_compute", {
      id: graphId,
      workspaceId,
      expectedVersion: scenarioGraph.version,
      ...baselineDescriptors,
      operation: {
        operation: "trend_v1",
        datasetId: baseline.datasetIds[0]!,
        parameters: { timeField: "observedAt", valueField: "revenue", grain: "day" },
      },
      ...context("trend"),
    });
    const trend = trendGraph.nodes.find((node) => node.kind === "analytics" && node.payload.operation === "trend_v1")!;
    expect(trend.payload).toMatchObject({ status: "ok", coverage: 1, missingWindows: [] });
    expect(trend.payload.points).toHaveLength(40);
    expect((trend.payload.points as JsonRecord[])[0]).toMatchObject({ window: "2026-01-01", value: 1, rowCount: 1 });
    expect((trend.payload.points as JsonRecord[])[39]).toMatchObject({ window: "2026-02-09", value: 40, rowCount: 1 });

    const funnelGraph = await call<AnalysisGraph>(client, "professional_analytics_compute", {
      id: graphId,
      workspaceId,
      expectedVersion: trendGraph.version,
      ...baselineDescriptors,
      operation: {
        operation: "funnel_v1",
        datasetId: baseline.datasetIds[0]!,
        parameters: { stageFields: ["impressions", "clicks", "conversions"] },
      },
      ...context("funnel"),
    });
    const funnel = funnelGraph.nodes.find((node) => node.kind === "analytics" && node.payload.operation === "funnel_v1")!;
    expect(funnel.payload).toMatchObject({
      status: "ok",
      stages: [
        { field: "impressions", total: 40_000, conversionFromPrevious: null },
        { field: "clicks", total: 4000, conversionFromPrevious: 0.1 },
        { field: "conversions", total: 400, conversionFromPrevious: 0.1 },
      ],
      overallConversion: 0.01,
      overallUnknownReason: null,
    });

    const monitorGraph = await call<AnalysisGraph>(client, "metric_monitor_compare", {
      id: graphId,
      workspaceId,
      expectedVersion: funnelGraph.version,
      baselineMetricNodeId: metric.id,
      scenarioNodeId: scenario.id,
      ...currentDescriptors,
      comparability: "comparable",
      ...context("monitor"),
    });
    const monitor = monitorGraph.nodes.find((node) => node.kind === "monitor")!;
    expect(monitor.payload).toMatchObject({
      status: "ok",
      baseline: { value: 0.1 },
      current: { value: 0.2 },
      absoluteDelta: 0.1,
      relativeDelta: 1,
      monitoring: { scheduling: "not_provided" },
    });

    const links = await call(client, "ingest_content_links", {
      id: "batch-dashboard-competitors",
      workspaceId,
      links: [
        {
          url: `${fixtureOrigin}/competitors/left`,
          fields: { price: ".price", cta: ".cta" },
        },
        {
          url: `${fixtureOrigin}/competitors/right`,
          fields: { price: ".price", cta: ".cta" },
        },
      ],
      ...context("competitor-links"),
    });
    expect(links).toMatchObject({ state: "completed", failures: [] });
    expect(fixturePaths).toEqual(expect.arrayContaining(["/competitors/left", "/competitors/right"]));
    const competitorIds = links.competitorIds as string[];
    expect(competitorIds).toHaveLength(2);
    for (const [index, id] of competitorIds.entries()) {
      const confirmed = await call(client, "competitor_confirm", {
        id,
        workspaceId,
        expectedVersion: 1,
        status: "confirmed",
        ...context(`competitor-confirm-${index}`),
      });
      expect(confirmed).toMatchObject({ id, status: "confirmed", version: 2 });
    }
    const diff = await call(client, "competitor_diff_create", {
      id: diffId,
      workspaceId,
      competitorIds,
      dimensions: ["price", "cta", "audience"],
      ...context("competitor-diff"),
    });
    expect(diff).toMatchObject({
      entries: [
        { dimension: "price", result: "different" },
        { dimension: "cta", result: "same" },
        { dimension: "audience", result: "unknown" },
      ],
    });

    const competitorMetadata = await ingestionDescriptors(client, { id: links.id as string });
    const viewSource = (source: JsonRecord): JsonRecord => ({
      sourceId: source.id,
      updatedAt: source.updatedAt,
      name: source.name,
      type: source.type,
      ownership: source.ownership,
    });
    const latest = (records: JsonRecord[], field: string): string =>
      records.map((record) => record[field] as string).sort().at(-1)!;
    const baselineSource = (baselineMetadata.sources as JsonRecord[])[0]!;
    const currentSource = (currentMetadata.sources as JsonRecord[])[0]!;
    const baselineEvidence = (baselineMetadata.evidence as JsonRecord[])[0]!;
    const currentEvidence = (currentMetadata.evidence as JsonRecord[])[0]!;
    const competitorSources = competitorMetadata.sources as JsonRecord[];
    const competitorEvidence = competitorMetadata.evidence as JsonRecord[];

    const renderV1Arguments = {
      id: dashboardId,
      workspaceId,
      views: dashboardViews([], trend.id, metric.id, funnel.id, monitor.id),
      ...context("dashboard-v1"),
    };
    const dashboardV1 = await call<Dashboard>(client, "dashboard_render", renderV1Arguments);
    expect(await call(client, "dashboard_render", renderV1Arguments)).toEqual(dashboardV1);
    expect(dashboardV1).toMatchObject({
      version: 1,
      renderer: { type: "controlled_renderer", id: "controlled_html_svg_v1", professionalTool: false },
    });
    expect(dashboardV1.views.map((view) => view.kind)).toEqual([
      "trend", "structure", "funnel", "competitor_comparison", "task_effect",
    ]);
    expect(dashboardV1.views).toHaveLength(5);
    expect(dashboardV1.views[4]).toMatchObject({
      status: "unverifiable",
      reasons: [{ code: "TASK_NOT_LINKED" }],
    });
    const baselineViewMetadata = {
      sources: [viewSource(baselineSource)],
      sourceUpdatedAt: baselineSource.updatedAt,
      dataAsOf: baselineEvidence.observedAt,
    };
    for (const view of dashboardV1.views.slice(0, 3)) {
      expect(view).toMatchObject(baselineViewMetadata);
    }
    expect(dashboardV1.views[0]!.metrics).toEqual([]);
    expect(dashboardV1.views[1]!.metrics).toEqual([{
      metricId: "ctr_v1",
      formula: "sum(clicks) / sum(impressions)",
      definitionVersion: metric.payload.definitionVersion,
    }]);
    expect(dashboardV1.views[2]!.metrics).toEqual([]);
    expect(dashboardV1.views[3]).toMatchObject({
      competitorDiffId: diffId,
      sourceUpdatedAt: latest(competitorSources, "updatedAt"),
      dataAsOf: latest(competitorEvidence, "observedAt"),
      metrics: [],
    });
    expect(dashboardV1.views[3]!.sources).toHaveLength(2);
    expect(dashboardV1.views[3]!.sources).toEqual(expect.arrayContaining(competitorSources.map(viewSource)));
    for (const source of dashboardV1.views[3]!.sources as JsonRecord[]) {
      expect(source.ownership).toBe("external_public");
    }
    expect(dashboardV1.views[4]).toMatchObject({
      graphId,
      taskIds: [],
      monitorNodeIds: [monitor.id],
      sourceUpdatedAt: dashboardV1.generatedAt,
      dataAsOf: null,
      sources: [],
      metrics: [],
    });
    expect(dashboardV1.artifacts.map((artifact) => artifact.kind).sort()).toEqual(["html", "manifest"]);
    for (const artifact of dashboardV1.artifacts) {
      expect(artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.byteLength).toBeGreaterThan(0);
    }

    const htmlDescriptorV1 = dashboardV1.artifacts.find((artifact) => artifact.kind === "html")!;
    const manifestDescriptorV1 = dashboardV1.artifacts.find((artifact) => artifact.kind === "manifest")!;
    const htmlV1 = await readArtifact(client, dashboardV1, htmlDescriptorV1);
    const manifestV1 = await readArtifact(client, dashboardV1, manifestDescriptorV1);
    expect(htmlV1.chunks).toBeGreaterThanOrEqual(2);
    const manifest = JSON.parse(manifestV1.bytes.toString("utf8")) as JsonRecord;
    expect(manifest).toMatchObject({ dashboardId, workspaceId, renderer: dashboardV1.renderer });
    const manifestViews = manifest.views as JsonRecord[];
    expect(manifestViews).toHaveLength(5);
    const assertBaselineDatum = (datum: JsonRecord, nodeId: string): void => {
      expect(datum).toMatchObject({
        datasetIds: [baseline.datasetIds[0]],
        evidenceIds: [baseline.evidenceIds[0]],
        analysisGraphRefs: [{
          graphId,
          graphVersion: monitorGraph.version,
          nodeId,
          kind: nodeId === metric.id ? "metric" : "analytics",
        }],
        datasets: [{
          datasetId: baseline.datasetIds[0],
          sourceId: baselineSource.id,
        }],
        evidence: [{
          evidenceId: baseline.evidenceIds[0],
          sourceId: baselineSource.id,
          contentHash: baselineEvidence.contentHash,
        }],
      });
    };
    const trendManifestData = manifestViews[0]!.data as JsonRecord[];
    expect(trendManifestData).toHaveLength(40);
    for (const datum of trendManifestData) {
      assertBaselineDatum(datum, trend.id);
      expect(datum).toMatchObject({
        formula: trend.payload.formula,
        definitionVersion: trend.payload.definitionVersion,
      });
    }
    expect(trendManifestData[0]).toMatchObject({ datumId: `${trend.id}/point/0` });
    const structureManifestData = manifestViews[1]!.data as JsonRecord[];
    expect(structureManifestData).toHaveLength(1);
    assertBaselineDatum(structureManifestData[0]!, metric.id);
    expect(structureManifestData[0]).toMatchObject({
      datumId: metric.id,
      metricId: "ctr_v1",
      formula: "sum(clicks) / sum(impressions)",
      definitionVersion: metric.payload.definitionVersion,
    });
    const funnelManifestData = manifestViews[2]!.data as JsonRecord[];
    expect(funnelManifestData).toHaveLength(3);
    for (const datum of funnelManifestData) {
      assertBaselineDatum(datum, funnel.id);
      expect(datum).toMatchObject({
        formula: funnel.payload.formula,
        definitionVersion: funnel.payload.definitionVersion,
      });
    }
    const competitorManifestData = manifestViews[3]!.data as JsonRecord[];
    expect(competitorManifestData).toHaveLength(3);
    const diffEntries = diff.entries as JsonRecord[];
    for (const [index, datum] of competitorManifestData.entries()) {
      expect(datum).toMatchObject({
        competitorDiffId: diffId,
        datasetIds: [],
        datasets: [],
        analysisGraphRefs: [],
      });
      const expectedEvidenceIds = diffEntries[index]!.evidenceIds as string[];
      expect(datum.evidenceIds).toEqual(expectedEvidenceIds);
      expect(datum.evidence).toHaveLength(expectedEvidenceIds.length);
      for (const evidenceId of expectedEvidenceIds) {
        const evidence = competitorEvidence.find((candidate) => candidate.id === evidenceId)!;
        expect(datum.evidence).toContainEqual(expect.objectContaining({
          evidenceId,
          sourceId: evidence.sourceId,
          contentHash: evidence.contentHash,
        }));
      }
    }
    expect(competitorManifestData.slice(0, 2).every((datum) =>
      (datum.evidenceIds as string[]).length === 2 &&
      (datum.evidence as JsonRecord[]).length === 2
    )).toBe(true);
    expect(competitorManifestData[2]).toMatchObject({
      result: "unknown",
      evidenceIds: [],
      evidence: [],
      reasons: [expect.objectContaining({ code: "COMPETITOR_DIFF_UNKNOWN" })],
    });
    expect(manifestViews[4]).toMatchObject({
      graphId,
      taskIds: [],
      monitorNodeIds: [monitor.id],
      data: [],
    });
    expect(htmlV1.bytes.toString("utf8")).toContain("COMPETITOR_DIFF_UNKNOWN");

    const browser = await chromium.launch({ headless: true });
    try {
      const browserContext = await browser.newContext({ offline: true, javaScriptEnabled: false });
      const networkRequests: string[] = [];
      await browserContext.route("**/*", async (route) => {
        networkRequests.push(route.request().url());
        await route.abort();
      });
      const page = await browserContext.newPage();
      await page.setContent(htmlV1.bytes.toString("utf8"), { waitUntil: "load" });
      expect(await page.locator("svg[data-view-id]").count()).toBe(5);
      expect(await page.locator("script").count()).toBe(0);
      expect(await page.locator('svg[data-view-id="task-view"] text').filter({ hasText: "不可验证" }).first().isVisible()).toBe(true);
      expect(await page.locator("body").textContent()).toContain("TASK_NOT_LINKED");
      expect(await page.locator("body").textContent()).toContain("COMPETITOR_DIFF_UNKNOWN");
      const datumId = `${trend.id}/point/0`;
      const rawAnchor = `drill-trend-view-${datumId}`;
      const anchor = encodeURIComponent(rawAnchor);
      const link = page.locator(`a[href="#${anchor}"]`);
      await link.click();
      expect(await page.evaluate(() => decodeURIComponent(location.hash.slice(1)))).toBe(rawAnchor);
      expect(await page.locator(`[id="${anchor}"]`).isVisible()).toBe(true);
      const captured = await link.evaluate((element) => ({
        viewId: element.closest("svg")?.getAttribute("data-view-id"),
        datumId: element.parentElement?.getAttribute("data-datum-id"),
      }));
      expect(captured).toEqual({ viewId: "trend-view", datumId });
      expect(networkRequests).toEqual([]);
      await browserContext.close();
    } finally {
      await browser.close();
    }

    const assertAnalyticsDrilldown = async (viewId: string, datumId: string, nodeId: string, target = client): Promise<JsonRecord> => {
      const drilldown = await call(target, "dashboard_drilldown_get", {
        id: dashboardId,
        workspaceId,
        viewId,
        datumId,
      });
      expect(drilldown.analysisGraphRefs).toEqual([
        expect.objectContaining({ graphId, nodeId, kind: "analytics" }),
      ]);
      expect(drilldown.datasets).toEqual([
        expect.objectContaining({ datasetId: baseline.datasetIds[0] }),
      ]);
      expect(drilldown.evidence).toEqual([
        expect.objectContaining({ evidenceId: baseline.evidenceIds[0] }),
      ]);
      const graph = await call<AnalysisGraph>(target, "analysis_graph_get", { id: graphId, workspaceId });
      expect(graph.nodes.some((node) => node.id === nodeId)).toBe(true);
      const evidence = (drilldown.evidence as JsonRecord[])[0]!;
      const assets = evidence.assets as JsonRecord[];
      const normalized = assets.find((asset) => asset.kind === "normalized_jsonl")!;
      const normalizedBytes = await readEvidenceAsset(target, evidence.evidenceId as string, normalized);
      expect(normalizedBytes.toString("utf8")).toContain("observedAt");
      return drilldown;
    };
    await assertAnalyticsDrilldown("trend-view", `${trend.id}/point/0`, trend.id);
    await assertAnalyticsDrilldown("funnel-view", `${funnel.id}/stage/1`, funnel.id);
    const assertCompetitorDrilldown = async (target = client): Promise<JsonRecord> => {
      const drilldown = await call(target, "dashboard_drilldown_get", {
        id: dashboardId,
        workspaceId,
        viewId: "competitor-view",
        datumId: `${diffId}/entry/0`,
      });
      expect(drilldown.analysisGraphRefs).toEqual([]);
      expect(drilldown.evidence).toHaveLength(2);
      for (const evidence of drilldown.evidence as JsonRecord[]) {
        const assets = evidence.assets as JsonRecord[];
        expect(assets.length).toBeGreaterThan(0);
        await readEvidenceAsset(target, evidence.evidenceId as string, assets[0]!);
      }
      return drilldown;
    };
    await assertCompetitorDrilldown();

    const finding = await call(client, "finding_record", {
      id: "finding-strategy",
      workspaceId,
      kind: "fact",
      statement: "The owned baseline CTR is 0.1 and the conditional target is 0.15.",
      evidenceIds: [baseline.evidenceIds[0]!],
      ...context("finding"),
    });
    expect(finding).toMatchObject({ id: "finding-strategy", evidenceIds: [baseline.evidenceIds[0]] });
    const recommendationArguments = {
      id: "recommendation-strategy",
      workspaceId,
      findingIds: ["finding-strategy"],
      hypothesis: "A controlled content revision may move CTR toward the explicit scenario target.",
      affectedStage: "click",
      targetChannels: ["search"],
      priority: "p1",
      analysisGraphId: graphId,
      analysisNodeIds: [trend.id],
      expectedMetrics: [{
        metricId: "ctr_v1",
        acceptance: "reach_scenario_target",
        baselineMetricNodeId: metric.id,
        scenarioNodeId: scenario.id,
      }],
      ...context("recommendation"),
    };
    const recommendation = await call(client, "strategy_recommendation_generate", recommendationArguments);
    expect(await call(client, "strategy_recommendation_generate", recommendationArguments)).toEqual(recommendation);
    expect(recommendation).toMatchObject({
      findingIds: ["finding-strategy"],
      evidenceIds: [baseline.evidenceIds[0]],
      affectedStage: "click",
      targetChannels: ["search"],
      expectedMetrics: [{
        metricId: "ctr_v1",
        baselineMetricNodeId: metric.id,
        scenarioNodeId: scenario.id,
      }],
      impacts: [{
        baselineValue: 0.1,
        targetValue: 0.15,
        projectedDenominator: 40_000,
        projectedNumerator: 6000,
        projectedNumeratorDelta: 2000,
        causality: "not_established",
      }],
    });
    const impact = (recommendation.impacts as JsonRecord[])[0]!;
    expect(impact.absoluteDelta).toBeCloseTo(0.05, 12);
    expect(impact.relativeDelta).toBeCloseTo(0.5, 12);

    const taskAArguments = taskArguments(taskIds[0], 2, "task-a-supplement");
    const taskA = await call(client, "strategy_task_supplement", taskAArguments);
    expect(await call(client, "strategy_task_supplement", taskAArguments)).toEqual(taskA);
    expect(taskA).toMatchObject({ version: 1, state: "draft", rank: 2 });
    const taskB = await call(client, "strategy_task_supplement", taskArguments(taskIds[1], 1, "task-b-supplement"));
    expect(taskB).toMatchObject({ version: 1, state: "draft", rank: 1 });

    const updateArguments = {
      id: taskIds[0],
      workspaceId,
      expectedVersion: 1,
      assignee: "human-owner-updated",
      assetRequirements: ["human supplied replacement material"],
      acceptanceCriteria: ["A human verifies the revised acceptance criterion"],
      ...context("task-a-update"),
    };
    const updated = await call(client, "strategy_task_update", updateArguments);
    expect(await call(client, "strategy_task_update", updateArguments)).toEqual(updated);
    expect(updated).toMatchObject({
      version: 2,
      state: "draft",
      assignee: "human-owner-updated",
      assetRequirements: ["human supplied replacement material"],
      acceptanceCriteria: ["A human verifies the revised acceptance criterion"],
    });
    await expectToolError(client, "strategy_task_update", {
      ...updateArguments,
      ...context("task-a-update-stale"),
      assignee: "stale-owner",
    });

    const reorderArguments = {
      id: taskIds[0],
      workspaceId,
      expectedVersion: 2,
      rank: 3,
      ...context("task-a-reorder"),
    };
    const reordered = await call(client, "strategy_task_reorder", reorderArguments);
    expect(await call(client, "strategy_task_reorder", reorderArguments)).toEqual(reordered);
    expect(reordered).toMatchObject({ version: 3, rank: 3, state: "draft" });
    await expectToolError(client, "strategy_task_reorder", {
      ...reorderArguments,
      ...context("task-a-reorder-stale"),
      rank: 9,
    });

    const rejectArguments = {
      id: taskIds[1],
      workspaceId,
      expectedVersion: 1,
      reason: "A human rejected this draft as not actionable.",
      ...context("task-b-reject"),
    };
    const rejected = await call(client, "strategy_task_reject", rejectArguments);
    expect(await call(client, "strategy_task_reject", rejectArguments)).toEqual(rejected);
    expect(rejected).toMatchObject({ version: 2, state: "rejected", rejectionReason: rejectArguments.reason });
    await expectToolError(client, "strategy_task_reject", {
      ...rejectArguments,
      ...context("task-b-reject-stale"),
      reason: "Stale rejection must not apply.",
    });

    const taskCArguments = taskArguments(taskIds[2], 1, "task-c-supplement");
    const taskC = await call(client, "strategy_task_supplement", taskCArguments);
    expect(await call(client, "strategy_task_supplement", taskCArguments)).toEqual(taskC);
    expect(taskC).toMatchObject({ version: 1, state: "draft", rank: 1 });

    let transitioned = reordered;
    for (const [next, expectedVersion] of [["ready", 3], ["in_progress", 4], ["completed", 5]] as const) {
      transitioned = await call(client, "task_transition", {
        id: taskIds[0],
        workspaceId,
        next,
        expectedVersion,
        ...context(`task-a-${next}`),
      });
      expect(transitioned).toMatchObject({ state: next, version: expectedVersion + 1 });
    }
    const listed = await call(client, "strategy_task_list", { workspaceId, limit: 20 });
    const listedTasks = listed.tasks as JsonRecord[];
    expect(listedTasks.map((task) => task.id)).toEqual([taskIds[2], taskIds[1], taskIds[0]]);
    expect(listedTasks.map((task) => [task.rank, task.id])).toEqual([
      [1, taskIds[2]],
      [1, taskIds[1]],
      [3, taskIds[0]],
    ]);
    const rankOneIds = listedTasks.slice(0, 2).map((task) => task.id as string);
    expect(rankOneIds).toEqual([taskIds[2], taskIds[1]]);
    expect(rankOneIds).toEqual([...rankOneIds].sort());
    expect(rankOneIds).not.toEqual([taskIds[1], taskIds[2]]);
    const fullTasks = await Promise.all(taskIds.map((id) => call(client, "strategy_task_get", { id, workspaceId })));
    for (const task of fullTasks) {
      expect(task).not.toHaveProperty("scheduledAt");
      expect(task).not.toHaveProperty("publishedAt");
      expect(task).not.toHaveProperty("approvedAt");
    }

    const renderV2Arguments = {
      id: dashboardId,
      workspaceId,
      expectedVersion: 1,
      views: dashboardViews([taskIds[0]], trend.id, metric.id, funnel.id, monitor.id),
      ...context("dashboard-v2"),
    };
    const dashboardV2 = await call<Dashboard>(client, "dashboard_render", renderV2Arguments);
    expect(await call(client, "dashboard_render", renderV2Arguments)).toEqual(dashboardV2);
    expect(dashboardV2).toMatchObject({ version: 2 });
    const taskViewV2 = dashboardV2.views[4]!;
    expect(taskViewV2).toMatchObject({
      status: "ok",
      graphId,
      taskIds: [taskIds[0]],
      monitorNodeIds: [monitor.id],
      sourceUpdatedAt: latest([baselineSource, currentSource], "updatedAt"),
      dataAsOf: latest([baselineEvidence, currentEvidence], "observedAt"),
      metrics: [{
        metricId: "ctr_v1",
        formula: "sum(clicks) / sum(impressions)",
        definitionVersion: monitor.payload.definitionVersion,
      }],
    });
    expect(taskViewV2.sources).toHaveLength(2);
    expect(taskViewV2.sources).toEqual(expect.arrayContaining([
      viewSource(baselineSource),
      viewSource(currentSource),
    ]));
    const htmlDescriptorV2 = dashboardV2.artifacts.find((artifact) => artifact.kind === "html")!;
    const manifestDescriptorV2 = dashboardV2.artifacts.find((artifact) => artifact.kind === "manifest")!;
    expect(htmlDescriptorV2.contentHash).not.toBe(htmlDescriptorV1.contentHash);
    expect(manifestDescriptorV2.contentHash).not.toBe(manifestDescriptorV1.contentHash);
    const manifestV2Bytes = await readArtifact(client, dashboardV2, manifestDescriptorV2);
    const manifestV2 = JSON.parse(manifestV2Bytes.bytes.toString("utf8")) as JsonRecord;
    const taskDataV2 = ((manifestV2.views as JsonRecord[])[4]!.data as JsonRecord[])[0]!;
    expect(taskDataV2).toMatchObject({
      datumId: `${taskIds[0]}/recommendation-strategy/0/${monitor.id}`,
      taskId: taskIds[0],
      monitorNodeId: monitor.id,
      metricId: "ctr_v1",
      formula: "sum(clicks) / sum(impressions)",
      definitionVersion: monitor.payload.definitionVersion,
      baselineValue: 0.1,
      currentValue: 0.2,
      absoluteDelta: 0.1,
      relativeDelta: 1,
      interpretation: "observed_change_not_causal",
      analysisGraphRefs: [
        { graphId, graphVersion: monitorGraph.version, nodeId: monitor.id, kind: "monitor" },
        { graphId, graphVersion: monitorGraph.version, nodeId: metric.id, kind: "metric" },
      ],
    });
    expect(taskDataV2.datasetIds).toHaveLength(2);
    expect(taskDataV2.datasetIds).toEqual(expect.arrayContaining([
      baseline.datasetIds[0],
      current.datasetIds[0],
    ]));
    expect(taskDataV2.evidenceIds).toHaveLength(2);
    expect(taskDataV2.evidenceIds).toEqual(expect.arrayContaining([
      baseline.evidenceIds[0],
      current.evidenceIds[0],
    ]));
    expect(taskDataV2.datasets).toEqual(expect.arrayContaining([
      expect.objectContaining({ datasetId: baseline.datasetIds[0], sourceId: baselineSource.id }),
      expect.objectContaining({ datasetId: current.datasetIds[0], sourceId: currentSource.id }),
    ]));
    expect(taskDataV2.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceId: baseline.evidenceIds[0],
        sourceId: baselineSource.id,
        contentHash: baselineEvidence.contentHash,
      }),
      expect.objectContaining({
        evidenceId: current.evidenceIds[0],
        sourceId: currentSource.id,
        contentHash: currentEvidence.contentHash,
      }),
    ]));
    const recommendationLineage = await call(client, "lineage_get", {
      entityType: "recommendation",
      id: "recommendation-strategy",
      workspaceId,
    });
    expect(recommendationLineage.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "recommendation", id: "recommendation-strategy" }),
      expect.objectContaining({ entityType: "analysis_graph", id: graphId }),
      expect.objectContaining({ entityType: "evidence", id: baseline.evidenceIds[0] }),
    ]));

    await stopClient(first);
    const restarted = await startClient();
    expect(await call(restarted.client, "dashboard_get", { id: dashboardId, workspaceId })).toEqual(dashboardV2);
    const restoredHtml = await readArtifact(restarted.client, dashboardV2, htmlDescriptorV2);
    const restoredManifest = await readArtifact(restarted.client, dashboardV2, manifestDescriptorV2);
    expect(restoredHtml.bytes.toString("utf8")).toContain("observed_change_not_causal");
    expect(JSON.parse(restoredManifest.bytes.toString("utf8"))).toEqual(manifestV2);
    await assertAnalyticsDrilldown("trend-view", `${trend.id}/point/0`, trend.id, restarted.client);
    await assertCompetitorDrilldown(restarted.client);
    expect(await call(restarted.client, "lineage_get", {
      entityType: "recommendation",
      id: "recommendation-strategy",
      workspaceId,
    })).toEqual(recommendationLineage);
    for (const [index, id] of taskIds.entries()) {
      expect(await call(restarted.client, "strategy_task_get", { id, workspaceId })).toEqual(fullTasks[index]);
    }
    expect(await call(restarted.client, "strategy_task_list", { workspaceId, limit: 20 })).toEqual(listed);
    await stopClient(restarted);
  }, 120_000);
});

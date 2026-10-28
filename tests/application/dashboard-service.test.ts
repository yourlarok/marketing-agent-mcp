import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DashboardService } from "../../src/application/dashboard-service.js";
import type { RenderDashboard } from "../../src/application/dashboard-commands.js";
import type { Clock, IdGenerator, Store } from "../../src/application/ports.js";
import type { CommandContext } from "../../src/application/commands.js";
import { FUNNEL_V1_FORMULA, TREND_V1_FORMULA } from "../../src/domain/analytics-model.js";
import { getMetricDefinition } from "../../src/domain/metric-catalog.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-28T12:00:00.000Z";
const later = "2026-10-28T12:01:00.000Z";
const metric = getMetricDefinition("ctr_v1");

class TestClock implements Clock {
  constructor(private current = now) {}
  now(): string { return this.current; }
  set(value: string): void { this.current = value; }
}

class TestIds implements IdGenerator {
  calls = 0;
  constructor(private values: string[]) {}
  next(): string {
    const value = this.values[this.calls];
    if (!value) throw new Error("No audit ID available");
    this.calls += 1;
    return value;
  }
}

function context(suffix: string): CommandContext {
  return { actor: "agent-1", requestId: `request-${suffix}`, idempotencyKey: `command-${suffix}` };
}

function input(patch: Partial<RenderDashboard> = {}): RenderDashboard {
  return {
    id: "dashboard-1",
    workspaceId: "workspace-1",
    views: [
      { id: "trend-view", kind: "trend", graphId: "graph-1", nodeIds: ["trend-1"] },
      { id: "structure-view", kind: "structure", graphId: "graph-1", nodeIds: ["metric-1"] },
      { id: "funnel-view", kind: "funnel", graphId: "graph-1", nodeIds: ["funnel-1"] },
      { id: "competitor-view", kind: "competitor_comparison", competitorDiffId: "diff-1" },
      { id: "task-view", kind: "task_effect", graphId: "graph-1", taskIds: ["task-1"], monitorNodeIds: ["monitor-1"] },
    ],
    ...patch,
  };
}

describe("DashboardService", () => {
  let store: Store;
  let artifacts: ArtifactStore;
  let root: string;
  let clock: TestClock;
  let ids: TestIds;
  let service: DashboardService;

  beforeEach(async () => {
    store = openStore(":memory:");
    root = await createTempDir();
    artifacts = new ArtifactStore(root);
    clock = new TestClock();
    ids = new TestIds(Array.from({ length: 20 }, (_, index) => `audit-${index + 1}`));
    service = new DashboardService(store, clock, ids, artifacts);
    await store.transaction(async (repos) => {
      await repos.workspaces.insert({
        id: "workspace-1", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now, name: "Workspace",
      });
      await repos.sources.insert({
        id: "source-1", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now,
        name: `Owned source ${"x".repeat(8_000)}`, type: "database", ownership: "owned",
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
        id: "recommendation-1", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now, findingIds: [], hypothesis: "Hypothesis", affectedStage: "click",
        priority: "p0", expectedMetric: "ctr_v1",
        expectedMetrics: [{ metricId: "ctr_v1", acceptance: "reach_scenario_target", scenarioNodeId: "scenario-1" }],
      });
      await repos.tasks.insert({
        id: "task-1", workspaceId: "workspace-1", version: 1,
        createdAt: now, updatedAt: now, recommendationIds: ["recommendation-1"], assignee: "owner",
        dependencyIds: [], assetRequirements: [], acceptanceCriteria: ["done"], state: "completed",
      });
    });
  });

  afterEach(async () => {
    store.close();
    await removeTempDir(root);
  });

  it("stores exact real HTML/JSON files, reads 32 KiB chunks, and drills to persisted refs", async () => {
    const dashboard = await service.render({ input: input(), context: context("render") });
    expect(dashboard).toMatchObject({
      id: "dashboard-1", version: 1, generatedAt: now,
      renderer: { type: "controlled_renderer", id: "controlled_html_svg_v1", professionalTool: false },
    });
    expect(dashboard.artifacts).toHaveLength(2);
    expect(dashboard.views).toHaveLength(5);
    expect(dashboard.sourceVersions).toEqual(expect.arrayContaining([
      { entityType: "source", id: "source-1", version: 1 },
      { entityType: "dataset", id: "dataset-1", version: 1 },
      { entityType: "evidence", id: "evidence-1", version: 1 },
      { entityType: "analysis_graph", id: "graph-1", version: 1 },
      { entityType: "competitor_diff", id: "diff-1", version: 1 },
      { entityType: "task", id: "task-1", version: 1 },
    ]));

    for (const artifact of dashboard.artifacts) {
      expect(artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const bytes = await readFile(join(root, artifact.contentHash));
      expect(bytes.byteLength).toBe(artifact.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.contentHash);
      if (artifact.kind === "manifest") {
        const manifest = JSON.parse(bytes.toString("utf8"));
        expect(manifest.dashboardId).toBe(dashboard.id);
        expect(manifest.views).toHaveLength(5);
        expect(manifest.sources[0]).toMatchObject({ sourceId: "source-1", ownership: "owned" });
      } else {
        const html = bytes.toString("utf8");
        expect(html.match(/<svg\b/g)).toHaveLength(5);
        expect(html).toContain("observed_change_not_causal");
        expect(html).not.toContain("<script");
      }
    }

    const html = dashboard.artifacts.find((artifact) => artifact.kind === "html")!;
    expect(html.byteLength).toBeGreaterThan(32_768);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < html.byteLength;) {
      const chunk = await service.getArtifact({ id: dashboard.id, workspaceId: dashboard.workspaceId, artifactId: html.id, offset });
      expect(chunk.length).toBeLessThanOrEqual(32_768);
      expect(chunk.length).toBe(chunk.content.byteLength);
      expect(chunk).toMatchObject({ offset, totalBytes: html.byteLength, contentHash: html.contentHash, mediaType: html.mediaType });
      chunks.push(Buffer.from(chunk.content));
      offset += chunk.length;
    }
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(html.contentHash);
    await expect(service.get({ id: dashboard.id, workspaceId: dashboard.workspaceId })).resolves.toEqual(dashboard);

    const drilldown = await service.getDrilldown({
      id: dashboard.id, workspaceId: dashboard.workspaceId, viewId: "trend-view", datumId: "trend-1/point/0",
    });
    expect(drilldown.analysisGraphRefs).toContainEqual({ graphId: "graph-1", graphVersion: 1, nodeId: "trend-1", kind: "analytics" });
    expect(drilldown.datasets).toContainEqual(expect.objectContaining({ datasetId: "dataset-1" }));
    expect(drilldown.evidence).toContainEqual(expect.objectContaining({
      evidenceId: "evidence-1", contentHash: "a".repeat(64), assets: [expect.objectContaining({ id: "asset-1", contentHash: "a".repeat(64) })],
    }));
    expect(JSON.stringify(drilldown)).not.toContain("points");
    const persisted = await store.transaction(async (repos) => ({
      graph: await repos.analysisGraphs.get(drilldown.analysisGraphRefs[0]!.graphId, dashboard.workspaceId),
      dataset: await repos.datasets.get(drilldown.datasets[0]!.datasetId, dashboard.workspaceId),
      evidence: await repos.evidence.get(drilldown.evidence[0]!.evidenceId, dashboard.workspaceId),
    }));
    expect(persisted.graph?.nodes.some((node) => node.id === "trend-1")).toBe(true);
    expect(persisted.dataset?.id).toBe("dataset-1");
    expect(persisted.evidence?.id).toBe("evidence-1");

    const competitor = await service.getDrilldown({
      id: dashboard.id, workspaceId: dashboard.workspaceId, viewId: "competitor-view", datumId: "diff-1/entry/0",
    });
    expect(competitor.evidence.map((item) => item.evidenceId)).toEqual(["evidence-1"]);
  });

  it("re-renders exact versions and replays only canonical-equivalent commands", async () => {
    const first = await service.render({ input: input(), context: context("first") });
    clock.set(later);
    const replay = await service.render({ input: input(), context: { ...context("first"), requestId: "replay-request" } });
    expect(replay).toEqual(first);
    expect(ids.calls).toBe(1);

    await expect(service.render({
      input: input({ views: [input().views[0]!] }), context: context("first"),
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const second = await service.render({
      input: input({ expectedVersion: 1, views: [input().views[0]!] }), context: context("second"),
    });
    expect(second).toMatchObject({ version: 2, createdAt: now, updatedAt: later, generatedAt: later });
    expect(second.views).toHaveLength(1);
    await expect(service.render({
      input: input({ expectedVersion: 1 }), context: context("stale-dashboard"),
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.get({ id: dashboardId(), workspaceId: "workspace-1" })).resolves.toEqual(second);
  });

  it("rejects a source version changed during artifact preparation without a Dashboard residue", async () => {
    class InvalidatingArtifacts extends ArtifactStore {
      private invalidated = false;
      override async put(content: Uint8Array) {
        const stored = await super.put(content);
        if (!this.invalidated) {
          this.invalidated = true;
          await store.transaction(async (repos) => {
            const source = (await repos.sources.get("source-1", "workspace-1"))!;
            await repos.sources.update({ ...source, name: "Changed", updatedAt: later }, 1);
          });
        }
        return stored;
      }
    }
    service = new DashboardService(store, clock, ids, new InvalidatingArtifacts(root));

    await expect(service.render({ input: input(), context: context("invalidated") }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await store.transaction((repos) => repos.dashboards.get("dashboard-1", "workspace-1"))).toBeUndefined();
    expect(await store.transaction((repos) => repos.idempotency.get("workspace-1", "command-invalidated"))).toBeUndefined();
  });

  it("fails closed for cross-workspace renders, reads, artifacts, and drilldowns", async () => {
    const dashboard = await service.render({ input: input(), context: context("scoped") });
    await store.transaction((repos) => repos.workspaces.insert({
      id: "workspace-2", workspaceId: "workspace-2", version: 1, createdAt: now, updatedAt: now, name: "Other",
    }));
    await expect(service.get({ id: dashboard.id, workspaceId: "workspace-2" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.getArtifact({ id: dashboard.id, workspaceId: "workspace-2", artifactId: dashboard.artifacts[0].id }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.getDrilldown({ id: dashboard.id, workspaceId: "workspace-2", viewId: "trend-view", datumId: "trend-1/point/0" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.render({ input: input({ id: "dashboard-other", workspaceId: "workspace-2" }), context: context("cross-render") }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("drills each Recommendation observation independently when they share a Monitor", async () => {
    await store.transaction(async (repos) => {
      const recommendation = (await repos.recommendations.get("recommendation-1", "workspace-1"))!;
      await repos.recommendations.insert({ ...recommendation, id: "recommendation-2" });
      const task = (await repos.tasks.get("task-1", "workspace-1"))!;
      await repos.tasks.update({
        ...task,
        recommendationIds: ["recommendation-1", "recommendation-2"],
      }, 1);
    });
    const dashboard = await service.render({
      input: input({ views: [input().views[4]!] }),
      context: context("shared-monitor"),
    });
    const manifestDescriptor = dashboard.artifacts.find((artifact) => artifact.kind === "manifest")!;
    const manifest = JSON.parse((await artifacts.read(manifestDescriptor.contentHash)).toString("utf8"));
    const data = manifest.views[0].data as { datumId: string }[];
    const datumIds = data.map((datum) => datum.datumId);
    expect(datumIds).toEqual([
      "task-1/recommendation-1/0/monitor-1",
      "task-1/recommendation-2/0/monitor-1",
    ]);
    expect(new Set(datumIds).size).toBe(2);

    const htmlDescriptor = dashboard.artifacts.find((artifact) => artifact.kind === "html")!;
    const html = (await artifacts.read(htmlDescriptor.contentHash)).toString("utf8");
    for (const datumId of datumIds) {
      const anchor = encodeURIComponent(`drill-task-view-${datumId}`);
      expect(html.split(`id="${anchor}"`)).toHaveLength(2);
      expect(html.split(`href="#${anchor}"`)).toHaveLength(2);
      const drilldown = await service.getDrilldown({
        id: dashboard.id,
        workspaceId: dashboard.workspaceId,
        viewId: "task-view",
        datumId,
      });
      expect(drilldown.datumId).toBe(datumId);
      expect(drilldown.analysisGraphRefs).toEqual([
        { graphId: "graph-1", graphVersion: 1, nodeId: "monitor-1", kind: "monitor" },
        { graphId: "graph-1", graphVersion: 1, nodeId: "metric-1", kind: "metric" },
      ]);
      expect(drilldown.evidence.map((item) => item.evidenceId)).toEqual(["evidence-1"]);
    }
  });

  it("detects a tampered manifest before returning drilldown data", async () => {
    const dashboard = await service.render({ input: input(), context: context("tamper") });
    const manifest = dashboard.artifacts.find((artifact) => artifact.kind === "manifest")!;
    await writeFile(join(root, manifest.contentHash), "{}");
    await expect(service.getDrilldown({
      id: dashboard.id, workspaceId: dashboard.workspaceId, viewId: "trend-view", datumId: "trend-1/point/0",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rolls back the Dashboard and idempotency record when audit append fails", async () => {
    service = new DashboardService(store, clock, new TestIds([]), artifacts);
    await expect(service.render({ input: input(), context: context("rollback") })).rejects.toThrow("No audit ID available");
    expect(await store.transaction((repos) => repos.dashboards.get("dashboard-1", "workspace-1"))).toBeUndefined();
    expect(await store.transaction((repos) => repos.idempotency.get("workspace-1", "command-rollback"))).toBeUndefined();
  });

  it("validates artifact ownership and bounded raw-byte ranges", async () => {
    const dashboard = await service.render({ input: input(), context: context("ranges") });
    const html = dashboard.artifacts.find((artifact) => artifact.kind === "html")!;
    await expect(service.getArtifact({ id: dashboard.id, workspaceId: dashboard.workspaceId, artifactId: "missing" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.getArtifact({ id: dashboard.id, workspaceId: dashboard.workspaceId, artifactId: html.id, length: 32_769 }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.getArtifact({ id: dashboard.id, workspaceId: dashboard.workspaceId, artifactId: html.id, offset: -1 }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

function dashboardId(): string {
  return "dashboard-1";
}

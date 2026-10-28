import { describe, expect, it } from "vitest";
import { FUNNEL_V1_FORMULA, TREND_V1_FORMULA } from "../../src/domain/analytics-model.js";
import { getMetricDefinition } from "../../src/domain/metric-catalog.js";
import {
  ControlledDashboardRenderer,
  MAX_DASHBOARD_ARTIFACT_BYTES,
  type DashboardSnapshot,
} from "../../src/infrastructure/controlled-dashboard-renderer.js";

const generatedAt = "2026-10-28T12:00:00.000Z";
const updatedAt = "2026-10-28T11:00:00.000Z";
const observedAt = "2026-10-28T10:00:00.000Z";
const metric = getMetricDefinition("ctr_v1");

function snapshot(): DashboardSnapshot {
  const provenance = {
    provider: "mcp",
    tool: "analyze",
    toolVersion: "fixture-1",
    inputHash: "a".repeat(64),
    rowCount: 2,
    batchId: "batch-1",
    datasetId: "dataset-1",
    evidenceId: "evidence-1",
    assetId: "asset-1",
    sourceId: "source-1",
    evidenceHash: "b".repeat(64),
    assetKind: "normalized_jsonl",
    assetContentHash: "b".repeat(64),
    assetByteLength: 100,
  };
  return {
    id: "dashboard-1",
    workspaceId: "workspace-1",
    generatedAt,
    sources: [{
      id: "source-1",
      workspaceId: "workspace-1",
      version: 3,
      createdAt: updatedAt,
      updatedAt,
      name: "Owned <script>alert(\"x\")</script> & 'source'",
      type: "database",
      ownership: "owned",
    }],
    datasets: [{
      id: "dataset-1",
      workspaceId: "workspace-1",
      version: 2,
      createdAt: updatedAt,
      updatedAt,
      sourceId: "source-1",
      name: "Dataset \"one\"",
      coverageStart: "2026-01-01T00:00:00.000Z",
      coverageEnd: "2026-01-31T00:00:00.000Z",
      fieldDefinitions: [],
      metricDefinitions: [],
      limitations: [],
    }],
    evidence: [{
      id: "evidence-1",
      workspaceId: "workspace-1",
      version: 4,
      createdAt: updatedAt,
      updatedAt,
      sourceId: "source-1",
      sourceLocator: "warehouse/one",
      observedAt,
      summary: "Evidence <script> & facts",
      contentHash: "b".repeat(64),
      classification: "owned_operating",
      assets: [{ id: "asset-1", kind: "normalized_jsonl", contentHash: "b".repeat(64), byteLength: 100 }],
    }],
    graphs: [{
      id: "graph-1",
      workspaceId: "workspace-1",
      version: 7,
      createdAt: updatedAt,
      updatedAt,
      parentGraphId: null,
      parentVersion: null,
      forkNodeId: null,
      edges: [],
      recommendedActions: [],
      nodes: [
        {
          id: "trend-ok",
          kind: "analytics",
          payload: {
            operation: "trend_v1",
            datasetId: "dataset-1",
            status: "ok",
            unknownReason: null,
            points: [
              { window: "2026-01-01", value: 10, rowCount: 1 },
              { window: "2026-01-02", value: null, rowCount: 0 },
            ],
            missingWindows: ["2026-01-02"],
            coverage: 0.5,
            definitionVersion: 1,
            formula: TREND_V1_FORMULA,
            provenance,
          },
        },
        {
          id: "trend-unknown",
          kind: "analytics",
          payload: {
            operation: "trend_v1",
            datasetId: "dataset-1",
            status: "unknown",
            unknownReason: "NO_VALID_ROWS",
            points: [],
            missingWindows: [],
            coverage: 0,
            definitionVersion: 1,
            formula: TREND_V1_FORMULA,
            provenance,
          },
        },
        {
          id: "metric-ok",
          kind: "metric",
          payload: {
            metricId: "ctr_v1",
            definitionVersion: 1,
            formula: metric.formula,
            unit: "ratio",
            status: "ok",
            numerator: 100,
            denominator: 1000,
            value: 0.1,
            unknownReason: null,
            datasetId: "dataset-1",
            evidenceId: "evidence-1",
            sourceId: "source-1",
            referenceAssessment: { level: "high", reasons: [] },
          },
        },
        {
          id: "metric-unknown",
          kind: "metric",
          payload: {
            metricId: "ctr_v1",
            definitionVersion: 1,
            formula: metric.formula,
            unit: "ratio",
            status: "unknown",
            numerator: 0,
            denominator: 0,
            value: null,
            unknownReason: "ZERO_DENOMINATOR",
            datasetId: "dataset-1",
            evidenceId: "evidence-1",
            sourceId: "source-1",
            referenceAssessment: { level: "unknown", reasons: [{ code: "ZERO_DENOMINATOR", message: "zero" }] },
          },
        },
        {
          id: "funnel-1",
          kind: "analytics",
          payload: {
            operation: "funnel_v1",
            datasetId: "dataset-1",
            status: "ok",
            stages: [
              { field: "likes", total: 0, conversionFromPrevious: null, conversionUnknownReason: null },
              { field: "comments", total: 5, conversionFromPrevious: null, conversionUnknownReason: "ZERO_DENOMINATOR" },
            ],
            overallConversion: null,
            overallUnknownReason: "ZERO_DENOMINATOR",
            definitionVersion: 1,
            formula: FUNNEL_V1_FORMULA,
            provenance,
          },
        },
        {
          id: "scenario-1",
          kind: "scenario",
          payload: { metricNodeId: "metric-ok", metricId: "ctr_v1", definitionVersion: 1 },
        },
        {
          id: "monitor-1",
          kind: "monitor",
          payload: {
            metricId: "ctr_v1",
            definitionVersion: 1,
            formula: metric.formula,
            status: "ok",
            baselineMetricNodeId: "metric-ok",
            scenarioNodeId: "scenario-1",
            datasetId: "dataset-1",
            evidenceId: "evidence-1",
            baseline: { value: 0.1 },
            current: {
              value: 0.2,
              datasetId: "dataset-1",
              evidenceId: "evidence-1",
              sourceId: "source-1",
            },
            absoluteDelta: 0.1,
            relativeDelta: 1,
            comparisonUnknownReason: null,
            relativeDeltaUnknownReason: null,
          },
        },
      ],
    }],
    competitorDiffs: [{
      id: "diff-1",
      workspaceId: "workspace-1",
      version: 2,
      createdAt: updatedAt,
      updatedAt,
      competitorIds: ["competitor-1", "competitor-2"],
      findingIds: [],
      entries: [
        { dimension: "Price <script> & \"quotes\"", result: "different", evidenceIds: ["evidence-1"] },
        { dimension: "Unknown dimension", result: "unknown", evidenceIds: ["evidence-1"] },
      ],
    }],
    tasks: [{
      id: "task-1",
      workspaceId: "workspace-1",
      version: 5,
      createdAt: updatedAt,
      updatedAt,
      recommendationIds: ["recommendation-1"],
      assignee: "owner",
      dependencyIds: [],
      assetRequirements: [],
      acceptanceCriteria: ["done"],
      state: "completed",
    }],
    recommendations: [{
      id: "recommendation-1",
      workspaceId: "workspace-1",
      version: 2,
      createdAt: updatedAt,
      updatedAt,
      findingIds: ["finding-1"],
      hypothesis: "hypothesis",
      affectedStage: "click",
      priority: "p0",
      expectedMetric: "ctr_v1",
      expectedMetrics: [{
        metricId: "ctr_v1",
        acceptance: "reach_scenario_target",
        scenarioNodeId: "scenario-1",
      }],
    }],
    views: [
      { id: "trend-view", kind: "trend", graphId: "graph-1", nodeIds: ["trend-ok", "trend-unknown"] },
      { id: "structure-view", kind: "structure", graphId: "graph-1", nodeIds: ["metric-ok", "metric-unknown"] },
      { id: "funnel-view", kind: "funnel", graphId: "graph-1", nodeIds: ["funnel-1"] },
      { id: "competitor-view", kind: "competitor_comparison", competitorDiffId: "diff-1" },
      { id: "task-view", kind: "task_effect", graphId: "graph-1", taskIds: ["task-1"], monitorNodeIds: ["monitor-1"] },
    ],
  };
}

function render(input = snapshot()) {
  return new ControlledDashboardRenderer().render(input);
}

describe("ControlledDashboardRenderer", () => {
  it("renders five real evidence-linked SVG views and a canonical manifest deterministically", () => {
    const first = render();
    const second = render();
    const html = new TextDecoder("utf-8").decode(first.html);
    const manifest = JSON.parse(new TextDecoder("utf-8").decode(first.manifest));

    expect(first.html).toEqual(second.html);
    expect(first.manifest).toEqual(second.manifest);
    expect(manifest).toEqual(first.manifestModel);
    expect(first.manifestModel.renderer).toEqual({
      type: "controlled_renderer",
      id: "controlled_html_svg_v1",
      professionalTool: false,
    });
    expect(first.views).toHaveLength(5);
    expect(first.views.every((view) => view.sourceUpdatedAt === updatedAt)).toBe(true);
    expect(html.match(/<svg\b/g)).toHaveLength(5);
    for (const kind of ["trend", "structure", "funnel", "competitor_comparison", "task_effect"]) {
      expect(html).toContain(`data-view-kind="${kind}"`);
    }
    expect(html).toContain("不可验证");
    for (const reason of ["NO_VALID_ROWS", "ZERO_DENOMINATOR", "COMPETITOR_DIFF_UNKNOWN", "observed_change_not_causal"]) {
      expect(html).toContain(reason);
    }
    expect(html).toContain(TREND_V1_FORMULA);
    expect(html).toContain(metric.formula);
    expect(html).toContain(observedAt);
    expect(html).toContain(updatedAt);
    expect(html).toContain("owned");
    expect(html).toContain("likes");
    expect(html).toContain("comments");
    const trendAnchor = encodeURIComponent("drill-trend-view-trend-ok/point/0");
    expect(html).toContain(`href="#${trendAnchor}"`);
    expect(html).toContain(`id="${trendAnchor}"`);
    expect(html).toContain("evidence-1");
    expect(html).toContain("dataset-1");
    expect(html).toContain("graph-1");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("Price <script>");
    expect(html).toContain("Price &lt;script&gt; &amp; &quot;quotes&quot;");
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<(?:script|img|link|iframe|object|embed)\b/i);
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["'](?:https?:|\/\/)/i);
    expect(first.html.byteLength).toBeLessThanOrEqual(MAX_DASHBOARD_ARTIFACT_BYTES);
    expect(first.manifest.byteLength).toBeLessThanOrEqual(MAX_DASHBOARD_ARTIFACT_BYTES);
  });

  it("retains null windows, exact unknown reasons, zero-denominator funnels, and observed non-causal deltas", () => {
    const { manifestModel, views } = render();
    const trend = manifestModel.views.find((view) => view.kind === "trend")!;
    const structure = manifestModel.views.find((view) => view.kind === "structure")!;
    const funnel = manifestModel.views.find((view) => view.kind === "funnel")!;
    const competitor = manifestModel.views.find((view) => view.kind === "competitor_comparison")!;
    const task = manifestModel.views.find((view) => view.kind === "task_effect")!;

    expect(trend.status).toBe("partial");
    expect(trend.data.map((datum) => datum.datumId)).toEqual(["trend-ok/point/0", "trend-ok/point/1"]);
    expect(trend.data[1]).toMatchObject({ value: null, rowCount: 0, status: "unknown" });
    expect(trend.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NO_VALID_ROWS" }),
      expect.objectContaining({ code: "MISSING_WINDOWS" }),
    ]));
    expect(structure.status).toBe("partial");
    expect(structure.data[1]).toMatchObject({ value: null, unknownReason: "ZERO_DENOMINATOR" });
    expect(funnel.status).toBe("partial");
    expect(funnel.data).toHaveLength(2);
    expect(funnel.data[0]).toMatchObject({ field: "likes", total: 0 });
    expect(funnel.data[1]).toMatchObject({ field: "comments", total: 5, overallConversion: null, overallUnknownReason: "ZERO_DENOMINATOR" });
    expect(competitor.status).toBe("partial");
    expect(competitor.data[1]).toMatchObject({ result: "unknown", reasons: [expect.objectContaining({ code: "COMPETITOR_DIFF_UNKNOWN" })] });
    expect(task.status).toBe("ok");
    expect(task.data[0]).toMatchObject({
      baselineValue: 0.1,
      currentValue: 0.2,
      absoluteDelta: 0.1,
      relativeDelta: 1,
      interpretation: "observed_change_not_causal",
    });
    expect(views.find((view) => view.id === "task-view")?.metrics).toEqual([
      { metricId: "ctr_v1", formula: metric.formula, definitionVersion: 1 },
    ]);
    expect(task.data[0]?.analysisGraphRefs).toEqual(expect.arrayContaining([
      { graphId: "graph-1", graphVersion: 7, nodeId: "monitor-1", kind: "monitor" },
      { graphId: "graph-1", graphVersion: 7, nodeId: "metric-ok", kind: "metric" },
    ]));
    expect(task.data[0]?.evidence[0]).toMatchObject({
      evidenceId: "evidence-1",
      observedAt,
      contentHash: "b".repeat(64),
      assets: [{ id: "asset-1", contentHash: "b".repeat(64) }],
    });
  });

  it("keeps shared-Monitor Recommendation observations uniquely addressable", () => {
    const input = snapshot();
    input.tasks[0]!.recommendationIds = ["recommendation-1", "recommendation-2"];
    input.recommendations.push({ ...input.recommendations[0]!, id: "recommendation-2" });
    input.views = [{
      id: "task-view",
      kind: "task_effect",
      graphId: "graph-1",
      taskIds: ["task-1"],
      monitorNodeIds: ["monitor-1"],
    }];

    const first = render(input);
    const second = render(input);
    const data = first.manifestModel.views[0]!.data;
    const datumIds = data.map((datum) => datum.datumId);
    expect(datumIds).toEqual([
      "task-1/recommendation-1/0/monitor-1",
      "task-1/recommendation-2/0/monitor-1",
    ]);
    expect(new Set(datumIds).size).toBe(2);
    expect(first.manifest).toEqual(second.manifest);
    const html = new TextDecoder().decode(first.html);
    for (const datum of data) {
      const anchor = encodeURIComponent(`drill-task-view-${datum.datumId}`);
      expect(html.split(`id="${anchor}"`)).toHaveLength(2);
      expect(html.split(`href="#${anchor}"`)).toHaveLength(2);
      expect(datum.analysisGraphRefs).toEqual([
        { graphId: "graph-1", graphVersion: 7, nodeId: "monitor-1", kind: "monitor" },
        { graphId: "graph-1", graphVersion: 7, nodeId: "metric-ok", kind: "metric" },
      ]);
    }
  });

  it("keeps unlinked and incomplete tasks explicitly unverifiable", () => {
    const input = snapshot();
    input.views = [{
      id: "task-view",
      kind: "task_effect",
      graphId: "graph-1",
      taskIds: [],
      monitorNodeIds: ["monitor-1"],
    }];
    const unlinked = render(input);
    expect(unlinked.views[0]).toMatchObject({ status: "unverifiable" });
    expect(unlinked.views[0]?.reasons).toContainEqual(expect.objectContaining({ code: "TASK_NOT_LINKED" }));
    expect(new TextDecoder().decode(unlinked.html)).toContain("TASK_NOT_LINKED");

    input.views = [{ id: "task-view", kind: "task_effect", graphId: "graph-1", taskIds: ["task-1"], monitorNodeIds: ["monitor-1"] }];
    input.tasks[0]!.state = "in_progress";
    const incomplete = render(input);
    expect(incomplete.views[0]).toMatchObject({ status: "unverifiable" });
    expect(incomplete.views[0]?.reasons).toContainEqual(expect.objectContaining({ code: "TASK_NOT_COMPLETED" }));
  });

  it("rejects mixed structure definitions and makes incomparable structures unverifiable", () => {
    const mixed = snapshot();
    mixed.views = [{ id: "structure-view", kind: "structure", graphId: "graph-1", nodeIds: ["metric-ok", "metric-unknown"] }];
    mixed.graphs[0]!.nodes.find((node) => node.id === "metric-unknown")!.payload.definitionVersion = 2;
    expect(() => render(mixed)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));

    const incomparable = snapshot();
    incomparable.views = [{ id: "structure-view", kind: "structure", graphId: "graph-1", nodeIds: ["metric-ok"] }];
    incomparable.graphs[0]!.nodes.find((node) => node.id === "metric-ok")!.payload.referenceAssessment = {
      level: "low",
      reasons: [{ code: "COMPARABILITY_NOT_COMPARABLE", message: "not comparable" }],
    };
    const result = render(incomparable);
    expect(result.views[0]).toMatchObject({ status: "unverifiable" });
    expect(result.views[0]?.reasons).toContainEqual(expect.objectContaining({ code: "COMPARABILITY_NOT_COMPARABLE" }));
  });

  it.each([
    "STALE_DATA",
    "SAMPLE_BELOW_MINIMUM",
    "COMPARABILITY_NOT_ASSESSED",
  ])("keeps Structure reference reason %s on the datum and downgrades a numeric view", (code) => {
    const input = snapshot();
    input.views = [{ id: "structure-view", kind: "structure", graphId: "graph-1", nodeIds: ["metric-ok"] }];
    input.graphs[0]!.nodes.find((node) => node.id === "metric-ok")!.payload.referenceAssessment = {
      level: "low",
      reasons: [{ code, message: `${code} message` }],
    };

    const result = render(input);
    expect(result.views[0]).toMatchObject({ status: "partial" });
    expect(result.views[0]?.reasons).toContainEqual({ code, message: `${code} message` });
    expect(result.manifestModel.views[0]?.data[0]).toMatchObject({
      status: "ok",
      value: 0.1,
      reasons: [{ code, message: `${code} message` }],
    });
  });

  it.each([
    ["STALE_DATA", "baseline"],
    ["SAMPLE_BELOW_MINIMUM", "current"],
    ["COMPARABILITY_NOT_ASSESSED", "current"],
  ] as const)("keeps Task observation %s reference reason from %s and downgrades the view", (code, location) => {
    const input = snapshot();
    input.views = [{ id: "task-view", kind: "task_effect", graphId: "graph-1", taskIds: ["task-1"], monitorNodeIds: ["monitor-1"] }];
    const assessment = { level: "low", reasons: [{ code, message: `${code} message` }] };
    if (location === "baseline") {
      input.graphs[0]!.nodes.find((node) => node.id === "metric-ok")!.payload.referenceAssessment = assessment;
    } else {
      const monitor = input.graphs[0]!.nodes.find((node) => node.id === "monitor-1")!;
      (monitor.payload.current as Record<string, unknown>).referenceAssessment = assessment;
    }

    const result = render(input);
    expect(result.views[0]).toMatchObject({ status: "partial" });
    expect(result.views[0]?.reasons).toContainEqual({ code, message: `${code} message` });
    expect(result.manifestModel.views[0]?.data[0]).toMatchObject({
      status: "ok",
      baselineValue: 0.1,
      currentValue: 0.2,
      reasons: [{ code, message: `${code} message` }],
    });
  });

  it("renders migrated legacy IDs with unique safe anchors and unchanged drilldown IDs", () => {
    const input = snapshot();
    const graphId = "9 legacy/graph:1";
    const datumId = `${"m".repeat(250)} /:idx`;
    input.graphs[0]!.id = graphId;
    input.graphs[0]!.nodes.find((node) => node.id === "metric-ok")!.id = datumId;
    input.views = [{ id: "structure-view", kind: "structure", graphId, nodeIds: [datumId] }];

    const result = render(input);
    const rawAnchor = `drill-structure-view-${datumId}`;
    const safeAnchor = encodeURIComponent(rawAnchor);
    const html = new TextDecoder().decode(result.html);
    expect(result.manifestModel.views[0]?.data[0]?.datumId).toBe(datumId);
    expect(result.manifestModel.workspaceId).toBe("workspace-1");
    expect(html.split(`id="${safeAnchor}"`)).toHaveLength(2);
    expect(html.split(`href="#${safeAnchor}"`)).toHaveLength(2);
    expect(html).not.toContain(`id="${rawAnchor}"`);
    expect(html).not.toContain(`href="#${rawAnchor}"`);
    expect(html).toContain(`data-datum-id="${datumId}"`);
    expect(safeAnchor).not.toMatch(/[\s/:#]/);
  });

  it("bounds data and fails oversized artifacts before persistence", () => {
    const many = snapshot();
    const trend = many.graphs[0]!.nodes.find((node) => node.id === "trend-ok")!;
    trend.payload.points = Array.from({ length: 501 }, (_, index) => ({
      window: `2026-01-${String(index + 1).padStart(2, "0")}`,
      value: index,
      rowCount: 1,
    }));
    many.views = [{ id: "trend-view", kind: "trend", graphId: "graph-1", nodeIds: ["trend-ok"] }];
    expect(() => render(many)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));

    const oversized = snapshot();
    oversized.sources[0]!.name = "x".repeat(MAX_DASHBOARD_ARTIFACT_BYTES);
    expect(() => render(oversized)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
  });
});

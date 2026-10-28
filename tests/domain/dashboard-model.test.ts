import { describe, expect, it } from "vitest";
import {
  DASHBOARD_VIEW_KINDS,
  createDashboard,
  createDashboardView,
  validateDashboard,
  type Dashboard,
  type DashboardView,
  type DashboardViewInput,
} from "../../src/domain/dashboard-model.js";
import { DomainError } from "../../src/domain/errors.js";

const now = "2026-10-28T00:00:00.000Z";
const later = "2026-10-28T01:00:00.000Z";

const viewInputs: DashboardViewInput[] = [
  { id: "trend-view", kind: "trend", graphId: "graph-1", nodeIds: ["node-1"] },
  { id: "structure-view", kind: "structure", graphId: "graph-1", nodeIds: ["node-1"] },
  { id: "funnel-view", kind: "funnel", graphId: "graph-1", nodeIds: ["node-1"] },
  { id: "competitor-view", kind: "competitor_comparison", competitorDiffId: "diff-1" },
  {
    id: "task-view",
    kind: "task_effect",
    graphId: "graph-1",
    taskIds: ["task-1"],
    monitorNodeIds: ["monitor-1"],
  },
];

function view(input: DashboardViewInput = viewInputs[0]!, overrides: Record<string, unknown> = {}): DashboardView {
  return createDashboardView({
    ...input,
    status: "ok",
    reasons: [],
    dataAsOf: now,
    sourceUpdatedAt: later,
    sources: [{ sourceId: "source-1", updatedAt: later }],
    metrics: [{ metricId: "ctr_v1", formula: "sum(clicks) / sum(impressions)" }],
    ...overrides,
  } as DashboardViewInput & Record<string, unknown>);
}

function dashboard(overrides: Record<string, unknown> = {}): Dashboard {
  return createDashboard({
    id: "dashboard-1",
    workspaceId: "workspace-1",
    createdAt: now,
    generatedAt: later,
    renderer: {
      type: "controlled_renderer",
      id: "controlled_html_svg_v1",
      professionalTool: false,
    },
    views: [view()],
    artifacts: [
      {
        id: "artifact-html",
        kind: "html",
        contentHash: "a".repeat(64),
        byteLength: 100,
        mediaType: "text/html; charset=utf-8",
      },
      {
        id: "artifact-manifest",
        kind: "manifest",
        contentHash: "b".repeat(64),
        byteLength: 200,
        mediaType: "application/json",
      },
    ],
    sourceIds: ["source-1"],
    datasetIds: [],
    evidenceIds: [],
    graphIds: ["graph-1"],
    competitorDiffIds: [],
    taskIds: [],
    sourceVersions: [
      { entityType: "source", id: "source-1", version: 1 },
      { entityType: "analysis_graph", id: "graph-1", version: 2 },
    ],
    ...overrides,
  });
}

function expectInvalid(value: () => unknown): void {
  expect(value).toThrowError(
    expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
  );
}

describe("dashboard views", () => {
  it("supports exactly the five controlled discriminants", () => {
    expect(DASHBOARD_VIEW_KINDS).toEqual([
      "trend",
      "structure",
      "funnel",
      "competitor_comparison",
      "task_effect",
    ]);
    expect(viewInputs.map((input) => view(input).kind)).toEqual(DASHBOARD_VIEW_KINDS);
  });

  it("rejects duplicate view IDs and duplicate view kinds", () => {
    expectInvalid(() => dashboard({ views: [view(), view()] }));
    expectInvalid(() => dashboard({
      views: [view(), view({ ...viewInputs[0]!, id: "other-trend" })],
    }));
  });

  it("rejects fields from another view discriminant", () => {
    expectInvalid(() => view(viewInputs[3]!, { graphId: "graph-1", nodeIds: ["node-1"] }));
    expectInvalid(() => view(viewInputs[0]!, { competitorDiffId: "diff-1" }));
  });

  it("accepts empty task-effect taskIds and reports TASK_NOT_LINKED", () => {
    const taskView = view(
      { id: "task-view", kind: "task_effect", graphId: "graph-1", taskIds: [], monitorNodeIds: ["monitor-1"] },
      { status: "ok", reasons: [] },
    );

    expect(taskView.status).toBe("unverifiable");
    expect(taskView.reasons).toContainEqual(expect.objectContaining({ code: "TASK_NOT_LINKED" }));
  });

  it("rejects an unnormalized empty task-effect view at the direct validation boundary", () => {
    const normalized = view({
      id: "task-view",
      kind: "task_effect",
      graphId: "graph-1",
      taskIds: [],
      monitorNodeIds: ["monitor-1"],
    });
    const candidate = {
      ...dashboard(),
      views: [{ ...normalized, status: "ok" as const, reasons: [] }],
    };

    expectInvalid(() => validateDashboard(candidate));
  });

  it("bounds source and metric descriptors and rejects duplicate descriptor IDs", () => {
    expectInvalid(() => view(viewInputs[0]!, {
      sources: Array.from({ length: 101 }, (_, index) => ({ sourceId: `source-${index}`, updatedAt: now })),
    }));
    expectInvalid(() => view(viewInputs[0]!, {
      metrics: Array.from({ length: 101 }, (_, index) => ({ metricId: "ctr_v1", formula: `formula-${index}` })),
    }));
    expectInvalid(() => view(viewInputs[0]!, {
      sources: [
        { sourceId: "source-1", updatedAt: now },
        { sourceId: "source-1", updatedAt: now },
      ],
    }));
  });
});

describe("dashboard entity contract", () => {
  it("accepts a controlled renderer and exactly one HTML plus one manifest artifact", () => {
    expect(() => validateDashboard(dashboard())).not.toThrow();
    expect(dashboard().artifacts.map((artifact) => artifact.kind)).toEqual(["html", "manifest"]);
  });

  it.each([
    ["duplicate html", [dashboard().artifacts[0], { ...dashboard().artifacts[0]!, id: "other-html" }]],
    ["missing manifest", [dashboard().artifacts[0]]],
    ["extra artifact", [...dashboard().artifacts, { ...dashboard().artifacts[1]!, id: "extra" }]],
    ["invalid hash", [{ ...dashboard().artifacts[0]!, contentHash: "not-a-sha256" }, dashboard().artifacts[1]]],
    ["zero length", [{ ...dashboard().artifacts[0]!, byteLength: 0 }, dashboard().artifacts[1]]],
    ["unsafe length", [{ ...dashboard().artifacts[0]!, byteLength: Number.MAX_SAFE_INTEGER + 1 }, dashboard().artifacts[1]]],
    ["wrong html media type", [{ ...dashboard().artifacts[0]!, mediaType: "text/html" }, dashboard().artifacts[1]]],
    ["wrong manifest media type", [dashboard().artifacts[0], { ...dashboard().artifacts[1]!, mediaType: "application/json; charset=utf-8" }]],
  ])("rejects %s", (_name, artifacts) => {
    expectInvalid(() => dashboard({ artifacts }));
  });

  it.each([
    [{ type: "controlled_renderer", id: "other", professionalTool: false }],
    [{ type: "other", id: "controlled_html_svg_v1", professionalTool: false }],
    [{ type: "controlled_renderer", id: "controlled_html_svg_v1", professionalTool: true }],
  ])("rejects invalid renderer identity", (renderer) => {
    expectInvalid(() => dashboard({ renderer }));
  });

  it("requires at least one top-level source reference", () => {
    expectInvalid(() => dashboard({
      sourceIds: [],
      datasetIds: [],
      evidenceIds: [],
      graphIds: [],
      competitorDiffIds: [],
      taskIds: [],
      sourceVersions: [],
    }));
  });

  it.each([
    ["createdAt", "2026-10-28T08:00:00+08:00"],
    ["generatedAt", "2026-10-28T00:00:00"],
  ])("rejects non-UTC %s", (field, value) => {
    expectInvalid(() => dashboard({ [field]: value }));
  });

  it("rejects non-UTC view timestamps", () => {
    expectInvalid(() => dashboard({ views: [view(viewInputs[0]!, { dataAsOf: "2026-10-28T08:00:00+08:00" })] }));
    expectInvalid(() => dashboard({ views: [view(viewInputs[0]!, { sourceUpdatedAt: "2026-10-28" })] }));
  });

  it.each([
    [{ entityType: "other", id: "source-1", version: 1 }],
    [{ entityType: "source", id: "source-1", version: 0 }],
    [{ entityType: "source", id: "source-1", version: 1.5 }],
    [{ entityType: "source", id: "missing-source", version: 1 }],
    [{ entityType: "task", id: "source-1", version: 1 }],
  ])("rejects malformed source version %j", (sourceVersion) => {
    expectInvalid(() => dashboard({
      sourceVersions: [sourceVersion, { entityType: "analysis_graph", id: "graph-1", version: 2 }],
    }));
  });

  it("requires one source version per top-level reference without duplicates", () => {
    expectInvalid(() => dashboard({ sourceVersions: [{ entityType: "source", id: "source-1", version: 1 }] }));
    expectInvalid(() => dashboard({
      sourceVersions: [
        { entityType: "source", id: "source-1", version: 1 },
        { entityType: "source", id: "source-1", version: 2 },
        { entityType: "analysis_graph", id: "graph-1", version: 2 },
      ],
    }));
  });
});

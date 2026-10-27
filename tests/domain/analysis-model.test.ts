import { describe, expect, it } from "vitest";
import {
  ANALYSIS_NODE_KINDS,
  createAnalysisGraph,
  createMetricScenario,
  expandAnalysisGraph,
  forkAnalysisGraph,
  validateAnalysisGraph,
  type AnalysisGraph,
} from "../../src/domain/analysis-model.js";
import { DomainError } from "../../src/domain/errors.js";
import { computeMetric } from "../../src/domain/metric-catalog.js";

function graph(): AnalysisGraph {
  return createAnalysisGraph({
    id: "graph-1",
    workspaceId: "workspace-1",
    createdAt: "2026-10-27T00:00:00.000Z",
    nodes: [
      { id: "question-1", kind: "question", payload: { text: "How?" } },
      { id: "research-1", kind: "research", payload: { nested: { values: [1, 2] } } },
    ],
    edges: [{ id: "edge-1", fromNodeId: "question-1", toNodeId: "research-1" }],
    recommendedActions: [{ tool: "research", description: "Review public evidence" }],
  });
}

describe("analysis graph", () => {
  it("controls node kinds and preserves supplied stable IDs", () => {
    expect(ANALYSIS_NODE_KINDS).toEqual([
      "question",
      "research",
      "dataset",
      "metric",
      "scenario",
      "monitor",
      "decision",
    ]);
    expect(graph()).toMatchObject({
      id: "graph-1",
      version: 1,
      parentGraphId: null,
      parentVersion: null,
      forkNodeId: null,
    });
    expect(() => createAnalysisGraph({
      id: "bad-graph",
      workspaceId: "workspace-1",
      createdAt: "2026-10-27T00:00:00.000Z",
      nodes: [{ id: "other", kind: "other", payload: {} }],
    } as never)).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }));
  });

  it.each([
    ["duplicate node IDs", {
      nodes: [
        { id: "same", kind: "question", payload: {} },
        { id: "same", kind: "research", payload: {} },
      ],
      edges: [],
    }],
    ["duplicate edge IDs", {
      nodes: [{ id: "question", kind: "question", payload: {} }],
      edges: [
        { id: "same", fromNodeId: "question", toNodeId: "question" },
        { id: "same", fromNodeId: "question", toNodeId: "question" },
      ],
    }],
    ["duplicate directed relationships", {
      nodes: [
        { id: "question", kind: "question", payload: {} },
        { id: "research", kind: "research", payload: {} },
      ],
      edges: [
        { id: "edge-1", fromNodeId: "question", toNodeId: "research" },
        { id: "edge-2", fromNodeId: "question", toNodeId: "research" },
      ],
    }],
    ["orphan references", {
      nodes: [{ id: "question", kind: "question", payload: {} }],
      edges: [{ id: "edge-1", fromNodeId: "question", toNodeId: "missing" }],
    }],
    ["cycles", {
      nodes: [
        { id: "a", kind: "question", payload: {} },
        { id: "b", kind: "research", payload: {} },
      ],
      edges: [
        { id: "edge-1", fromNodeId: "a", toNodeId: "b" },
        { id: "edge-2", fromNodeId: "b", toNodeId: "a" },
      ],
    }],
  ])("rejects %s", (_name, value) => {
    expect(() => validateAnalysisGraph({
      ...graph(),
      ...value,
    } as AnalysisGraph)).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }));
  });

  it("does not collide distinct edge tuples when IDs contain NUL characters", () => {
    const graphWithNulIds = createAnalysisGraph({
      id: "graph-nul",
      workspaceId: "workspace-1",
      createdAt: "2026-10-27T00:00:00.000Z",
      nodes: [
        { id: "a", kind: "question", payload: {} },
        { id: "b\u0000c", kind: "research", payload: {} },
        { id: "a\u0000b", kind: "dataset", payload: {} },
        { id: "c", kind: "metric", payload: {} },
      ],
      edges: [
        { id: "edge-1", fromNodeId: "a", toNodeId: "b\u0000c" },
        { id: "edge-2", fromNodeId: "a\u0000b", toNodeId: "c" },
      ],
    });

    expect(graphWithNulIds.edges).toHaveLength(2);
  });

  it("expands atomically after any existing node and enforces expected version", () => {
    const original = graph();
    const expanded = expandAnalysisGraph(original, {
      expectedVersion: 1,
      updatedAt: "2026-10-27T01:00:00.000Z",
      nodes: [
        { id: "dataset-1", kind: "dataset", payload: { datasetId: "dataset-1" } },
        { id: "metric-1", kind: "metric", payload: { value: 0.2 } },
      ],
      edges: [
        { id: "edge-2", fromNodeId: "research-1", toNodeId: "dataset-1" },
        { id: "edge-3", fromNodeId: "dataset-1", toNodeId: "metric-1" },
      ],
    });

    expect(expanded.version).toBe(2);
    expect(expanded.nodes.map((node) => node.id)).toEqual([
      "question-1",
      "research-1",
      "dataset-1",
      "metric-1",
    ]);
    expect(original.version).toBe(1);
    expect(original.nodes).toHaveLength(2);
    expect(() => expandAnalysisGraph(original, {
      expectedVersion: 2,
      updatedAt: "2026-10-27T01:00:00.000Z",
      nodes: [],
      edges: [],
    })).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "CONFLICT" }));
    expect(() => expandAnalysisGraph(original, {
      expectedVersion: 1,
      updatedAt: "2026-10-27T01:00:00.000Z",
      nodes: [{ id: "metric-2", kind: "metric", payload: {} }],
      edges: [{ id: "edge-4", fromNodeId: "metric-2", toNodeId: "missing" }],
    })).toThrowError(DomainError);
    expect(original.nodes).toHaveLength(2);
  });

  it("forks with lineage and deep-copies nested payloads and actions", () => {
    const parent = graph();
    const fork = forkAnalysisGraph(parent, {
      id: "graph-2",
      forkNodeId: "research-1",
      createdAt: "2026-10-27T02:00:00.000Z",
    });

    expect(fork).toMatchObject({
      id: "graph-2",
      version: 1,
      parentGraphId: "graph-1",
      parentVersion: 1,
      forkNodeId: "research-1",
    });
    expect(fork).not.toBe(parent);
    expect(fork.nodes[1]).not.toBe(parent.nodes[1]);
    expect(fork.recommendedActions).not.toBe(parent.recommendedActions);
    (fork.nodes[1]!.payload.nested as { values: number[] }).values.push(3);
    expect(parent.nodes[1]!.payload).toEqual({ nested: { values: [1, 2] } });
    expect(() => forkAnalysisGraph(parent, {
      id: "graph-3",
      forkNodeId: "missing",
      createdAt: "2026-10-27T02:00:00.000Z",
    })).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "NOT_FOUND" }));
  });
});

describe("conditional metric scenarios", () => {
  const baseline = computeMetric("ctr_v1", [
    { clicks: 20, impressions: 200 },
    { clicks: 30, impressions: 300 },
  ]);

  it("computes conditional absolute, relative, and numerator changes", () => {
    expect(createMetricScenario(baseline, {
      label: "base",
      targetValue: 0.2,
      projectedDenominator: 1000,
    })).toMatchObject({
      status: "ok",
      label: "base",
      baselineValue: 0.1,
      targetValue: 0.2,
      absoluteDelta: 0.1,
      relativeDelta: 1,
      projectedNumerator: 200,
      projectedNumeratorDelta: 150,
      assumptions: ["denominator_unchanged", "other_conditions_unchanged"],
    });
    expect(createMetricScenario(baseline, {
      label: "conservative",
      targetValue: 0.2,
      projectedDenominator: 1000,
    }).sensitivity).toMatch(/denominator|conditions/i);
  });

  it("keeps relative change null at a zero baseline", () => {
    const zero = computeMetric("ctr_v1", [{ clicks: 0, impressions: 100 }]);
    const scenario = createMetricScenario(zero, {
      label: "optimistic",
      targetValue: 0.1,
      projectedDenominator: 100,
    });

    expect(scenario).toMatchObject({
      status: "ok",
      absoluteDelta: 0.1,
      relativeDelta: null,
      relativeDeltaUnknownReason: "ZERO_BASELINE",
      projectedNumerator: 10,
      projectedNumeratorDelta: 10,
    });
    expect(Number.isFinite(scenario.absoluteDelta)).toBe(true);
  });

  it("rejects non-finite relative change from a tiny non-zero baseline", () => {
    const tiny = computeMetric("ctr_v1", [{ clicks: Number.MIN_VALUE, impressions: 1 }]);
    expect(tiny.value).toBe(Number.MIN_VALUE);
    expect(() => createMetricScenario(tiny, {
      label: "base",
      targetValue: 1,
      projectedDenominator: 1,
    })).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }));
  });

  it("preserves unknown baselines and rejects invalid targets and denominators", () => {
    const unknown = computeMetric("ctr_v1", [{ clicks: 0, impressions: 0 }]);
    expect(createMetricScenario(unknown, {
      label: "base",
      targetValue: 0.1,
      projectedDenominator: 100,
    })).toMatchObject({
      status: "unknown",
      absoluteDelta: null,
      relativeDelta: null,
      projectedNumerator: null,
      projectedNumeratorDelta: null,
    });
    for (const input of [
      { label: "base", targetValue: -1, projectedDenominator: 100 },
      { label: "base", targetValue: Number.NaN, projectedDenominator: 100 },
      { label: "base", targetValue: Number.POSITIVE_INFINITY, projectedDenominator: 100 },
      { label: "base", targetValue: 0.1, projectedDenominator: -1 },
      { label: "base", targetValue: 0.1, projectedDenominator: Number.NaN },
    ] as const) {
      expect(() => createMetricScenario(baseline, input)).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
      );
    }
  });
});

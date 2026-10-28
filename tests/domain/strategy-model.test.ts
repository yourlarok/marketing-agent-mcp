import { describe, expect, it } from "vitest";
import type { Recommendation, Task } from "../../src/domain/model.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  AFFECTED_STAGES,
  STRATEGY_PRIORITIES,
  validateRecommendationStrategy,
  validateTaskStrategy,
  type RecommendationExpectedMetric,
  type RecommendationImpact,
} from "../../src/domain/strategy-model.js";

const now = "2026-10-28T00:00:00.000Z";

function recommendation(overrides: Record<string, unknown> = {}): Recommendation {
  return {
    id: "recommendation-1",
    workspaceId: "workspace-1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    findingIds: ["finding-1"],
    hypothesis: "A clearer opening will improve qualified clicks.",
    affectedStage: "click",
    priority: "p1",
    expectedMetric: "ctr_v1",
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}): Task {
  return {
    id: "task-1",
    workspaceId: "workspace-1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    recommendationIds: ["recommendation-1"],
    assignee: "owner-1",
    dependencyIds: [],
    assetRequirements: [],
    acceptanceCriteria: ["The revised opening passes review."],
    state: "draft",
    ...overrides,
  };
}

function impact(overrides: Record<string, unknown> = {}): RecommendationImpact {
  return {
    formula: "sum(clicks) / sum(impressions)",
    baselineValue: 0.1,
    targetValue: 0.2,
    projectedDenominator: 1000,
    absoluteDelta: 0.1,
    relativeDelta: 1,
    projectedNumerator: 200,
    projectedNumeratorDelta: 100,
    assumptions: ["other_conditions_unchanged"],
    status: "ok",
    unknownReason: null,
    causality: "not_established",
    ...overrides,
  };
}

function expectInvalid(value: () => unknown): void {
  expect(value).toThrowError(
    expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
  );
}

describe("strategy recommendation contract", () => {
  it("keeps legacy recommendations without strategy fields readable", () => {
    expect(() => validateRecommendationStrategy(recommendation())).not.toThrow();
    expect(AFFECTED_STAGES).toEqual([
      "impression",
      "click",
      "engagement",
      "lead",
      "trial",
      "purchase",
      "retention",
    ]);
    expect(STRATEGY_PRIORITIES).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("accepts complete evidence, channel, node, metric, and impact references", () => {
    expect(() => validateRecommendationStrategy(recommendation({
      evidenceIds: ["evidence-1"],
      targetChannels: ["xiaohongshu"],
      analysisNodeRefs: [{ graphId: "graph-1", nodeId: "scenario-1" }],
      expectedMetrics: [{ metricId: "ctr_v1", acceptance: "reach_scenario_target", baselineMetricNodeId: "baseline-1", scenarioNodeId: "scenario-1" }],
      impacts: [impact()],
    }))).not.toThrow();
  });

  it.each(["graph 1", "graph/1", "graph:1", "9graph", "g".repeat(256)])(
    "accepts legacy persisted graph and node reference ID %j",
    (id) => {
      expect(() => validateRecommendationStrategy(recommendation({
        analysisNodeRefs: [{ graphId: id, nodeId: id }],
        expectedMetrics: [{
          metricId: "ctr_v1",
          acceptance: "reach_scenario_target",
          baselineMetricNodeId: id,
          scenarioNodeId: id,
        }],
      }))).not.toThrow();
    },
  );

  it.each(["__proto__", "prototype", "constructor"])("rejects prototype entity reference ID %s", (id) => {
    expectInvalid(() => validateRecommendationStrategy(recommendation({
      analysisNodeRefs: [{ graphId: id, nodeId: id }],
    })));
  });

  it.each([
    [{ metricId: "ctr_v1", acceptance: "reach_scenario_target" }],
    [{ metricId: "ctr_v1", acceptance: "reach_scenario_target", scenarioNodeId: "scenario-1" }],
    [{ metricId: "ctr_v1", acceptance: "reach_scenario_target", baselineMetricNodeId: "baseline-1" }],
    [{ metricId: "ctr_v1", acceptance: "establish_baseline", baselineMetricNodeId: "baseline-1" }],
    [{ metricId: "ctr_v1", acceptance: "establish_baseline", scenarioNodeId: "scenario-1" }],
    [{ metricId: "unknown_metric", acceptance: "establish_baseline" }],
  ] as RecommendationExpectedMetric[])("rejects invalid expected-metric combination %j", (expectedMetric) => {
    expectInvalid(() => validateRecommendationStrategy(recommendation({ expectedMetrics: [expectedMetric] })));
  });

  it("accepts both valid expected-metric acceptance shapes", () => {
    for (const expectedMetric of [
      { metricId: "ctr_v1", acceptance: "reach_scenario_target", baselineMetricNodeId: "baseline-1", scenarioNodeId: "scenario-1" },
      { metricId: "ctr_v1", acceptance: "establish_baseline" },
    ] as RecommendationExpectedMetric[]) {
      expect(() => validateRecommendationStrategy(recommendation({ expectedMetrics: [expectedMetric] }))).not.toThrow();
    }
  });

  it.each([
    "baselineValue",
    "targetValue",
    "projectedDenominator",
    "absoluteDelta",
    "relativeDelta",
    "projectedNumerator",
    "projectedNumeratorDelta",
  ])("rejects non-finite %s", (field) => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expectInvalid(() => validateRecommendationStrategy(recommendation({ impacts: [impact({ [field]: value })] })));
    }
  });

  it("requires catalog formulas, explicit unknown reasons, and no causal claim", () => {
    expectInvalid(() => validateRecommendationStrategy(recommendation({ impacts: [impact({ formula: "clicks / impressions" })] })));
    expectInvalid(() => validateRecommendationStrategy(recommendation({ impacts: [impact({ status: "unknown", unknownReason: null })] })));
    expectInvalid(() => validateRecommendationStrategy(recommendation({ impacts: [impact({ causality: "established" })] })));
  });

  it("allows nullable unknown and zero-baseline impact values when numeric values remain finite", () => {
    expect(() => validateRecommendationStrategy(recommendation({
      impacts: [impact({ baselineValue: null, absoluteDelta: null, relativeDelta: null, projectedNumeratorDelta: null, status: "unknown", unknownReason: "ZERO_DENOMINATOR" })],
    }))).not.toThrow();
    expect(() => validateRecommendationStrategy(recommendation({ impacts: [impact({ baselineValue: 0, relativeDelta: null })] }))).not.toThrow();
  });
});

describe("strategy task contract", () => {
  it("keeps legacy tasks without title, priority, rank, or rejection reason valid", () => {
    expect(() => validateTaskStrategy(task())).not.toThrow();
  });

  it.each([1, 2, Number.MAX_SAFE_INTEGER])("accepts positive safe-integer rank %s", (rank) => {
    expect(() => validateTaskStrategy(task({ title: "Rewrite opening", priority: "p0", rank }))).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid rank %s", (rank) => {
    expectInvalid(() => validateTaskStrategy(task({ rank })));
  });

  it("requires a non-empty rejection reason only in rejected state", () => {
    expect(() => validateTaskStrategy(task({ state: "rejected", rejectionReason: "Not actionable" }))).not.toThrow();
    expectInvalid(() => validateTaskStrategy(task({ state: "rejected" })));
    expectInvalid(() => validateTaskStrategy(task({ state: "rejected", rejectionReason: "  " })));
    expectInvalid(() => validateTaskStrategy(task({ state: "draft", rejectionReason: "Not actionable" })));
    expectInvalid(() => validateTaskStrategy(task({ state: "completed", rejectionReason: "Not actionable" })));
  });

  it("validates optional title and priority when supplied", () => {
    expectInvalid(() => validateTaskStrategy(task({ title: "" })));
    expectInvalid(() => validateTaskStrategy(task({ priority: "urgent" })));
  });
});

import type { Recommendation, Task } from "./model.js";
import {
  assertRecord,
  assertEntityReferenceId,
  invalid,
} from "./contract-validation.js";
import { METRIC_CATALOG, getMetricDefinition, type MetricId } from "./metric-catalog.js";
import { TASK_STATES } from "./model.js";

export const STRATEGY_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type StrategyPriority = (typeof STRATEGY_PRIORITIES)[number];

export const AFFECTED_STAGES = [
  "impression",
  "click",
  "engagement",
  "lead",
  "trial",
  "purchase",
  "retention",
] as const;
export type AffectedStage = (typeof AFFECTED_STAGES)[number];

export interface AnalysisNodeRef {
  graphId: string;
  nodeId: string;
}

export interface RecommendationExpectedMetric {
  metricId: MetricId;
  acceptance: "reach_scenario_target" | "establish_baseline";
  baselineMetricNodeId?: string;
  scenarioNodeId?: string;
}

export interface RecommendationImpact {
  formula: string;
  baselineValue: number | null;
  targetValue: number | null;
  projectedDenominator: number | null;
  absoluteDelta: number | null;
  relativeDelta: number | null;
  projectedNumerator: number | null;
  projectedNumeratorDelta: number | null;
  assumptions: string[];
  status: "ok" | "unknown";
  unknownReason: string | null;
  causality: "not_established";
}

function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${label} must be a non-empty string`);
  }
}

function assertStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) {
    invalid(`${label} must be a non-empty bounded array`);
  }
  for (const item of value) assertNonEmptyString(item, label);
  if (new Set(value).size !== value.length) invalid(`${label} must not contain duplicates`);
}

function validateExpectedMetric(metric: RecommendationExpectedMetric): void {
  assertRecord(metric, "Recommendation expected metric", [
    "metricId",
    "acceptance",
    "baselineMetricNodeId",
    "scenarioNodeId",
  ]);
  getMetricDefinition(metric.metricId);
  if (metric.acceptance === "reach_scenario_target") {
    if (metric.scenarioNodeId === undefined || metric.baselineMetricNodeId === undefined) {
      invalid("reach_scenario_target requires baselineMetricNodeId and scenarioNodeId");
    }
    assertEntityReferenceId(metric.scenarioNodeId, "Recommendation scenarioNodeId");
    assertEntityReferenceId(metric.baselineMetricNodeId, "Recommendation baselineMetricNodeId");
  } else if (metric.acceptance === "establish_baseline") {
    if (metric.baselineMetricNodeId !== undefined || metric.scenarioNodeId !== undefined) {
      invalid("establish_baseline forbids baselineMetricNodeId and scenarioNodeId");
    }
  } else {
    invalid("Recommendation expected-metric acceptance must be supported");
  }
}

function assertNullableFinite(value: unknown, label: string): void {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    invalid(`${label} must be finite or null`);
  }
}

function validateImpact(impact: RecommendationImpact): void {
  assertRecord(impact, "Recommendation impact", [
    "formula",
    "baselineValue",
    "targetValue",
    "projectedDenominator",
    "absoluteDelta",
    "relativeDelta",
    "projectedNumerator",
    "projectedNumeratorDelta",
    "assumptions",
    "status",
    "unknownReason",
    "causality",
  ]);
  if (!Object.values(METRIC_CATALOG).some((definition) => definition.formula === impact.formula)) {
    invalid("Recommendation impact formula must come from the controlled metric catalog");
  }
  for (const field of [
    "baselineValue",
    "targetValue",
    "projectedDenominator",
    "absoluteDelta",
    "relativeDelta",
    "projectedNumerator",
    "projectedNumeratorDelta",
  ] as const) {
    assertNullableFinite(impact[field], `Recommendation impact ${field}`);
  }
  if (!Array.isArray(impact.assumptions) || impact.assumptions.length > 1000) {
    invalid("Recommendation impact assumptions must be a bounded array");
  }
  for (const assumption of impact.assumptions) {
    assertNonEmptyString(assumption, "Recommendation impact assumptions");
  }
  if (impact.status !== "ok" && impact.status !== "unknown") invalid("Recommendation impact status must be supported");
  if (impact.status === "unknown") {
    assertNonEmptyString(impact.unknownReason, "Recommendation impact unknownReason");
  } else {
    if (impact.unknownReason !== null) invalid("Known recommendation impacts must have a null unknownReason");
    if ([
      impact.baselineValue,
      impact.targetValue,
      impact.projectedDenominator,
      impact.absoluteDelta,
      impact.projectedNumerator,
      impact.projectedNumeratorDelta,
    ].some((value) => value === null)) {
      invalid("Known recommendation impacts require finite baseline, target, and projection values");
    }
  }
  if (impact.causality !== "not_established") invalid("Recommendation impact causality must be not_established");
}

export function validateRecommendationStrategy(recommendation: Recommendation): void {
  if (recommendation.evidenceIds !== undefined) assertStringArray(recommendation.evidenceIds, "Recommendation evidenceIds");
  if (recommendation.targetChannels !== undefined) assertStringArray(recommendation.targetChannels, "Recommendation targetChannels");
  if (recommendation.analysisNodeRefs !== undefined) {
    if (!Array.isArray(recommendation.analysisNodeRefs) || recommendation.analysisNodeRefs.length === 0 ||
        recommendation.analysisNodeRefs.length > 1000) {
      invalid("Recommendation analysisNodeRefs must be a non-empty bounded array");
    }
    const references = new Set<string>();
    for (const reference of recommendation.analysisNodeRefs) {
      assertRecord(reference, "Recommendation analysis node reference", ["graphId", "nodeId"]);
      assertEntityReferenceId(reference.graphId, "Recommendation graphId");
      assertEntityReferenceId(reference.nodeId, "Recommendation nodeId");
      const key = JSON.stringify([reference.graphId, reference.nodeId]);
      if (references.has(key)) invalid("Recommendation analysisNodeRefs must not contain duplicates");
      references.add(key);
    }
  }
  if (recommendation.expectedMetrics !== undefined) {
    if (!Array.isArray(recommendation.expectedMetrics) || recommendation.expectedMetrics.length === 0 ||
        recommendation.expectedMetrics.length > 1000) {
      invalid("Recommendation expectedMetrics must be a non-empty bounded array");
    }
    for (const metric of recommendation.expectedMetrics) validateExpectedMetric(metric);
    if (new Set(recommendation.expectedMetrics.map((metric) => metric.metricId)).size !== recommendation.expectedMetrics.length) {
      invalid("Recommendation expected metric IDs must not contain duplicates");
    }
  }
  if (recommendation.impacts !== undefined) {
    if (!Array.isArray(recommendation.impacts) || recommendation.impacts.length === 0 ||
        recommendation.impacts.length > 1000) {
      invalid("Recommendation impacts must be a non-empty bounded array");
    }
    for (const impact of recommendation.impacts) validateImpact(impact);
  }
}

export function validateTaskStrategy(task: Task): void {
  if (task.title !== undefined) assertNonEmptyString(task.title, "Task title");
  if (task.priority !== undefined && !(STRATEGY_PRIORITIES as readonly string[]).includes(task.priority)) {
    invalid("Task priority must be supported");
  }
  if (task.rank !== undefined && (!Number.isSafeInteger(task.rank) || task.rank < 1)) {
    invalid("Task rank must be a positive safe integer");
  }
  if (!(TASK_STATES as readonly string[]).includes(task.state)) invalid("Task state must be supported");
  if (task.state === "rejected") {
    assertNonEmptyString(task.rejectionReason, "Task rejectionReason");
  } else if (task.rejectionReason !== undefined) {
    invalid("Task rejectionReason is only valid for rejected tasks");
  }
}

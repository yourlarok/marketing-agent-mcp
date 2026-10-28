import type { EntityRecord, JsonValue } from "../application/ports.js";
import { DomainError } from "./errors.js";
import type { MetricComputation } from "./metric-catalog.js";

export const ANALYSIS_NODE_KINDS = [
  "question",
  "research",
  "dataset",
  "metric",
  "analytics",
  "scenario",
  "monitor",
  "decision",
] as const;
export type AnalysisNodeKind = (typeof ANALYSIS_NODE_KINDS)[number];

export type AnalysisPayload = Record<string, JsonValue>;

export interface AnalysisGraphNode {
  id: string;
  kind: AnalysisNodeKind;
  payload: AnalysisPayload;
}

export interface AnalysisGraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface AnalysisRecommendedAction {
  tool: string;
  description: string;
  arguments?: AnalysisPayload;
  status?: "ready" | "requires_input";
  missingInputs?: string[];
}

export interface AnalysisGraph extends EntityRecord {
  id: string;
  workspaceId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  nodes: AnalysisGraphNode[];
  edges: AnalysisGraphEdge[];
  recommendedActions: AnalysisRecommendedAction[];
  parentGraphId: string | null;
  parentVersion: number | null;
  forkNodeId: string | null;
}

export interface CreateAnalysisGraphInput {
  id: string;
  workspaceId: string;
  createdAt: string;
  nodes?: AnalysisGraphNode[];
  edges?: AnalysisGraphEdge[];
  recommendedActions?: AnalysisRecommendedAction[];
}

export interface ExpandAnalysisGraphInput {
  expectedVersion: number;
  updatedAt: string;
  nodes: AnalysisGraphNode[];
  edges: AnalysisGraphEdge[];
  recommendedActions?: AnalysisRecommendedAction[];
}

export interface ForkAnalysisGraphInput {
  id: string;
  forkNodeId: string;
  createdAt: string;
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  }
  return value;
}

function cloneGraph(graph: AnalysisGraph): AnalysisGraph {
  return cloneJson(graph as unknown as JsonValue) as unknown as AnalysisGraph;
}

function requireId(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("INVALID_INPUT", `${label} must be a non-empty stable ID`);
  }
}

export function validateAnalysisGraph(graph: AnalysisGraph): void {
  requireId(graph.id, "Graph ID");
  requireId(graph.workspaceId, "Workspace ID");
  if (!Number.isInteger(graph.version) || graph.version < 1) {
    throw new DomainError("INVALID_INPUT", "Graph version must be a positive integer");
  }
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    requireId(node.id, "Node ID");
    if (nodeIds.has(node.id)) {
      throw new DomainError("INVALID_INPUT", `Duplicate node ID: ${node.id}`);
    }
    if (!(ANALYSIS_NODE_KINDS as readonly string[]).includes(node.kind)) {
      throw new DomainError("INVALID_INPUT", `Unsupported analysis node kind: ${String(node.kind)}`);
    }
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  const relationships = new Set<string>();
  for (const edge of graph.edges) {
    requireId(edge.id, "Edge ID");
    requireId(edge.fromNodeId, "Edge fromNodeId");
    requireId(edge.toNodeId, "Edge toNodeId");
    if (edgeIds.has(edge.id)) {
      throw new DomainError("INVALID_INPUT", `Duplicate edge ID: ${edge.id}`);
    }
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      throw new DomainError("INVALID_INPUT", `Edge has an orphan node reference: ${edge.id}`);
    }
    const relationship = JSON.stringify([edge.fromNodeId, edge.toNodeId]);
    if (relationships.has(relationship)) {
      throw new DomainError("INVALID_INPUT", "Duplicate directed node relationship");
    }
    edgeIds.add(edge.id);
    relationships.add(relationship);
  }

  const incomingCounts = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    incomingCounts.set(edge.toNodeId, incomingCounts.get(edge.toNodeId)! + 1);
    outgoing.set(edge.fromNodeId, [...outgoing.get(edge.fromNodeId) ?? [], edge.toNodeId]);
  }
  const queue = graph.nodes.filter((node) => incomingCounts.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]!;
    visited += 1;
    for (const target of outgoing.get(nodeId) ?? []) {
      const count = incomingCounts.get(target)! - 1;
      incomingCounts.set(target, count);
      if (count === 0) queue.push(target);
    }
  }
  if (visited !== graph.nodes.length) {
    throw new DomainError("INVALID_INPUT", "Analysis graph must be acyclic");
  }
}

export function createAnalysisGraph(input: CreateAnalysisGraphInput): AnalysisGraph {
  const graph: AnalysisGraph = {
    id: input.id,
    workspaceId: input.workspaceId,
    version: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    nodes: input.nodes ?? [],
    edges: input.edges ?? [],
    recommendedActions: input.recommendedActions ?? [],
    parentGraphId: null,
    parentVersion: null,
    forkNodeId: null,
  };
  validateAnalysisGraph(graph);
  return cloneGraph(graph);
}

export function expandAnalysisGraph(
  graph: AnalysisGraph,
  input: ExpandAnalysisGraphInput,
): AnalysisGraph {
  validateAnalysisGraph(graph);
  if (graph.version !== input.expectedVersion) {
    throw new DomainError("CONFLICT", "Analysis graph version does not match expectedVersion");
  }
  const expanded = cloneGraph(graph);
  expanded.nodes.push(...cloneJson(input.nodes as unknown as JsonValue) as unknown as AnalysisGraphNode[]);
  expanded.edges.push(...cloneJson(input.edges as unknown as JsonValue) as unknown as AnalysisGraphEdge[]);
  if (input.recommendedActions !== undefined) {
    expanded.recommendedActions = cloneJson(
      input.recommendedActions as unknown as JsonValue,
    ) as unknown as AnalysisRecommendedAction[];
  }
  expanded.version += 1;
  expanded.updatedAt = input.updatedAt;
  validateAnalysisGraph(expanded);
  return expanded;
}

export function forkAnalysisGraph(
  graph: AnalysisGraph,
  input: ForkAnalysisGraphInput,
): AnalysisGraph {
  validateAnalysisGraph(graph);
  requireId(input.id, "Fork graph ID");
  if (!graph.nodes.some((node) => node.id === input.forkNodeId)) {
    throw new DomainError("NOT_FOUND", `Fork node not found: ${input.forkNodeId}`);
  }
  const fork = cloneGraph(graph);
  fork.id = input.id;
  fork.version = 1;
  fork.createdAt = input.createdAt;
  fork.updatedAt = input.createdAt;
  fork.parentGraphId = graph.id;
  fork.parentVersion = graph.version;
  fork.forkNodeId = input.forkNodeId;
  return fork;
}

export const SCENARIO_LABELS = ["conservative", "base", "optimistic"] as const;
export type ScenarioLabel = (typeof SCENARIO_LABELS)[number];

export interface CreateMetricScenarioInput {
  label: ScenarioLabel;
  targetValue: number;
  projectedDenominator: number;
}

export interface MetricScenario {
  metricId: MetricComputation["metricId"];
  definitionVersion: number;
  status: "ok" | "unknown";
  label: ScenarioLabel;
  baselineValue: number | null;
  baselineNumerator: number | null;
  baselineDenominator: number | null;
  targetValue: number;
  projectedDenominator: number;
  absoluteDelta: number | null;
  relativeDelta: number | null;
  relativeDeltaUnknownReason: "ZERO_BASELINE" | "UNKNOWN_BASELINE" | null;
  projectedNumerator: number | null;
  projectedNumeratorDelta: number | null;
  assumptions: ["projected_denominator_fixed_for_projection", "other_conditions_unchanged"];
  sensitivity: string;
}

export function createMetricScenario(
  baseline: MetricComputation,
  input: CreateMetricScenarioInput,
): MetricScenario {
  if (!Number.isFinite(input.targetValue) || input.targetValue < 0) {
    throw new DomainError("INVALID_INPUT", "Scenario targetValue must be finite and non-negative");
  }
  if (!Number.isFinite(input.projectedDenominator) || input.projectedDenominator < 0) {
    throw new DomainError("INVALID_INPUT", "Scenario projectedDenominator must be finite and non-negative");
  }
  if (!(SCENARIO_LABELS as readonly string[]).includes(input.label)) {
    throw new DomainError("INVALID_INPUT", `Unsupported scenario label: ${String(input.label)}`);
  }

  const scenario: MetricScenario = {
    metricId: baseline.metricId,
    definitionVersion: baseline.definitionVersion,
    status: "unknown",
    label: input.label,
    baselineValue: baseline.value,
    baselineNumerator: baseline.numerator,
    baselineDenominator: baseline.denominator,
    targetValue: input.targetValue,
    projectedDenominator: input.projectedDenominator,
    absoluteDelta: null,
    relativeDelta: null,
    relativeDeltaUnknownReason: "UNKNOWN_BASELINE",
    projectedNumerator: null,
    projectedNumeratorDelta: null,
    assumptions: ["projected_denominator_fixed_for_projection", "other_conditions_unchanged"],
    sensitivity: "Conditional arithmetic uses the supplied projected denominator as fixed for this projection and holds other conditions constant. The projected numerator delta also reflects any difference between baseline and projected denominators; it does not promise improvement.",
  };
  if (baseline.status === "unknown" || baseline.value === null ||
      baseline.numerator === null || baseline.denominator === null) {
    return scenario;
  }

  const projectedNumerator = input.targetValue * input.projectedDenominator;
  const absoluteDelta = input.targetValue - baseline.value;
  const relativeDelta = baseline.value === 0 ? null : absoluteDelta / baseline.value;
  const projectedNumeratorDelta = projectedNumerator - baseline.numerator;
  if (![projectedNumerator, absoluteDelta, projectedNumeratorDelta].every(Number.isFinite) ||
      (relativeDelta !== null && !Number.isFinite(relativeDelta))) {
    throw new DomainError("INVALID_INPUT", "Scenario arithmetic must remain finite");
  }
  scenario.status = "ok";
  scenario.absoluteDelta = absoluteDelta;
  scenario.relativeDelta = relativeDelta;
  scenario.relativeDeltaUnknownReason = baseline.value === 0 ? "ZERO_BASELINE" : null;
  scenario.projectedNumerator = projectedNumerator;
  scenario.projectedNumeratorDelta = projectedNumeratorDelta;
  return scenario;
}

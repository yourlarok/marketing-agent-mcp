import { DomainError } from "../domain/errors.js";
import type {
  AnalysisGraph,
  AnalysisGraphNode,
} from "../domain/analysis-model.js";
import { getMetricDefinition } from "../domain/metric-catalog.js";
import type {
  Evidence,
  Finding,
  Recommendation,
  Task,
} from "../domain/model.js";
import { assertTaskDependencyGraph, assertTaskTransition } from "../domain/task-machine.js";
import {
  AFFECTED_STAGES,
  STRATEGY_PRIORITIES,
  validateRecommendationStrategy,
  validateTaskStrategy,
  type RecommendationExpectedMetric,
  type RecommendationImpact,
} from "../domain/strategy-model.js";
import {
  AuditableCommandPipeline,
  type Command,
  type CommandPipeline,
} from "./commands.js";
import type {
  Clock,
  IdGenerator,
  Repositories,
  Store,
} from "./ports.js";
import type {
  GenerateRecommendation,
  GetStrategyTask,
  ListStrategyTasks,
  RejectStrategyTask,
  ReorderStrategyTask,
  StrategyTaskCursor,
  StrategyTaskPage,
  StrategyTaskSummary,
  SupplementTask,
  UpdateStrategyTask,
} from "./strategy-commands.js";

const GENERATE_FIELDS = new Set([
  "id",
  "workspaceId",
  "findingIds",
  "hypothesis",
  "affectedStage",
  "targetChannels",
  "priority",
  "expectedMetrics",
  "analysisGraphId",
  "analysisNodeIds",
]);

const MUTABLE_TASK_FIELDS = [
  "recommendationIds",
  "title",
  "assignee",
  "priority",
  "dependencyIds",
  "assetRequirements",
  "acceptanceCriteria",
] as const;

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

function conflict(message: string): never {
  throw new DomainError("CONFLICT", message);
}

function assertAllowedFields(input: object, allowed: ReadonlySet<string>): void {
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) invalid(`Unsupported strategy input field: ${field}`);
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${field} must be a non-empty string`);
  }
}

function assertStringArray(
  value: unknown,
  field: string,
  options: { nonEmpty?: boolean; unique?: boolean } = {},
): asserts value is string[] {
  if (!Array.isArray(value) || (options.nonEmpty && value.length === 0)) {
    invalid(`${field} must be ${options.nonEmpty ? "a non-empty" : "an"} array`);
  }
  for (const item of value) assertNonEmptyString(item, field);
  if (options.unique && new Set(value).size !== value.length) {
    invalid(`${field} must not contain duplicates`);
  }
}

function assertExpectedVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid("expectedVersion must be a positive safe integer");
  }
}

async function requireWorkspace(repos: Repositories, workspaceId: string): Promise<void> {
  if (!await repos.workspaces.get(workspaceId, workspaceId)) {
    throw new DomainError("NOT_FOUND", "Workspace not found", false, { workspaceId });
  }
}

async function requireTask(repos: Repositories, workspaceId: string, id: string): Promise<Task> {
  const task = await repos.tasks.get(id, workspaceId);
  if (!task) {
    throw new DomainError("NOT_FOUND", "Task not found in workspace", false, {
      taskId: id,
      workspaceId,
    });
  }
  return task as Task;
}

function requireNode(graph: AnalysisGraph, nodeId: string): AnalysisGraphNode {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new DomainError("NOT_FOUND", "Analysis node not found in graph", false, {
      graphId: graph.id,
      nodeId,
    });
  }
  return node;
}

function nodeEvidenceIds(node: AnalysisGraphNode): string[] {
  const ids: string[] = [];
  for (const field of ["evidenceId", "evidenceIds"] as const) {
    const value = node.payload[field];
    if (value === undefined || value === null) continue;
    if (field === "evidenceId") {
      assertNonEmptyString(value, `Analysis node ${field}`);
      ids.push(value);
    } else {
      assertStringArray(value, `Analysis node ${field}`);
      ids.push(...value);
    }
  }
  return ids;
}

function nullableFinite(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${field} must be finite or null`);
  }
  return value;
}

function requiredFinite(value: unknown, field: string): number {
  const result = nullableFinite(value, field);
  if (result === null) invalid(`${field} must be finite`);
  return result;
}

function payloadMetricDefinition(
  payload: AnalysisGraphNode["payload"],
  expectedMetric: RecommendationExpectedMetric,
  label: string,
) {
  const definition = getMetricDefinition(expectedMetric.metricId);
  if (payload.metricId !== definition.id || payload.definitionVersion !== definition.version) {
    invalid(`${label} metric ID and definition must match the controlled catalog`);
  }
  return definition;
}

function scenarioImpact(
  expectedMetric: RecommendationExpectedMetric,
  baseline: AnalysisGraphNode,
  scenario: AnalysisGraphNode,
): RecommendationImpact {
  if (baseline.kind !== "metric" || scenario.kind !== "scenario") {
    invalid("reach_scenario_target requires a baseline Metric and Scenario node");
  }
  const definition = payloadMetricDefinition(baseline.payload, expectedMetric, "Baseline");
  payloadMetricDefinition(scenario.payload, expectedMetric, "Scenario");
  if (baseline.payload.formula !== definition.formula) {
    invalid("Baseline formula must match the controlled metric catalog");
  }
  if (scenario.payload.metricNodeId !== baseline.id) {
    invalid("Scenario must reference the stated baseline Metric node");
  }
  if (scenario.payload.status !== "ok" && scenario.payload.status !== "unknown") {
    invalid("Scenario status must be supported");
  }
  if (!Array.isArray(scenario.payload.assumptions) ||
      scenario.payload.assumptions.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    invalid("Scenario assumptions must be non-empty strings");
  }
  const status = scenario.payload.status;
  const assumptions = scenario.payload.assumptions as string[];
  const unknownReason = status === "unknown"
    ? scenario.payload.relativeDeltaUnknownReason ?? "UNKNOWN_BASELINE"
    : null;
  if (typeof unknownReason !== "string" && unknownReason !== null) {
    invalid("Scenario unknown reason must be explicit");
  }
  return {
    formula: definition.formula,
    baselineValue: nullableFinite(scenario.payload.baselineValue, "Scenario baselineValue"),
    targetValue: requiredFinite(scenario.payload.targetValue, "Scenario targetValue"),
    projectedDenominator: requiredFinite(scenario.payload.projectedDenominator, "Scenario projectedDenominator"),
    absoluteDelta: nullableFinite(scenario.payload.absoluteDelta, "Scenario absoluteDelta"),
    relativeDelta: nullableFinite(scenario.payload.relativeDelta, "Scenario relativeDelta"),
    projectedNumerator: nullableFinite(scenario.payload.projectedNumerator, "Scenario projectedNumerator"),
    projectedNumeratorDelta: nullableFinite(scenario.payload.projectedNumeratorDelta, "Scenario projectedNumeratorDelta"),
    assumptions: [...assumptions],
    status,
    unknownReason,
    causality: "not_established",
  };
}

function baselineImpact(expectedMetric: RecommendationExpectedMetric): RecommendationImpact {
  return {
    formula: getMetricDefinition(expectedMetric.metricId).formula,
    baselineValue: null,
    targetValue: null,
    projectedDenominator: null,
    absoluteDelta: null,
    relativeDelta: null,
    projectedNumerator: null,
    projectedNumeratorDelta: null,
    assumptions: [],
    status: "unknown",
    unknownReason: "BASELINE_NOT_COMPUTED",
    causality: "not_established",
  };
}

function assertTaskCollections(task: Task): void {
  assertStringArray(task.recommendationIds, "recommendationIds", { nonEmpty: true, unique: true });
  assertNonEmptyString(task.assignee, "assignee");
  assertStringArray(task.dependencyIds, "dependencyIds", { unique: true });
  assertStringArray(task.assetRequirements, "assetRequirements");
  assertStringArray(task.acceptanceCriteria, "acceptanceCriteria", { nonEmpty: true });
}

async function validateTaskAndWorkspaceGraph(repos: Repositories, candidate: Task): Promise<void> {
  assertTaskCollections(candidate);
  validateTaskStrategy(candidate);
  for (const recommendationId of candidate.recommendationIds) {
    if (!await repos.recommendations.get(recommendationId, candidate.workspaceId)) {
      throw new DomainError("NOT_FOUND", "Recommendation not found in workspace", false, {
        recommendationId,
        workspaceId: candidate.workspaceId,
      });
    }
  }
  const persisted = await repos.tasks.list(candidate.workspaceId) as Task[];
  const tasks = new Map(persisted.map((task) => [task.id, task]));
  tasks.set(candidate.id, candidate);
  for (const task of tasks.values()) {
    for (const dependencyId of task.dependencyIds) {
      if (!tasks.has(dependencyId)) {
        throw new DomainError("NOT_FOUND", "Task dependency not found in workspace", false, {
          taskId: task.id,
          dependencyId,
        });
      }
    }
  }
  assertTaskDependencyGraph(tasks.values());
}

function assertMutable(task: Task): void {
  if (task.state === "completed" || task.state === "rejected") {
    conflict(`Task in ${task.state} state is terminal`);
  }
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTasks(left: Task, right: Task): number {
  if (left.rank !== undefined && right.rank !== undefined && left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  if (left.rank !== undefined && right.rank === undefined) return -1;
  if (left.rank === undefined && right.rank !== undefined) return 1;
  return compareIds(left.id, right.id);
}

function isAfterCursor(task: Task, cursor: StrategyTaskCursor): boolean {
  if (cursor.rank !== null) {
    if (task.rank === undefined) return true;
    return task.rank > cursor.rank || (task.rank === cursor.rank && compareIds(task.id, cursor.id) > 0);
  }
  return task.rank === undefined && compareIds(task.id, cursor.id) > 0;
}

export class StrategyService {
  private readonly commands: CommandPipeline;

  constructor(
    private readonly store: Store,
    clock: Clock,
    ids: IdGenerator,
  ) {
    this.commands = new AuditableCommandPipeline(store, clock, ids);
  }

  generateRecommendation(command: Command<GenerateRecommendation>): Promise<Recommendation> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "strategy.recommendation.generate",
      entityType: "recommendation",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        assertAllowedFields(input, GENERATE_FIELDS);
        assertStringArray(input.findingIds, "findingIds", { nonEmpty: true, unique: true });
        assertNonEmptyString(input.hypothesis, "hypothesis");
        assertStringArray(input.targetChannels, "targetChannels", { nonEmpty: true, unique: true });
        if (!(AFFECTED_STAGES as readonly string[]).includes(input.affectedStage)) {
          invalid("affectedStage must be supported");
        }
        if (!(STRATEGY_PRIORITIES as readonly string[]).includes(input.priority)) {
          invalid("priority must be supported");
        }
        if (input.analysisNodeIds !== undefined) {
          assertStringArray(input.analysisNodeIds, "analysisNodeIds", { unique: true });
        }
        if (!Array.isArray(input.expectedMetrics)) {
          invalid("expectedMetrics must be a non-empty array");
        }
        validateRecommendationStrategy({
          id: input.id,
          workspaceId: input.workspaceId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          findingIds: input.findingIds,
          hypothesis: input.hypothesis,
          affectedStage: input.affectedStage,
          priority: input.priority,
          expectedMetric: "pending",
          targetChannels: input.targetChannels,
          expectedMetrics: input.expectedMetrics,
        });
        const needsGraph = (input.analysisNodeIds?.length ?? 0) > 0 ||
          input.expectedMetrics.some((metric) => metric.acceptance === "reach_scenario_target");
        if (needsGraph && input.analysisGraphId === undefined) {
          invalid("analysisGraphId is required when analysis nodes are referenced");
        }
        if (input.analysisGraphId !== undefined) assertNonEmptyString(input.analysisGraphId, "analysisGraphId");
        await requireWorkspace(repos, input.workspaceId);

        const findings: Finding[] = [];
        for (const findingId of input.findingIds) {
          const finding = await repos.findings.get(findingId, input.workspaceId) as Finding | undefined;
          if (!finding) {
            throw new DomainError("NOT_FOUND", "Finding not found in workspace", false, {
              findingId,
              workspaceId: input.workspaceId,
            });
          }
          findings.push(finding);
        }
        const graph = input.analysisGraphId === undefined ? undefined
          : await repos.analysisGraphs.get(input.analysisGraphId, input.workspaceId);
        if (input.analysisGraphId !== undefined && !graph) {
          throw new DomainError("NOT_FOUND", "Analysis graph not found in workspace", false, {
            graphId: input.analysisGraphId,
            workspaceId: input.workspaceId,
          });
        }
        const selectedNodeIds = [...input.analysisNodeIds ?? []];
        for (const metric of input.expectedMetrics) {
          if (metric.baselineMetricNodeId !== undefined) selectedNodeIds.push(metric.baselineMetricNodeId);
          if (metric.scenarioNodeId !== undefined) selectedNodeIds.push(metric.scenarioNodeId);
        }
        const uniqueNodeIds = [...new Set(selectedNodeIds)];
        const selectedNodes = uniqueNodeIds.map((nodeId) => requireNode(graph!, nodeId));
        const evidenceIds = [...new Set([
          ...findings.flatMap((finding) => finding.evidenceIds),
          ...selectedNodes.flatMap(nodeEvidenceIds),
        ])];
        const evidenceRecords: Evidence[] = [];
        for (const evidenceId of evidenceIds) {
          const evidence = await repos.evidence.get(evidenceId, input.workspaceId) as Evidence | undefined;
          if (!evidence) {
            throw new DomainError("NOT_FOUND", "Evidence not found in workspace", false, {
              evidenceId,
              workspaceId: input.workspaceId,
            });
          }
          evidenceRecords.push(evidence);
        }
        if (input.expectedMetrics.some((metric) => metric.metricId === "conversion_rate_v1")) {
          for (const evidence of evidenceRecords) {
            const source = await repos.sources.get(evidence.sourceId, input.workspaceId);
            if (!source) {
              throw new DomainError("NOT_FOUND", "Evidence Source not found in workspace", false, {
                sourceId: evidence.sourceId,
                workspaceId: input.workspaceId,
              });
            }
            if (source.ownership === "external_public") {
              invalid("External public interactions cannot support an owned conversion recommendation");
            }
          }
        }
        const impacts = input.expectedMetrics.map((metric) => {
          if (metric.acceptance === "establish_baseline") return baselineImpact(metric);
          return scenarioImpact(
            metric,
            requireNode(graph!, metric.baselineMetricNodeId!),
            requireNode(graph!, metric.scenarioNodeId!),
          );
        });
        const recommendation: Recommendation = {
          id: input.id,
          workspaceId: input.workspaceId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          findingIds: [...input.findingIds],
          hypothesis: input.hypothesis,
          affectedStage: input.affectedStage,
          priority: input.priority,
          expectedMetric: input.expectedMetrics.map((metric) => metric.metricId).join(","),
          evidenceIds,
          targetChannels: [...input.targetChannels],
          ...(uniqueNodeIds.length === 0 ? {} : {
            analysisNodeRefs: uniqueNodeIds.map((nodeId) => ({ graphId: graph!.id, nodeId })),
          }),
          expectedMetrics: input.expectedMetrics.map((metric) => ({ ...metric })),
          impacts,
        };
        validateRecommendationStrategy(recommendation);
        return repos.recommendations.insert(recommendation) as Promise<Recommendation>;
      },
    });
  }

  supplementTask(command: Command<SupplementTask>): Promise<Task> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "strategy.task.supplement",
      entityType: "task",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        await requireWorkspace(repos, input.workspaceId);
        const task: Task = {
          id: input.id,
          workspaceId: input.workspaceId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          recommendationIds: input.recommendationIds,
          title: input.title,
          assignee: input.assignee,
          priority: input.priority,
          rank: input.rank,
          dependencyIds: input.dependencyIds,
          assetRequirements: input.assetRequirements,
          acceptanceCriteria: input.acceptanceCriteria,
          state: "draft",
        };
        await validateTaskAndWorkspaceGraph(repos, task);
        return repos.tasks.insert(task) as Promise<Task>;
      },
    });
  }

  updateStrategyTask(command: Command<UpdateStrategyTask>): Promise<Task> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "strategy.task.update",
      entityType: "task",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        assertExpectedVersion(input.expectedVersion);
        if (!MUTABLE_TASK_FIELDS.some((field) => input[field] !== undefined)) {
          invalid("At least one mutable Task field is required");
        }
        const current = await requireTask(repos, input.workspaceId, input.id);
        assertMutable(current);
        const updated: Task = { ...current, updatedAt: timestamp };
        for (const field of MUTABLE_TASK_FIELDS) {
          const value = input[field];
          if (value !== undefined) {
            (updated as Record<string, unknown>)[field] = Array.isArray(value) ? [...value] : value;
          }
        }
        await validateTaskAndWorkspaceGraph(repos, updated);
        return repos.tasks.update(updated, input.expectedVersion) as Promise<Task>;
      },
    });
  }

  rejectStrategyTask(command: Command<RejectStrategyTask>): Promise<Task> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "strategy.task.reject",
      entityType: "task",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        assertExpectedVersion(input.expectedVersion);
        assertNonEmptyString(input.reason, "reason");
        const current = await requireTask(repos, input.workspaceId, input.id);
        assertTaskTransition(current.state, "rejected");
        const rejected: Task = {
          ...current,
          state: "rejected",
          rejectionReason: input.reason,
          updatedAt: timestamp,
        };
        await validateTaskAndWorkspaceGraph(repos, rejected);
        return repos.tasks.update(rejected, input.expectedVersion) as Promise<Task>;
      },
    });
  }

  reorderStrategyTask(command: Command<ReorderStrategyTask>): Promise<Task> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "strategy.task.reorder",
      entityType: "task",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        assertExpectedVersion(input.expectedVersion);
        const current = await requireTask(repos, input.workspaceId, input.id);
        assertMutable(current);
        const reordered: Task = { ...current, rank: input.rank, updatedAt: timestamp };
        await validateTaskAndWorkspaceGraph(repos, reordered);
        return repos.tasks.update(reordered, input.expectedVersion) as Promise<Task>;
      },
    });
  }

  getStrategyTask(query: GetStrategyTask): Promise<Task> {
    return this.store.transaction(async (repos) => {
      assertNonEmptyString(query.id, "id");
      assertNonEmptyString(query.workspaceId, "workspaceId");
      return requireTask(repos, query.workspaceId, query.id);
    });
  }

  listStrategyTasks(query: ListStrategyTasks): Promise<StrategyTaskPage> {
    return this.store.transaction(async (repos) => {
      assertNonEmptyString(query.workspaceId, "workspaceId");
      const limit = query.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
        invalid("limit must be a positive integer no greater than 20");
      }
      if (query.cursor !== undefined) {
        assertNonEmptyString(query.cursor.id, "cursor.id");
        if (query.cursor.rank !== null &&
            (!Number.isSafeInteger(query.cursor.rank) || query.cursor.rank < 1)) {
          invalid("cursor.rank must be null or a positive safe integer");
        }
      }
      const tasks = (await repos.tasks.list(query.workspaceId) as Task[])
        .sort(compareTasks)
        .filter((task) => query.cursor === undefined || isAfterCursor(task, query.cursor));
      const page = tasks.slice(0, limit);
      const summaries: StrategyTaskSummary[] = page.map((task) => ({
        id: task.id,
        version: task.version,
        title: task.title ?? null,
        assignee: task.assignee,
        priority: task.priority ?? null,
        rank: task.rank ?? null,
        state: task.state,
        updatedAt: task.updatedAt,
      }));
      const last = page.at(-1);
      return {
        tasks: summaries,
        nextCursor: tasks.length > limit && last
          ? { rank: last.rank ?? null, id: last.id }
          : null,
      };
    });
  }
}

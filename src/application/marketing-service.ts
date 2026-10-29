import { DomainError } from "../domain/errors.js";
import type { AnalysisGraph } from "../domain/analysis-model.js";
import {
  CAPABILITY_ADAPTER_KINDS,
  CAPABILITY_STATES,
  EVIDENCE_CLASSIFICATIONS,
  FINDING_KINDS,
  SOURCE_OWNERSHIPS,
  SOURCE_TYPES,
  TASK_STATES,
  type CapabilityAdapterKind,
  type CapabilityState,
  type Dataset,
  type Evidence,
  type Finding,
  type Recommendation,
  type Source,
  type Task,
  type ToolCapability,
  type ToolHealthEvidence,
  type Workspace,
} from "../domain/model.js";
import {
  assertTaskDependencyGraph,
  assertTaskTransition,
} from "../domain/task-machine.js";
import { analysisGraphReferenceIds, assertUtcInstant } from "../infrastructure/sqlite.js";
import {
  AuditableCommandPipeline,
  type Command,
  type CommandPipeline,
  type CreateRecommendation,
  type CreateTask,
  type CreateWorkspace,
  type RecordCapabilityHealth,
  type RecordEvidence,
  type RecordFinding,
  type RegisterCapability,
  type RegisterDataset,
  type RegisterSource,
  type TransitionTask,
} from "./commands.js";
import type {
  Clock,
  EntityRecord,
  EntityRef,
  EntityRepository,
  IdGenerator,
  Lineage,
  LineageEdge,
  LineageEntityType,
  LineageNode,
  Repositories,
  Store,
} from "./ports.js";

const MAX_LINEAGE_ENTITIES = 1_000;

export interface CapabilityQuery {
  workspaceId: string;
  adapterKind?: CapabilityAdapterKind;
  state?: CapabilityState;
}

const lineageEntityTypes: Record<LineageEntityType, keyof Repositories> = {
  source: "sources",
  dataset: "datasets",
  evidence: "evidence",
  finding: "findings",
  recommendation: "recommendations",
  task: "tasks",
  data_request_plan: "dataRequestPlans",
  ingestion_batch: "ingestionBatches",
  research_session: "researchSessions",
  competitor: "competitors",
  competitor_diff: "competitorDiffs",
  analysis_graph: "analysisGraphs",
  dashboard: "dashboards",
  benchmark_analysis: "benchmarkAnalyses",
  content_brief: "contentBriefs",
  asset_version: "assetVersions",
};

function lineageReferences(record: EntityRecord, entityType: LineageEntityType): EntityRef[] {
  if (entityType === "analysis_graph") {
    try {
      const graph = record as unknown as AnalysisGraph;
      const ids = analysisGraphReferenceIds(graph);
      const references: EntityRef[] = [
        ...ids.datasetIds.map((id) => ({ entityType: "dataset" as const, id })),
        ...ids.evidenceIds.map((id) => ({ entityType: "evidence" as const, id })),
      ];
      if (graph.parentGraphId !== null) {
        if (typeof graph.parentGraphId !== "string" || graph.parentGraphId.trim().length === 0) {
          throw new TypeError("Invalid parent graph reference");
        }
        references.push({ entityType: "analysis_graph", id: graph.parentGraphId });
      }
      return references;
    } catch {
      throw new DomainError("NOT_FOUND", "Lineage reference is invalid", false, {
        entityType,
        id: record.id,
      });
    }
  }
  if (entityType === "benchmark_analysis" || entityType === "content_brief" || entityType === "asset_version") {
    const fail = (): never => {
      throw new DomainError("NOT_FOUND", "Lineage reference is invalid", false, {
        entityType,
        id: record.id,
      });
    };
    const references: EntityRef[] = [];
    const addIds = (key: string, referencedType: EntityRef["entityType"]) => {
      const ids = record[key];
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.trim().length === 0)) {
        fail();
      }
      references.push(...(ids as string[]).map((id) => ({ entityType: referencedType, id })));
    };
    const addScalar = (key: string, referencedType: EntityRef["entityType"], nullable = false) => {
      const id = record[key];
      if (nullable && id === null) return;
      if (typeof id !== "string" || id.trim().length === 0) fail();
      references.push({ entityType: referencedType, id: id as string });
    };
    if (entityType === "benchmark_analysis") {
      addIds("evidenceIds", "evidence");
      addScalar("competitorDiffId", "competitor_diff", true);
    } else if (entityType === "content_brief") {
      addScalar("taskId", "task");
      addScalar("recommendationId", "recommendation");
      addScalar("benchmarkAnalysisId", "benchmark_analysis");
      addIds("findingIds", "finding");
      addIds("evidenceIds", "evidence");
    } else {
      addScalar("taskId", "task");
      addScalar("recommendationId", "recommendation");
      addScalar("briefId", "content_brief");
      addScalar("parentVersionId", "asset_version", true);
      addIds("evidenceIds", "evidence");
    }
    const sourceVersions = record.sourceVersions;
    if (!Array.isArray(sourceVersions)) fail();
    for (const reference of sourceVersions as unknown[]) {
      if (reference === null || typeof reference !== "object" || Array.isArray(reference)) fail();
      const sourceReference = reference as { entityType?: unknown; id?: unknown };
      if (sourceReference.entityType === "source") {
        if (typeof sourceReference.id !== "string" || sourceReference.id.trim().length === 0) fail();
        references.push({ entityType: "source", id: sourceReference.id as string });
      }
    }
    if (entityType === "benchmark_analysis") {
      if (!Array.isArray(record.methods)) fail();
      for (const method of record.methods as { evidenceAssetRefs?: { sourceId?: unknown }[] }[]) {
        const assetRefs = method.evidenceAssetRefs;
        if (!Array.isArray(assetRefs)) fail();
        for (const reference of assetRefs as { sourceId?: unknown }[]) {
          const sourceId = reference.sourceId;
          if (typeof sourceId !== "string" || sourceId.trim().length === 0) fail();
          references.push({ entityType: "source", id: sourceId as string });
        }
      }
    }
    if (entityType === "asset_version") {
      if (!Array.isArray(record.sourceMaterials)) fail();
      for (const material of record.sourceMaterials as { role?: unknown; source?: { sourceId?: unknown } }[]) {
        if (material.role === "source") {
          const sourceId = material.source?.sourceId;
          if (typeof sourceId !== "string" || sourceId.trim().length === 0) fail();
          references.push({ entityType: "source", id: sourceId as string });
        }
      }
    }
    const seen = new Set<string>();
    return references.filter((reference) => {
      const key = JSON.stringify([reference.entityType, reference.id]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (entityType === "dataset" || entityType === "evidence") {
    if (typeof record.sourceId !== "string") {
      throw new DomainError("NOT_FOUND", "Lineage reference is invalid", false, {
        entityType,
        id: record.id,
      });
    }
    return [{ entityType: "source", id: record.sourceId }];
  }
  if (entityType === "source" || entityType === "data_request_plan") {
    return [];
  }
  const reference = {
    finding: [["evidenceIds", "evidence"]],
    recommendation: [["findingIds", "finding"]],
    task: [["recommendationIds", "recommendation"]],
    ingestion_batch: [
      ["sourceIds", "source"],
      ["datasetIds", "dataset"],
      ["evidenceIds", "evidence"],
    ],
    research_session: [["evidenceIds", "evidence"]],
    competitor: [["evidenceIds", "evidence"]],
    competitor_diff: [["findingIds", "finding"]],
    dashboard: [
      ["sourceIds", "source"],
      ["datasetIds", "dataset"],
      ["evidenceIds", "evidence"],
      ["graphIds", "analysis_graph"],
      ["competitorDiffIds", "competitor_diff"],
      ["taskIds", "task"],
    ],
  } as const;
  const references: EntityRef[] = [];
  for (const [key, referencedType] of reference[entityType]) {
    const ids = record[key];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new DomainError("NOT_FOUND", "Lineage reference is invalid", false, {
        entityType,
        id: record.id,
      });
    }
    references.push(...ids.map((id) => ({ entityType: referencedType, id })));
  }
  if (entityType === "task") {
    const dependencyIds = record.dependencyIds;
    if (
      !Array.isArray(dependencyIds) ||
      dependencyIds.some((id) => typeof id !== "string")
    ) {
      throw new DomainError("NOT_FOUND", "Lineage reference is invalid", false, {
        entityType,
        id: record.id,
      });
    }
    references.push(
      ...dependencyIds.map((id) => ({ entityType: "task" as const, id })),
    );
  }
  if (entityType === "recommendation") {
    const evidenceIds = record.evidenceIds;
    const analysisNodeRefs = record.analysisNodeRefs;
    if ((evidenceIds !== undefined &&
        (!Array.isArray(evidenceIds) || evidenceIds.some((id) => typeof id !== "string"))) ||
        (analysisNodeRefs !== undefined &&
        (!Array.isArray(analysisNodeRefs) || analysisNodeRefs.some((reference) =>
          reference === null || typeof reference !== "object" || Array.isArray(reference) ||
          typeof reference.graphId !== "string" || typeof reference.nodeId !== "string")))) {
      throw new DomainError("NOT_FOUND", "Lineage reference is invalid", false, {
        entityType,
        id: record.id,
      });
    }
    references.push(
      ...(evidenceIds ?? []).map((id) => ({ entityType: "evidence" as const, id })),
      ...(analysisNodeRefs ?? []).map((reference) => ({
        entityType: "analysis_graph" as const,
        id: reference.graphId,
      })),
    );
  }
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = JSON.stringify([reference.entityType, reference.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function requireWorkspace(
  repos: Repositories,
  workspaceId: string,
): Promise<void> {
  const workspace = await repos.workspaces.get(workspaceId, workspaceId);
  if (!workspace) {
    throw new DomainError("NOT_FOUND", "Workspace not found", false, { workspaceId });
  }
}

async function requireSource(
  repos: Repositories,
  workspaceId: string,
  sourceId: string,
): Promise<Source> {
  const source = await repos.sources.get(sourceId, workspaceId);
  if (!source) {
    throw new DomainError("NOT_FOUND", "Source not found in workspace", false, {
      sourceId,
      workspaceId,
    });
  }
  return source as Source;
}

function assertUtcInput(value: string, field: string): void {
  try {
    assertUtcInstant(value);
  } catch {
    throw new DomainError(
      "INVALID_INPUT",
      `${field} must be a valid UTC ISO-8601 instant`,
    );
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("INVALID_INPUT", `${field} must not be empty`);
  }
}

function assertToolHealthInput(
  value: unknown,
): asserts value is ToolHealthEvidence | undefined {
  if (value === undefined) {
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_INPUT", "toolHealth must be a structured health check");
  }
  const health = value as Record<string, unknown>;
  if (health.purpose !== "tool_health") {
    throw new DomainError("INVALID_INPUT", "toolHealth purpose must be tool_health");
  }
  assertNonEmptyString(health.capabilityId, "toolHealth.capabilityId");
  if (typeof health.healthy !== "boolean") {
    throw new DomainError("INVALID_INPUT", "toolHealth.healthy must be a boolean");
  }
  assertNonEmptyString(health.checkedAt, "toolHealth.checkedAt");
  assertUtcInput(health.checkedAt, "toolHealth.checkedAt");
  assertNonEmptyString(health.toolVersion, "toolHealth.toolVersion");
}

function assertStringArray(
  value: unknown,
  field: string,
  options: { nonEmpty?: boolean; unique?: boolean } = {},
): void {
  if (
    !Array.isArray(value) ||
    (options.nonEmpty && value.length === 0)
  ) {
    throw new DomainError(
      "INVALID_INPUT",
      `${field} must be ${options.nonEmpty ? "a non-empty" : "an"} array of non-empty strings`,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new DomainError(
        "INVALID_INPUT",
        `${field} must be ${options.nonEmpty ? "a non-empty" : "an"} array of non-empty strings`,
      );
    }
  }
  if (options.unique && new Set(value).size !== value.length) {
    throw new DomainError("INVALID_INPUT", `${field} must not contain duplicates`);
  }
}

async function requireTask(
  repos: Repositories,
  workspaceId: string,
  taskId: string,
): Promise<Task> {
  const task = await repos.tasks.get(taskId, workspaceId);
  if (!task) {
    throw new DomainError("NOT_FOUND", "Task not found in workspace", false, {
      taskId,
      workspaceId,
    });
  }
  return task as Task;
}

async function assertWorkspaceDependencyGraph(
  repos: Repositories,
  candidate: Pick<Task, "id" | "workspaceId" | "dependencyIds">,
): Promise<void> {
  const nodes = new Map<string, Pick<Task, "id" | "dependencyIds">>([
    [candidate.id, candidate],
  ]);
  const load = async (taskId: string): Promise<void> => {
    if (nodes.has(taskId)) {
      return;
    }
    const task = await requireTask(repos, candidate.workspaceId, taskId);
    nodes.set(task.id, task);
    for (const dependencyId of task.dependencyIds) {
      await load(dependencyId);
    }
  };
  for (const dependencyId of candidate.dependencyIds) {
    await load(dependencyId);
  }
  assertTaskDependencyGraph(nodes.values());
}

export class MarketingService {
  private readonly commands: CommandPipeline;

  constructor(
    private readonly store: Store,
    clock: Clock,
    ids: IdGenerator,
  ) {
    this.commands = new AuditableCommandPipeline(store, clock, ids);
  }

  createWorkspace(command: Command<CreateWorkspace>): Promise<Workspace> {
    return this.commands.execute({
      workspaceId: command.input.id,
      action: "workspace.create",
      entityType: "workspace",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        const workspace: Workspace = {
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          id: input.id,
          workspaceId: input.id,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          name: input.name,
        };
        return repos.workspaces.insert(workspace) as Promise<Workspace>;
      },
    });
  }

  registerSource(command: Command<RegisterSource>): Promise<Source> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "source.register",
      entityType: "source",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        if (!(SOURCE_TYPES as readonly string[]).includes(input.type)) {
          throw new DomainError("INVALID_INPUT", "type must be a supported source type");
        }
        if (!(SOURCE_OWNERSHIPS as readonly string[]).includes(input.ownership)) {
          throw new DomainError(
            "INVALID_INPUT",
            "ownership must be a supported source ownership",
          );
        }
        await requireWorkspace(repos, input.workspaceId);
        const source: Source = {
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          id: input.id,
          workspaceId: input.workspaceId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          name: input.name,
          type: input.type,
          ownership: input.ownership,
        };
        return repos.sources.insert(source) as Promise<Source>;
      },
    });
  }

  registerDataset(command: Command<RegisterDataset>): Promise<Dataset> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "dataset.register",
      entityType: "dataset",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        await requireSource(repos, input.workspaceId, input.sourceId);
        assertUtcInput(input.coverageStart, "coverageStart");
        assertUtcInput(input.coverageEnd, "coverageEnd");
        if (Date.parse(input.coverageStart) > Date.parse(input.coverageEnd)) {
          throw new DomainError(
            "INVALID_INPUT",
            "coverageStart must not be after coverageEnd",
          );
        }
        const dataset: Dataset = {
          id: input.id,
          workspaceId: input.workspaceId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          sourceId: input.sourceId,
          name: input.name,
          coverageStart: input.coverageStart,
          coverageEnd: input.coverageEnd,
          fieldDefinitions: input.fieldDefinitions,
          metricDefinitions: input.metricDefinitions,
          limitations: input.limitations,
        };
        return repos.datasets.insert(dataset) as Promise<Dataset>;
      },
    });
  }

  recordEvidence(command: Command<RecordEvidence>): Promise<Evidence> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "evidence.record",
      entityType: "evidence",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        const source = await requireSource(repos, input.workspaceId, input.sourceId);
        if (
          !(EVIDENCE_CLASSIFICATIONS as readonly string[]).includes(
            input.classification,
          )
        ) {
          throw new DomainError(
            "INVALID_INPUT",
            "classification must be a supported evidence classification",
          );
        }
        if (
          typeof input.sourceLocator !== "string" ||
          input.sourceLocator.trim().length === 0
        ) {
          throw new DomainError(
            "INVALID_INPUT",
            "sourceLocator must not be empty",
          );
        }
        if (typeof input.summary !== "string" || input.summary.trim().length === 0) {
          throw new DomainError("INVALID_INPUT", "summary must not be empty");
        }
        assertUtcInput(input.observedAt, "observedAt");
        assertToolHealthInput(input.toolHealth);
        if (!/^[0-9a-f]{64}$/i.test(input.contentHash)) {
          throw new DomainError(
            "INVALID_INPUT",
            "contentHash must be a SHA-256 hexadecimal hash",
          );
        }
        if (
          input.classification !== "external_observation" &&
          source.ownership === "external_public"
        ) {
          throw new DomainError(
            "INVALID_INPUT",
            "Owned facts require an owned or authorized source",
          );
        }
        const evidence: Evidence = {
          id: input.id,
          workspaceId: input.workspaceId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          sourceId: input.sourceId,
          sourceLocator: input.sourceLocator,
          observedAt: input.observedAt,
          summary: input.summary,
          contentHash: input.contentHash,
          classification: input.classification,
          ...(input.toolHealth === undefined ? {} : { toolHealth: input.toolHealth }),
        };
        return repos.evidence.insert(evidence) as Promise<Evidence>;
      },
    });
  }

  recordFinding(command: Command<RecordFinding>): Promise<Finding> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "finding.record",
      entityType: "finding",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        if (typeof input.statement !== "string" || input.statement.trim().length === 0) {
          throw new DomainError("INVALID_INPUT", "statement must not be empty");
        }
        if (!Array.isArray(input.evidenceIds)) {
          throw new DomainError(
            "INVALID_INPUT",
            "evidenceIds must be an array of non-empty strings",
          );
        }
        for (let index = 0; index < input.evidenceIds.length; index += 1) {
          const evidenceId = input.evidenceIds[index];
          if (typeof evidenceId !== "string" || evidenceId.trim().length === 0) {
            throw new DomainError(
              "INVALID_INPUT",
              "evidenceIds must be an array of non-empty strings",
            );
          }
        }
        if (new Set(input.evidenceIds).size !== input.evidenceIds.length) {
          throw new DomainError(
            "INVALID_INPUT",
            "evidenceIds must not contain duplicates",
          );
        }
        if (!(FINDING_KINDS as readonly string[]).includes(input.kind)) {
          throw new DomainError("INVALID_INPUT", "kind must be a supported finding kind");
        }
        if (
          (input.kind === "fact" || input.kind === "inference") &&
          input.evidenceIds.length === 0
        ) {
          throw new DomainError(
            "INVALID_INPUT",
            "Facts and inferences require supporting evidence",
          );
        }
        if (
          input.kind === "inference" &&
          (typeof input.limitations !== "string" ||
            input.limitations.trim().length === 0)
        ) {
          throw new DomainError(
            "INVALID_INPUT",
            "Inferences require explicit limitations",
          );
        }
        if (
          input.kind === "unknown" &&
          (typeof input.unknownReason !== "string" ||
            input.unknownReason.trim().length === 0)
        ) {
          throw new DomainError(
            "INVALID_INPUT",
            "Unknown findings require an explicit reason",
          );
        }
        await requireWorkspace(repos, input.workspaceId);
        for (const evidenceId of input.evidenceIds) {
          const evidence = await repos.evidence.get(evidenceId, input.workspaceId);
          if (!evidence) {
            throw new DomainError(
              "NOT_FOUND",
              "Evidence not found in workspace",
              false,
              { evidenceId, workspaceId: input.workspaceId },
            );
          }
        }
        const finding: Finding = {
          id: input.id,
          workspaceId: input.workspaceId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          kind: input.kind,
          statement: input.statement,
          evidenceIds: input.evidenceIds,
          ...(input.limitations === undefined
            ? {}
            : { limitations: input.limitations }),
          ...(input.unknownReason === undefined
            ? {}
            : { unknownReason: input.unknownReason }),
        };
        return repos.findings.insert(finding) as Promise<Finding>;
      },
    });
  }

  createRecommendation(
    command: Command<CreateRecommendation>,
  ): Promise<Recommendation> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "recommendation.create",
      entityType: "recommendation",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        assertStringArray(input.findingIds, "findingIds", {
          nonEmpty: true,
          unique: true,
        });
        assertNonEmptyString(input.hypothesis, "hypothesis");
        assertNonEmptyString(input.affectedStage, "affectedStage");
        assertNonEmptyString(input.priority, "priority");
        assertNonEmptyString(input.expectedMetric, "expectedMetric");
        for (const findingId of input.findingIds) {
          const finding = await repos.findings.get(findingId, input.workspaceId);
          if (!finding) {
            throw new DomainError(
              "NOT_FOUND",
              "Finding not found in workspace",
              false,
              { findingId, workspaceId: input.workspaceId },
            );
          }
        }
        const recommendation: Recommendation = {
          id: input.id,
          workspaceId: input.workspaceId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          findingIds: input.findingIds,
          hypothesis: input.hypothesis,
          affectedStage: input.affectedStage,
          priority: input.priority,
          expectedMetric: input.expectedMetric,
        };
        return repos.recommendations.insert(
          recommendation,
        ) as Promise<Recommendation>;
      },
    });
  }

  createTask(command: Command<CreateTask>): Promise<Task> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "task.create",
      entityType: "task",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        assertStringArray(input.recommendationIds, "recommendationIds", {
          nonEmpty: true,
          unique: true,
        });
        assertNonEmptyString(input.assignee, "assignee");
        assertStringArray(input.dependencyIds, "dependencyIds", { unique: true });
        assertStringArray(input.assetRequirements, "assetRequirements");
        assertStringArray(input.acceptanceCriteria, "acceptanceCriteria", {
          nonEmpty: true,
        });
        for (const recommendationId of input.recommendationIds) {
          const recommendation = await repos.recommendations.get(
            recommendationId,
            input.workspaceId,
          );
          if (!recommendation) {
            throw new DomainError(
              "NOT_FOUND",
              "Recommendation not found in workspace",
              false,
              { recommendationId, workspaceId: input.workspaceId },
            );
          }
        }
        const task: Task = {
          id: input.id,
          workspaceId: input.workspaceId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          recommendationIds: input.recommendationIds,
          assignee: input.assignee,
          dependencyIds: input.dependencyIds,
          assetRequirements: input.assetRequirements,
          acceptanceCriteria: input.acceptanceCriteria,
          state: "draft",
        };
        await assertWorkspaceDependencyGraph(repos, task);
        return repos.tasks.insert(task) as Promise<Task>;
      },
    });
  }

  registerCapability(
    command: Command<RegisterCapability>,
  ): Promise<ToolCapability> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "capability.register",
      entityType: "capability",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        assertNonEmptyString(input.id, "id");
        assertNonEmptyString(input.workspaceId, "workspaceId");
        assertNonEmptyString(input.name, "name");
        if (!(CAPABILITY_ADAPTER_KINDS as readonly string[]).includes(input.adapterKind)) {
          throw new DomainError(
            "INVALID_INPUT",
            "adapterKind must be a supported capability adapter kind",
          );
        }
        if (input.origin !== "user_extension") {
          throw new DomainError(
            "INVALID_INPUT",
            "Public capability registration requires an explicit user extension",
          );
        }
        await requireWorkspace(repos, input.workspaceId);
        const capability: ToolCapability = {
          id: input.id,
          workspaceId: input.workspaceId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          name: input.name,
          adapterKind: input.adapterKind,
          origin: input.origin,
          state: input.configuration === undefined ? "registered" : "configured",
          ...(input.configuration === undefined
            ? {}
            : { configuration: input.configuration }),
        };
        return repos.capabilities.insert(capability) as Promise<ToolCapability>;
      },
    });
  }

  recordCapabilityHealth(
    command: Command<RecordCapabilityHealth>,
  ): Promise<ToolCapability> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "capability.health.record",
      entityType: "capability",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
          throw new DomainError(
            "INVALID_INPUT",
            "expectedVersion must be a positive integer",
          );
        }
        if (typeof input.healthy !== "boolean") {
          throw new DomainError("INVALID_INPUT", "healthy must be a boolean");
        }
        assertUtcInput(input.checkedAt, "checkedAt");
        const capability = await repos.capabilities.get(input.id, input.workspaceId);
        if (!capability) {
          throw new DomainError(
            "NOT_FOUND",
            "Capability not found in workspace",
            false,
            { capabilityId: input.id, workspaceId: input.workspaceId },
          );
        }
        const current = capability as ToolCapability;
        const updated: ToolCapability = {
          ...current,
          state: input.healthy ? "verified" : "unavailable",
          checkedAt: input.checkedAt,
          updatedAt: timestamp,
        };
        delete updated.toolVersion;
        delete updated.evidenceId;
        delete updated.unavailableReason;
        if (input.healthy) {
          assertNonEmptyString(input.toolVersion, "toolVersion");
          assertNonEmptyString(input.evidenceId, "evidenceId");
          const evidence = await repos.evidence.get(input.evidenceId, input.workspaceId);
          if (!evidence) {
            throw new DomainError(
              "NOT_FOUND",
              "Capability health evidence not found in workspace",
              false,
              { evidenceId: input.evidenceId, workspaceId: input.workspaceId },
            );
          }
          const health = (evidence as Evidence).toolHealth;
          if (
            !health ||
            health.purpose !== "tool_health" ||
            health.capabilityId !== current.id ||
            health.healthy !== true ||
            health.checkedAt !== input.checkedAt ||
            health.toolVersion !== input.toolVersion
          ) {
            throw new DomainError(
              "INVALID_INPUT",
              "Evidence does not match this capability health verification",
            );
          }
          updated.toolVersion = input.toolVersion;
          updated.evidenceId = input.evidenceId;
        } else {
          assertNonEmptyString(input.reason, "reason");
          updated.unavailableReason = input.reason;
        }
        return repos.capabilities.update(
          updated,
          input.expectedVersion,
        ) as Promise<ToolCapability>;
      },
    });
  }

  listCapabilities(query: CapabilityQuery): Promise<ToolCapability[]> {
    return this.store.transaction(async (repos) => {
      assertNonEmptyString(query.workspaceId, "workspaceId");
      if (
        query.adapterKind !== undefined &&
        !(CAPABILITY_ADAPTER_KINDS as readonly string[]).includes(query.adapterKind)
      ) {
        throw new DomainError(
          "INVALID_INPUT",
          "adapterKind must be a supported capability adapter kind",
        );
      }
      if (
        query.state !== undefined &&
        !(CAPABILITY_STATES as readonly string[]).includes(query.state)
      ) {
        throw new DomainError("INVALID_INPUT", "state must be a supported capability state");
      }
      const capabilities = await repos.capabilities.list(query.workspaceId);
      return capabilities.filter(
        (capability) =>
          (query.adapterKind === undefined || capability.adapterKind === query.adapterKind) &&
          (query.state === undefined || capability.state === query.state),
      ) as ToolCapability[];
    });
  }

  getLineage(query: EntityRef & { workspaceId: string }): Promise<Lineage> {
    return this.store.transaction(async (repos) => {
      if (!Object.hasOwn(lineageEntityTypes, query.entityType)) {
        throw new DomainError("INVALID_INPUT", "entityType must be a lineage entity type");
      }
      const nodes: LineageNode[] = [];
      const edges: LineageEdge[] = [];
      const visited = new Set<string>();
      const visiting = new Set<string>();
      const visit = async (ref: EntityRef): Promise<void> => {
        const key = `${ref.entityType}:${ref.id}`;
        if (visited.has(key)) {
          return;
        }
        if (visiting.has(key)) {
          throw new DomainError("CONFLICT", "Lineage contains a reference cycle");
        }
        if (visited.size >= MAX_LINEAGE_ENTITIES) {
          throw new DomainError("CONFLICT", "Lineage entity limit exceeded", false, {
            limit: MAX_LINEAGE_ENTITIES,
          });
        }
        visiting.add(key);
        const repositoryName = lineageEntityTypes[ref.entityType];
        const repository = repos[repositoryName] as EntityRepository;
        const record = await repository.get(ref.id, query.workspaceId);
        if (!record) {
          throw new DomainError("NOT_FOUND", "Lineage entity not found in workspace", false, {
            entityType: ref.entityType,
            id: ref.id,
            workspaceId: query.workspaceId,
          });
        }
        for (const parent of lineageReferences(record, ref.entityType)) {
          await visit(parent);
          edges.push({ from: parent, to: ref });
        }
        const audits = await repos.audit.listForEntity(
          query.workspaceId,
          ref.entityType,
          ref.id,
        );
        nodes.push({
          ...ref,
          version: record.version,
          auditRequestIds: audits.map((audit) => audit.requestId),
        });
        visiting.delete(key);
        visited.add(key);
      };

      await visit({ entityType: query.entityType, id: query.id });
      const order = new Map(
        nodes.map((node, index) => [`${node.entityType}:${node.id}`, index]),
      );
      const position = (ref: EntityRef): number =>
        order.get(`${ref.entityType}:${ref.id}`)!;
      edges.sort((left, right) =>
        (position(left.from) - position(right.from)) ||
        (position(left.to) - position(right.to)),
      );
      return { workspaceId: query.workspaceId, nodes, edges };
    });
  }

  transitionTask(command: Command<TransitionTask>): Promise<Task> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "task.transition",
      entityType: "task",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        if (!(TASK_STATES as readonly string[]).includes(input.next)) {
          throw new DomainError("INVALID_INPUT", "next must be a supported task state");
        }
        if (input.next === "rejected") {
          throw new DomainError("INVALID_INPUT", "Task rejection requires the dedicated rejection command");
        }
        if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
          throw new DomainError("INVALID_INPUT", "expectedVersion must be a positive integer");
        }
        const task = await requireTask(repos, input.workspaceId, input.id);
        assertTaskTransition(task.state, input.next);
        if (input.next === "ready" || input.next === "in_progress") {
          for (const dependencyId of task.dependencyIds) {
            const dependency = await requireTask(
              repos,
              input.workspaceId,
              dependencyId,
            );
            if (dependency.state !== "completed") {
              throw new DomainError(
                "CONFLICT",
                "Task dependencies must be completed before it is ready",
                false,
                { taskId: task.id, dependencyId },
              );
            }
          }
        }
        return repos.tasks.update(
          { ...task, state: input.next, updatedAt: timestamp },
          input.expectedVersion,
        ) as Promise<Task>;
      },
    });
  }
}

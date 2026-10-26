import { DomainError } from "../domain/errors.js";
import {
  EVIDENCE_CLASSIFICATIONS,
  FINDING_KINDS,
  TASK_STATES,
  type Dataset,
  type Evidence,
  type Finding,
  type Recommendation,
  type Source,
  type Task,
  type Workspace,
} from "../domain/model.js";
import {
  assertTaskDependencyGraph,
  assertTaskTransition,
} from "../domain/task-machine.js";
import { assertUtcInstant } from "../infrastructure/sqlite.js";
import {
  AuditableCommandPipeline,
  type Command,
  type CommandPipeline,
  type CreateRecommendation,
  type CreateTask,
  type CreateWorkspace,
  type RecordEvidence,
  type RecordFinding,
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

const lineageEntityTypes: Record<LineageEntityType, keyof Repositories> = {
  source: "sources",
  dataset: "datasets",
  evidence: "evidence",
  finding: "findings",
  recommendation: "recommendations",
  task: "tasks",
};

function lineageReferences(record: EntityRecord, entityType: LineageEntityType): EntityRef[] {
  if (entityType === "dataset" || entityType === "evidence") {
    if (typeof record.sourceId !== "string") {
      throw new DomainError("NOT_FOUND", "Lineage reference is invalid", false, {
        entityType,
        id: record.id,
      });
    }
    return [{ entityType: "source", id: record.sourceId }];
  }
  const reference = {
    finding: ["evidenceIds", "evidence"],
    recommendation: ["findingIds", "finding"],
    task: ["recommendationIds", "recommendation"],
  } as const;
  if (entityType === "source") {
    return [];
  }
  const [key, referencedType] = reference[entityType];
  const ids = record[key];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new DomainError("NOT_FOUND", "Lineage reference is invalid", false, {
      entityType,
      id: record.id,
    });
  }
  return ids.map((id) => ({ entityType: referencedType, id }));
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

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("INVALID_INPUT", `${field} must not be empty`);
  }
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

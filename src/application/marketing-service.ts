import { DomainError } from "../domain/errors.js";
import {
  EVIDENCE_CLASSIFICATIONS,
  FINDING_KINDS,
  type Dataset,
  type Evidence,
  type Finding,
  type Source,
  type Workspace,
} from "../domain/model.js";
import { assertUtcInstant } from "../infrastructure/sqlite.js";
import {
  AuditableCommandPipeline,
  type Command,
  type CommandPipeline,
  type CreateWorkspace,
  type RecordEvidence,
  type RecordFinding,
  type RegisterDataset,
  type RegisterSource,
} from "./commands.js";
import type {
  Clock,
  IdGenerator,
  Repositories,
  Store,
} from "./ports.js";

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

export class MarketingService {
  private readonly commands: CommandPipeline;

  constructor(store: Store, clock: Clock, ids: IdGenerator) {
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
        if (
          !Array.isArray(input.evidenceIds) ||
          input.evidenceIds.some(
            (evidenceId) =>
              typeof evidenceId !== "string" || evidenceId.trim().length === 0,
          )
        ) {
          throw new DomainError(
            "INVALID_INPUT",
            "evidenceIds must be an array of non-empty strings",
          );
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
}

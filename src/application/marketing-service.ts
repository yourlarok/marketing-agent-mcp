import { DomainError } from "../domain/errors.js";
import type {
  Dataset,
  Evidence,
  Source,
  Workspace,
} from "../domain/model.js";
import { assertUtcInstant } from "../infrastructure/sqlite.js";
import {
  AuditableCommandPipeline,
  type Command,
  type CommandPipeline,
  type CreateWorkspace,
  type RecordEvidence,
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
}

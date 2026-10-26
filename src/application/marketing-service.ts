import type { Source, Workspace } from "../domain/model.js";
import {
  AuditableCommandPipeline,
  type Command,
  type CommandPipeline,
  type CreateWorkspace,
  type RegisterSource,
} from "./commands.js";
import type { Clock, IdGenerator, Store } from "./ports.js";

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
}

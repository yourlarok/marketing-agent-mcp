import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MarketingService } from "../application/marketing-service.js";
import { canonicalJson } from "../infrastructure/sqlite.js";
import { toMcpError } from "./error-mapper.js";
import {
  createWorkspaceInputSchema,
  registerSourceInputSchema,
} from "./schemas.js";

export function registerTools(server: McpServer, service: MarketingService): void {
  server.registerTool(
    "workspace_create",
    {
      description: "Create an auditable marketing workspace",
      inputSchema: createWorkspaceInputSchema.shape,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          createWorkspaceInputSchema.parse(arguments_);
        const workspace = await service.createWorkspace({
          input,
          context: { actor, requestId, idempotencyKey },
        });
        return {
          content: [{ type: "text" as const, text: canonicalJson(workspace) }],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "source_register",
    {
      description: "Register an auditable marketing data source",
      inputSchema: registerSourceInputSchema.shape,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          registerSourceInputSchema.parse(arguments_);
        const source = await service.registerSource({
          input,
          context: { actor, requestId, idempotencyKey },
        });
        return {
          content: [{ type: "text" as const, text: canonicalJson(source) }],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MarketingService } from "../application/marketing-service.js";
import { canonicalJson } from "../infrastructure/sqlite.js";
import { toMcpError } from "./error-mapper.js";
import {
  createWorkspaceInputSchema,
  recordEvidenceInputSchema,
  recordFindingInputSchema,
  registerDatasetInputSchema,
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

  server.registerTool(
    "dataset_register",
    {
      description: "Register dataset metadata and source provenance",
      inputSchema: registerDatasetInputSchema.shape,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          registerDatasetInputSchema.parse(arguments_);
        const dataset = await service.registerDataset({
          input,
          context: { actor, requestId, idempotencyKey },
        });
        return {
          content: [{ type: "text" as const, text: canonicalJson(dataset) }],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "evidence_record",
    {
      description: "Record evidence metadata without fetching remote content",
      inputSchema: recordEvidenceInputSchema.shape,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          recordEvidenceInputSchema.parse(arguments_);
        const evidence = await service.recordEvidence({
          input,
          context: { actor, requestId, idempotencyKey },
        });
        return {
          content: [{ type: "text" as const, text: canonicalJson(evidence) }],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "finding_record",
    {
      description: "Record a fact, inference, or unknown with explicit truth boundaries",
      inputSchema: recordFindingInputSchema.shape,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          recordFindingInputSchema.parse(arguments_);
        const finding = await service.recordFinding({
          input,
          context: { actor, requestId, idempotencyKey },
        });
        return {
          content: [{ type: "text" as const, text: canonicalJson(finding) }],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MarketingService } from "../application/marketing-service.js";
import { DomainError } from "../domain/errors.js";
import { canonicalJson } from "../infrastructure/sqlite.js";
import { toMcpError } from "./error-mapper.js";
import {
  capabilityListInputSchema,
  capabilityListToolSchema,
  createRecommendationInputSchema,
  createRecommendationToolSchema,
  createTaskInputSchema,
  createTaskToolSchema,
  createWorkspaceInputSchema,
  createWorkspaceToolSchema,
  lineageGetInputSchema,
  lineageGetToolSchema,
  recordCapabilityHealthInputSchema,
  recordCapabilityHealthToolSchema,
  recordEvidenceInputSchema,
  recordEvidenceToolSchema,
  recordFindingInputSchema,
  recordFindingToolSchema,
  registerCapabilityInputSchema,
  registerCapabilityToolSchema,
  registerDatasetInputSchema,
  registerDatasetToolSchema,
  registerSourceInputSchema,
  registerSourceToolSchema,
  serializedInputSchema,
  transitionTaskInputSchema,
  transitionTaskToolSchema,
} from "./schemas.js";

export function validateToolArguments<T>(arguments_: T): T {
  const result = serializedInputSchema.safeParse(arguments_);
  if (!result.success) {
    throw new DomainError("INVALID_INPUT", "Tool input validation failed");
  }
  return arguments_;
}

export function registerTools(server: McpServer, service: MarketingService): void {
  server.registerTool(
    "workspace_create",
    {
      description: "Create an auditable marketing workspace",
      inputSchema: createWorkspaceToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          createWorkspaceInputSchema.parse(validateToolArguments(arguments_));
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
      inputSchema: registerSourceToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          registerSourceInputSchema.parse(validateToolArguments(arguments_));
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
    "capability_register",
    {
      description: "Register controlled tool metadata without installing or executing it",
      inputSchema: registerCapabilityToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          registerCapabilityInputSchema.parse(validateToolArguments(arguments_));
        const capability = await service.registerCapability({
          input,
          context: { actor, requestId, idempotencyKey },
        });
        return {
          content: [{ type: "text" as const, text: canonicalJson(capability) }],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "capability_health_record",
    {
      description: "Record externally checked capability health and evidence",
      inputSchema: recordCapabilityHealthToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          recordCapabilityHealthInputSchema.parse(validateToolArguments(arguments_));
        const capability = await service.recordCapabilityHealth({
          input,
          context: { actor, requestId, idempotencyKey },
        });
        return {
          content: [{ type: "text" as const, text: canonicalJson(capability) }],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "capability_list",
    {
      description: "List workspace-scoped controlled tool capabilities",
      inputSchema: capabilityListToolSchema,
    },
    async (arguments_) => {
      try {
        const query = capabilityListInputSchema.parse(validateToolArguments(arguments_));
        const capabilities = await service.listCapabilities(query);
        return {
          content: [{ type: "text" as const, text: canonicalJson(capabilities) }],
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
      inputSchema: registerDatasetToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          registerDatasetInputSchema.parse(validateToolArguments(arguments_));
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
      inputSchema: recordEvidenceToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          recordEvidenceInputSchema.parse(validateToolArguments(arguments_));
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
      inputSchema: recordFindingToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          recordFindingInputSchema.parse(validateToolArguments(arguments_));
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

  server.registerTool(
    "recommendation_create",
    {
      description: "Create a finding-backed marketing recommendation",
      inputSchema: createRecommendationToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          createRecommendationInputSchema.parse(validateToolArguments(arguments_));
        const recommendation = await service.createRecommendation({
          input,
          context: { actor, requestId, idempotencyKey },
        });
        return {
          content: [{ type: "text" as const, text: canonicalJson(recommendation) }],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "task_create",
    {
      description: "Create an executable recommendation-backed draft task",
      inputSchema: createTaskToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          createTaskInputSchema.parse(validateToolArguments(arguments_));
        const task = await service.createTask({
          input,
          context: { actor, requestId, idempotencyKey },
        });
        return {
          content: [{ type: "text" as const, text: canonicalJson(task) }],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "lineage_get",
    {
      description: "Read bounded workspace-scoped lineage and audit provenance",
      inputSchema: lineageGetToolSchema,
    },
    async (arguments_) => {
      try {
        const query = lineageGetInputSchema.parse(validateToolArguments(arguments_));
        const lineage = await service.getLineage(query);
        return {
          content: [{ type: "text" as const, text: canonicalJson(lineage) }],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "task_transition",
    {
      description: "Transition a task with state and dependency safety checks",
      inputSchema: transitionTaskToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          transitionTaskInputSchema.parse(validateToolArguments(arguments_));
        const task = await service.transitionTask({
          input,
          context: { actor, requestId, idempotencyKey },
        });
        return {
          content: [{ type: "text" as const, text: canonicalJson(task) }],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}

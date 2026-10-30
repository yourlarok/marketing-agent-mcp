import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PublishingService } from "../application/publishing-service.js";
import { DomainError } from "../domain/errors.js";
import { toCapabilityGapResult, toMcpError } from "./error-mapper.js";
import { validateToolArguments } from "./register-tools.js";
import { textResult } from "./results.js";
import {
  approvalGetInputSchema,
  approvalGetToolSchema,
  approvalRecordInputSchema,
  approvalRecordToolSchema,
  deliveryPackageGetInputSchema,
  deliveryPackageGetToolSchema,
  publicationGetInputSchema,
  publicationGetToolSchema,
  publicationManualCompleteInputSchema,
  publicationManualCompleteToolSchema,
  publicationOperationInputSchema,
  publicationOperationToolSchema,
  scheduleCancelInputSchema,
  scheduleCancelToolSchema,
  scheduleCreateInputSchema,
  scheduleCreateToolSchema,
  scheduleGetInputSchema,
  scheduleGetToolSchema,
  scheduleRescheduleInputSchema,
  scheduleRescheduleToolSchema,
} from "./schemas.js";

function capabilityError(error: unknown): CallToolResult {
  const gap = toCapabilityGapResult(error);
  if (gap) return gap;
  throw toMcpError(error);
}

export function registerPublishingTools(server: McpServer, publishing: PublishingService): void {
  server.registerTool(
    "approval_record",
    {
      description: "Record a human-attested decision locked to an exact AssetVersion and artifact hash",
      inputSchema: approvalRecordToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          approvalRecordInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await publishing.recordApproval({
          input, context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        return capabilityError(error);
      }
    },
  );

  server.registerTool(
    "approval_get",
    {
      description: "Read a workspace-scoped immutable Approval",
      inputSchema: approvalGetToolSchema,
    },
    async (arguments_) => {
      try {
        return textResult(await publishing.getApproval(
          approvalGetInputSchema.parse(validateToolArguments(arguments_)),
        ));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "schedule_create",
    {
      description: "Create an exact-approval Schedule and pending Publication without submitting it",
      inputSchema: scheduleCreateToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          scheduleCreateInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await publishing.createSchedule({
          input, context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        return capabilityError(error);
      }
    },
  );

  server.registerTool(
    "schedule_reschedule",
    {
      description: "Move a still-scheduled Publication using its optimistic Schedule version",
      inputSchema: scheduleRescheduleToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          scheduleRescheduleInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await publishing.reschedule({
          input, context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        return capabilityError(error);
      }
    },
  );

  server.registerTool(
    "schedule_cancel",
    {
      description: "Cancel a still-scheduled Publication without reporting delivery",
      inputSchema: scheduleCancelToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          scheduleCancelInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await publishing.cancelSchedule({
          input, context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        return capabilityError(error);
      }
    },
  );

  server.registerTool(
    "schedule_get",
    {
      description: "Read a workspace-scoped Schedule",
      inputSchema: scheduleGetToolSchema,
    },
    async (arguments_) => {
      try {
        return textResult(await publishing.getSchedule(
          scheduleGetInputSchema.parse(validateToolArguments(arguments_)),
        ));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  for (const [name, description, operation] of [
    ["publication_submit", "Submit a due automatic Publication; submitted is not published", "submit"],
    ["publication_verify", "Verify a submitted or uncertain Publication before claiming delivery", "verify"],
    ["publication_retry", "Verify uncertain delivery first and resubmit only after explicit provider not_found", "retry"],
  ] as const) {
    server.registerTool(
      name,
      { description, inputSchema: publicationOperationToolSchema },
      async (arguments_) => {
        try {
          const { actor, requestId, idempotencyKey, ...input } =
            publicationOperationInputSchema.parse(validateToolArguments(arguments_));
          return textResult(await publishing[operation]({
            input, context: { actor, requestId, idempotencyKey },
          }));
        } catch (error) {
          return capabilityError(error);
        }
      },
    );
  }

  server.registerTool(
    "publication_get",
    {
      description: "Read a workspace-scoped Publication and its actual verification state",
      inputSchema: publicationGetToolSchema,
    },
    async (arguments_) => {
      try {
        return textResult(await publishing.get(
          publicationGetInputSchema.parse(validateToolArguments(arguments_)),
        ));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "publication_manual_handoff",
    {
      description: "Create a manual-assisted delivery package without submitting or claiming publication",
      inputSchema: publicationOperationToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          publicationOperationInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await publishing.manualHandoff({
          input, context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        return capabilityError(error);
      }
    },
  );

  server.registerTool(
    "publication_manual_complete",
    {
      description: "Verify manual-assisted completion only with persisted owned operating Evidence",
      inputSchema: publicationManualCompleteToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          publicationManualCompleteInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await publishing.manualComplete({
          input, context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        return capabilityError(error);
      }
    },
  );

  server.registerTool(
    "delivery_package_get",
    {
      description: "Read at most 32,768 bytes of a not-published manual delivery package as base64",
      inputSchema: deliveryPackageGetToolSchema,
    },
    async (arguments_) => {
      try {
        const { content, ...descriptor } = await publishing.getDeliveryPackage(
          deliveryPackageGetInputSchema.parse(validateToolArguments(arguments_)),
        );
        if (content.byteLength > 32_768) {
          throw new DomainError("CONFLICT", "Delivery package chunk exceeds 32,768 bytes");
        }
        return textResult({ ...descriptor, length: content.byteLength, content: content.toString("base64") });
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}

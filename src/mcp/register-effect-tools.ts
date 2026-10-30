import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EffectService } from "../application/effect-service.js";
import { toCapabilityGapResult, toMcpError } from "./error-mapper.js";
import { validateToolArguments } from "./register-tools.js";
import { textResult } from "./results.js";
import {
  effectMetricSnapshotGetInputSchema,
  effectMetricSnapshotGetToolSchema,
  effectMetricSnapshotImportInputSchema,
  effectMetricSnapshotImportToolSchema,
  effectReviewCreateInputSchema,
  effectReviewCreateToolSchema,
  effectReviewGetInputSchema,
  effectReviewGetToolSchema,
} from "./schemas.js";

export function registerEffectTools(server: McpServer, effect: EffectService): void {
  server.registerTool(
    "effect_metric_snapshot_import",
    {
      description: "Import bounded post-publication metrics linked to owned classified Evidence",
      inputSchema: effectMetricSnapshotImportToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          effectMetricSnapshotImportInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await effect.importMetricSnapshot({
          input, context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        const gap = toCapabilityGapResult(error);
        if (gap) return gap;
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "effect_metric_snapshot_get",
    {
      description: "Read a workspace-scoped immutable MetricSnapshot",
      inputSchema: effectMetricSnapshotGetToolSchema,
    },
    async (arguments_) => {
      try {
        return textResult(await effect.getMetricSnapshot(
          effectMetricSnapshotGetInputSchema.parse(validateToolArguments(arguments_)),
        ));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "effect_review_create",
    {
      description: "Create a descriptive four-part effect review without inferring causality",
      inputSchema: effectReviewCreateToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          effectReviewCreateInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await effect.createReview({
          input, context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        const gap = toCapabilityGapResult(error);
        if (gap) return gap;
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "effect_review_get",
    {
      description: "Read a workspace-scoped immutable EffectReview and its unknown reasons",
      inputSchema: effectReviewGetToolSchema,
    },
    async (arguments_) => {
      try {
        return textResult(await effect.getReview(
          effectReviewGetInputSchema.parse(validateToolArguments(arguments_)),
        ));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}

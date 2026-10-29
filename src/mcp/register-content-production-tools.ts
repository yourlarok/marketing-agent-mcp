import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BenchmarkService } from "../application/benchmark-service.js";
import type { ContentProductionService } from "../application/content-production-service.js";
import { toCapabilityGapResult, toMcpError } from "./error-mapper.js";
import { validateToolArguments } from "./register-tools.js";
import { textResult } from "./results.js";
import {
  benchmarkReverseCreateInputSchema,
  benchmarkReverseCreateToolSchema,
  benchmarkReverseGetInputSchema,
  benchmarkReverseGetToolSchema,
  contentArtifactGetInputSchema,
  contentArtifactGetToolSchema,
  contentAssetDeriveInputSchema,
  contentAssetDeriveToolSchema,
  contentAssetGenerateInputSchema,
  contentAssetGenerateToolSchema,
  contentAssetGetInputSchema,
  contentAssetGetToolSchema,
  contentBriefCreateInputSchema,
  contentBriefCreateToolSchema,
  contentBriefGetInputSchema,
  contentBriefGetToolSchema,
} from "./schemas.js";

export function registerContentProductionTools(
  server: McpServer,
  benchmark?: BenchmarkService,
  contentProduction?: ContentProductionService,
): void {
  if (benchmark) {
    server.registerTool(
      "benchmark_reverse_create",
      {
        description: "Create an evidence-bound benchmark analysis through the configured reverse provider",
        inputSchema: benchmarkReverseCreateToolSchema,
      },
      async (arguments_) => {
        try {
          const { actor, requestId, idempotencyKey, ...input } =
            benchmarkReverseCreateInputSchema.parse(validateToolArguments(arguments_));
          return textResult(await benchmark.reverse({
            input,
            context: { actor, requestId, idempotencyKey },
          }));
        } catch (error) {
          const gap = toCapabilityGapResult(error);
          if (gap) return gap;
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "benchmark_reverse_get",
      {
        description: "Read a workspace-scoped persisted benchmark analysis",
        inputSchema: benchmarkReverseGetToolSchema,
      },
      async (arguments_) => {
        try {
          return textResult(await benchmark.get(
            benchmarkReverseGetInputSchema.parse(validateToolArguments(arguments_)),
          ));
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );
  }

  if (contentProduction) {
    server.registerTool(
      "content_brief_create",
      {
        description: "Create an original evidence-bound content brief without producing or publishing an asset",
        inputSchema: contentBriefCreateToolSchema,
      },
      async (arguments_) => {
        try {
          const { actor, requestId, idempotencyKey, ...input } =
            contentBriefCreateInputSchema.parse(validateToolArguments(arguments_));
          return textResult(await contentProduction.createBrief({
            input,
            context: { actor, requestId, idempotencyKey },
          }));
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "content_brief_get",
      {
        description: "Read a workspace-scoped persisted content brief",
        inputSchema: contentBriefGetToolSchema,
      },
      async (arguments_) => {
        try {
          return textResult(await contentProduction.getBrief(
            contentBriefGetInputSchema.parse(validateToolArguments(arguments_)),
          ));
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "content_asset_generate",
      {
        description: "Generate and internally validate a root asset through the configured professional media provider",
        inputSchema: contentAssetGenerateToolSchema,
      },
      async (arguments_) => {
        try {
          const { actor, requestId, idempotencyKey, ...input } =
            contentAssetGenerateInputSchema.parse(validateToolArguments(arguments_));
          return textResult(await contentProduction.generate({
            input,
            context: { actor, requestId, idempotencyKey },
          }));
        } catch (error) {
          const gap = toCapabilityGapResult(error);
          if (gap) return gap;
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "content_asset_derive",
      {
        description: "Derive and internally validate the next asset version through the configured media provider",
        inputSchema: contentAssetDeriveToolSchema,
      },
      async (arguments_) => {
        try {
          const { actor, requestId, idempotencyKey, ...input } =
            contentAssetDeriveInputSchema.parse(validateToolArguments(arguments_));
          return textResult(await contentProduction.derive({
            input,
            context: { actor, requestId, idempotencyKey },
          }));
        } catch (error) {
          const gap = toCapabilityGapResult(error);
          if (gap) return gap;
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "content_asset_get",
      {
        description: "Read a workspace-scoped persisted asset version and its internal validation provenance",
        inputSchema: contentAssetGetToolSchema,
      },
      async (arguments_) => {
        try {
          return textResult(await contentProduction.getAssetVersion(
            contentAssetGetInputSchema.parse(validateToolArguments(arguments_)),
          ));
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "content_artifact_get",
      {
        description: "Read at most 32 KiB of a persisted content artifact as base64",
        inputSchema: contentArtifactGetToolSchema,
      },
      async (arguments_) => {
        try {
          const { content, ...artifact } = await contentProduction.getContentArtifact(
            contentArtifactGetInputSchema.parse(validateToolArguments(arguments_)),
          );
          return textResult({
            ...artifact,
            length: content.byteLength,
            content: content.toString("base64"),
          });
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );
  }
}

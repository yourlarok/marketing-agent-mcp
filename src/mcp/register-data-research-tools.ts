import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DataResearchService } from "../application/data-research-service.js";
import type { MarketingService } from "../application/marketing-service.js";
import { canonicalJson } from "../infrastructure/sqlite.js";
import { toMcpError } from "./error-mapper.js";
import { validateToolArguments } from "./register-tools.js";
import {
  competitorConfirmInputSchema,
  competitorDiffCreateInputSchema,
  dataRequestDeclineInputSchema,
  dataRequestPlanInputSchema,
  dataResearchGetInputSchema,
  evidenceAssetGetInputSchema,
  ingestContentLinksInputSchema,
  ingestFilesInputSchema,
  ingestTemporaryApiInputSchema,
  researchPermissionSetInputSchema,
  researchSessionCreateInputSchema,
  researchSessionRunInputSchema,
} from "./schemas.js";

function textResult(value: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: canonicalJson(value) }] };
}

export function registerDataResearchTools(
  server: McpServer,
  marketing: MarketingService | undefined,
  dataResearch: DataResearchService,
): void {
  server.registerTool(
    "data_request_plan",
    {
      description: "Create a deterministic, evidence-aware data request plan",
      inputSchema: dataRequestPlanInputSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          dataRequestPlanInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await dataResearch.planDataRequests({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "data_request_decline",
    {
      description: "Decline an active data request with an explicit limitation",
      inputSchema: dataRequestDeclineInputSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          dataRequestDeclineInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await dataResearch.declineDataRound({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "ingest_files",
    {
      description: "Import CSV or XLSX files with quality and provenance records",
      inputSchema: ingestFilesInputSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          ingestFilesInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await dataResearch.importFiles({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "ingest_temporary_api",
    {
      description: "Ingest an authorized expiring API response without accepting credentials",
      inputSchema: ingestTemporaryApiInputSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          ingestTemporaryApiInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await dataResearch.ingestTemporaryApi({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "ingest_content_links",
    {
      description: "Acquire public content links through professional browser tools",
      inputSchema: ingestContentLinksInputSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          ingestContentLinksInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await dataResearch.ingestContentLinks({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "research_session_create",
    {
      description: "Create a scope- and budget-bounded public research session",
      inputSchema: researchSessionCreateInputSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          researchSessionCreateInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await dataResearch.createResearchSession({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "research_permission_set",
    {
      description: "Allow or deny expansion beyond the research seed pages",
      inputSchema: researchPermissionSetInputSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          researchPermissionSetInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await dataResearch.setResearchPermission({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "research_session_run",
    {
      description: "Run a research session within its approved scope and budgets",
      inputSchema: researchSessionRunInputSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          researchSessionRunInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await dataResearch.runResearch({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "competitor_confirm",
    {
      description: "Confirm or exclude a competitor with optimistic concurrency",
      inputSchema: competitorConfirmInputSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          competitorConfirmInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await dataResearch.confirmCompetitor({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "competitor_diff_create",
    {
      description: "Create a deterministic evidence-linked competitor comparison",
      inputSchema: competitorDiffCreateInputSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          competitorDiffCreateInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await dataResearch.diffCompetitors({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "data_research_get",
    {
      description: "Read workspace-scoped data research lineage and audit provenance",
      inputSchema: dataResearchGetInputSchema,
    },
    async (arguments_) => {
      try {
        const query = dataResearchGetInputSchema.parse(validateToolArguments(arguments_));
        if (!marketing) {
          throw new Error("Marketing service is required for data research reads");
        }
        return textResult(await marketing.getLineage(query));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "evidence_asset_get",
    {
      description: "Read an evidence asset by workspace, evidence, and asset IDs only",
      inputSchema: evidenceAssetGetInputSchema,
    },
    async (arguments_) => {
      try {
        const query = evidenceAssetGetInputSchema.parse(validateToolArguments(arguments_));
        const { content, ...asset } = await dataResearch.getEvidenceAsset(query);
        return textResult({ ...asset, content: content.toString("base64") });
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}

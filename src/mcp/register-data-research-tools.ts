import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DataResearchService } from "../application/data-research-service.js";
import type { MarketingService } from "../application/marketing-service.js";
import { toMcpError } from "./error-mapper.js";
import { validateToolArguments } from "./register-tools.js";
import { textResult } from "./results.js";
import {
  competitorConfirmInputSchema,
  competitorConfirmToolSchema,
  competitorDiffCreateInputSchema,
  competitorDiffCreateToolSchema,
  connectorSqliteDiscoverInputSchema,
  connectorSqliteDiscoverToolSchema,
  dataRequestDeclineInputSchema,
  dataRequestDeclineToolSchema,
  dataRequestPlanInputSchema,
  dataRequestPlanToolSchema,
  dataResearchGetInputSchema,
  dataResearchGetToolSchema,
  evidenceAssetGetInputSchema,
  evidenceAssetGetToolSchema,
  ingestContentLinksInputSchema,
  ingestContentLinksToolSchema,
  ingestFilesInputSchema,
  ingestFilesToolSchema,
  ingestSqliteInputSchema,
  ingestSqliteToolSchema,
  ingestTemporaryApiInputSchema,
  ingestTemporaryApiToolSchema,
  researchPermissionSetInputSchema,
  researchPermissionSetToolSchema,
  researchSessionCreateInputSchema,
  researchSessionCreateToolSchema,
  researchSessionRunInputSchema,
  researchSessionRunToolSchema,
} from "./schemas.js";

export function registerDataResearchTools(
  server: McpServer,
  marketing: MarketingService | undefined,
  dataResearch: DataResearchService,
): void {
  server.registerTool(
    "data_request_plan",
    {
      description: "Create a deterministic, evidence-aware data request plan",
      inputSchema: dataRequestPlanToolSchema,
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
      inputSchema: dataRequestDeclineToolSchema,
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
      inputSchema: ingestFilesToolSchema,
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
    "connector_sqlite_discover",
    {
      description: "Discover the schema of an authorized SQLite database without reading rows",
      inputSchema: connectorSqliteDiscoverToolSchema,
    },
    async (arguments_) => {
      try {
        return textResult(dataResearch.connectorSqliteDiscover(
          connectorSqliteDiscoverInputSchema.parse(validateToolArguments(arguments_)),
        ));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "ingest_sqlite",
    {
      description: "Import an authorized SQLite snapshot through a structured read-only query",
      inputSchema: ingestSqliteToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          ingestSqliteInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await dataResearch.ingestSqlite({
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
      inputSchema: ingestTemporaryApiToolSchema,
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
      inputSchema: ingestContentLinksToolSchema,
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
      inputSchema: researchSessionCreateToolSchema,
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
      inputSchema: researchPermissionSetToolSchema,
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
      inputSchema: researchSessionRunToolSchema,
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
      inputSchema: competitorConfirmToolSchema,
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
      inputSchema: competitorDiffCreateToolSchema,
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
      description: "Read a workspace-scoped business entity, continuation descriptors, and lineage",
      inputSchema: dataResearchGetToolSchema,
    },
    async (arguments_) => {
      try {
        const query = dataResearchGetInputSchema.parse(validateToolArguments(arguments_));
        if (!marketing) {
          throw new Error("Marketing service is required for data research reads");
        }
        const [result, lineage] = await Promise.all([
          dataResearch.getDataResearch(query),
          marketing.getLineage(query),
        ]);
        return textResult({ ...lineage, ...result });
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "evidence_asset_get",
    {
      description: "Read an evidence asset by workspace, evidence, and asset IDs only",
      inputSchema: evidenceAssetGetToolSchema,
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

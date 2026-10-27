import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AnalysisCapabilityService,
  type AnalysisService,
} from "../application/analysis-service.js";
import { canonicalJson } from "../infrastructure/sqlite.js";
import { toMcpError } from "./error-mapper.js";
import { validateToolArguments } from "./register-tools.js";
import {
  analysisGraphExpandInputSchema,
  analysisGraphExpandToolSchema,
  analysisGraphForkInputSchema,
  analysisGraphForkToolSchema,
  analysisGraphGetInputSchema,
  analysisGraphGetToolSchema,
  analysisStartInputSchema,
  analysisStartToolSchema,
  marketingCapabilityListInputSchema,
  marketingCapabilityListToolSchema,
  metricComputeInputSchema,
  metricComputeToolSchema,
  metricMonitorCompareInputSchema,
  metricMonitorCompareToolSchema,
  metricScenarioCreateInputSchema,
  metricScenarioCreateToolSchema,
} from "./schemas.js";

function textResult(value: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: canonicalJson(value) }] };
}

export function registerAnalysisTools(
  server: McpServer,
  analysis: AnalysisService,
  capabilities: AnalysisCapabilityService = new AnalysisCapabilityService(),
): void {
  server.registerTool(
    "marketing_analysis_start",
    {
      description: "Start a guided marketing analysis with optional owned data",
      inputSchema: analysisStartToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          analysisStartInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await analysis.start({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "marketing_capability_list",
    {
      description: "List analysis, research, ingestion, fallback, and availability boundaries",
      inputSchema: marketingCapabilityListToolSchema,
    },
    async (arguments_) => {
      try {
        marketingCapabilityListInputSchema.parse(validateToolArguments(arguments_));
        return textResult(capabilities.list());
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "analysis_graph_get",
    {
      description: "Restore a workspace-scoped analysis graph and all persisted results",
      inputSchema: analysisGraphGetToolSchema,
    },
    async (arguments_) => {
      try {
        return textResult(await analysis.get(
          analysisGraphGetInputSchema.parse(validateToolArguments(arguments_)),
        ));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "analysis_graph_expand",
    {
      description: "Atomically expand a versioned analysis graph with controlled nodes and edges",
      inputSchema: analysisGraphExpandToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          analysisGraphExpandInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await analysis.expand({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "analysis_graph_fork",
    {
      description: "Copy an analysis graph into an independent branch from an existing node",
      inputSchema: analysisGraphForkToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          analysisGraphForkInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await analysis.fork({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "metric_compute",
    {
      description: "Compute a controlled metric from verified imported evidence",
      inputSchema: metricComputeToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          metricComputeInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await analysis.computeMetric({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "metric_scenario_create",
    {
      description: "Create a conditional metric scenario without promising uplift or causality",
      inputSchema: metricScenarioCreateToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          metricScenarioCreateInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await analysis.createMetricScenario({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerTool(
    "metric_monitor_compare",
    {
      description: "Compare a new imported snapshot with a baseline using the same metric definition",
      inputSchema: metricMonitorCompareToolSchema,
    },
    async (arguments_) => {
      try {
        const { actor, requestId, idempotencyKey, ...input } =
          metricMonitorCompareInputSchema.parse(validateToolArguments(arguments_));
        return textResult(await analysis.compareMetricMonitor({
          input,
          context: { actor, requestId, idempotencyKey },
        }));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}

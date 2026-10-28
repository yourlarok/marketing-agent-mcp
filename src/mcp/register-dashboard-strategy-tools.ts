import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DashboardService } from "../application/dashboard-service.js";
import type { StrategyService } from "../application/strategy-service.js";
import { toMcpError } from "./error-mapper.js";
import { validateToolArguments } from "./register-tools.js";
import { textResult } from "./results.js";
import {
  dashboardArtifactGetInputSchema,
  dashboardArtifactGetToolSchema,
  dashboardDrilldownGetInputSchema,
  dashboardDrilldownGetToolSchema,
  dashboardGetInputSchema,
  dashboardGetToolSchema,
  dashboardRenderInputSchema,
  dashboardRenderToolSchema,
  strategyRecommendationGenerateInputSchema,
  strategyRecommendationGenerateToolSchema,
  strategyTaskGetInputSchema,
  strategyTaskGetToolSchema,
  strategyTaskListInputSchema,
  strategyTaskListToolSchema,
  strategyTaskRejectInputSchema,
  strategyTaskRejectToolSchema,
  strategyTaskReorderInputSchema,
  strategyTaskReorderToolSchema,
  strategyTaskSupplementInputSchema,
  strategyTaskSupplementToolSchema,
  strategyTaskUpdateInputSchema,
  strategyTaskUpdateToolSchema,
} from "./schemas.js";

export function registerDashboardStrategyTools(
  server: McpServer,
  dashboard?: DashboardService,
  strategy?: StrategyService,
): void {
  if (dashboard) {
    server.registerTool(
      "dashboard_render",
      {
        description: "Render controlled HTML/SVG views from persisted evidence",
        inputSchema: dashboardRenderToolSchema,
      },
      async (arguments_) => {
        try {
          const { actor, requestId, idempotencyKey, ...input } =
            dashboardRenderInputSchema.parse(validateToolArguments(arguments_));
          return textResult(await dashboard.render({
            input,
            context: { actor, requestId, idempotencyKey },
          }));
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "dashboard_get",
      {
        description: "Read a workspace-scoped controlled dashboard",
        inputSchema: dashboardGetToolSchema,
      },
      async (arguments_) => {
        try {
          return textResult(await dashboard.get(
            dashboardGetInputSchema.parse(validateToolArguments(arguments_)),
          ));
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "dashboard_drilldown_get",
      {
        description: "Read persisted graph, dataset, source, and evidence references for one dashboard datum",
        inputSchema: dashboardDrilldownGetToolSchema,
      },
      async (arguments_) => {
        try {
          return textResult(await dashboard.getDrilldown(
            dashboardDrilldownGetInputSchema.parse(validateToolArguments(arguments_)),
          ));
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "dashboard_artifact_get",
      {
        description: "Read a bounded base64 chunk of a controlled dashboard artifact",
        inputSchema: dashboardArtifactGetToolSchema,
      },
      async (arguments_) => {
        try {
          const query = dashboardArtifactGetInputSchema.parse(validateToolArguments(arguments_));
          const { content, ...artifact } = await dashboard.getArtifact(query);
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

  if (strategy) {
    server.registerTool(
      "strategy_recommendation_generate",
      {
        description: "Generate an evidence-bound recommendation without promising an outcome",
        inputSchema: strategyRecommendationGenerateToolSchema,
      },
      async (arguments_) => {
        try {
          const { actor, requestId, idempotencyKey, ...input } =
            strategyRecommendationGenerateInputSchema.parse(validateToolArguments(arguments_));
          return textResult(await strategy.generateRecommendation({
            input,
            context: { actor, requestId, idempotencyKey },
          }));
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "strategy_task_supplement",
      {
        description: "Create a user-controlled draft task without producing or publishing material",
        inputSchema: strategyTaskSupplementToolSchema,
      },
      async (arguments_) => {
        try {
          const { actor, requestId, idempotencyKey, ...input } =
            strategyTaskSupplementInputSchema.parse(validateToolArguments(arguments_));
          return textResult(await strategy.supplementTask({
            input,
            context: { actor, requestId, idempotencyKey },
          }));
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "strategy_task_update",
      {
        description: "Update mutable fields of a non-terminal user-controlled task",
        inputSchema: strategyTaskUpdateToolSchema,
      },
      async (arguments_) => {
        try {
          const { actor, requestId, idempotencyKey, ...input } =
            strategyTaskUpdateInputSchema.parse(validateToolArguments(arguments_));
          return textResult(await strategy.updateStrategyTask({
            input,
            context: { actor, requestId, idempotencyKey },
          }));
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "strategy_task_reject",
      {
        description: "Reject a task with an audited user-supplied reason",
        inputSchema: strategyTaskRejectToolSchema,
      },
      async (arguments_) => {
        try {
          const { actor, requestId, idempotencyKey, ...input } =
            strategyTaskRejectInputSchema.parse(validateToolArguments(arguments_));
          return textResult(await strategy.rejectStrategyTask({
            input,
            context: { actor, requestId, idempotencyKey },
          }));
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "strategy_task_reorder",
      {
        description: "Set the numeric rank of a non-terminal task",
        inputSchema: strategyTaskReorderToolSchema,
      },
      async (arguments_) => {
        try {
          const { actor, requestId, idempotencyKey, ...input } =
            strategyTaskReorderInputSchema.parse(validateToolArguments(arguments_));
          return textResult(await strategy.reorderStrategyTask({
            input,
            context: { actor, requestId, idempotencyKey },
          }));
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "strategy_task_get",
      {
        description: "Read one workspace-scoped strategy task",
        inputSchema: strategyTaskGetToolSchema,
      },
      async (arguments_) => {
        try {
          return textResult(await strategy.getStrategyTask(
            strategyTaskGetInputSchema.parse(validateToolArguments(arguments_)),
          ));
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );

    server.registerTool(
      "strategy_task_list",
      {
        description: "List strategy tasks with deterministic bounded cursor pagination",
        inputSchema: strategyTaskListToolSchema,
      },
      async (arguments_) => {
        try {
          return textResult(await strategy.listStrategyTasks(
            strategyTaskListInputSchema.parse(validateToolArguments(arguments_)),
          ));
        } catch (error) {
          throw toMcpError(error);
        }
      },
    );
  }
}

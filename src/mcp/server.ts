import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AnalysisCapabilityService,
  type AnalysisCapabilityConfiguration,
  type AnalysisService,
} from "../application/analysis-service.js";
import type { DashboardService } from "../application/dashboard-service.js";
import type { DataResearchService } from "../application/data-research-service.js";
import type { MarketingService } from "../application/marketing-service.js";
import type { StrategyService } from "../application/strategy-service.js";
import { DomainError } from "../domain/errors.js";
import { registerAnalysisTools } from "./register-analysis-tools.js";
import { registerDashboardStrategyTools } from "./register-dashboard-strategy-tools.js";
import { registerDataResearchTools } from "./register-data-research-tools.js";
import { registerTools } from "./register-tools.js";

export { toMcpError } from "./error-mapper.js";
export {
  idSchema,
  jsonValueSchema,
  resourceIdInputSchema,
  serializedInputSchema,
  timestampInputSchema,
  utcTimestampSchema,
} from "./schemas.js";

export type McpServerOptions = AnalysisCapabilityConfiguration;

export function createMcpServer(
  service?: MarketingService,
  dataResearch?: DataResearchService,
  analysis?: AnalysisService,
  options: McpServerOptions = {},
  dashboard?: DashboardService,
  strategy?: StrategyService,
): McpServer {
  const installed: Required<AnalysisCapabilityConfiguration> = {
    sqliteConfigured: dataResearch?.hasConfiguredSqliteConnector() ?? false,
    professionalAnalyticsConfigured: analysis?.hasProfessionalAnalyticsProvider() ?? false,
    dashboardRendererConfigured: dashboard !== undefined,
    strategyConfigured: strategy !== undefined,
  };
  for (const key of Object.keys(installed) as (keyof typeof installed)[]) {
    if (options[key] !== undefined && options[key] !== installed[key]) {
      throw new DomainError(
        "INVALID_INPUT",
        `MCP capability declaration contradicts installed service: ${key}`,
      );
    }
  }
  const server = new McpServer(
    {
      name: "marketing-agent-mcp",
      version: "1.0.0",
    },
    {
      capabilities: { tools: {} },
      instructions: [
        "For marketing requests, understand the objective first. Your own business data is optional; analysis can start without data.",
        "Without owned data, plan public research rather than demanding a CSV. With public links, use the links branch; with files or an authorized API, use the corresponding ingestion branch.",
        "Use connector_sqlite_discover before ingest_sqlite for an authorized configured SQLite database. Use professional_analytics_compute only for controlled trend, funnel, or anomaly operations on verified imported evidence.",
        ...(dashboard ? [
          "Render trend, structure, funnel, competitor_comparison, and task_effect views from persisted evidence. Use dashboard_drilldown_get before making evidence claims. Identify dashboard output as controlled HTML/SVG rather than Power BI or professional BI verification.",
        ] : []),
        ...(strategy ? [
          "Treat strategy tasks as user-controlled drafts that never automatically produce, approve, schedule, or publish material.",
        ] : []),
        "Ask at most one high-impact question that would change the branch, and allow the user to continue with the stated default.",
        "Call the high-level marketing_analysis_start tool first. Use marketing_capability_list to inspect declared capabilities, configuration, fallbacks, and limitations.",
        "Keep facts, inferences, and unknowns separate. Public engagement must not be inferred as CTR or conversion, and observations or scenarios must not be presented as causal effects or guaranteed outcomes.",
        "Do not claim unavailable or not installed capabilities, including PostgreSQL, MySQL, GA4, OAuth account access, other live connectors, general web search by this server, publishing, or scheduled monitoring. Host-provided search is optional and must actually be available before use.",
      ].join(" "),
    },
  );
  if (service) {
    registerTools(server, service);
  }
  if (dataResearch) {
    registerDataResearchTools(server, service, dataResearch);
  }
  if (analysis) {
    registerAnalysisTools(server, analysis, new AnalysisCapabilityService(installed));
  }
  if (dashboard || strategy) {
    registerDashboardStrategyTools(server, dashboard, strategy);
  }
  return server;
}

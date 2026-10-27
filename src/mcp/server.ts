import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnalysisService } from "../application/analysis-service.js";
import type { DataResearchService } from "../application/data-research-service.js";
import type { MarketingService } from "../application/marketing-service.js";
import { registerAnalysisTools } from "./register-analysis-tools.js";
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

export function createMcpServer(
  service?: MarketingService,
  dataResearch?: DataResearchService,
  analysis?: AnalysisService,
): McpServer {
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
        "Ask at most one high-impact question that would change the branch, and allow the user to continue with the stated default.",
        "Call the high-level marketing_analysis_start tool first. Use marketing_capability_list to inspect declared capabilities, configuration, fallbacks, and limitations.",
        "Keep facts, inferences, and unknowns separate. Public engagement must not be inferred as CTR or conversion, and observations or scenarios must not be presented as causal effects or guaranteed outcomes.",
        "Do not claim unavailable or not installed capabilities, including live connectors, OAuth account access, general web search by this server, publishing, or scheduled monitoring. Host-provided search is optional and must actually be available before use.",
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
    registerAnalysisTools(server, analysis);
  }
  return server;
}

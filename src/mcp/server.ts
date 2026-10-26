import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DataResearchService } from "../application/data-research-service.js";
import type { MarketingService } from "../application/marketing-service.js";
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
): McpServer {
  const server = new McpServer(
    {
      name: "marketing-agent-mcp",
      version: "1.0.0",
    },
    { capabilities: { tools: {} } },
  );
  if (service) {
    registerTools(server, service);
  }
  if (dataResearch) {
    registerDataResearchTools(server, service, dataResearch);
  }
  return server;
}

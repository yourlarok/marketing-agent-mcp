import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export { toMcpError } from "./error-mapper.js";
export {
  idSchema,
  jsonValueSchema,
  resourceIdInputSchema,
  serializedInputSchema,
  timestampInputSchema,
  utcTimestampSchema,
} from "./schemas.js";

export function createMcpServer(): McpServer {
  return new McpServer(
    {
      name: "marketing-agent-mcp",
      version: "1.0.0",
    },
    { capabilities: { tools: {} } },
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createMcpServer(): McpServer {
  return new McpServer(
    {
      name: "marketing-agent-mcp",
      version: "1.0.0",
    },
    { capabilities: { tools: {} } },
  );
}

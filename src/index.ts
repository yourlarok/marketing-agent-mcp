import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp/server.js";

loadConfig(process.env);

const server = createMcpServer();
const transport = new StdioServerTransport();

await server.connect(transport);

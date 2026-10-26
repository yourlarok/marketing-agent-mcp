import { appendFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "content-fixture", version: "1.0.0" });
server.registerTool("acquire_content", {
  description: "Acquire a content page in the local test fixture",
  inputSchema: {
    url: z.string().url(),
    fields: z.record(z.string(), z.string()).optional(),
  },
}, async ({ url, fields }) => {
  if (process.env.MCP_FIXTURE_MARKER) {
    await appendFile(process.env.MCP_FIXTURE_MARKER, `${url}\n`, "utf8");
  }
  const structuredContent = {
    url,
    finalUrl: url,
    title: "Professional fixture",
    text: "Acquired through the real MCP fixture",
    fields: Object.fromEntries(Object.keys(fields ?? {}).map((key) => [key, `fixture:${key}`])),
    screenshotBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
});
await server.connect(new StdioServerTransport());

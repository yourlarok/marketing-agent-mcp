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
  const mode = process.env.MCP_FIXTURE_MODE ?? "success";
  const gap = /^mcp-(401|403|429|login|captcha)$/.exec(new URL(url).pathname.slice(1));
  if (gap) {
    const reason = ["401", "403", "429"].includes(gap[1]) ? `http_${gap[1]}` : "access_gate";
    const error = { code: "ACCESS_GAP", reason, message: `Fixture ${reason}` };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error }) }],
      structuredContent: { error },
    };
  }
  const structuredContent = {
    url,
    finalUrl: mode === "wrong-url" ? "file:///etc/passwd" : url,
    title: "Professional fixture",
    text: mode === "environment" ? (process.env.UNRELATED_SECRET ?? "secret-absent") : "Acquired through the real MCP fixture",
    fields: mode === "wrong-fields" ? { unexpected: "forged" } : Object.fromEntries(Object.keys(fields ?? {}).map((key) => [key, `fixture:${key}`])),
    screenshotBase64: mode === "fake-png"
      ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")
      : "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
});
await server.connect(new StdioServerTransport());

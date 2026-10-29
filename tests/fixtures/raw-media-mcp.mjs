import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  let newline = input.indexOf("\n");
  while (newline >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line.trim().length > 0) {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "raw-professional-media-fixture", version: "fixture-2026.10.29" },
          },
        })}\n`);
      } else if (message.method === "tools/call") {
        const args = message.params.arguments;
        const content = Buffer.from("raw-media-fixture");
        const result = {
          content: [{ type: "text", text: "raw professional media fixture" }],
          structuredContent: {
            inputHash: createHash("sha256").update(JSON.stringify(canonical(args))).digest("hex"),
            artifact: {
              mediaType: args.operation === "render_xhs_png_v1" ? "image/png" : "video/mp4",
              contentBase64: content.toString("base64"),
              contentHash: createHash("sha256").update(content).digest("hex"),
              byteLength: content.length,
            },
          },
        };
        const envelope = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        process.stdout.write(`${" ".repeat(20_000)}${envelope}\n`);
      }
    }
    newline = input.indexOf("\n");
  }
});

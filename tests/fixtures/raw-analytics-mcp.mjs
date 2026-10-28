import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function respond(message) {
  const result = {
    content: [{ type: "text", text: "raw analytics fixture" }],
    structuredContent: {
      inputHash: createHash("sha256").update(JSON.stringify(canonical(message.params.arguments))).digest("hex"),
      result: {
        operation: "trend_v1",
        datasetId: "dataset-1",
        status: "ok",
        unknownReason: null,
        points: [
          { window: "2026-01-01", value: 21, rowCount: 2 },
          { window: "2026-01-02", value: null, rowCount: 0 },
          { window: "2026-01-03", value: 19, rowCount: 2 },
          { window: "2026-01-04", value: 112, rowCount: 2 },
        ],
        missingWindows: ["2026-01-02"],
        coverage: 0.75,
      },
    },
  };
  const envelope = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
  process.stdout.write(`${" ".repeat(20_000)}${envelope}\n`);
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
            serverInfo: { name: "raw-analytics-fixture", version: "1.0.0" },
          },
        })}\n`);
      } else if (message.method === "tools/call") {
        respond(message);
      }
    }
    newline = input.indexOf("\n");
  }
});

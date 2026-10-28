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
            serverInfo: { name: "raw-benchmark-reverse-test-fixture", version: "fixture-2026.10.28" },
          },
        })}\n`);
      } else if (message.method === "tools/call") {
        const args = message.params.arguments;
        const asset = args.observations[0].assets[0];
        const result = {
          content: [{ type: "text", text: "raw benchmark reverse fixture" }],
          structuredContent: {
            inputHash: createHash("sha256").update(JSON.stringify(canonical(args))).digest("hex"),
            analysisMethod: "raw-independent-test-fixture-v1",
            methods: [{
              id: "method-raw",
              dimension: "hook",
              pattern: "Structural hook pattern only",
              transferableRule: "Transfer structure without copying source text",
              basis: "text",
              confidence: "unknown",
              evidenceAssetRefs: [{
                sourceId: asset.sourceId,
                evidenceId: asset.evidenceId,
                assetId: asset.assetId,
                kind: asset.kind,
                observedAt: asset.observedAt,
                contentHash: asset.contentHash,
                byteLength: asset.byteLength,
              }],
            }],
            gaps: [],
          },
        };
        const envelope = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        process.stdout.write(`${" ".repeat(20_000)}${envelope}\n`);
      }
    }
    newline = input.indexOf("\n");
  }
});

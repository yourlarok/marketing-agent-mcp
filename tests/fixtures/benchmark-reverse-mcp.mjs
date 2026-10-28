import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.env.BENCHMARK_FIXTURE_PID_FILE) {
  await appendFile(process.env.BENCHMARK_FIXTURE_PID_FILE, `${process.pid}\n`, "utf8");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function bytes(asset) {
  return asset.kind === "page_text" || asset.kind === "asr_transcript"
    ? Buffer.from(asset.text, "utf8")
    : Buffer.from(asset.base64, "base64");
}

function ref(asset) {
  return {
    sourceId: asset.sourceId,
    evidenceId: asset.evidenceId,
    assetId: asset.assetId,
    kind: asset.kind,
    observedAt: asset.observedAt,
    contentHash: asset.contentHash,
    byteLength: asset.byteLength,
  };
}

function method(id, dimension, basis, confidence, assets) {
  return {
    id,
    dimension,
    pattern: `Structural ${dimension} pattern from the independent test fixture`,
    transferableRule: `Transfer only the ${dimension} structure, not source wording or media`,
    basis,
    confidence,
    evidenceAssetRefs: assets.map(ref),
  };
}

const server = new McpServer({ name: "benchmark-reverse-test-fixture", version: "fixture-2026.10.28" });
server.registerTool("reverse_engineer", {
  description: "Independent deterministic structural benchmark fixture; no human review",
  inputSchema: {
    modality: z.enum(["image", "video"]),
    observations: z.array(z.record(z.string(), z.unknown())),
  },
}, async ({ modality, observations }) => {
  if (process.env.MARKETING_TEST_BUSINESS_SECRET) throw new Error("Business environment leaked into fixture");
  const mode = process.env.BENCHMARK_FIXTURE_MODE ?? "success";
  if (mode === "timeout-ignore-sigterm" || mode === "success-hang") {
    process.on("SIGTERM", () => undefined);
  }
  if (mode === "timeout" || mode === "timeout-ignore-sigterm") await delay(5_000);
  if (mode === "success-hang") setInterval(() => undefined, 1_000);
  const input = { modality, observations };
  if (process.env.BENCHMARK_FIXTURE_CAPTURE) {
    await appendFile(process.env.BENCHMARK_FIXTURE_CAPTURE, `${JSON.stringify(canonical(input))}\n`, "utf8");
  }
  const assets = observations.flatMap((observation) => observation.assets);
  for (const asset of assets) {
    const content = bytes(asset);
    if (content.length !== asset.byteLength || createHash("sha256").update(content).digest("hex") !== asset.contentHash) {
      throw new Error("Fixture received bytes that differ from the persisted descriptor");
    }
  }
  const inputHash = createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
  const byKind = (kind) => assets.filter((asset) => asset.kind === kind);
  let methods;
  let gaps = [];
  if (modality === "video") {
    methods = mode === "video-no-declaration"
      ? [method("method-text", "hook", "text", "unknown", byKind("page_text"))]
      : [method("method-video", "shot_rhythm", "video_frames_and_asr", "high", [...byKind("video_frames"), ...byKind("asr_transcript")])];
  } else if (byKind("screenshot").length > 0) {
    methods = [method("method-layout", "layout", "image", "medium", byKind("screenshot"))];
  } else {
    methods = [
      method("method-hook", "hook", "text", "high", byKind("page_text")),
      method("method-order", "information_order", "text", "unknown", byKind("page_text")),
      method("method-cta", "cta", "text", "low", byKind("page_text")),
    ];
    gaps = [{ code: "screenshot_missing", message: "Layout cannot be assessed without a screenshot" }];
  }
  let structuredContent = {
    inputHash,
    analysisMethod: "independent-test-fixture-structural-v1",
    methods,
    gaps,
  };
  if (mode === "malformed") structuredContent = { inputHash, analysisMethod: 42, methods, gaps };
  if (mode === "unknown-field") structuredContent = { ...structuredContent, performance: { conversions: 10 } };
  if (mode === "wrong-hash") structuredContent = { ...structuredContent, inputHash: "0".repeat(64) };
  if (mode === "invented-ref") {
    structuredContent = {
      ...structuredContent,
      methods: [{ ...methods[0], evidenceAssetRefs: [{ ...methods[0].evidenceAssetRefs[0], assetId: "invented-asset" }] }],
    };
  }
  if (mode === "forged-descriptor") {
    structuredContent = {
      ...structuredContent,
      methods: [{
        ...methods[0],
        evidenceAssetRefs: [{
          ...methods[0].evidenceAssetRefs[0],
          observedAt: "2000-01-01T00:00:00.000Z",
          contentHash: "f".repeat(64),
          byteLength: 999999,
        }],
      }],
    };
  }
  return {
    content: [{ type: "text", text: "benchmark reverse independent test fixture" }],
    structuredContent,
  };
});
await server.connect(new StdioServerTransport());

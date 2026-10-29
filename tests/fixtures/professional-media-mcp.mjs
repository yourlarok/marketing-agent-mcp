import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.env.MEDIA_FIXTURE_PID_FILE) {
  await appendFile(process.env.MEDIA_FIXTURE_PID_FILE, `${process.pid}\n`, "utf8");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function generatePng(width, height, color) {
  return execFileSync(process.env.MARKETING_TEST_FFMPEG, [
    "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${width}x${height}`,
    "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1",
  ], { maxBuffer: 8 * 1024 * 1024 });
}

function generateMp4(width, color, duration, audio, videoCodec = "libx264") {
  return execFileSync(process.env.MARKETING_TEST_FFMPEG, [
    "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${width}x1920:r=1`,
    ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=44100"] : []),
    "-t", duration, "-c:v", videoCodec, "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-enc_time_base", "1",
    ...(audio ? ["-c:a", "aac"] : []),
    "-movflags", "frag_keyframe+empty_moov", "-video_track_timescale", "1000", "-f", "mp4", "pipe:1",
  ], { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
}

const server = new McpServer({ name: "professional-media-fixture", version: "fixture-2026.10.29" });
server.registerTool("render", {
  description: "Independent deterministic protocol fixture using test-only local ffmpeg; not a commercial provider",
  inputSchema: {
    operation: z.enum(["render_xhs_png_v1", "render_channels_mp4_v1"]),
    brief: z.record(z.string(), z.unknown()),
    benchmarkAnalysis: z.record(z.string(), z.unknown()),
    sourceAssets: z.array(z.record(z.string(), z.unknown())),
    parent: z.record(z.string(), z.unknown()).optional(),
    revisionInstructions: z.string(),
    profile: z.record(z.string(), z.unknown()),
  },
}, async (input) => {
  if (process.env.MARKETING_TEST_BUSINESS_SECRET) throw new Error("Business environment leaked into fixture");
  const mode = process.env.MEDIA_FIXTURE_MODE ?? "success";
  if (mode === "provider-error") throw new Error("Independent fixture provider failure");
  if (mode === "timeout-ignore-sigterm" || mode === "success-hang") process.on("SIGTERM", () => undefined);
  if (mode === "timeout" || mode === "timeout-ignore-sigterm") await delay(5_000);
  if (mode === "success-hang") setInterval(() => undefined, 1_000);
  if (process.env.MEDIA_FIXTURE_CAPTURE) {
    await appendFile(process.env.MEDIA_FIXTURE_CAPTURE, `${JSON.stringify(canonical(input))}\n`, "utf8");
  }
  for (const asset of input.sourceAssets) {
    const content = Buffer.from(asset.contentBase64, "base64");
    if (content.length !== asset.source.byteLength ||
        createHash("sha256").update(content).digest("hex") !== asset.source.contentHash) {
      throw new Error("Fixture received source bytes that differ from their descriptor");
    }
    if (input.benchmarkAnalysis.evidenceIds.includes(asset.source.evidenceId)) {
      throw new Error("Fixture received referenced benchmark Evidence bytes");
    }
  }
  if (input.parent) {
    const content = Buffer.from(input.parent.contentBase64, "base64");
    if (content.length !== input.parent.byteLength ||
        createHash("sha256").update(content).digest("hex") !== input.parent.contentHash) {
      throw new Error("Fixture received parent bytes that differ from their descriptor");
    }
  }
  const inputHash = createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
  const color = `0x${inputHash.slice(0, 6)}`;
  let content = input.operation === "render_xhs_png_v1"
    ? generatePng(mode === "wrong-dimensions" ? 1440 : 1080, mode === "wrong-dimensions" ? 1080 : 1440, color)
    : generateMp4(
      mode === "wrong-dimensions" ? 1082 : 1080,
      color,
      mode === "wrong-duration" ? "60.001" : "2",
      mode !== "wrong-codec",
      mode === "wrong-video-codec" ? "mpeg4" : "libx264",
    );
  if (mode === "oversized-output") {
    content = Buffer.alloc((input.operation === "render_xhs_png_v1" ? 4 : 16) * 1024 * 1024 + 1, 7);
  }
  const mediaType = input.operation === "render_xhs_png_v1" ? "image/png" : "video/mp4";
  let structuredContent = {
    inputHash,
    artifact: {
      mediaType,
      contentBase64: content.toString("base64"),
      contentHash: createHash("sha256").update(content).digest("hex"),
      byteLength: content.length,
    },
  };
  if (mode === "malformed") structuredContent = { inputHash };
  if (mode === "unknown-field") structuredContent = { ...structuredContent, provider: "commercial-name" };
  if (mode === "wrong-input-hash") structuredContent = { ...structuredContent, inputHash: "0".repeat(64) };
  if (mode === "bad-base64") structuredContent.artifact.contentBase64 = "not***base64";
  if (mode === "bad-hash") structuredContent.artifact.contentHash = "not-a-sha256";
  if (mode === "wrong-content-hash") structuredContent.artifact.contentHash = "0".repeat(64);
  if (mode === "wrong-length") structuredContent.artifact.byteLength += 1;
  if (mode === "wrong-media-type") {
    structuredContent.artifact.mediaType = mediaType === "image/png" ? "video/mp4" : "image/png";
  }
  return {
    content: [{ type: "text", text: "professional media independent protocol fixture" }],
    structuredContent,
  };
});
await server.connect(new StdioServerTransport());

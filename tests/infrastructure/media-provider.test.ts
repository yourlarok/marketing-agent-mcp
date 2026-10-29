import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHANNEL_PROFILES,
  type BenchmarkAnalysis,
  type ContentBrief,
  type EvidenceAssetRef,
} from "../../src/domain/content-production-model.js";
import type { DomainError } from "../../src/domain/errors.js";
import {
  MEDIA_PROVIDER_LIMITS,
  McpMediaProvider,
  type MediaRenderRequest,
  type MediaSourceAsset,
} from "../../src/infrastructure/media-provider.js";
import { toCapabilityGapResult } from "../../src/mcp/error-mapper.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const fixture = fileURLToPath(new URL("../fixtures/professional-media-mcp.mjs", import.meta.url));
const rawFixture = fileURLToPath(new URL("../fixtures/raw-media-mcp.mjs", import.meta.url));
const ffmpeg = process.env.MARKETING_TEST_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const observedAt = "2026-10-29T08:00:00.000Z";
const benchmarkEvidenceId = "evidence-benchmark";

const benchmarkRef: EvidenceAssetRef = {
  sourceId: "source-benchmark",
  evidenceId: benchmarkEvidenceId,
  assetId: "asset-benchmark",
  kind: "screenshot",
  observedAt,
  contentHash: "1".repeat(64),
  byteLength: 100,
};

const benchmarkAnalysis: BenchmarkAnalysis = {
  id: "benchmark-1",
  workspaceId: "workspace-1",
  version: 1,
  createdAt: observedAt,
  updatedAt: observedAt,
  modality: "image",
  status: "completed",
  methods: [{
    id: "method-layout",
    dimension: "layout",
    pattern: "Use a clear visual hierarchy",
    transferableRule: "Lead with the main subject and preserve readable spacing",
    basis: "image",
    confidence: "medium",
    evidenceAssetRefs: [benchmarkRef],
  }],
  gaps: [],
  evidenceIds: [benchmarkEvidenceId],
  competitorDiffId: null,
  sourceVersions: [{ entityType: "evidence", id: benchmarkEvidenceId, version: 1 }],
  provider: {
    type: "mcp",
    tool: "reverse_engineer",
    toolVersion: "fixture-2026.10.28",
    inputHash: "2".repeat(64),
    analysisMethod: "independent-structural-analysis-v1",
    humanReview: "not_performed",
  },
};

function brief(channel: "xhs" | "channels"): ContentBrief {
  return {
    id: `brief-${channel}`,
    workspaceId: "workspace-1",
    version: 1,
    createdAt: observedAt,
    updatedAt: observedAt,
    channel,
    taskId: "task-1",
    recommendationId: "recommendation-1",
    benchmarkAnalysisId: benchmarkAnalysis.id,
    methodIds: ["method-layout"],
    objective: "Explain the product clearly",
    audience: "Independent business owners",
    copy: {
      hook: { id: "segment-hook", kind: "creative", text: "A clearer way to plan" },
      body: [{ id: "segment-body", kind: "creative", text: "See the important details first." }],
      cta: { id: "segment-cta", kind: "creative", text: "Explore the workflow" },
    },
    frames: channel === "channels" ? [{
      id: "frame-1",
      order: 1,
      purpose: "Demonstrate the workflow",
      visualDirection: "A simple product demonstration",
      onScreenText: [],
      narration: [],
      durationMs: 2_000,
    }] : [],
    assetRequirements: [],
    findingIds: [],
    evidenceIds: [benchmarkEvidenceId],
    sourceVersions: [{ entityType: "evidence", id: benchmarkEvidenceId, version: 1 }],
  };
}

function request(operation: "render_xhs_png_v1" | "render_channels_mp4_v1" = "render_xhs_png_v1"): MediaRenderRequest {
  return {
    operation,
    brief: brief(operation === "render_xhs_png_v1" ? "xhs" : "channels"),
    benchmarkAnalysis,
    revisionInstructions: "Initial controlled render",
    profile: operation === "render_xhs_png_v1" ? CHANNEL_PROFILES.xhs : CHANNEL_PROFILES.channels,
  };
}

function source(content = Buffer.from("independent-owned-production-source")): MediaSourceAsset {
  return {
    role: "source",
    source: {
      sourceId: "source-independent",
      evidenceId: "evidence-independent",
      assetId: "asset-independent",
      kind: "image",
      observedAt,
      contentHash: createHash("sha256").update(content).digest("hex"),
      byteLength: content.length,
    },
    ownership: "owned",
    contentBase64: content.toString("base64"),
  };
}

function provider(
  mode?: string,
  patch: { timeoutMs?: number; maxResponseBytes?: number; pidFile?: string; fixturePath?: string; capture?: string } = {},
) {
  const { pidFile, fixturePath, capture, ...options } = patch;
  return new McpMediaProvider({
    command: process.execPath,
    args: [fixturePath ?? fixture],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MARKETING_TEST_FFMPEG: ffmpeg,
      MARKETING_TEST_BUSINESS_SECRET: "must-not-reach-child",
      ...(mode === undefined ? {} : { MEDIA_FIXTURE_MODE: mode }),
      ...(pidFile === undefined ? {} : { MEDIA_FIXTURE_PID_FILE: pidFile }),
      ...(capture === undefined ? {} : { MEDIA_FIXTURE_CAPTURE: capture }),
    },
    envAllowlist: [
      "MARKETING_TEST_FFMPEG",
      "MEDIA_FIXTURE_MODE",
      "MEDIA_FIXTURE_PID_FILE",
      "MEDIA_FIXTURE_CAPTURE",
    ],
    ...options,
  });
}

async function expectGap(promise: Promise<unknown>, reason: string): Promise<void> {
  await expect(promise).rejects.toMatchObject<DomainError>({
    code: "CAPABILITY_UNAVAILABLE",
    details: {
      capability: "professional_media",
      reason,
      configurationAction: "Configure MARKETING_MEDIA_MCP_COMMAND and MARKETING_MEDIA_MCP_ARGS in the trusted deployment environment",
    },
  });
}

async function latestPid(pidFile: string): Promise<number> {
  const pids = (await readFile(pidFile, "utf8")).trim().split("\n");
  return Number(pids.at(-1));
}

function expectProcessExited(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
}

function runningFixturePids(fixturePath: string): number[] {
  const processes = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  return processes.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match?.[2]?.includes(fixturePath) ? [Number(match[1])] : [];
  });
}

describe("controlled professional media stdio MCP provider", () => {
  it.each([
    ["render_xhs_png_v1", "image/png", 4 * 1024 * 1024],
    ["render_channels_mp4_v1", "video/mp4", 16 * 1024 * 1024],
  ] as const)("renders %s once and recomputes the real artifact hash and length", async (operation, mediaType, maxBytes) => {
    const tempDir = await createTempDir();
    const capture = join(tempDir, "request.jsonl");
    try {
      const input = request(operation);
      const response = await provider(undefined, { capture }).render(input);
      const content = Buffer.from(response.content);
      expect(content.length).toBeGreaterThan(100);
      expect(content.length).toBeLessThanOrEqual(maxBytes);
      expect(response.artifact).toEqual({
        mediaType,
        contentHash: createHash("sha256").update(content).digest("hex"),
        byteLength: content.length,
      });
      expect(response.inputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(response.toolVersion).toBe("fixture-2026.10.29");
      expect(response.content).toBeInstanceOf(Uint8Array);
      const captured = JSON.parse((await readFile(capture, "utf8")).trim());
      expect(captured.operation).toBe(operation);
      expect(captured.brief).toEqual(input.brief);
      expect(captured.benchmarkAnalysis).toEqual(input.benchmarkAnalysis);
      expect(captured.profile).toEqual(input.profile);
      expect(captured.sourceAssets).toEqual([]);
      expect(captured).not.toHaveProperty("command");
      expect(captured).not.toHaveProperty("env");
    } finally {
      await removeTempDir(tempDir);
    }
  }, 20_000);

  it("forwards only independent authorized source bytes and produces deterministic changed derivative bytes", async () => {
    const root = await provider().render(request());
    const parentContent = Buffer.from(root.content);
    const input: MediaRenderRequest = {
      ...request(),
      sourceAssets: [{ ...source(), ownership: "authorized" }],
      parent: {
        role: "parent",
        assetVersionId: "asset-version-1",
        artifactId: "artifact-1",
        mediaType: "image/png",
        contentHash: createHash("sha256").update(parentContent).digest("hex"),
        byteLength: parentContent.length,
        contentBase64: parentContent.toString("base64"),
      },
      revisionInstructions: "Change the background and tighten the layout",
    };
    const derivative = await provider().render(input);
    expect(createHash("sha256").update(derivative.content).digest("hex")).not.toBe(root.artifact.contentHash);
    expect(derivative.artifact.byteLength).toBe(Buffer.from(derivative.content).length);
  }, 20_000);

  it("does not forward business MARKETING secrets by default", async () => {
    const response = await provider().render(request());
    expect(response.artifact.mediaType).toBe("image/png");
  });

  it("rejects benchmark Evidence bytes, forged source descriptors, excess sources, and excess total bytes before spawn", async () => {
    const unavailable = new McpMediaProvider({ command: "/definitely/missing/media-provider" });
    await expect(unavailable.render({ ...request(), sourceAssets: [{ ...source(), source: benchmarkRef }] }))
      .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    const forged = source();
    forged.source.byteLength += 1;
    await expect(unavailable.render({ ...request(), sourceAssets: [forged] }))
      .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expect(unavailable.render({
      ...request(),
      sourceAssets: Array.from({ length: MEDIA_PROVIDER_LIMITS.maxSourceAssets + 1 }, () => source()),
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expect(unavailable.render({
      ...request(),
      sourceAssets: [source(Buffer.alloc(MEDIA_PROVIDER_LIMITS.maxTotalSourceBytes + 1))],
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it("rejects public command, environment, code, path, and inexact profile overrides", async () => {
    const unavailable = new McpMediaProvider({ command: "/definitely/missing/media-provider" });
    for (const extra of [{ env: { TOKEN: "x" } }, { command: "sh" }, { code: "process.exit()" }, { path: "/tmp/x" }]) {
      await expect(unavailable.render({ ...request(), ...extra } as MediaRenderRequest))
        .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    }
    await expect(unavailable.render({
      ...request(),
      profile: { ...CHANNEL_PROFILES.xhs, width: 1440 },
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it("returns explicit configuration and availability gaps", async () => {
    await expectGap(new McpMediaProvider({}).render(request()), "mcp_not_configured");
    await expectGap(new McpMediaProvider({ command: "/definitely/missing/media-provider" }).render(request()), "mcp_unavailable");
    expect(() => new McpMediaProvider({ command: "  " })).toThrowError(/must not be empty/);
  });

  it.each([
    ["malformed", "mcp_invalid_response"],
    ["unknown-field", "mcp_invalid_response"],
    ["wrong-input-hash", "mcp_input_hash_mismatch"],
    ["bad-base64", "mcp_invalid_response"],
    ["bad-hash", "mcp_invalid_response"],
    ["wrong-content-hash", "mcp_result_mismatch"],
    ["wrong-length", "mcp_result_mismatch"],
    ["wrong-media-type", "mcp_result_mismatch"],
    ["provider-error", "mcp_unavailable"],
  ])("rejects fixture mode %s with stable reason %s", async (mode, reason) => {
    await expectGap(provider(mode).render(request()), reason);
  }, 20_000);

  it("rejects actual output beyond the operation byte limit", async () => {
    await expectGap(provider("oversized-output").render(request()), "mcp_response_too_large");
  }, 20_000);

  it("bounds raw JSON-RPC envelopes before parsing with a low test override", async () => {
    const raw = new McpMediaProvider({
      command: process.execPath,
      args: [rawFixture],
      maxResponseBytes: 4_096,
      timeoutMs: 2_000,
    });
    await expectGap(raw.render(request()), "mcp_response_too_large");
  });

  it("confirms process exit after timeout and SIGTERM-ignore escalation", async () => {
    const fixtureDir = await mkdtemp(join(dirname(fixture), "media-timeout-"));
    const fixturePath = join(fixtureDir, "timeout-fixture.mjs");
    await copyFile(fixture, fixturePath);
    try {
      for (const mode of ["timeout", "timeout-ignore-sigterm"]) {
        await expectGap(provider(mode, { timeoutMs: 100, fixturePath }).render(request()), "mcp_timeout");
        expect(runningFixturePids(fixturePath)).toEqual([]);
      }
    } finally {
      await removeTempDir(fixtureDir);
    }
  }, 10_000);

  it("leaves no child after a successful hanging fixture", async () => {
    const tempDir = await createTempDir();
    const pidFile = join(tempDir, "provider-pid");
    const started = Date.now();
    try {
      const response = await provider("success-hang", { pidFile }).render(request());
      expect(response.artifact.mediaType).toBe("image/png");
      expect(Date.now() - started).toBeLessThan(2_000);
      expectProcessExited(await latestPid(pidFile));
    } finally {
      await removeTempDir(tempDir);
    }
  }, 10_000);

  it("maps only fixed safe media gap details", async () => {
    try {
      await new McpMediaProvider({}).render(request());
      throw new Error("Expected render to fail");
    } catch (error) {
      const mapped = toCapabilityGapResult(error);
      expect(mapped?.structuredContent).toEqual({
        code: "CAPABILITY_UNAVAILABLE",
        message: "Capability unavailable",
        retryable: false,
        capability: "professional_media",
        configurationAction: "Configure MARKETING_MEDIA_MCP_COMMAND and MARKETING_MEDIA_MCP_ARGS in the trusted deployment environment",
        reason: "mcp_not_configured",
      });
    }
  });
});

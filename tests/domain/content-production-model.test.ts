import { describe, expect, it } from "vitest";
import {
  ASSET_ARTIFACT_CHUNK_MAX_BYTES,
  BENCHMARK_METHOD_DIMENSIONS,
  CHANNEL_PROFILES,
  MAX_ASSET_RESPONSE_BYTES,
  METHOD_CONFIDENCES,
  OBSERVATION_BASES,
  createAssetVersion,
  createBenchmarkAnalysis,
  createContentBrief,
  validateAssetVersion,
  validateBenchmarkAnalysis,
  validateContentBrief,
  type AssetVersion,
  type BenchmarkAnalysis,
  type BenchmarkMethod,
  type ContentBrief,
  type ContentSegment,
  type EvidenceAssetRef,
} from "../../src/domain/content-production-model.js";
import { ARTIFACT_KINDS } from "../../src/domain/model.js";

const now = "2026-10-28T12:00:00.000Z";
const hash = "a".repeat(64);

function assetRef(overrides: Record<string, unknown> = {}): EvidenceAssetRef {
  return {
    sourceId: "source-1",
    evidenceId: "evidence-1",
    assetId: "asset-1",
    kind: "screenshot",
    observedAt: now,
    contentHash: hash,
    byteLength: 128,
    ...overrides,
  } as EvidenceAssetRef;
}

function method(overrides: Record<string, unknown> = {}): BenchmarkMethod {
  return {
    id: "method-1",
    dimension: "hook",
    pattern: "A question precedes the supporting detail",
    transferableRule: "Open with the audience problem before adding detail",
    basis: "text",
    confidence: "medium",
    evidenceAssetRefs: [assetRef()],
    ...overrides,
  } as BenchmarkMethod;
}

function benchmark(overrides: Record<string, unknown> = {}): BenchmarkAnalysis {
  return createBenchmarkAnalysis({
    id: "benchmark-1",
    workspaceId: "workspace-1",
    createdAt: now,
    modality: "image",
    status: "completed",
    methods: [method()],
    gaps: [],
    evidenceIds: ["evidence-1"],
    competitorDiffId: "diff-1",
    sourceVersions: [
      { entityType: "source", id: "source-1", version: 1 },
      { entityType: "evidence", id: "evidence-1", version: 1 },
      { entityType: "competitor_diff", id: "diff-1", version: 1 },
    ],
    provider: {
      type: "mcp",
      tool: "reverse_engineer",
      toolVersion: "fixture-1",
      inputHash: "b".repeat(64),
      analysisMethod: "structural-fixture-v1",
      humanReview: "not_performed",
    },
    ...overrides,
  });
}

const creative = (id = "creative-1"): ContentSegment => ({
  id,
  kind: "creative",
  text: "Original creative copy",
});
const fact = (id = "fact-1"): ContentSegment => ({
  id,
  kind: "fact",
  text: "A traceable fact",
  findingId: "finding-1",
});

function brief(overrides: Record<string, unknown> = {}): ContentBrief {
  return createContentBrief({
    id: "brief-1",
    workspaceId: "workspace-1",
    createdAt: now,
    channel: "xhs",
    taskId: "task-1",
    recommendationId: "recommendation-1",
    benchmarkAnalysisId: "benchmark-1",
    methodIds: ["method-1"],
    objective: "Explain the offer clearly",
    audience: "Prospective learners",
    copy: { hook: creative("hook"), body: [fact("body-fact")], cta: creative("cta") },
    frames: [{
      id: "frame-1",
      order: 1,
      purpose: "Introduce the offer",
      visualDirection: "A simple product demonstration",
      onScreenText: [creative("screen")],
      narration: [creative("narration")],
      durationMs: null,
    }],
    assetRequirements: ["One original product photograph"],
    findingIds: ["finding-1"],
    evidenceIds: ["evidence-1"],
    sourceVersions: [
      { entityType: "task", id: "task-1", version: 2 },
      { entityType: "recommendation", id: "recommendation-1", version: 1 },
      { entityType: "benchmark_analysis", id: "benchmark-1", version: 1 },
      { entityType: "finding", id: "finding-1", version: 1 },
      { entityType: "evidence", id: "evidence-1", version: 1 },
      { entityType: "source", id: "source-1", version: 1 },
    ],
    ...overrides,
  });
}

function asset(overrides: Record<string, unknown> = {}): AssetVersion {
  return createAssetVersion({
    id: "asset-version-1",
    workspaceId: "workspace-1",
    createdAt: now,
    contentId: "content-1",
    channel: "xhs",
    briefId: "brief-1",
    briefVersion: 1,
    taskId: "task-1",
    recommendationId: "recommendation-1",
    parentVersionId: null,
    parentVersion: null,
    artifact: {
      id: "primary-1",
      kind: "primary",
      mediaType: "image/png",
      contentHash: hash,
      byteLength: 1024,
    },
    sourceMaterials: [{ role: "source", source: assetRef(), ownership: "owned" }],
    modification: {
      summary: "Initial version",
      revisionInstructions: "Create the original asset",
      actor: "agent-1",
      requestId: "request-1",
      createdAt: now,
    },
    provider: {
      type: "mcp",
      tool: "render",
      toolVersion: "fixture-1",
      inputHash: "c".repeat(64),
    },
    validation: {
      status: "passed",
      profileId: "xhs_png_1080x1440_v1",
      guarantee: "internal_acceptance_only",
      decoder: "playwright_chromium",
      width: 1080,
      height: 1440,
      durationMs: null,
      videoCodec: null,
      audioCodec: null,
    },
    evidenceIds: ["evidence-1"],
    sourceVersions: [
      { entityType: "content_brief", id: "brief-1", version: 1 },
      { entityType: "task", id: "task-1", version: 2 },
      { entityType: "recommendation", id: "recommendation-1", version: 1 },
      { entityType: "evidence", id: "evidence-1", version: 1 },
      { entityType: "source", id: "source-1", version: 1 },
    ],
    ...overrides,
  });
}

describe("content production profiles and evidence contracts", () => {
  it("defines the exact internal-only channel acceptance profiles and separate response guards", () => {
    expect(CHANNEL_PROFILES).toEqual({
      xhs: {
        profileId: "xhs_png_1080x1440_v1",
        channel: "xhs",
        mediaType: "image/png",
        width: 1080,
        height: 1440,
        maxBytes: 4 * 1024 * 1024,
        maxDurationMs: null,
        videoCodec: null,
        audioCodec: null,
        decoder: "playwright_chromium",
        guarantee: "internal_acceptance_only",
      },
      channels: {
        profileId: "channels_mp4_1080x1920_h264_aac_v1",
        channel: "channels",
        mediaType: "video/mp4",
        width: 1080,
        height: 1920,
        maxBytes: 16 * 1024 * 1024,
        maxDurationMs: 60_000,
        videoCodec: "h264",
        audioCodec: "aac",
        probe: "ffprobe",
        guarantee: "internal_acceptance_only",
      },
    });
    expect(ASSET_ARTIFACT_CHUNK_MAX_BYTES).toBe(32 * 1024);
    expect(MAX_ASSET_RESPONSE_BYTES).toBe(64 * 1024);
  });

  it("extends evidence artifacts for persisted video understanding without changing existing kinds", () => {
    expect(ARTIFACT_KINDS).toEqual([
      "original",
      "normalized_jsonl",
      "quality_report",
      "page_text",
      "screenshot",
      "api_response",
      "snapshot",
      "video",
      "video_frames",
      "asr_transcript",
    ]);
  });

  it("accepts every method dimension, observation basis, and confidence with actual refs", () => {
    for (const dimension of BENCHMARK_METHOD_DIMENSIONS) {
      for (const basis of OBSERVATION_BASES) {
        for (const confidence of METHOD_CONFIDENCES) {
          expect(benchmark({ methods: [method({ dimension, basis, confidence })] }).methods[0]).toMatchObject({
            dimension,
            basis,
            confidence,
          });
        }
      }
    }
    expect(BENCHMARK_METHOD_DIMENSIONS).toEqual([
      "hook", "information_order", "layout", "shot_rhythm", "cta", "other",
    ]);
    expect(OBSERVATION_BASES).toEqual(["text", "image", "video_frames", "asr", "video_frames_and_asr"]);
    expect(METHOD_CONFIDENCES).toEqual(["high", "medium", "low", "unknown"]);
  });

  it.each([
    ["missing method refs", { methods: [method({ evidenceAssetRefs: [] })] }],
    ["uppercase evidence hash", { methods: [method({ evidenceAssetRefs: [assetRef({ contentHash: "A".repeat(64) })] })] }],
    ["non-UTC observation", { methods: [method({ evidenceAssetRefs: [assetRef({ observedAt: "2026-10-28T20:00:00+08:00" })] })] }],
    ["unsafe byte length", { methods: [method({ evidenceAssetRefs: [assetRef({ byteLength: Number.MAX_SAFE_INTEGER + 1 })] })] }],
    ["negative byte length", { methods: [method({ evidenceAssetRefs: [assetRef({ byteLength: -1 })] })] }],
    ["wrong provider type", { provider: { ...benchmark().provider, type: "local" } }],
    ["wrong reverse tool", { provider: { ...benchmark().provider, tool: "render" } }],
    ["human review claimed", { provider: { ...benchmark().provider, humanReview: "performed" } }],
    ["invalid provider input hash", { provider: { ...benchmark().provider, inputHash: "not-a-hash" } }],
    ["too many methods", { methods: Array.from({ length: 21 }, (_, index) => method({ id: `method-${index}` })) }],
    ["too many gaps", { gaps: Array.from({ length: 21 }, (_, index) => ({ code: `gap-${index}`, message: "Missing observation" })) }],
    ["duplicate method IDs", { methods: [method(), method()] }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => benchmark(overrides)).toThrow();
  });

  it("requires every Benchmark method Evidence ref to be declared in top-level evidenceIds", () => {
    const nested = method({ evidenceAssetRefs: [assetRef({ evidenceId: "evidence-2" })] });
    expect(() => benchmark({ methods: [nested] })).toThrow(/evidenceIds/i);
    expect(benchmark({ evidenceIds: ["evidence-1", "evidence-2"], methods: [nested] }).evidenceIds).toEqual([
      "evidence-1",
      "evidence-2",
    ]);
  });

  it("keeps BenchmarkAnalysis below 64 KiB", () => {
    expect(() => benchmark({ methods: [method({ pattern: "x".repeat(MAX_ASSET_RESPONSE_BYTES) })] })).toThrow(/64/i);
  });
});

describe("ContentBrief contracts", () => {
  it("accepts creative and fact discriminants and derives version one", () => {
    const value = brief();
    expect(value.version).toBe(1);
    expect(value.updatedAt).toBe(now);
    expect(value.copy.body[0]).toEqual(fact("body-fact"));
    expect(() => validateContentBrief(value)).not.toThrow();
  });

  it.each([
    ["creative with findingId", { ...creative(), findingId: "finding-1" }],
    ["fact without findingId", { id: "fact-1", kind: "fact", text: "Fact" }],
    ["unknown segment kind", { id: "segment-1", kind: "inference", text: "Inference" }],
  ])("rejects %s", (_label, segment) => {
    expect(() => brief({ copy: { hook: segment, body: [creative()], cta: creative("cta") } })).toThrow();
  });

  it("rejects duplicate segment IDs across copy and frames", () => {
    expect(() => brief({
      copy: { hook: creative("duplicate"), body: [creative("duplicate")], cta: creative("cta") },
    })).toThrow(/duplicate/i);
    expect(() => brief({
      copy: { hook: creative("duplicate"), body: [fact()], cta: creative("cta") },
      frames: [{ ...brief().frames[0]!, onScreenText: [creative("duplicate")] }],
    })).toThrow(/duplicate/i);
  });

  it("rejects duplicate and nonconsecutive frames and oversized bodies", () => {
    expect(() => brief({ frames: [brief().frames[0]!, brief().frames[0]!] })).toThrow(/duplicate|order/i);
    expect(() => brief({ frames: [{ ...brief().frames[0]!, order: 2 }] })).toThrow(/order/i);
    expect(() => brief({
      copy: { hook: creative("hook"), body: Array.from({ length: 21 }, (_, index) => creative(`body-${index}`)), cta: creative("cta") },
    })).toThrow(/body/i);
    expect(() => brief({ copy: { hook: creative("hook"), body: [], cta: creative("cta") } })).toThrow(/body/i);
  });

  it("enforces XHS null durations and Channels positive bounded durations", () => {
    expect(() => brief({ frames: [{ ...brief().frames[0]!, durationMs: 1000 }] })).toThrow(/duration/i);
    const channelsFrame = { ...brief().frames[0]!, durationMs: 60_000 };
    expect(brief({ channel: "channels", frames: [channelsFrame] }).frames[0]?.durationMs).toBe(60_000);
    for (const durationMs of [0, -1, 60_001, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => brief({ channel: "channels", frames: [{ ...channelsFrame, durationMs }] })).toThrow(/duration/i);
    }
    expect(() => brief({
      channel: "channels",
      frames: [
        { ...channelsFrame, durationMs: 30_000 },
        { ...channelsFrame, id: "frame-2", order: 2, durationMs: 30_001, onScreenText: [], narration: [] },
      ],
    })).toThrow(/60,000|60000|duration/i);
  });

  it("requires fact segments to be represented in findingIds", () => {
    expect(() => brief({ findingIds: [] })).toThrow(/finding/i);
  });
});

describe("AssetVersion contracts", () => {
  it("accepts exact PNG validation and owned/authorized source material", () => {
    expect(asset().version).toBe(1);
    expect(asset({ sourceMaterials: [{ role: "source", source: assetRef(), ownership: "authorized" }] }).sourceMaterials[0]).toMatchObject({ ownership: "authorized" });
    expect(() => validateAssetVersion(asset())).not.toThrow();
  });

  it("requires every source material Evidence ref to be declared in top-level evidenceIds", () => {
    const sourceMaterials = [{
      role: "source" as const,
      source: assetRef({ evidenceId: "evidence-2" }),
      ownership: "owned" as const,
    }];
    expect(() => asset({ sourceMaterials })).toThrow(/evidenceIds/i);
    expect(asset({ evidenceIds: ["evidence-1", "evidence-2"], sourceMaterials }).evidenceIds).toEqual([
      "evidence-1",
      "evidence-2",
    ]);
  });

  it("accepts exact MP4 validation at the 60-second boundary", () => {
    const value = asset({
      channel: "channels",
      artifact: { ...asset().artifact, mediaType: "video/mp4" },
      validation: {
        status: "passed",
        profileId: "channels_mp4_1080x1920_h264_aac_v1",
        guarantee: "internal_acceptance_only",
        probe: "ffprobe",
        probeVersion: "7.1",
        width: 1080,
        height: 1920,
        durationMs: 60_000,
        videoCodec: "h264",
        audioCodec: "aac",
      },
    });
    expect(value.validation).toMatchObject({ durationMs: 60_000, videoCodec: "h264", audioCodec: "aac" });
  });

  it.each([
    ["uppercase artifact hash", { artifact: { ...asset().artifact, contentHash: "A".repeat(64) } }],
    ["wrong media type", { artifact: { ...asset().artifact, mediaType: "image/jpeg" } }],
    ["profile mismatch", { validation: { ...asset().validation, width: 1440 } }],
    ["provider mismatch", { provider: { ...asset().provider, tool: "reverse_engineer" } }],
    ["external public source material", { sourceMaterials: [{ role: "source", source: assetRef(), ownership: "external_public" }] }],
    ["non-UTC modification", { modification: { ...asset().modification, createdAt: "2026-10-28T20:00:00+08:00" } }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => asset(overrides)).toThrow();
  });

  it.each([
    ["root parent ID", { parentVersionId: "asset-parent" }],
    ["root parent version", { parentVersion: 1 }],
    ["derivative missing parent", { version: 2, parentVersionId: null, parentVersion: 1 }],
    ["derivative missing parent version", { version: 2, parentVersionId: "asset-parent", parentVersion: null }],
    ["derivative version mismatch", { version: 3, parentVersionId: "asset-parent", parentVersion: 1 }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => asset(overrides)).toThrow(/parent|version/i);
  });

  it("allows a derivative only with both exact parent fields and source descriptor", () => {
    const value = asset({
      id: "asset-version-2",
      version: 2,
      parentVersionId: "asset-version-1",
      parentVersion: 1,
      sourceMaterials: [{
        role: "parent",
        assetVersionId: "asset-version-1",
        artifactId: "primary-1",
        mediaType: "image/png",
        contentHash: hash,
        byteLength: 1024,
      }],
      sourceVersions: [...asset().sourceVersions, { entityType: "asset_version", id: "asset-version-1", version: 1 }],
    });
    expect(value).toMatchObject({ version: 2, parentVersionId: "asset-version-1", parentVersion: 1 });
  });

  it.each(["approved", "scheduled", "published", "performance"])("has no %s field", (field) => {
    expect(asset()).not.toHaveProperty(field);
    expect(() => validateAssetVersion({ ...asset(), [field]: true } as AssetVersion)).toThrow(/unsupported/i);
  });
});

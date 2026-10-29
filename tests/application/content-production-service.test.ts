import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CreateContentBrief,
  DeriveAssetVersion,
  GenerateAssetVersion,
} from "../../src/application/content-production-commands.js";
import { ContentProductionService } from "../../src/application/content-production-service.js";
import type { Command, CommandContext } from "../../src/application/commands.js";
import type { Store } from "../../src/application/ports.js";
import {
  CHANNEL_PROFILES,
  createBenchmarkAnalysis,
  type ContentBrief,
  type ContentSegment,
} from "../../src/domain/content-production-model.js";
import { DomainError } from "../../src/domain/errors.js";
import type { Evidence, Finding, Recommendation, Source, Task } from "../../src/domain/model.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import {
  McpMediaProvider,
  computeMediaRenderInputHash,
  type MediaProvider,
  type MediaRenderRequest,
  type MediaRenderResponse,
} from "../../src/infrastructure/media-provider.js";
import { MediaValidator } from "../../src/infrastructure/media-validation.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-29T10:00:00.000Z";
const workspaceId = "workspace-1";
const fixture = fileURLToPath(new URL("../fixtures/professional-media-mcp.mjs", import.meta.url));
const ffmpeg = process.env.MARKETING_TEST_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const ffprobe = process.env.MARKETING_TEST_FFPROBE ?? "/opt/homebrew/bin/ffprobe";

function context(suffix: string): CommandContext {
  return { actor: "agent-1", requestId: `request-${suffix}`, idempotencyKey: `content-${suffix}` };
}

class StubProvider implements MediaProvider {
  calls = 0;
  requests: MediaRenderRequest[] = [];

  constructor(private readonly behavior?: (request: MediaRenderRequest, call: number) => Promise<Uint8Array> | Uint8Array) {}

  async render(request: MediaRenderRequest): Promise<MediaRenderResponse> {
    this.calls += 1;
    this.requests.push(request);
    const content = this.behavior
      ? await this.behavior(request, this.calls)
      : Buffer.from(`controlled-render-${this.calls}-${request.revisionInstructions}`);
    const bytes = Buffer.from(content);
    return {
      content: new Uint8Array(bytes),
      artifact: {
        mediaType: request.brief.channel === "xhs" ? "image/png" : "video/mp4",
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.length,
      },
      inputHash: computeMediaRenderInputHash(request),
      toolVersion: "service-stub-1",
    };
  }
}

function passingValidator(): MediaValidator {
  return {
    validateXhsPng: async () => ({
      status: "passed", profileId: CHANNEL_PROFILES.xhs.profileId, guarantee: "internal_acceptance_only",
      decoder: "playwright_chromium", width: 1080, height: 1440,
      durationMs: null, videoCodec: null, audioCodec: null,
    }),
    validateChannelsMp4: async () => ({
      status: "passed", profileId: CHANNEL_PROFILES.channels.profileId, guarantee: "internal_acceptance_only",
      probe: "ffprobe", probeVersion: "service-stub-probe", width: 1080, height: 1920,
      durationMs: 2_000, videoCodec: "h264", audioCodec: "aac",
    }),
  } as MediaValidator;
}

function creative(id: string, text = `Original creative copy for ${id}`): ContentSegment {
  return { id, kind: "creative", text };
}

function fact(id: string, findingId = "finding-fact", text = `Traceable copy for ${id}`): ContentSegment {
  return { id, kind: "fact", findingId, text };
}

function briefInput(channel: "xhs" | "channels" = "xhs"): CreateContentBrief {
  return {
    id: `brief-${channel}`,
    workspaceId,
    taskId: "task-1",
    expectedTaskVersion: 1,
    recommendationId: "recommendation-1",
    expectedRecommendationVersion: 1,
    benchmarkAnalysisId: "benchmark-1",
    expectedBenchmarkVersion: 1,
    channel,
    methodIds: ["method-1"],
    objective: "Explain an original operating workflow",
    audience: "Independent operators",
    copy: { hook: creative("hook"), body: [fact("body-fact")], cta: creative("cta") },
    frames: channel === "channels" ? [
      {
        id: "shot-1", order: 1, purpose: "Establish the workflow", visualDirection: "Original wide product shot",
        onScreenText: [creative("shot-1-screen")], narration: [fact("shot-1-narration")], durationMs: 1_000,
      },
      {
        id: "shot-2", order: 2, purpose: "Show the result", visualDirection: "Original close product shot",
        onScreenText: [fact("shot-2-screen")], narration: [creative("shot-2-narration")], durationMs: 1_000,
      },
    ] : [{
      id: "frame-1", order: 1, purpose: "Show the workflow", visualDirection: "Original product photograph",
      onScreenText: [creative("frame-screen")], narration: [fact("frame-narration")], durationMs: null,
    }],
    assetRequirements: ["One independently owned product photograph"],
  };
}

function generationInput(briefId = "brief-xhs"): GenerateAssetVersion {
  return {
    id: `asset-${briefId}`,
    workspaceId,
    contentId: `content-${briefId}`,
    briefId,
    expectedBriefVersion: 1,
    sourceMaterials: [],
    revisionInstructions: "Create the initial controlled asset",
  };
}

describe("ContentProductionService", () => {
  let tempDir: string;
  let artifactRoot: string;
  let storePath: string;
  let store: Store;
  let artifacts: ArtifactStore;
  let provider: StubProvider;
  let validator: MediaValidator;
  let service: ContentProductionService;
  let sequence: number;

  beforeEach(async () => {
    tempDir = await createTempDir();
    artifactRoot = await createTempDir();
    storePath = join(tempDir, "content.db");
    store = openStore(storePath);
    artifacts = new ArtifactStore(artifactRoot);
    provider = new StubProvider();
    validator = passingValidator();
    sequence = 0;
    service = createService();
    await seedGraph();
  });

  afterEach(async () => {
    store.close();
    await Promise.all([removeTempDir(tempDir), removeTempDir(artifactRoot)]);
  });

  function createService(currentStore = store, currentProvider: MediaProvider = provider, currentValidator = validator) {
    return new ContentProductionService(
      currentStore,
      { now: () => now },
      { next: () => `audit-${++sequence}` },
      artifacts,
      currentProvider,
      currentValidator,
    );
  }

  async function seedGraph(): Promise<void> {
    const externalText = "A public benchmark describes its own structurally observed campaign sequence.";
    const storedExternal = await artifacts.put(Buffer.from(externalText));
    const base = { workspaceId, version: 1, createdAt: now, updatedAt: now };
    const ownedSource: Source = { ...base, id: "source-owned", name: "Owned records", type: "manual", ownership: "owned" };
    const externalSource: Source = { ...base, id: "source-external", name: "Public benchmark", type: "link", ownership: "external_public" };
    const ownedEvidence: Evidence = {
      ...base, id: "evidence-fact", sourceId: ownedSource.id, sourceLocator: "ledger/month-1", observedAt: now,
      summary: "Owned reconciled fact", contentHash: "a".repeat(64), classification: "owned_operating",
    };
    const benchmarkEvidence: Evidence = {
      ...base, id: "evidence-benchmark", sourceId: externalSource.id, sourceLocator: "https://example.test/benchmark",
      observedAt: now, summary: "Public structural observation", contentHash: storedExternal.contentHash,
      classification: "external_observation", assets: [{ id: "benchmark-page", kind: "page_text", ...storedExternal }],
    };
    const finding: Finding = { ...base, id: "finding-fact", kind: "fact", statement: "The ledger reconciled", evidenceIds: [ownedEvidence.id] };
    const recommendation: Recommendation = {
      ...base, id: "recommendation-1", findingIds: [finding.id], evidenceIds: [ownedEvidence.id],
      hypothesis: "A clear workflow will help operators", affectedStage: "activation", priority: "high",
      expectedMetric: "activation", targetChannels: ["xhs", "channels"],
    };
    const task: Task = {
      ...base, id: "task-1", recommendationIds: [recommendation.id], assignee: "marketer", dependencyIds: [],
      assetRequirements: ["Original channel asset"], acceptanceCriteria: ["Internally validated asset"], state: "ready",
    };
    const benchmark = createBenchmarkAnalysis({
      id: "benchmark-1", workspaceId, createdAt: now, modality: "image", status: "completed",
      methods: [{
        id: "method-1", dimension: "information_order", pattern: "Observed sequence",
        transferableRule: "Transfer only the structural ordering", basis: "text", confidence: "medium",
        evidenceAssetRefs: [{
          sourceId: externalSource.id, evidenceId: benchmarkEvidence.id, assetId: "benchmark-page", kind: "page_text",
          observedAt: now, contentHash: storedExternal.contentHash, byteLength: storedExternal.byteLength,
        }],
      }],
      gaps: [], evidenceIds: [benchmarkEvidence.id], competitorDiffId: null,
      sourceVersions: [
        { entityType: "source", id: externalSource.id, version: 1 },
        { entityType: "evidence", id: benchmarkEvidence.id, version: 1 },
      ],
      provider: {
        type: "mcp", tool: "reverse_engineer", toolVersion: "fixture-1", inputHash: "b".repeat(64),
        analysisMethod: "structural-fixture", humanReview: "not_performed",
      },
    });
    await store.transaction(async (repos) => {
      await repos.workspaces.insert({ ...base, id: workspaceId, name: "Workspace" });
      await repos.sources.insert(ownedSource);
      await repos.sources.insert(externalSource);
      await repos.evidence.insert(ownedEvidence);
      await repos.evidence.insert(benchmarkEvidence);
      await repos.findings.insert(finding);
      await repos.recommendations.insert(recommendation);
      await repos.tasks.insert(task);
      await repos.benchmarkAnalyses.insert(benchmark);
    });
  }

  async function createBrief(channel: "xhs" | "channels" = "xhs", suffix = channel): Promise<ContentBrief> {
    return service.createBrief({ input: briefInput(channel), context: context(`brief-${suffix}`) });
  }

  async function getAsset(id: string) {
    return store.transaction((repos) => repos.assetVersions.get(id, workspaceId));
  }

  async function expectNoSuccess(id: string, key: string): Promise<void> {
    expect(await getAsset(id)).toBeUndefined();
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "asset_version", id))).toEqual([]);
    expect(await store.transaction((repos) => repos.idempotency.get(workspaceId, key))).toBeUndefined();
  }

  it("creates XHS and 1000+1000 ms Channels briefs with derived refs and immutable versions", async () => {
    const xhs = await createBrief();
    expect(xhs).toMatchObject({ channel: "xhs", version: 1, findingIds: ["finding-fact"], evidenceIds: ["evidence-fact"] });
    expect(xhs.sourceVersions).toEqual([
      { entityType: "task", id: "task-1", version: 1 },
      { entityType: "recommendation", id: "recommendation-1", version: 1 },
      { entityType: "benchmark_analysis", id: "benchmark-1", version: 1 },
      { entityType: "finding", id: "finding-fact", version: 1 },
      { entityType: "evidence", id: "evidence-fact", version: 1 },
      { entityType: "source", id: "source-owned", version: 1 },
    ]);
    const channelsInput = briefInput("channels");
    const channels = await service.createBrief({ input: channelsInput, context: context("brief-channels") });
    expect(channels.frames.map((frame) => frame.durationMs)).toEqual([1_000, 1_000]);
    expect(channels.frames.reduce((sum, frame) => sum + frame.durationMs!, 0)).toBe(2_000);
    expect(await service.getBrief({ id: channels.id, workspaceId })).toEqual(channels);
  });

  it.each(["draft", "blocked", "rejected", "completed"] as const)("rejects an unconfirmed %s Task", async (state) => {
    await store.transaction(async (repos) => {
      const task = (await repos.tasks.get("task-1", workspaceId))!;
      await repos.tasks.update({ ...task, state }, 1);
    });
    const input = { ...briefInput(), expectedTaskVersion: 2 };
    await expect(service.createBrief({ input, context: context(`state-${state}`) })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
  });

  it("enforces Task membership, exact target channels, selected methods, and expected versions", async () => {
    for (const [suffix, patch] of [
      ["task-version", { expectedTaskVersion: 2 }],
      ["recommendation-version", { expectedRecommendationVersion: 2 }],
      ["benchmark-version", { expectedBenchmarkVersion: 2 }],
      ["method", { methodIds: ["method-missing"] }],
      ["recommendation", { recommendationId: "recommendation-missing", expectedRecommendationVersion: 1 }],
    ] as const) {
      await expect(service.createBrief({ input: { ...briefInput(), ...patch }, context: context(suffix) }))
        .rejects.toMatchObject<DomainError>({ code: suffix.endsWith("version") ? "CONFLICT" : suffix === "recommendation" ? "NOT_FOUND" : "INVALID_INPUT" });
    }
    await store.transaction(async (repos) => {
      const recommendation = (await repos.recommendations.get("recommendation-1", workspaceId))!;
      await repos.recommendations.update({ ...recommendation, targetChannels: ["channels"] }, 1);
    });
    await expect(service.createBrief({
      input: { ...briefInput(), expectedRecommendationVersion: 2 }, context: context("channel-mismatch"),
    })).rejects.toThrow(/channel/i);
    expect(provider.calls).toBe(0);
  });

  it.each(["inference", "unknown"] as const)("rejects a fact segment backed by an %s Finding", async (kind) => {
    await store.transaction(async (repos) => {
      const evidence = (await repos.evidence.get("evidence-fact", workspaceId))!;
      await repos.findings.insert({
        id: `finding-${kind}`, workspaceId, version: 1, createdAt: now, updatedAt: now, kind,
        statement: `${kind} statement`, evidenceIds: [evidence.id], ...(kind === "inference" ? { limitations: "Limited" } : { unknownReason: "Unknown" }),
      } as Finding);
      const recommendation = (await repos.recommendations.get("recommendation-1", workspaceId))!;
      await repos.recommendations.update({ ...recommendation, findingIds: ["finding-fact", `finding-${kind}`] }, 1);
    });
    const input = { ...briefInput(), expectedRecommendationVersion: 2 };
    input.copy.body = [fact("body-fact", `finding-${kind}`)];
    await expect(service.createBrief({ input, context: context(`finding-${kind}`) })).rejects.toThrow(/fact/i);
  });

  it("rejects a fact Finding without Evidence or outside the Recommendation context", async () => {
    await store.transaction(async (repos) => {
      await repos.findings.insert({
        id: "finding-empty", workspaceId, version: 1, createdAt: now, updatedAt: now,
        kind: "fact", statement: "Invalid stored fact", evidenceIds: [],
      });
      await repos.evidence.insert({
        id: "evidence-unrelated", workspaceId, version: 1, createdAt: now, updatedAt: now,
        sourceId: "source-owned", sourceLocator: "unrelated", observedAt: now, summary: "Unrelated",
        contentHash: "d".repeat(64), classification: "owned_operating",
      });
      await repos.findings.insert({
        id: "finding-unrelated", workspaceId, version: 1, createdAt: now, updatedAt: now,
        kind: "fact", statement: "Unrelated fact", evidenceIds: ["evidence-unrelated"],
      });
    });
    for (const findingId of ["finding-empty", "finding-unrelated", "finding-missing"]) {
      const input = briefInput();
      input.copy.body = [fact("body-fact", findingId)];
      await expect(service.createBrief({ input, context: context(`context-${findingId}`) })).rejects.toThrow();
    }
  });

  it.each(["hook", "body", "cta", "onScreenText", "narration"] as const)("validates facts in %s", async (location) => {
    const input = briefInput();
    if (location === "hook") input.copy.hook = fact("hook-fact", "finding-missing");
    else if (location === "body") input.copy.body = [fact("body-fact", "finding-missing")];
    else if (location === "cta") input.copy.cta = fact("cta-fact", "finding-missing");
    else input.frames[0]![location] = [fact(`frame-${location}-fact`, "finding-missing")];
    await expect(service.createBrief({ input, context: context(`location-${location}`) })).rejects.toThrow(/Finding|finding/);
  });

  it("rejects caller-supplied Evidence IDs, hashes, paths, and base64 in segments", async () => {
    for (const [suffix, extra] of [
      ["evidence", { evidenceIds: ["evidence-fact"] }],
      ["hash", { contentHash: "a".repeat(64) }],
      ["path", { path: "/tmp/source" }],
      ["base64", { contentBase64: "AA==" }],
    ] as const) {
      const input = briefInput();
      input.copy.hook = { ...creative("hook"), ...extra } as ContentSegment;
      await expect(service.createBrief({ input, context: context(`segment-${suffix}`) })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    }
  });

  it("rejects normalized exact external-public runs in every publishable text location but accepts structural reuse", async () => {
    const external = (await store.transaction((repos) => repos.evidence.get("evidence-benchmark", workspaceId))) as Evidence;
    const copied = (await artifacts.read(external.assets![0]!.contentHash)).toString("utf8");
    const normalizedCopy = `Ａ${copied.slice(1).replace(/\s+/gu, "\n")}`;
    const patches: [string, (input: CreateContentBrief) => void][] = [
      ["objective", (input) => { input.objective = normalizedCopy; }],
      ["audience", (input) => { input.audience = normalizedCopy; }],
      ["hook", (input) => { input.copy.hook = creative("hook", normalizedCopy); }],
      ["body", (input) => { input.copy.body = [creative("body", normalizedCopy)]; }],
      ["cta", (input) => { input.copy.cta = creative("cta", normalizedCopy); }],
      ["purpose", (input) => { input.frames[0]!.purpose = normalizedCopy; }],
      ["visual", (input) => { input.frames[0]!.visualDirection = normalizedCopy; }],
      ["screen", (input) => { input.frames[0]!.onScreenText = [creative("copied-screen", normalizedCopy)]; }],
      ["narration", (input) => { input.frames[0]!.narration = [creative("copied-narration", normalizedCopy)]; }],
      ["requirements", (input) => { input.assetRequirements = [normalizedCopy]; }],
    ];
    for (const [suffix, patch] of patches) {
      const input = briefInput();
      patch(input);
      await expect(service.createBrief({ input, context: context(`copy-${suffix}`) })).rejects.toThrow(/40 Unicode code points/);
    }
    const split = briefInput();
    const copiedPoints = Array.from(copied);
    split.copy.hook = creative("hook", copiedPoints.slice(0, 19).join(""));
    split.copy.body = [creative("body", copiedPoints.slice(19).join(""))];
    await expect(service.createBrief({ input: split, context: context("copy-split-segments") })).rejects.toThrow(/40 Unicode code points/);
    const structural = briefInput();
    structural.objective = "Use a clear sequence with an entirely original explanation";
    structural.copy.body = [creative("body", "A short public benchmark describes its own")];
    await expect(service.createBrief({ input: structural, context: context("copy-structural") })).resolves.toMatchObject({ version: 1 });
  });

  it("rejects cross-workspace facts and oversized brief responses without residue", async () => {
    await store.transaction(async (repos) => {
      await repos.workspaces.insert({ id: "workspace-2", workspaceId: "workspace-2", version: 1, createdAt: now, updatedAt: now, name: "Other" });
      await repos.sources.insert({ id: "source-other", workspaceId: "workspace-2", version: 1, createdAt: now, updatedAt: now, name: "Other", type: "manual", ownership: "owned" });
      await repos.evidence.insert({ id: "evidence-other", workspaceId: "workspace-2", version: 1, createdAt: now, updatedAt: now, sourceId: "source-other", sourceLocator: "other", observedAt: now, summary: "Other", contentHash: "c".repeat(64), classification: "owned_operating" });
      await repos.findings.insert({ id: "finding-other", workspaceId: "workspace-2", version: 1, createdAt: now, updatedAt: now, kind: "fact", statement: "Other", evidenceIds: ["evidence-other"] });
    });
    const cross = briefInput();
    cross.copy.body = [fact("body-fact", "finding-other")];
    await expect(service.createBrief({ input: cross, context: context("cross-workspace") })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    const oversized = { ...briefInput(), id: "brief-oversized", objective: "x".repeat(64 * 1024) };
    await expect(service.createBrief({ input: oversized, context: context("oversized") })).rejects.toThrow(/64/);
    expect(await store.transaction((repos) => repos.contentBriefs.get("brief-oversized", workspaceId))).toBeUndefined();
  });

  it("audits and exactly replays a completed brief across restart", async () => {
    const command: Command<CreateContentBrief> = { input: briefInput(), context: context("brief-replay") };
    const first = await service.createBrief(command);
    store.close();
    store = openStore(storePath);
    service = createService(store);
    const replay = await service.createBrief(command);
    expect(replay).toEqual(first);
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "content_brief", first.id))).toHaveLength(1);
    await expect(service.getBrief({ id: first.id, workspaceId: "workspace-other" })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
  });

  it("generates and derives immutable assets with automatic parent bytes, changed hashes, audit, and exact replay", async () => {
    const brief = await createBrief();
    let decodes = 0;
    const baseValidator = passingValidator();
    validator = {
      ...baseValidator,
      validateXhsPng: async (bytes) => {
        decodes += 1;
        return baseValidator.validateXhsPng(bytes);
      },
    } as MediaValidator;
    service = createService();
    const rootCommand: Command<GenerateAssetVersion> = { input: generationInput(brief.id), context: context("generate-root") };
    const root = await service.generate(rootCommand);
    expect(root).toMatchObject({ version: 1, channel: "xhs", parentVersionId: null, parentVersion: null });
    expect(root.provider).toEqual({ type: "mcp", tool: "render", toolVersion: "service-stub-1", inputHash: computeMediaRenderInputHash(provider.requests[0]!) });
    const replay = await service.generate(rootCommand);
    expect(replay).toEqual(root);
    store.close();
    store = openStore(storePath);
    service = createService(store);
    expect(await service.generate(rootCommand)).toEqual(root);
    expect(provider.calls).toBe(1);
    expect(decodes).toBe(1);
    const deriveInput: DeriveAssetVersion = {
      id: "asset-derived", workspaceId, contentId: root.contentId, parentVersionId: root.id, expectedParentVersion: 1,
      briefId: brief.id, expectedBriefVersion: 1, sourceMaterials: [], revisionInstructions: "Change the original layout materially",
    };
    const deriveCommand = { input: deriveInput, context: context("derive-root") };
    const derived = await service.derive(deriveCommand);
    expect(derived).toMatchObject({ version: 2, parentVersionId: root.id, parentVersion: 1 });
    expect(derived.artifact.contentHash).not.toBe(root.artifact.contentHash);
    expect(derived.sourceMaterials[0]).toEqual({
      role: "parent", assetVersionId: root.id, artifactId: root.artifact.id, mediaType: root.artifact.mediaType,
      contentHash: root.artifact.contentHash, byteLength: root.artifact.byteLength,
    });
    expect(Buffer.from(provider.requests[1]!.parent!.contentBase64, "base64")).toEqual(await artifacts.read(root.artifact.contentHash));
    expect(await service.derive(deriveCommand)).toEqual(derived);
    expect(provider.calls).toBe(2);
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "asset_version", root.id))).toHaveLength(1);
    expect(await store.transaction((repos) => repos.tasks.get("task-1", workspaceId))).toMatchObject({ state: "ready", version: 1 });
    for (const field of ["approved", "scheduled", "published", "performance"]) expect(derived).not.toHaveProperty(field);
  });

  it("requires separate calls for separate channels and never accepts a caller channel override or batch", async () => {
    const xhs = await createBrief();
    const channels = await createBrief("channels");
    const first = await service.generate({ input: generationInput(xhs.id), context: context("separate-xhs") });
    const secondInput = { ...generationInput(channels.id), channel: "xhs" } as GenerateAssetVersion;
    await expect(service.generate({ input: secondInput, context: context("channel-override") })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    const second = await service.generate({ input: generationInput(channels.id), context: context("separate-channels") });
    expect([first.channel, second.channel]).toEqual(["xhs", "channels"]);
    expect(provider.requests.map((request) => request.operation)).toEqual(["render_xhs_png_v1", "render_channels_mp4_v1"]);
    expect(provider.calls).toBe(2);
  });

  it("rejects code, path, command, caller bytes, excessive sources, and unsafe revision commands", async () => {
    const brief = await createBrief();
    for (const [suffix, extra] of [
      ["code", { code: "process.exit()" }], ["path", { path: "/tmp/source" }], ["command", { command: "sh" }],
      ["base64", { contentBase64: "AA==" }], ["channel", { channel: "channels" }],
      ["sources", { sourceMaterials: Array.from({ length: 9 }, (_, index) => ({ evidenceId: `evidence-${index}`, assetId: `asset-${index}` })) }],
    ] as const) {
      await expect(service.generate({ input: { ...generationInput(brief.id), ...extra }, context: context(`unsafe-${suffix}`) }))
        .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    }
    expect(provider.calls).toBe(0);
  });

  it.each(["owned", "authorized", "external_public"] as const)("rejects selected benchmark Evidence for %s ownership and all external-public production sources", async (ownership) => {
    const brief = await createBrief();
    const bytes = Buffer.from(`independent-${ownership}`);
    const stored = await artifacts.put(bytes);
    await store.transaction(async (repos) => {
      await repos.sources.insert({ id: `source-production-${ownership}`, workspaceId, version: 1, createdAt: now, updatedAt: now, name: ownership, type: "manual", ownership });
      await repos.evidence.insert({
        id: `evidence-production-${ownership}`, workspaceId, version: 1, createdAt: now, updatedAt: now,
        sourceId: `source-production-${ownership}`, sourceLocator: "production", observedAt: now, summary: "Production",
        contentHash: stored.contentHash, classification: ownership === "external_public" ? "external_observation" : "owned_operating",
        assets: [{ id: `asset-production-${ownership}`, kind: "original", ...stored }],
      });
    });
    const external = { ...generationInput(brief.id), id: `asset-external-${ownership}`, sourceMaterials: [{ evidenceId: `evidence-production-${ownership}`, assetId: `asset-production-${ownership}` }] };
    if (ownership === "external_public") {
      await expect(service.generate({ input: external, context: context(`external-${ownership}`) })).rejects.toThrow(/external_public|owned|authorized/);
    }
    const selectedBenchmark = createBenchmarkAnalysis({
      id: `benchmark-selected-${ownership}`, workspaceId, createdAt: now, modality: "image", status: "completed", gaps: [],
      evidenceIds: [`evidence-production-${ownership}`], competitorDiffId: null,
      methods: [{
        id: "method-selected", dimension: "other", pattern: "Selected structure", transferableRule: "Structure only",
        basis: "text", confidence: "unknown", evidenceAssetRefs: [{
          sourceId: `source-production-${ownership}`, evidenceId: `evidence-production-${ownership}`,
          assetId: `asset-production-${ownership}`, kind: "original", observedAt: now,
          contentHash: stored.contentHash, byteLength: stored.byteLength,
        }],
      }],
      sourceVersions: [
        { entityType: "source", id: `source-production-${ownership}`, version: 1 },
        { entityType: "evidence", id: `evidence-production-${ownership}`, version: 1 },
      ],
      provider: { type: "mcp", tool: "reverse_engineer", toolVersion: "fixture", inputHash: "e".repeat(64), analysisMethod: "fixture", humanReview: "not_performed" },
    });
    await store.transaction((repos) => repos.benchmarkAnalyses.insert(selectedBenchmark));
    const selectedBriefInput = { ...briefInput(), id: `brief-selected-${ownership}`, benchmarkAnalysisId: selectedBenchmark.id, methodIds: ["method-selected"] };
    await service.createBrief({ input: selectedBriefInput, context: context(`brief-selected-${ownership}`) });
    const selected = { ...generationInput(selectedBriefInput.id), sourceMaterials: external.sourceMaterials };
    await expect(service.generate({ input: selected, context: context(`selected-${ownership}`) })).rejects.toThrow(/BenchmarkAnalysis|benchmark/i);
    expect(provider.calls).toBe(0);
  });

  it("verifies independent source descriptors and supported stored bytes before rendering", async () => {
    const brief = await createBrief();
    const stored = await artifacts.put(Buffer.from("independent production bytes"));
    await store.transaction(async (repos) => {
      await repos.evidence.update({
        ...(await repos.evidence.get("evidence-fact", workspaceId))!,
        assets: [{ id: "owned-source", kind: "original", ...stored }],
      }, 1);
    });
    const input = { ...generationInput(brief.id), sourceMaterials: [{ evidenceId: "evidence-fact", assetId: "owned-source" }] };
    const result = await service.generate({ input, context: context("owned-source") });
    expect(result.sourceMaterials[0]).toMatchObject({ role: "source", ownership: "owned", source: { evidenceId: "evidence-fact", assetId: "owned-source" } });
    expect(Buffer.from(provider.requests[0]!.sourceAssets![0]!.contentBase64, "base64").toString()).toBe("independent production bytes");
    const missing = { ...input, id: "asset-missing-bytes", contentId: "content-missing-bytes", sourceMaterials: [{ evidenceId: "evidence-fact", assetId: "missing" }] };
    await expect(service.generate({ input: missing, context: context("missing-source") })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    expect(provider.calls).toBe(1);
  });

  it("allows a different brief only when channel, Task, and Recommendation match and requires the latest parent", async () => {
    const firstBrief = await createBrief();
    const secondInput = { ...briefInput(), id: "brief-second", objective: "A different original objective" };
    const secondBrief = await service.createBrief({ input: secondInput, context: context("brief-second") });
    const root = await service.generate({ input: generationInput(firstBrief.id), context: context("lineage-root") });
    const derived = await service.derive({
      input: {
        id: "asset-different-brief", workspaceId, contentId: root.contentId, parentVersionId: root.id, expectedParentVersion: 1,
        briefId: secondBrief.id, expectedBriefVersion: 1, sourceMaterials: [], revisionInstructions: "Revise using the second brief",
      }, context: context("different-brief"),
    });
    expect(derived).toMatchObject({ briefId: secondBrief.id, taskId: root.taskId, recommendationId: root.recommendationId, channel: root.channel });
    await expect(service.derive({
      input: {
        id: "asset-stale-parent", workspaceId, contentId: root.contentId, parentVersionId: root.id, expectedParentVersion: 1,
        briefId: secondBrief.id, expectedBriefVersion: 1, sourceMaterials: [], revisionInstructions: "Stale parent",
      }, context: context("stale-parent"),
    })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
  });

  it("reads raw multi-chunk artifacts with stable total hash and workspace/range checks", async () => {
    const brief = await createBrief();
    const root = await service.generate({ input: generationInput(brief.id), context: context("range-root") });
    const bytes = await artifacts.read(root.artifact.contentHash);
    const first = await service.getArtifact({ id: root.id, workspaceId, artifactId: root.artifact.id, length: 5 });
    const second = await service.getArtifact({ id: root.id, workspaceId, artifactId: root.artifact.id, offset: 5, length: 32_768 });
    expect(first.content).toEqual(bytes.subarray(0, 5));
    expect(Buffer.concat([first.content, second.content])).toEqual(bytes);
    expect(second).toMatchObject({ offset: 5, length: bytes.length - 5, totalBytes: bytes.length, contentHash: root.artifact.contentHash, mediaType: "image/png" });
    await expect(service.getArtifact({ id: root.id, workspaceId: "workspace-other", artifactId: root.artifact.id })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    await expect(service.getArtifact({ id: root.id, workspaceId, artifactId: root.artifact.id, length: 32_769 })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it.each(["task", "recommendation", "finding", "evidence", "brief", "parent"] as const)("rejects stale %s during a deferred provider call without success residue", async (changed) => {
    const brief = await createBrief();
    let root: Awaited<ReturnType<ContentProductionService["generate"]>> | undefined;
    if (changed === "parent") {
      root = await service.generate({ input: generationInput(brief.id), context: context("stale-setup-root") });
    }
    let currentStore = store;
    if (changed === "brief") {
      let reads = 0;
      currentStore = {
        ...store,
        transaction: (work) => store.transaction((repos) => work({
          ...repos,
          contentBriefs: {
            ...repos.contentBriefs,
            get: async (id, scope) => {
              reads += 1;
              const value = await repos.contentBriefs.get(id, scope);
              return reads > 1 && value ? { ...value, objective: "Changed before commit" } : value;
            },
          },
        })),
      };
    }
    provider = new StubProvider(async (request, call) => {
      if (changed === "parent") {
        const current = (await store.transaction((repos) => repos.assetVersions.get(root!.id, workspaceId)))!;
        await store.transaction((repos) => repos.assetVersions.insert({
          ...current, id: "asset-newer-parent", version: 2, parentVersionId: current.id, parentVersion: 1,
          createdAt: now, updatedAt: now,
          sourceMaterials: [{ role: "parent", assetVersionId: current.id, artifactId: current.artifact.id, mediaType: current.artifact.mediaType, contentHash: current.artifact.contentHash, byteLength: current.artifact.byteLength }],
          sourceVersions: [...current.sourceVersions, { entityType: "asset_version", id: current.id, version: 1 }],
        }));
      } else if (changed !== "brief") {
        await store.transaction(async (repos) => {
          if (changed === "task") {
            const value = (await repos.tasks.get("task-1", workspaceId))!;
            await repos.tasks.update({ ...value, state: "in_progress" }, value.version);
          } else if (changed === "recommendation") {
            const value = (await repos.recommendations.get("recommendation-1", workspaceId))!;
            await repos.recommendations.update({ ...value, hypothesis: "Changed during render" }, value.version);
          } else if (changed === "finding") {
            const value = (await repos.findings.get("finding-fact", workspaceId))!;
            await repos.findings.update({ ...value, statement: "Changed during render" }, value.version);
          } else {
            const value = (await repos.evidence.get("evidence-fact", workspaceId))!;
            await repos.evidence.update({ ...value, summary: "Changed during render" }, value.version);
          }
        });
      }
      return Buffer.from(`deferred-${changed}-${call}`);
    });
    service = createService(currentStore);
    const id = `asset-stale-${changed}`;
    const key = `content-stale-${changed}`;
    const command = changed === "parent"
      ? {
          input: {
            id, workspaceId, contentId: root!.contentId, parentVersionId: root!.id, expectedParentVersion: 1,
            briefId: brief.id, expectedBriefVersion: 1, sourceMaterials: [], revisionInstructions: "Deferred derivative",
          }, context: context(`stale-${changed}`),
        }
      : { input: { ...generationInput(brief.id), id }, context: context(`stale-${changed}`) };
    const attempt = changed === "parent" ? service.derive(command as Command<DeriveAssetVersion>) : service.generate(command as Command<GenerateAssetVersion>);
    await expect(attempt).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await expectNoSuccess(id, key);
  });

  it("leaves no success after validation failure and requires a fresh validated attempt", async () => {
    const brief = await createBrief();
    provider = new StubProvider(() => Buffer.from("same-unvalidated-bytes"));
    validator = {
      ...passingValidator(),
      validateXhsPng: async () => { throw new DomainError("CAPABILITY_UNAVAILABLE", "Decode failed", false, { reason: "image_decode_failed" }); },
    } as MediaValidator;
    service = createService();
    const command = { input: generationInput(brief.id), context: context("validation-failure") };
    await expect(service.generate(command)).rejects.toMatchObject<DomainError>({ code: "CAPABILITY_UNAVAILABLE" });
    await expectNoSuccess(command.input.id, command.context.idempotencyKey);
    validator = passingValidator();
    service = createService();
    await expect(service.generate(command)).resolves.toMatchObject({ version: 1 });
    expect(provider.calls).toBe(2);
  });
});

describe("ContentProductionService real Task 3 media fixtures", () => {
  let tempDir: string;
  let artifactRoot: string;
  let store: Store;
  let artifacts: ArtifactStore;
  let service: ContentProductionService;
  let sequence: number;

  beforeEach(async () => {
    expect(existsSync(ffmpeg), `MARKETING_TEST_FFMPEG executable missing: ${ffmpeg}`).toBe(true);
    expect(existsSync(ffprobe), `MARKETING_TEST_FFPROBE executable missing: ${ffprobe}`).toBe(true);
    tempDir = await createTempDir();
    artifactRoot = await createTempDir();
    store = openStore(join(tempDir, "real-content.db"));
    artifacts = new ArtifactStore(artifactRoot);
    sequence = 0;
    const unit = new ContentProductionService(store, { now: () => now }, { next: () => `audit-${++sequence}` }, artifacts, new StubProvider(), passingValidator());
    const external = await artifacts.put(Buffer.from("A real external benchmark supplies structure rather than reusable copy."));
    await store.transaction(async (repos) => {
      const base = { workspaceId, version: 1, createdAt: now, updatedAt: now };
      await repos.workspaces.insert({ ...base, id: workspaceId, name: "Real media" });
      await repos.sources.insert({ ...base, id: "source-owned", name: "Owned", type: "manual", ownership: "owned" });
      await repos.sources.insert({ ...base, id: "source-external", name: "External", type: "link", ownership: "external_public" });
      await repos.evidence.insert({ ...base, id: "evidence-fact", sourceId: "source-owned", sourceLocator: "owned", observedAt: now, summary: "Fact", contentHash: "a".repeat(64), classification: "owned_operating" });
      await repos.evidence.insert({ ...base, id: "evidence-benchmark", sourceId: "source-external", sourceLocator: "public", observedAt: now, summary: "Benchmark", contentHash: external.contentHash, classification: "external_observation", assets: [{ id: "page", kind: "page_text", ...external }] });
      await repos.findings.insert({ ...base, id: "finding-fact", kind: "fact", statement: "Fact", evidenceIds: ["evidence-fact"] });
      await repos.recommendations.insert({ ...base, id: "recommendation-1", findingIds: ["finding-fact"], evidenceIds: ["evidence-fact"], hypothesis: "Hypothesis", affectedStage: "activation", priority: "high", expectedMetric: "activation", targetChannels: ["xhs", "channels"] });
      await repos.tasks.insert({ ...base, id: "task-1", recommendationIds: ["recommendation-1"], assignee: "agent", dependencyIds: [], assetRequirements: [], acceptanceCriteria: ["Valid"], state: "ready" });
      await repos.benchmarkAnalyses.insert(createBenchmarkAnalysis({
        id: "benchmark-1", workspaceId, createdAt: now, modality: "image", status: "completed", gaps: [], evidenceIds: ["evidence-benchmark"], competitorDiffId: null,
        methods: [{ id: "method-1", dimension: "layout", pattern: "Structure", transferableRule: "Transfer structure only", basis: "text", confidence: "medium", evidenceAssetRefs: [{ sourceId: "source-external", evidenceId: "evidence-benchmark", assetId: "page", kind: "page_text", observedAt: now, contentHash: external.contentHash, byteLength: external.byteLength }] }],
        sourceVersions: [{ entityType: "source", id: "source-external", version: 1 }, { entityType: "evidence", id: "evidence-benchmark", version: 1 }],
        provider: { type: "mcp", tool: "reverse_engineer", toolVersion: "fixture", inputHash: "b".repeat(64), analysisMethod: "fixture", humanReview: "not_performed" },
      }));
    });
    service = realService();
    void unit;
  });

  afterEach(async () => {
    store.close();
    await Promise.all([removeTempDir(tempDir), removeTempDir(artifactRoot)]);
  });

  function realService(mode?: string, currentValidator?: MediaValidator): ContentProductionService {
    const provider = new McpMediaProvider({
      command: process.execPath,
      args: [fixture],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, MARKETING_TEST_FFMPEG: ffmpeg, ...(mode ? { MEDIA_FIXTURE_MODE: mode } : {}) },
      envAllowlist: ["MARKETING_TEST_FFMPEG", "MEDIA_FIXTURE_MODE"],
    });
    return new ContentProductionService(
      store, { now: () => now }, { next: () => `audit-${++sequence}` }, artifacts, provider,
      currentValidator ?? new MediaValidator({ ffprobeCommand: ffprobe }),
    );
  }

  async function brief(channel: "xhs" | "channels"): Promise<ContentBrief> {
    return service.createBrief({ input: briefInput(channel), context: context(`real-brief-${channel}`) });
  }

  it("validates and stores real 1080x1440 PNG root and changed derivative bytes with exactly two renders", async () => {
    const value = await brief("xhs");
    const root = await service.generate({ input: generationInput(value.id), context: context("real-png-root") });
    const derived = await service.derive({
      input: { id: "real-png-derived", workspaceId, contentId: root.contentId, parentVersionId: root.id, expectedParentVersion: 1, briefId: value.id, expectedBriefVersion: 1, sourceMaterials: [], revisionInstructions: "Change the real rendered PNG" },
      context: context("real-png-derived"),
    });
    expect(root.validation).toMatchObject({ decoder: "playwright_chromium", width: 1080, height: 1440 });
    expect(derived.artifact.contentHash).not.toBe(root.artifact.contentHash);
    expect((await artifacts.read(root.artifact.contentHash)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect((await readFile(join(artifactRoot, derived.artifact.contentHash))).length).toBe(derived.artifact.byteLength);
  }, 30_000);

  it("validates and stores a real 2000ms 1080x1920 H264/AAC MP4 with ffprobe provenance", async () => {
    const value = await brief("channels");
    const asset = await service.generate({ input: generationInput(value.id), context: context("real-mp4") });
    expect(asset.validation).toMatchObject({ probe: "ffprobe", durationMs: 2_000, width: 1080, height: 1920, videoCodec: "h264", audioCodec: "aac" });
    expect(asset.artifact.byteLength).toBeGreaterThan(100);
  }, 30_000);

  it("persists no success for provider hash mismatch, bad PNG decode/dimensions, or missing/bad ffprobe", async () => {
    const png = await brief("xhs");
    for (const [suffix, mode] of [["hash", "wrong-content-hash"], ["dimensions", "wrong-dimensions"]] as const) {
      service = realService(mode);
      const input = { ...generationInput(png.id), id: `real-png-${suffix}`, contentId: `content-real-png-${suffix}` };
      await expect(service.generate({ input, context: context(`real-png-${suffix}`) })).rejects.toMatchObject<DomainError>({ code: "CAPABILITY_UNAVAILABLE" });
      expect(await store.transaction((repos) => repos.assetVersions.get(input.id, workspaceId))).toBeUndefined();
    }
    service = new ContentProductionService(
      store, { now: () => now }, { next: () => `audit-${++sequence}` }, artifacts,
      new StubProvider(() => Uint8Array.from([0, 1, 2, 3])), new MediaValidator(),
    );
    const invalidPng = { ...generationInput(png.id), id: "real-png-decode", contentId: "content-real-png-decode" };
    await expect(service.generate({ input: invalidPng, context: context("real-png-decode") }))
      .rejects.toMatchObject<DomainError>({ code: "CAPABILITY_UNAVAILABLE", details: { reason: "image_decode_failed" } });
    expect(await store.transaction((repos) => repos.assetVersions.get(invalidPng.id, workspaceId))).toBeUndefined();

    const channels = await brief("channels");
    const malformedProbe = join(tempDir, "ffprobe-malformed");
    await writeFile(malformedProbe, "#!/bin/sh\nif [ \"$1\" = \"-version\" ]; then echo ffprobe-test; else echo '{not-json'; fi\n", { mode: 0o700 });
    for (const [suffix, validator] of [
      ["missing", new MediaValidator()],
      ["bad", new MediaValidator({ ffprobeCommand: "/definitely/missing/ffprobe" })],
      ["malformed", new MediaValidator({ ffprobeCommand: malformedProbe })],
    ] as const) {
      service = realService(undefined, validator);
      const input = { ...generationInput(channels.id), id: `real-mp4-${suffix}`, contentId: `content-real-mp4-${suffix}` };
      await expect(service.generate({ input, context: context(`real-mp4-${suffix}`) })).rejects.toMatchObject<DomainError>({ code: "CAPABILITY_UNAVAILABLE" });
      expect(await store.transaction((repos) => repos.assetVersions.get(input.id, workspaceId))).toBeUndefined();
    }
  }, 60_000);
});

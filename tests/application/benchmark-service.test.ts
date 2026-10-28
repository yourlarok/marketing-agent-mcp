import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReverseBenchmark } from "../../src/application/benchmark-commands.js";
import { BenchmarkService } from "../../src/application/benchmark-service.js";
import type { Command, CommandContext } from "../../src/application/commands.js";
import type { Store } from "../../src/application/ports.js";
import type { BenchmarkMethod } from "../../src/domain/content-production-model.js";
import type { CompetitorDiff } from "../../src/domain/data-research-model.js";
import { DomainError } from "../../src/domain/errors.js";
import type { ArtifactKind, Evidence, Source } from "../../src/domain/model.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import type {
  BenchmarkReverseProvider,
  BenchmarkReverseProviderRequest,
  BenchmarkReverseProviderResponse,
} from "../../src/infrastructure/benchmark-reverse-provider.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-28T09:00:00.000Z";
const workspaceId = "workspace-1";

function context(suffix: string): CommandContext {
  return { actor: "agent-1", requestId: `request-${suffix}`, idempotencyKey: `benchmark-${suffix}` };
}

function ref(asset: BenchmarkReverseProviderRequest["observations"][number]["assets"][number]) {
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

class StubProvider implements BenchmarkReverseProvider {
  calls = 0;
  requests: BenchmarkReverseProviderRequest[] = [];

  constructor(
    private readonly behavior?: (request: BenchmarkReverseProviderRequest) => Promise<BenchmarkReverseProviderResponse> | BenchmarkReverseProviderResponse,
  ) {}

  async reverse(request: BenchmarkReverseProviderRequest): Promise<BenchmarkReverseProviderResponse> {
    this.calls += 1;
    this.requests.push(request);
    if (this.behavior) return this.behavior(request);
    const assets = request.observations.flatMap((observation) => observation.assets);
    const refs = (kind: ArtifactKind) => assets.filter((asset) => asset.kind === kind).map((asset) => ({
      sourceId: asset.sourceId,
      evidenceId: asset.evidenceId,
      assetId: asset.assetId,
      kind: asset.kind,
      observedAt: asset.observedAt,
      contentHash: asset.contentHash,
      byteLength: asset.byteLength,
    }));
    let methods: BenchmarkMethod[];
    let gaps: { code: string; message: string }[] = [];
    if (request.modality === "video") {
      methods = [{
        id: "method-video", dimension: "shot_rhythm", pattern: "Alternate establishing and detail shots",
        transferableRule: "Plan an establishing shot before detail shots", basis: "video_frames_and_asr",
        confidence: "medium", evidenceAssetRefs: [...refs("video_frames"), ...refs("asr_transcript")],
      }];
    } else if (assets.some((asset) => asset.kind === "screenshot")) {
      methods = [{
        id: "method-layout", dimension: "layout", pattern: "Primary content precedes supporting detail",
        transferableRule: "Place the primary content before supporting detail", basis: "image",
        confidence: "high", evidenceAssetRefs: refs("screenshot"),
      }];
    } else {
      methods = (["hook", "information_order", "cta"] as const).map((dimension, index) => ({
        id: `method-${index}`, dimension, pattern: `Structural ${dimension} sequence`,
        transferableRule: `Transfer only the ${dimension} structure`, basis: "text" as const,
        confidence: index === 1 ? "unknown" as const : "medium" as const, evidenceAssetRefs: refs("page_text"),
      }));
      gaps = [{ code: "screenshot_missing", message: "Layout was not observable" }];
    }
    return {
      inputHash: request.inputHash,
      analysisMethod: "service-stub-structural-v1",
      toolVersion: "service-stub-1",
      methods,
      gaps,
    };
  }
}

describe("BenchmarkService evidence-bound reverse analysis", () => {
  let tempDir: string;
  let artifactRoot: string;
  let storePath: string;
  let store: Store;
  let artifacts: ArtifactStore;
  let provider: StubProvider;
  let service: BenchmarkService;
  let sequence: number;

  beforeEach(async () => {
    tempDir = await createTempDir();
    artifactRoot = await createTempDir();
    storePath = join(tempDir, "benchmark.db");
    store = openStore(storePath);
    artifacts = new ArtifactStore(artifactRoot);
    sequence = 0;
    provider = new StubProvider();
    service = createService();
    await store.transaction(async (repos) => {
      await repos.workspaces.insert({
        id: workspaceId, workspaceId, version: 1, createdAt: now, updatedAt: now, name: "workspace-1",
      });
    });
  });

  afterEach(async () => {
    store.close();
    await Promise.all([removeTempDir(tempDir), removeTempDir(artifactRoot)]);
  });

  function createService(currentStore = store, currentProvider = provider): BenchmarkService {
    return new BenchmarkService(
      currentStore,
      { now: () => now },
      { next: () => `audit-${++sequence}` },
      artifacts,
      currentProvider,
    );
  }

  async function seedEvidence(
    id: string,
    kinds: { kind: ArtifactKind; content: Buffer | string; assetId?: string }[],
    options: { workspaceId?: string; ownership?: Source["ownership"]; classification?: Evidence["classification"] } = {},
  ): Promise<{ source: Source; evidence: Evidence }> {
    const currentWorkspace = options.workspaceId ?? workspaceId;
    const stored = await Promise.all(kinds.map(async ({ kind, content, assetId }) => ({
      id: assetId ?? `${id}-${kind}`,
      kind,
      ...(await artifacts.put(Buffer.from(content))),
    })));
    const source: Source = {
      id: `source-${id}`, workspaceId: currentWorkspace, version: 1, createdAt: now, updatedAt: now,
      name: `source-${id}`, type: "link", ownership: options.ownership ?? "external_public",
    };
    const evidence: Evidence = {
      id, workspaceId: currentWorkspace, version: 1, createdAt: now, updatedAt: now,
      sourceId: source.id, sourceLocator: `https://example.test/${id}`, observedAt: now,
      summary: `Persisted observation ${id}`, contentHash: stored[0]!.contentHash,
      classification: options.classification ?? "external_observation", assets: stored,
    };
    await store.transaction(async (repos) => {
      if (currentWorkspace !== workspaceId) {
        await repos.workspaces.insert({
          id: currentWorkspace, workspaceId: currentWorkspace, version: 1,
          createdAt: now, updatedAt: now, name: currentWorkspace,
        });
      }
      await repos.sources.insert(source);
      await repos.evidence.insert(evidence);
    });
    return { source, evidence };
  }

  async function seedDiff(id: string, evidenceIds: string[]): Promise<CompetitorDiff> {
    const diff: CompetitorDiff = {
      id, workspaceId, version: 1, createdAt: now, updatedAt: now,
      competitorIds: ["competitor-1", "competitor-2"],
      entries: [{ dimension: "structure", result: "different", evidenceIds }], findingIds: [],
    };
    await store.transaction((repos) => repos.competitorDiffs.insert(diff));
    return diff;
  }

  function command(
    id: string,
    evidenceIds: string[],
    suffix = id,
    patch: Record<string, unknown> = {},
  ): Command<ReverseBenchmark> {
    return {
      input: { id: `analysis-${suffix}`, workspaceId, modality: "image", evidenceIds, ...patch },
      context: context(suffix),
    };
  }

  async function getAnalysis(id: string) {
    return store.transaction((repos) => repos.benchmarkAnalyses.get(id, workspaceId));
  }

  it("persists text-only image structure with explicit visual gaps, server refs, audit, and restart lineage", async () => {
    const { source, evidence } = await seedEvidence("evidence-text", [{ kind: "page_text", content: "Persisted structural text" }]);
    const diff = await seedDiff("diff-1", [evidence.id]);
    const result = await service.reverse(command("unused", [evidence.id], "text", {
      competitorDiffId: diff.id, expectedCompetitorDiffVersion: 1,
    }));
    expect(result.status).toBe("partial");
    expect(result.methods.map((method) => [method.dimension, method.basis, method.confidence])).toEqual([
      ["hook", "text", "medium"], ["information_order", "text", "unknown"], ["cta", "text", "medium"],
    ]);
    expect(result.gaps).toEqual([{ code: "screenshot_missing", message: "Layout was not observable" }]);
    expect(result.provider).toEqual({
      type: "mcp", tool: "reverse_engineer", toolVersion: "service-stub-1",
      inputHash: provider.requests[0]!.inputHash, analysisMethod: "service-stub-structural-v1", humanReview: "not_performed",
    });
    expect(result.methods[0]!.evidenceAssetRefs[0]).toMatchObject({
      sourceId: source.id, evidenceId: evidence.id, observedAt: evidence.observedAt,
      contentHash: evidence.assets![0]!.contentHash, byteLength: evidence.assets![0]!.byteLength,
    });
    expect(result.sourceVersions).toEqual([
      { entityType: "source", id: source.id, version: 1 },
      { entityType: "evidence", id: evidence.id, version: 1 },
      { entityType: "competitor_diff", id: diff.id, version: 1 },
    ]);
    expect(provider.requests[0]!.observations[0]!.assets[0]).toMatchObject({
      kind: "page_text", text: "Persisted structural text",
    });
    expect(provider.requests[0]!.observations[0]!.assets[0]).not.toHaveProperty("base64");
    const audits = await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "benchmark_analysis", result.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "benchmark.reverse.create", requestId: "request-text" });

    store.close();
    store = openStore(storePath);
    service = createService(store);
    await expect(service.get({ id: result.id, workspaceId })).resolves.toEqual(result);
    await expect(service.get({ id: result.id, workspaceId: "workspace-other" })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
  });

  it("uses only real screenshot bytes for layout and never claims human review", async () => {
    const bytes = Buffer.from([0, 255, 1, 254, 2, 253]);
    await seedEvidence("evidence-visual", [
      { kind: "page_text", content: "do not treat this as an image" },
      { kind: "screenshot", content: bytes },
      { kind: "original", content: "undeclared for structural analysis" },
    ]);
    const result = await service.reverse(command("unused", ["evidence-visual"], "visual"));
    const sent = provider.requests[0]!.observations[0]!.assets;
    expect(sent.map((asset) => asset.kind)).toEqual(["page_text", "screenshot"]);
    expect(Buffer.from(sent.find((asset) => asset.kind === "screenshot")!.base64!, "base64")).toEqual(bytes);
    expect(result.methods[0]).toMatchObject({ dimension: "layout", basis: "image" });
    expect(result.status).toBe("completed");
    expect(result.provider.humanReview).toBe("not_performed");
  });

  it("requires every video Evidence to have real frames and ASR and persists declared video understanding", async () => {
    await seedEvidence("evidence-video", [
      { kind: "page_text", content: "Page text is not a video substitute" },
      { kind: "video_frames", content: Buffer.from([1, 3, 3, 7]) },
      { kind: "asr_transcript", content: "Actual spoken transcript" },
    ]);
    const result = await service.reverse(command("unused", ["evidence-video"], "video", { modality: "video" }));
    expect(result.methods[0]).toMatchObject({ dimension: "shot_rhythm", basis: "video_frames_and_asr" });
    expect(provider.requests[0]!.observations[0]!.assets.map((asset) => asset.kind)).toEqual([
      "page_text", "video_frames", "asr_transcript",
    ]);
  });

  it.each([
    [{ kind: "asr_transcript", content: "ASR only" }, "video_frames_missing"],
    [{ kind: "video_frames", content: "frames only" }, "asr_transcript_missing"],
  ] as const)("returns %s video prerequisite gap without page-text fallback", async (asset, reason) => {
    await seedEvidence(`evidence-${reason}`, [{ kind: "page_text", content: "Tempting text fallback" }, asset]);
    await expect(service.reverse(command("unused", [`evidence-${reason}`], reason, { modality: "video" })))
      .rejects.toMatchObject<DomainError>({ code: "CAPABILITY_UNAVAILABLE", details: { reason } });
    expect(provider.calls).toBe(0);
    expect(await getAnalysis(`analysis-${reason}`)).toBeUndefined();
  });

  it("rejects a provider response that does not declare video frame and ASR understanding", async () => {
    await seedEvidence("evidence-video-declaration", [
      { kind: "page_text", content: "Text only response must not pass" },
      { kind: "video_frames", content: "frames" }, { kind: "asr_transcript", content: "ASR" },
    ]);
    provider = new StubProvider((request) => {
      const text = request.observations[0]!.assets.find((asset) => asset.kind === "page_text")!;
      return {
        inputHash: request.inputHash, analysisMethod: "bad-video", toolVersion: "stub", gaps: [],
        methods: [{
          id: "bad-video", dimension: "hook", pattern: "Text fallback", transferableRule: "Do not use this",
          basis: "text", confidence: "unknown", evidenceAssetRefs: [ref(text)],
        }],
      };
    });
    service = createService();
    await expect(service.reverse(command("unused", ["evidence-video-declaration"], "video-declaration", { modality: "video" })))
      .rejects.toMatchObject<DomainError>({ code: "CAPABILITY_UNAVAILABLE", details: { reason: "video_understanding_missing" } });
    expect(await getAnalysis("analysis-video-declaration")).toBeUndefined();
  });

  it("enforces diff membership, expected version, and workspace isolation before calling the provider", async () => {
    await seedEvidence("evidence-in-diff", [{ kind: "page_text", content: "inside" }]);
    await seedEvidence("evidence-outside", [{ kind: "page_text", content: "outside" }]);
    const diff = await seedDiff("diff-membership", ["evidence-in-diff"]);
    await expect(service.reverse(command("unused", ["evidence-outside"], "outside", {
      competitorDiffId: diff.id, expectedCompetitorDiffVersion: 1,
    }))).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expect(service.reverse(command("unused", ["evidence-in-diff"], "version", {
      competitorDiffId: diff.id, expectedCompetitorDiffVersion: 2,
    }))).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await expect(service.reverse(command("unused", ["evidence-in-diff"], "pair", {
      competitorDiffId: diff.id,
    }))).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await seedEvidence("evidence-cross", [{ kind: "page_text", content: "other workspace" }], { workspaceId: "workspace-2" });
    await expect(service.reverse(command("unused", ["evidence-cross"], "cross"))).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    expect(provider.calls).toBe(0);
  });

  it("keeps Source ownership and Evidence classification consistent", async () => {
    await seedEvidence("evidence-classification", [{ kind: "page_text", content: "mismatch" }], {
      ownership: "external_public", classification: "owned_operating",
    });
    await expect(service.reverse(command("unused", ["evidence-classification"], "classification")))
      .rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    expect(provider.calls).toBe(0);
  });

  it("verifies real artifact bytes and descriptors instead of trusting persisted hashes", async () => {
    const { evidence } = await seedEvidence("evidence-tampered", [{ kind: "page_text", content: "original bytes" }]);
    await writeFile(join(artifactRoot, evidence.assets![0]!.contentHash), "tampered bytes");
    await expect(service.reverse(command("unused", [evidence.id], "tampered"))).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    expect(provider.calls).toBe(0);
    expect(await getAnalysis("analysis-tampered")).toBeUndefined();
  });

  it("rejects an exact normalized 40-code-point external-public copy without claiming a copyright guarantee", async () => {
    await seedEvidence("evidence-copy", [{ kind: "page_text", content: "A".repeat(45) }]);
    provider = new StubProvider((request) => {
      const sourceAsset = request.observations[0]!.assets[0]!;
      return {
        inputHash: request.inputHash, analysisMethod: "copy-test", toolVersion: "stub", gaps: [],
        methods: [{
          id: "copy", dimension: "hook", pattern: `Ａ`.repeat(45), transferableRule: "Original rule",
          basis: "text", confidence: "unknown", evidenceAssetRefs: [ref(sourceAsset)],
        }],
      };
    });
    service = createService();
    await expect(service.reverse(command("unused", ["evidence-copy"], "copy")))
      .rejects.toThrow(/40 Unicode code points/);
    expect(await getAnalysis("analysis-copy")).toBeUndefined();
  });

  it.each(["source", "evidence", "diff"] as const)("rechecks %s version and descriptors before commit", async (changed) => {
    const { source, evidence } = await seedEvidence(`evidence-commit-${changed}`, [{ kind: "page_text", content: "snapshot" }]);
    const diff = await seedDiff(`diff-commit-${changed}`, [evidence.id]);
    provider = new StubProvider(async (request) => {
      await store.transaction(async (repos) => {
        if (changed === "source") {
          await repos.sources.update({ ...source, name: "changed during provider call", updatedAt: "2026-10-28T09:01:00.000Z" }, 1);
        } else if (changed === "evidence") {
          await repos.evidence.update({
            ...evidence,
            assets: [{ ...evidence.assets![0]!, byteLength: evidence.assets![0]!.byteLength + 1 }],
            updatedAt: "2026-10-28T09:01:00.000Z",
          }, 1);
        } else {
          await repos.competitorDiffs.update({ ...diff, entries: [], updatedAt: "2026-10-28T09:01:00.000Z" }, 1);
        }
      });
      return new StubProvider().reverse(request);
    });
    service = createService();
    const id = `analysis-commit-${changed}`;
    await expect(service.reverse(command("unused", [evidence.id], `commit-${changed}`, {
      competitorDiffId: diff.id, expectedCompetitorDiffVersion: 1,
    }))).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    expect(await getAnalysis(id)).toBeUndefined();
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "benchmark_analysis", id))).toEqual([]);
  });

  it("does not persist a success analysis or audit after provider failure", async () => {
    await seedEvidence("evidence-provider-failure", [{ kind: "page_text", content: "valid input" }]);
    provider = new StubProvider(() => {
      throw new DomainError("CAPABILITY_UNAVAILABLE", "Provider failed", true, { capability: "benchmark_reverse", reason: "mcp_unavailable" });
    });
    service = createService();
    await expect(service.reverse(command("unused", ["evidence-provider-failure"], "provider-failure")))
      .rejects.toMatchObject<DomainError>({ code: "CAPABILITY_UNAVAILABLE" });
    expect(await getAnalysis("analysis-provider-failure")).toBeUndefined();
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "benchmark_analysis", "analysis-provider-failure"))).toEqual([]);
  });

  it("replays exactly without another provider call and rejects conflicting key reuse", async () => {
    await seedEvidence("evidence-replay", [{ kind: "page_text", content: "stable replay" }]);
    const first = await service.reverse(command("unused", ["evidence-replay"], "replay"));
    const replayed = await service.reverse(command("unused", ["evidence-replay"], "replay"));
    expect(replayed).toEqual(first);
    expect(provider.calls).toBe(1);
    await expect(service.reverse(command("unused", ["evidence-replay"], "replay", { modality: "video" })))
      .rejects.toMatchObject<DomainError>({ code: "IDEMPOTENCY_CONFLICT" });
    expect(provider.calls).toBe(1);
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "benchmark_analysis", first.id))).toHaveLength(1);
  });

  it("rejects public request configuration overrides and invalid evidence selections", async () => {
    await seedEvidence("evidence-validation", [{ kind: "page_text", content: "valid" }]);
    for (const [suffix, patch] of [
      ["command", { command: process.execPath }],
      ["args", { args: ["anything"] }],
      ["duplicates", { evidenceIds: ["evidence-validation", "evidence-validation"] }],
      ["empty", { evidenceIds: [] }],
      ["excess", { evidenceIds: Array.from({ length: 11 }, (_, index) => `evidence-${index}`) }],
    ] as const) {
      await expect(service.reverse(command("unused", ["evidence-validation"], suffix, patch)))
        .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    }
    expect(provider.calls).toBe(0);
  });
});

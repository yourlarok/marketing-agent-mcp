import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisService, type AnalysisCapability } from "../../src/application/analysis-service.js";
import { BenchmarkService } from "../../src/application/benchmark-service.js";
import type { CommandContext } from "../../src/application/commands.js";
import { ContentProductionService } from "../../src/application/content-production-service.js";
import { DashboardService } from "../../src/application/dashboard-service.js";
import { DataResearchService } from "../../src/application/data-research-service.js";
import { MarketingService } from "../../src/application/marketing-service.js";
import type { Store } from "../../src/application/ports.js";
import { StrategyService } from "../../src/application/strategy-service.js";
import {
  CHANNEL_PROFILES,
  type AssetVersion,
  type BenchmarkAnalysis,
  type ContentBrief,
  type ContentSegment,
} from "../../src/domain/content-production-model.js";
import { DomainError } from "../../src/domain/errors.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import type {
  BenchmarkReverseProvider,
  BenchmarkReverseProviderRequest,
  BenchmarkReverseProviderResponse,
} from "../../src/infrastructure/benchmark-reverse-provider.js";
import {
  computeMediaRenderInputHash,
  type MediaProvider,
  type MediaRenderRequest,
  type MediaRenderResponse,
} from "../../src/infrastructure/media-provider.js";
import type { MediaValidator } from "../../src/infrastructure/media-validation.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { canonicalJson } from "../../src/infrastructure/sqlite.js";
import { MAX_SERIALIZED_OUTPUT_BYTES } from "../../src/mcp/schemas.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-29T12:00:00.000Z";
const newToolNames = [
  "benchmark_reverse_create",
  "benchmark_reverse_get",
  "content_artifact_get",
  "content_asset_derive",
  "content_asset_generate",
  "content_asset_get",
  "content_brief_create",
  "content_brief_get",
];
const existingToolNames = [
  "analysis_graph_expand", "analysis_graph_fork", "analysis_graph_get",
  "capability_health_record", "capability_list", "capability_register",
  "competitor_confirm", "competitor_diff_create", "connector_sqlite_discover",
  "dashboard_artifact_get", "dashboard_drilldown_get", "dashboard_get", "dashboard_render",
  "data_request_decline", "data_request_plan", "data_research_get", "dataset_register",
  "evidence_asset_get", "evidence_record", "finding_record", "ingest_content_links",
  "ingest_files", "ingest_sqlite", "ingest_temporary_api", "lineage_get",
  "marketing_analysis_start", "marketing_capability_list", "metric_compute",
  "metric_monitor_compare", "metric_scenario_create", "professional_analytics_compute",
  "recommendation_create", "research_permission_set", "research_session_create",
  "research_session_run", "source_register", "strategy_recommendation_generate",
  "strategy_task_get", "strategy_task_list", "strategy_task_reject", "strategy_task_reorder",
  "strategy_task_supplement", "strategy_task_update", "task_create", "task_transition", "workspace_create",
];
const writeToolNames = [
  "benchmark_reverse_create", "content_asset_derive", "content_asset_generate", "content_brief_create",
];
const readToolNames = newToolNames.filter((name) => !writeToolNames.includes(name));

function context(suffix: string): CommandContext {
  return { actor: "agent-1", requestId: `request-${suffix}`, idempotencyKey: `command-${suffix}` };
}

function creative(id: string, text = `Original creative expression for ${id}`): ContentSegment {
  return { id, kind: "creative", text };
}

function fact(id: string): ContentSegment {
  return { id, kind: "fact", findingId: "finding-fact", text: `Traceable expression for ${id}` };
}

class StubBenchmarkProvider implements BenchmarkReverseProvider {
  calls = 0;
  failure: DomainError | undefined;

  async reverse(request: BenchmarkReverseProviderRequest): Promise<BenchmarkReverseProviderResponse> {
    this.calls += 1;
    if (this.failure) throw this.failure;
    const evidenceAssetRefs = request.observations.flatMap((observation) =>
      observation.assets.filter((asset) => asset.kind === "page_text").map((asset) => ({
        sourceId: asset.sourceId,
        evidenceId: asset.evidenceId,
        assetId: asset.assetId,
        kind: asset.kind,
        observedAt: asset.observedAt,
        contentHash: asset.contentHash,
        byteLength: asset.byteLength,
      })));
    return {
      inputHash: request.inputHash,
      analysisMethod: "mcp-stub-structural-v1",
      toolVersion: "benchmark-stub-1",
      methods: [{
        id: "method-text",
        dimension: "information_order",
        pattern: "Lead with the observed sequence before supporting detail",
        transferableRule: "Preserve only the information order, not source expression",
        basis: "text",
        confidence: "medium",
        evidenceAssetRefs,
      }],
      gaps: [],
    };
  }
}

class StubMediaProvider implements MediaProvider {
  calls = 0;
  failure: DomainError | undefined;

  async render(request: MediaRenderRequest): Promise<MediaRenderResponse> {
    this.calls += 1;
    if (this.failure) throw this.failure;
    const content = Buffer.alloc(70_000, this.calls);
    return {
      content: new Uint8Array(content),
      artifact: {
        mediaType: request.brief.channel === "xhs" ? "image/png" : "video/mp4",
        contentHash: createHash("sha256").update(content).digest("hex"),
        byteLength: content.length,
      },
      inputHash: computeMediaRenderInputHash(request),
      toolVersion: "media-stub-1",
    };
  }
}

function passingValidator(failure: () => DomainError | undefined): MediaValidator {
  return {
    validateXhsPng: async () => {
      const error = failure();
      if (error) throw error;
      return {
        status: "passed", profileId: CHANNEL_PROFILES.xhs.profileId, guarantee: "internal_acceptance_only",
        decoder: "playwright_chromium", width: 1080, height: 1440,
        durationMs: null, videoCodec: null, audioCodec: null,
      };
    },
    validateChannelsMp4: async () => {
      const error = failure();
      if (error) throw error;
      return {
        status: "passed", profileId: CHANNEL_PROFILES.channels.profileId, guarantee: "internal_acceptance_only",
        probe: "ffprobe", probeVersion: "ffprobe-stub-1", width: 1080, height: 1920,
        durationMs: 2_000, videoCodec: "h264", audioCodec: "aac",
      };
    },
  } as MediaValidator;
}

function reverseArguments(suffix = "reverse") {
  return {
    id: `benchmark-${suffix}`,
    workspaceId: "workspace-1",
    modality: "image",
    evidenceIds: ["evidence-benchmark"],
    ...context(suffix),
  };
}

function briefArguments(channel: "xhs" | "channels" = "xhs", suffix = channel) {
  return {
    id: `brief-${suffix}`,
    workspaceId: "workspace-1",
    taskId: "task-1",
    expectedTaskVersion: 1,
    recommendationId: "recommendation-1",
    expectedRecommendationVersion: 1,
    benchmarkAnalysisId: "benchmark-reverse",
    expectedBenchmarkVersion: 1,
    channel,
    methodIds: ["method-text"],
    objective: "Explain an original operating workflow",
    audience: "Independent operators",
    copy: { hook: creative(`hook-${suffix}`), body: [fact(`body-${suffix}`)], cta: creative(`cta-${suffix}`) },
    frames: channel === "channels" ? [{
      id: `shot-${suffix}`, order: 1, purpose: "Show the workflow", visualDirection: "Original wide product shot",
      onScreenText: [creative(`screen-${suffix}`)], narration: [fact(`narration-${suffix}`)], durationMs: 2_000,
    }] : [{
      id: `frame-${suffix}`, order: 1, purpose: "Show the workflow", visualDirection: "Original product photograph",
      onScreenText: [creative(`screen-${suffix}`)], narration: [fact(`narration-${suffix}`)], durationMs: null,
    }],
    assetRequirements: ["One independently owned product photograph"],
    ...context(`brief-${suffix}`),
  };
}

function generateArguments(suffix = "xhs", channel: "xhs" | "channels" = "xhs") {
  return {
    id: `asset-${suffix}`,
    workspaceId: "workspace-1",
    contentId: `content-${suffix}`,
    briefId: `brief-${channel}`,
    expectedBriefVersion: 1,
    sourceMaterials: [{ evidenceId: "evidence-production", assetId: "production-image" }],
    revisionInstructions: "Create original output from the controlled brief",
    ...context(`generate-${suffix}`),
  };
}

describe("benchmark and content production MCP contracts", () => {
  let tempDir: string;
  let store: Store;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let marketing: MarketingService;
  let dataResearch: DataResearchService;
  let analysis: AnalysisService;
  let dashboard: DashboardService;
  let strategy: StrategyService;
  let artifacts: ArtifactStore;
  let benchmarkProvider: StubBenchmarkProvider;
  let mediaProvider: StubMediaProvider;
  let validatorFailure: DomainError | undefined;
  let benchmark: BenchmarkService;
  let contentProduction: ContentProductionService;
  const clock = { now: () => now };
  let sequence = 0;
  const ids = { next: () => `audit-${++sequence}` };

  beforeEach(async () => {
    tempDir = await createTempDir();
    store = openStore(join(tempDir, "store.db"));
    artifacts = new ArtifactStore(join(tempDir, "artifacts"));
    marketing = new MarketingService(store, clock, ids);
    dataResearch = new DataResearchService(store, clock, ids, artifacts);
    analysis = new AnalysisService(store, clock, ids, artifacts);
    dashboard = new DashboardService(store, clock, ids, artifacts);
    strategy = new StrategyService(store, clock, ids);
    benchmarkProvider = new StubBenchmarkProvider();
    mediaProvider = new StubMediaProvider();
    validatorFailure = undefined;
    benchmark = new BenchmarkService(store, clock, ids, artifacts, benchmarkProvider);
    contentProduction = new ContentProductionService(
      store, clock, ids, artifacts, mediaProvider, passingValidator(() => validatorFailure),
    );
    const external = await artifacts.put(Buffer.from("Persisted public benchmark text for structural analysis."));
    const production = await artifacts.put(Buffer.from("independently-owned-production-source"));
    await store.transaction(async (repos) => {
      const base = { workspaceId: "workspace-1", version: 1, createdAt: now, updatedAt: now };
      await repos.workspaces.insert({ ...base, id: "workspace-1", name: "Workspace" });
      await repos.sources.insert({ ...base, id: "source-benchmark", name: "Public benchmark", type: "link", ownership: "external_public" });
      await repos.sources.insert({ ...base, id: "source-owned", name: "Owned facts", type: "manual", ownership: "owned" });
      await repos.sources.insert({ ...base, id: "source-production", name: "Owned production", type: "manual", ownership: "owned" });
      await repos.evidence.insert({
        ...base, id: "evidence-benchmark", sourceId: "source-benchmark", sourceLocator: "https://example.test/benchmark",
        observedAt: now, summary: "Public observation", contentHash: external.contentHash, classification: "external_observation",
        assets: [{ id: "benchmark-text", kind: "page_text", ...external }],
      });
      await repos.evidence.insert({
        ...base, id: "evidence-fact", sourceId: "source-owned", sourceLocator: "ledger/month-1", observedAt: now,
        summary: "Owned fact", contentHash: "a".repeat(64), classification: "owned_operating",
      });
      await repos.evidence.insert({
        ...base, id: "evidence-production", sourceId: "source-production", sourceLocator: "owned/source-image", observedAt: now,
        summary: "Independent production source", contentHash: production.contentHash, classification: "owned_operating",
        assets: [{ id: "production-image", kind: "screenshot", ...production }],
      });
      await repos.findings.insert({
        ...base, id: "finding-fact", kind: "fact", statement: "A persisted operating fact", evidenceIds: ["evidence-fact"],
      });
      await repos.recommendations.insert({
        ...base, id: "recommendation-1", findingIds: ["finding-fact"], evidenceIds: ["evidence-fact"],
        hypothesis: "An original explanation may help the audience", affectedStage: "engagement", priority: "p1",
        expectedMetric: "engagement_rate_v1", targetChannels: ["xhs", "channels"],
      });
      await repos.tasks.insert({
        ...base, id: "task-1", recommendationIds: ["recommendation-1"], assignee: "owner", dependencyIds: [],
        assetRequirements: [], acceptanceCriteria: ["A user reviews the draft"], state: "ready",
      });
    });
    server = createMcpServer(marketing, dataResearch, analysis, {}, dashboard, strategy, benchmark, contentProduction);
    client = new Client({ name: "content-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
    store.close();
    await removeTempDir(tempDir);
  });

  async function result(name: string, arguments_: Record<string, unknown>) {
    return client.callTool({ name, arguments: arguments_ });
  }

  async function call<T>(name: string, arguments_: Record<string, unknown>): Promise<T> {
    const response = await result(name, arguments_);
    expect(response, name).not.toMatchObject({ isError: true });
    const text = (response.content[0] as { text: string }).text;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_SERIALIZED_OUTPUT_BYTES);
    const parsed = JSON.parse(text) as T;
    expect(text).toBe(canonicalJson(parsed));
    return parsed;
  }

  async function createBenchmark(): Promise<BenchmarkAnalysis> {
    return call<BenchmarkAnalysis>("benchmark_reverse_create", reverseArguments());
  }

  async function createBrief(channel: "xhs" | "channels" = "xhs"): Promise<ContentBrief> {
    return call<ContentBrief>("content_brief_create", briefArguments(channel));
  }

  it("registers exactly 54 tools with strict raw discovery schemas and four write contexts", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...existingToolNames, ...newToolNames].sort());
    expect(tools).toHaveLength(54);
    const visit = (schema: unknown): void => {
      if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return;
      const record = schema as Record<string, unknown>;
      if (record.type === "object" && record.properties !== undefined) {
        expect(record.additionalProperties).toBe(false);
      }
      for (const value of Object.values(record)) {
        if (Array.isArray(value)) value.forEach(visit);
        else visit(value);
      }
    };
    for (const name of newToolNames) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      visit(tool.inputSchema);
      const serialized = JSON.stringify(tool.inputSchema);
      for (const forbidden of ["command", "args", "code", "env", "contentBase64", "path"]) {
        expect(serialized, `${name}.${forbidden}`).not.toContain(`\"${forbidden}\"`);
      }
    }
    for (const name of writeToolNames) {
      const required = tools.find((tool) => tool.name === name)!.inputSchema.required ?? [];
      expect(required).toEqual(expect.arrayContaining(["actor", "requestId", "idempotencyKey"]));
    }
    for (const name of readToolNames) {
      const required = tools.find((tool) => tool.name === name)!.inputSchema.required ?? [];
      for (const field of ["actor", "requestId", "idempotencyKey"]) expect(required).not.toContain(field);
    }
    expect(tools.find((tool) => tool.name === "lineage_get")!.inputSchema.properties?.entityType)
      .toMatchObject({ enum: expect.arrayContaining(["benchmark_analysis", "content_brief", "asset_version"]) });
  });

  it("adapts all eight tools to real services, bounded base64 chunks, and content lineage", async () => {
    const reversed = await createBenchmark();
    expect(reversed).toMatchObject({ id: "benchmark-reverse", version: 1, provider: { humanReview: "not_performed" } });
    expect(await call<BenchmarkAnalysis>("benchmark_reverse_get", {
      id: reversed.id, workspaceId: reversed.workspaceId,
    })).toEqual(reversed);

    const brief = await createBrief();
    expect(brief).toMatchObject({ id: "brief-xhs", version: 1, channel: "xhs" });
    expect(await call<ContentBrief>("content_brief_get", { id: brief.id, workspaceId: brief.workspaceId })).toEqual(brief);

    const generated = await call<AssetVersion>("content_asset_generate", generateArguments());
    expect(generated).toMatchObject({ id: "asset-xhs", version: 1, parentVersionId: null });
    expect(await call<AssetVersion>("content_asset_get", { id: generated.id, workspaceId: generated.workspaceId })).toEqual(generated);
    const first = await call<{ content: string; length: number; offset: number; totalBytes: number }>("content_artifact_get", {
      id: generated.id, workspaceId: generated.workspaceId, artifactId: generated.artifact.id, offset: 0, length: 32_768,
    });
    const second = await call<{ content: string; length: number; offset: number }>("content_artifact_get", {
      id: generated.id, workspaceId: generated.workspaceId, artifactId: generated.artifact.id, offset: 32_768, length: 32_768,
    });
    expect(first).toMatchObject({ length: 32_768, offset: 0, totalBytes: 70_000 });
    expect(second).toMatchObject({ length: 32_768, offset: 32_768 });
    expect(Buffer.from(first.content, "base64")).toEqual(Buffer.alloc(32_768, 1));
    expect(Buffer.from(second.content, "base64")).toEqual(Buffer.alloc(32_768, 1));

    const derived = await call<AssetVersion>("content_asset_derive", {
      id: "asset-xhs-derived", workspaceId: generated.workspaceId, contentId: generated.contentId,
      parentVersionId: generated.id, expectedParentVersion: 1, briefId: brief.id, expectedBriefVersion: 1,
      sourceMaterials: [], revisionInstructions: "Create an original derived version", ...context("derive-xhs"),
    });
    expect(derived).toMatchObject({ version: 2, parentVersionId: generated.id, parentVersion: 1 });
    for (const [entityType, id] of [
      ["benchmark_analysis", reversed.id], ["content_brief", brief.id], ["asset_version", derived.id],
    ] as const) {
      const lineage = await call<{ nodes: { entityType: string; id: string }[] }>("lineage_get", {
        entityType, id, workspaceId: "workspace-1",
      });
      expect(lineage.nodes).toContainEqual(expect.objectContaining({ entityType, id }));
    }
  });

  it("rejects malformed segment/frame/source unions, duplicate refs, and version or chunk bounds", async () => {
    await createBenchmark();
    const brief = briefArguments() as Record<string, unknown>;
    const invalidBriefs = [
      { ...brief, copy: { ...(brief.copy as object), hook: { ...creative("bad-creative"), findingId: "finding-fact" } } },
      { ...brief, copy: { ...(brief.copy as object), hook: { id: "bad-fact", kind: "fact", text: "Missing ref" } } },
      { ...brief, frames: [{ ...(brief.frames as Record<string, unknown>[])[0], order: 2 }] },
      { ...brief, frames: [{ ...(brief.frames as Record<string, unknown>[])[0], durationMs: 1 }] },
      { ...brief, methodIds: ["method-text", "method-text"] },
      { ...brief, expectedTaskVersion: 0 },
    ];
    for (const [index, arguments_] of invalidBriefs.entries()) {
      expect(await result("content_brief_create", {
        ...arguments_, id: `invalid-brief-${index}`, ...context(`invalid-brief-${index}`),
      } as Record<string, unknown>)).toMatchObject({ isError: true });
    }
    const generate = generateArguments();
    for (const arguments_ of [
      { ...generate, sourceMaterials: [{ evidenceId: "evidence-production", assetId: "production-image", role: "source" }] },
      { ...generate, sourceMaterials: [generate.sourceMaterials[0], generate.sourceMaterials[0]] },
      { ...generate, sourceMaterials: Array.from({ length: 9 }, (_, index) => ({ evidenceId: `evidence-${index}`, assetId: `asset-${index}` })) },
      { ...generate, expectedBriefVersion: 0 },
    ]) {
      expect(await result("content_asset_generate", arguments_)).toMatchObject({ isError: true });
    }
    expect(await result("content_artifact_get", {
      id: "asset-xhs", workspaceId: "workspace-1", artifactId: "asset-xhs", length: 32_769,
    })).toMatchObject({ isError: true });
  });

  it("rejects nested secrets, dynamic execution fields, and 65,537-byte input before writes", async () => {
    const secret = "synthetic-content-mcp-secret";
    for (const [name, arguments_] of [
      ["benchmark_reverse_create", { ...reverseArguments("secret"), metadata: { apiKey: secret } }],
      ["content_brief_create", { ...briefArguments("xhs", "secret"), copy: { hook: creative("hook"), body: [fact("body")], cta: creative("cta"), credential: secret } }],
      ["content_asset_generate", { ...generateArguments("secret"), provider: { command: "/tmp/provider", args: ["--run"] } }],
      ["content_asset_derive", { ...generateArguments("derive-secret"), parentVersionId: "asset-xhs", expectedParentVersion: 1, code: "process.exit()" }],
      ["content_artifact_get", { id: "asset", workspaceId: "workspace-1", artifactId: "artifact", path: "/tmp/raw-media" }],
    ] as const) {
      const response = await result(name, arguments_ as Record<string, unknown>);
      expect(response, name).toMatchObject({ isError: true });
      expect(JSON.stringify(response), name).not.toContain(secret);
    }
    const oversized = reverseArguments("oversized") as Record<string, unknown>;
    oversized.modality = "";
    const padding = 65_537 - Buffer.byteLength(JSON.stringify(oversized), "utf8");
    oversized.modality = "x".repeat(padding);
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBe(65_537);
    expect(await result("benchmark_reverse_create", oversized)).toMatchObject({ isError: true });
    expect(benchmarkProvider.calls).toBe(0);
    expect(await store.transaction((repos) => repos.idempotency.get("workspace-1", "command-oversized"))).toBeUndefined();
  });

  it("enforces the 64 KiB response bound without returning partial entity JSON", async () => {
    const reversed = await createBenchmark();
    const brief = await createBrief();
    const oversized = { ...brief, id: "brief-oversized", objective: "x".repeat(65_536) };
    const raw = new DatabaseSync(join(tempDir, "store.db"));
    try {
      raw.prepare(
        "INSERT INTO content_briefs (id, workspace_id, task_id, recommendation_id, benchmark_analysis_id, version, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        oversized.id, oversized.workspaceId, oversized.taskId, oversized.recommendationId,
        oversized.benchmarkAnalysisId, oversized.version, oversized.createdAt, oversized.updatedAt,
        canonicalJson(oversized),
      );
    } finally {
      raw.close();
    }
    const response = await result("content_brief_get", { id: "brief-oversized", workspaceId: brief.workspaceId });
    expect(response).toMatchObject({ isError: true });
    expect(JSON.stringify(response)).toContain("Resource conflict");
    expect(JSON.stringify(response)).not.toContain(reversed.id);
    expect((response.content[0] as { text: string }).text).not.toContain('"findingIds"');
  });

  it("returns structured safe capability gaps for reverse, generate, derive, decode, and probe failures", async () => {
    benchmarkProvider.failure = new DomainError("CAPABILITY_UNAVAILABLE", "private benchmark failure", false, {
      capability: "benchmark_reverse", reason: "mcp_not_configured", command: "/private/provider", apiKey: "secret",
    });
    const reverseGap = await result("benchmark_reverse_create", reverseArguments("gap"));
    expect(reverseGap).toMatchObject({
      isError: true,
      structuredContent: {
        code: "CAPABILITY_UNAVAILABLE", capability: "benchmark_reverse", reason: "mcp_not_configured",
        configurationAction: "Configure MARKETING_BENCHMARK_MCP_COMMAND and MARKETING_BENCHMARK_MCP_ARGS in the trusted deployment environment",
      },
    });
    expect(JSON.stringify(reverseGap)).not.toContain("/private/provider");
    benchmarkProvider.failure = undefined;
    await createBenchmark();
    await createBrief();

    mediaProvider.failure = new DomainError("CAPABILITY_UNAVAILABLE", "private media failure", false, {
      capability: "professional_media", reason: "mcp_not_configured", env: "SECRET_ENV",
    });
    const generateGap = await result("content_asset_generate", generateArguments("media-gap"));
    expect(generateGap).toMatchObject({
      isError: true,
      structuredContent: {
        code: "CAPABILITY_UNAVAILABLE", capability: "professional_media", reason: "mcp_not_configured",
        configurationAction: "Configure MARKETING_MEDIA_MCP_COMMAND and MARKETING_MEDIA_MCP_ARGS in the trusted deployment environment",
      },
    });
    mediaProvider.failure = undefined;
    const generated = await call<AssetVersion>("content_asset_generate", generateArguments());
    mediaProvider.failure = new DomainError("CAPABILITY_UNAVAILABLE", "private derivative failure", false, {
      capability: "professional_media", reason: "mcp_unavailable", path: "/private/media",
    });
    const deriveGap = await result("content_asset_derive", {
      id: "asset-derived-gap", workspaceId: generated.workspaceId, contentId: generated.contentId,
      parentVersionId: generated.id, expectedParentVersion: 1, briefId: generated.briefId, expectedBriefVersion: 1,
      sourceMaterials: [], revisionInstructions: "Retry through the unavailable provider", ...context("derive-gap"),
    });
    expect(deriveGap).toMatchObject({ isError: true, structuredContent: { capability: "professional_media", reason: "mcp_unavailable" } });
    expect(JSON.stringify(deriveGap)).not.toContain("SECRET_ENV");
    mediaProvider.failure = undefined;

    validatorFailure = new DomainError("CAPABILITY_UNAVAILABLE", "private decode failure", false, {
      capability: "professional_media", reason: "image_decode_failed", path: "/private/image",
    });
    const decodeGap = await result("content_asset_generate", generateArguments("decode-gap"));
    expect(decodeGap).toMatchObject({ isError: true, structuredContent: { capability: "professional_media", reason: "image_decode_failed" } });
    await createBrief("channels");
    validatorFailure = new DomainError("CAPABILITY_UNAVAILABLE", "private probe failure", false, {
      capability: "video_probe", reason: "ffprobe_not_configured", command: "/private/ffprobe",
    });
    const probeGap = await result("content_asset_generate", generateArguments("probe-gap", "channels"));
    expect(probeGap).toMatchObject({
      isError: true,
      structuredContent: {
        capability: "video_probe", reason: "ffprobe_not_configured",
        configurationAction: "Configure MARKETING_FFPROBE_COMMAND as an absolute deployment-controlled executable path",
      },
    });
    expect(JSON.stringify(probeGap)).not.toContain("/private/ffprobe");
  });

  it("keeps invalid business input on strict MCP errors rather than capability-gap results", async () => {
    const response = await result("benchmark_reverse_create", {
      ...reverseArguments("business-invalid"), evidenceIds: ["evidence-benchmark", "evidence-benchmark"],
    });
    expect(response).toMatchObject({ isError: true });
    expect(response.structuredContent).toBeUndefined();
    expect(JSON.stringify(response)).toContain("Input validation error");
  });

  it("initializes with persisted-evidence, original-expression, decode/probe, chunk, and non-publishing instructions", () => {
    const instructions = client.getInstructions()!;
    for (const pattern of [
      /persisted evidence/i, /video frames and ASR/i, /original expression/i, /host.*language/i,
      /Finding references/i, /separate/i, /actual Chromium decode/i, /actual ffprobe/i, /base64 chunks/i,
      /internal.*profiles/i, /not.*publishing/i, /never claim human viewing/i, /invented metrics/i,
      /not approved, scheduled, or published/i,
    ]) expect(instructions).toMatch(pattern);
  });

  it("declares all five capabilities with trusted configuration, exact limits, and per-call validation", async () => {
    const capabilities = await call<AnalysisCapability[]>("marketing_capability_list", {});
    expect(capabilities.filter((capability) => capability.id.startsWith("content.") || capability.id.startsWith("media."))
      .map((capability) => capability.id).sort()).toEqual([
      "content.authoring", "content.internal_profiles", "content.reverse", "media.professional", "media.video_probe",
    ]);
    for (const id of ["content.reverse", "content.authoring", "media.professional", "media.video_probe", "content.internal_profiles"]) {
      expect(capabilities.find((capability) => capability.id === id)!.availability.state).toBe("available");
    }
    const all = capabilities.map((capability) => JSON.stringify(capability)).join(" ");
    for (const pattern of [
      /MARKETING_BENCHMARK_MCP_COMMAND/, /MARKETING_MEDIA_MCP_COMMAND/, /MARKETING_MEDIA_MCP_ENV_ALLOWLIST/,
      /MARKETING_FFPROBE_COMMAND/, /16 MiB/, /24 MiB/, /1 MiB/, /60 seconds/, /32 KiB/, /64 KiB/,
      /each explicit call/i, /internal_acceptance_only/, /1080x1440/, /1080x1920/, /H\.264/, /AAC/,
      /original.*language/i, /no local generator fallback/i, /not.*publish/i,
    ]) expect(all).toMatch(pattern);
  });

  it("registers tools without providers and fails closed on installed capability mismatches", async () => {
    const absentBenchmark = new BenchmarkService(store, clock, ids, artifacts);
    const absentContent = new ContentProductionService(store, clock, ids, artifacts);
    const absentServer = createMcpServer(
      marketing, dataResearch, analysis, {}, dashboard, strategy, absentBenchmark, absentContent,
    );
    const absentClient = new Client({ name: "absent-provider-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await absentServer.connect(serverTransport);
      await absentClient.connect(clientTransport);
      expect((await absentClient.listTools()).tools).toHaveLength(54);
      const response = await absentClient.callTool({ name: "marketing_capability_list", arguments: {} });
      const capabilities = JSON.parse((response.content[0] as { text: string }).text) as AnalysisCapability[];
      for (const id of ["content.reverse", "media.professional", "media.video_probe"]) {
        expect(capabilities.find((capability) => capability.id === id)!.availability.state).toBe("unavailable");
      }
      expect(capabilities.find((capability) => capability.id === "content.authoring")!.availability.state).toBe("available");
      expect(capabilities.find((capability) => capability.id === "media.video_probe")!.configuration.join(" "))
        .toMatch(/independent/i);
    } finally {
      await Promise.all([absentClient.close(), absentServer.close()]);
    }
    expect(() => createMcpServer(marketing, dataResearch, analysis, {
      benchmarkReverseConfigured: false,
    }, dashboard, strategy, benchmark, contentProduction)).toThrow("benchmarkReverseConfigured");
    expect(() => createMcpServer(marketing, dataResearch, analysis, {
      benchmarkReverseConfigured: true,
    }, dashboard, strategy, absentBenchmark, absentContent)).toThrow("benchmarkReverseConfigured");
    expect(() => createMcpServer(marketing, dataResearch, analysis, {
      professionalMediaConfigured: false,
    }, dashboard, strategy, benchmark, contentProduction)).toThrow("professionalMediaConfigured");
    expect(() => createMcpServer(marketing, dataResearch, analysis, {
      professionalMediaConfigured: true,
    }, dashboard, strategy, absentBenchmark, absentContent)).toThrow("professionalMediaConfigured");
    expect(() => createMcpServer(marketing, dataResearch, analysis, {
      ffprobeConfigured: false,
    }, dashboard, strategy, benchmark, contentProduction)).toThrow("ffprobeConfigured");
    expect(() => createMcpServer(marketing, dataResearch, analysis, {
      ffprobeConfigured: true,
    }, dashboard, strategy, absentBenchmark, absentContent)).toThrow("ffprobeConfigured");
    expect(() => createMcpServer(marketing, dataResearch, analysis, {
      contentProductionConfigured: false,
    }, dashboard, strategy, benchmark, contentProduction)).toThrow("contentProductionConfigured");
    expect(() => createMcpServer(marketing, dataResearch, analysis, {
      contentProductionConfigured: true,
    }, dashboard, strategy)).toThrow("contentProductionConfigured");
  });
});

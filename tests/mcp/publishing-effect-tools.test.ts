import { createHash } from "node:crypto";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisService, type AnalysisCapability } from "../../src/application/analysis-service.js";
import { BenchmarkService } from "../../src/application/benchmark-service.js";
import type { CommandContext } from "../../src/application/commands.js";
import { ContentProductionService } from "../../src/application/content-production-service.js";
import { DashboardService } from "../../src/application/dashboard-service.js";
import { DataResearchService } from "../../src/application/data-research-service.js";
import { EffectService } from "../../src/application/effect-service.js";
import { MarketingService } from "../../src/application/marketing-service.js";
import type { Store } from "../../src/application/ports.js";
import { PublishingService } from "../../src/application/publishing-service.js";
import { StrategyService } from "../../src/application/strategy-service.js";
import {
  createAssetVersion,
  createBenchmarkAnalysis,
  createContentBrief,
} from "../../src/domain/content-production-model.js";
import type { EffectReview, MetricSnapshot } from "../../src/domain/effect-model.js";
import type { Approval, Publication, Schedule } from "../../src/domain/publishing-model.js";
import { ArtifactStore, type StoredArtifact } from "../../src/infrastructure/artifact-store.js";
import {
  computePublishingSubmitInputHash,
  type PublishingProvider,
  type PublishingProviderResult,
  type PublishingSubmitRequest,
  type PublishingVerifyRequest,
} from "../../src/infrastructure/publishing-provider.js";
import { canonicalJson } from "../../src/infrastructure/sqlite.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { MAX_SERIALIZED_OUTPUT_BYTES } from "../../src/mcp/schemas.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const workspaceId = "workspace-1";
const initialNow = "2026-10-29T10:00:00.000Z";
const dueNow = "2026-10-30T11:00:00.000Z";
const newToolNames = [
  "approval_get",
  "approval_record",
  "effect_metric_snapshot_get",
  "effect_metric_snapshot_import",
  "effect_review_create",
  "effect_review_get",
  "delivery_package_get",
  "publication_get",
  "publication_manual_complete",
  "publication_manual_handoff",
  "publication_retry",
  "publication_submit",
  "publication_verify",
  "schedule_cancel",
  "schedule_create",
  "schedule_get",
  "schedule_reschedule",
];
const writeToolNames = [
  "approval_record",
  "effect_metric_snapshot_import",
  "effect_review_create",
  "publication_manual_complete",
  "publication_manual_handoff",
  "publication_retry",
  "publication_submit",
  "publication_verify",
  "schedule_cancel",
  "schedule_create",
  "schedule_reschedule",
];

function context(suffix: string): CommandContext {
  return { actor: "agent-1", requestId: `request-${suffix}`, idempotencyKey: `command-${suffix}` };
}

class StubPublishingProvider implements PublishingProvider {
  submitCalls = 0;
  verifyCalls = 0;

  isConfigured(channel: string, accountId: string): boolean {
    return channel === "xhs" && accountId === "account-1";
  }

  async submit(request: PublishingSubmitRequest): Promise<PublishingProviderResult> {
    this.submitCalls += 1;
    return this.result(request.operationKey, computePublishingSubmitInputHash(request), "accepted");
  }

  async verify(request: PublishingVerifyRequest): Promise<PublishingProviderResult> {
    this.verifyCalls += 1;
    return this.result(request.operationKey, request.inputHash, "verified");
  }

  private result(
    operationKey: string,
    inputHash: string,
    status: "accepted" | "verified",
  ): PublishingProviderResult {
    const receipt = Buffer.from(`${status}:${operationKey}`);
    return {
      status,
      inputHash,
      operationKey,
      channel: "xhs",
      accountId: "account-1",
      receipt: {
        receiptId: `receipt-${status}`,
        content: new Uint8Array(receipt),
        contentHash: createHash("sha256").update(receipt).digest("hex"),
      },
      externalPublicationId: status === "verified" ? "external-1" : null,
      publishedAt: status === "verified" ? dueNow : null,
      failure: null,
      toolVersion: "stub-1",
    };
  }
}

describe("publishing and effect MCP contracts", () => {
  let tempDir: string;
  let store: Store;
  let artifacts: ArtifactStore;
  let artifact: StoredArtifact;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let marketing: MarketingService;
  let dataResearch: DataResearchService;
  let analysis: AnalysisService;
  let dashboard: DashboardService;
  let strategy: StrategyService;
  let benchmark: BenchmarkService;
  let contentProduction: ContentProductionService;
  let publishing: PublishingService;
  let effect: EffectService;
  let provider: StubPublishingProvider;
  let now: string;
  let sequence: number;
  const clock = { now: () => now };
  const ids = { next: () => `audit-${++sequence}` };

  beforeEach(async () => {
    tempDir = await createTempDir();
    store = openStore(join(tempDir, "store.db"));
    artifacts = new ArtifactStore(join(tempDir, "artifacts"));
    artifact = await artifacts.put(Buffer.from("approved-image"));
    now = initialNow;
    sequence = 0;
    await seedGraph(store, artifact);
    marketing = new MarketingService(store, clock, ids);
    dataResearch = new DataResearchService(store, clock, ids, artifacts);
    analysis = new AnalysisService(store, clock, ids, artifacts);
    dashboard = new DashboardService(store, clock, ids, artifacts);
    strategy = new StrategyService(store, clock, ids);
    benchmark = new BenchmarkService(store, clock, ids, artifacts);
    contentProduction = new ContentProductionService(store, clock, ids, artifacts);
    provider = new StubPublishingProvider();
    publishing = new PublishingService(store, clock, ids, artifacts, provider, provider);
    effect = new EffectService(store, clock, ids);
    server = createMcpServer(
      marketing, dataResearch, analysis, {}, dashboard, strategy, benchmark, contentProduction,
      publishing, effect, true,
    );
    client = new Client({ name: "publishing-effect-test", version: "1.0.0" });
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
    expect(Buffer.byteLength(text, "utf8"), name).toBeLessThan(MAX_SERIALIZED_OUTPUT_BYTES);
    const parsed = JSON.parse(text) as T;
    expect(text).toBe(canonicalJson(parsed));
    return parsed;
  }

  function scheduleArguments(suffix: string, deliveryMode: "automatic" | "manual_assisted" = "automatic") {
    return {
      id: `schedule-${suffix}`,
      publicationId: `publication-${suffix}`,
      workspaceId,
      assetVersionId: "asset-1",
      expectedAssetVersion: 1,
      approvalId: "approval-1",
      channel: "xhs",
      accountId: "account-1",
      scheduledFor: "2026-10-30T10:00:00.000Z",
      timeZone: "UTC",
      deliveryMode,
      ...context(`schedule-${suffix}`),
    };
  }

  it("registers exactly 71 tools with strict raw schemas and write contexts on all 11 writes", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(71);
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(newToolNames));
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
      visit(tool.inputSchema);
      const serialized = JSON.stringify(tool.inputSchema);
      for (const forbidden of [
        "command", "args", "code", "env", "path", "credential", "apiKey", "secret",
        "password", "contentBase64", "artifactBase64", "media",
      ]) expect(serialized, `${name}.${forbidden}`).not.toContain(`\"${forbidden}\"`);
      const required = tool.inputSchema.required ?? [];
      for (const field of ["actor", "requestId", "idempotencyKey"]) {
        if (writeToolNames.includes(name)) expect(required, `${name}.${field}`).toContain(field);
        else expect(required, `${name}.${field}`).not.toContain(field);
      }
    }
    expect(tools.find((tool) => tool.name === "lineage_get")!.inputSchema.properties?.entityType)
      .toMatchObject({ enum: expect.arrayContaining([
        "approval", "schedule", "publication", "metric_snapshot", "effect_review",
      ]) });
  });

  it("adapts all 17 tools to real services, bounded packages, formulas, and lineage", async () => {
    const approval = await call<Approval>("approval_record", {
      id: "approval-1", workspaceId, assetVersionId: "asset-1", expectedAssetVersion: 1,
      decision: "approved", comment: "Human reviewed the exact artifact", ...context("approval"),
    });
    expect(approval).toMatchObject({ version: 1, artifactHash: artifact.contentHash });
    expect(await call<Approval>("approval_get", { id: approval.id, workspaceId })).toEqual(approval);

    const automatic = await call<Schedule>("schedule_create", scheduleArguments("automatic"));
    const manual = await call<Schedule>("schedule_create", scheduleArguments("manual", "manual_assisted"));
    const mutable = await call<Schedule>("schedule_create", scheduleArguments("mutable"));
    expect(automatic).toMatchObject({ status: "scheduled", version: 1 });
    const rescheduled = await call<Schedule>("schedule_reschedule", {
      id: mutable.id, workspaceId, expectedVersion: 1,
      scheduledFor: "2026-11-01T10:00:00.000Z", timeZone: "Europe/London", ...context("reschedule"),
    });
    expect(rescheduled).toMatchObject({ version: 2, timeZone: "Europe/London" });
    expect(await call<Schedule>("schedule_cancel", {
      id: mutable.id, workspaceId, expectedVersion: 2, ...context("cancel"),
    })).toMatchObject({ version: 3, status: "cancelled" });
    expect(await call<Schedule>("schedule_get", { id: manual.id, workspaceId })).toEqual(manual);

    now = dueNow;
    const submitted = await call<Publication>("publication_submit", {
      id: "publication-automatic", workspaceId, expectedVersion: 1, ...context("submit"),
    });
    expect(submitted).toMatchObject({ status: "submitted", verification: null });
    const verified = await call<Publication>("publication_verify", {
      id: submitted.id, workspaceId, expectedVersion: submitted.version, ...context("verify"),
    });
    expect(verified).toMatchObject({ status: "verified", verification: { method: "provider" } });
    expect(await call<Publication>("publication_retry", {
      id: verified.id, workspaceId, expectedVersion: verified.version, ...context("retry"),
    })).toEqual(verified);
    expect(await call<Publication>("publication_get", { id: verified.id, workspaceId })).toEqual(verified);
    expect(provider).toMatchObject({ submitCalls: 1, verifyCalls: 1 });

    const handoff = await call<Publication>("publication_manual_handoff", {
      id: "publication-manual", workspaceId, expectedVersion: 1, ...context("handoff"),
    });
    expect(handoff).toMatchObject({ status: "manual_handoff", delivery: null });
    const first = await call<{ content: string; length: number; totalBytes: number; contentHash: string }>(
      "delivery_package_get",
      { id: handoff.id, workspaceId, offset: 0, length: 32_768 },
    );
    const second = await call<{ content: string; length: number; offset: number }>(
      "delivery_package_get",
      { id: handoff.id, workspaceId, offset: 32_768, length: 32_768 },
    );
    expect(first.length).toBe(32_768);
    expect(first.totalBytes).toBeGreaterThan(32_768);
    expect(second.offset).toBe(32_768);
    const packageBytes = Buffer.concat([
      Buffer.from(first.content, "base64"), Buffer.from(second.content, "base64"),
    ]);
    expect(packageBytes.length).toBe(first.totalBytes);
    expect(createHash("sha256").update(packageBytes).digest("hex")).toBe(first.contentHash);
    expect(JSON.parse(packageBytes.toString("utf8"))).toMatchObject({ status: "not_published" });

    const completed = await call<Publication>("publication_manual_complete", {
      id: "completion-1", workspaceId, publicationId: handoff.id,
      expectedPublicationVersion: handoff.version, evidenceIds: ["evidence-1"],
      externalPublicationId: "external-manual-1", publishedAt: dueNow, ...context("manual-complete"),
    });
    expect(completed).toMatchObject({
      status: "verified", deliveryMode: "manual_assisted", verification: { method: "manual_evidence" },
    });

    const snapshot = await call<MetricSnapshot>("effect_metric_snapshot_import", {
      id: "snapshot-1", workspaceId, publicationId: completed.id,
      expectedPublicationVersion: completed.version,
      windowStart: dueNow, windowEnd: "2026-10-30T12:00:00.000Z",
      observedAt: "2026-10-30T12:00:00.000Z",
      observations: [
        { metric: "impressions", evidenceIds: ["evidence-operating"], value: 0 },
        { metric: "interactions", evidenceIds: ["evidence-operating"], value: 5 },
        { metric: "purchases", evidenceIds: ["evidence-conversion"], value: 2 },
      ],
      ...context("snapshot"),
    });
    expect(await call<MetricSnapshot>("effect_metric_snapshot_get", { id: snapshot.id, workspaceId })).toEqual(snapshot);
    const review = await call<EffectReview>("effect_review_create", {
      id: "review-1", workspaceId,
      publicationRefs: [{ id: completed.id, version: completed.version }],
      metricSnapshotIds: [snapshot.id], baselineMetricSnapshotIds: [], benchmarkEvidenceIds: [],
      ...context("review"),
    });
    expect(review.content.metrics.find((metric) => metric.name === "interactionRate")).toMatchObject({
      value: null, status: "unknown", reason: "zero_denominator", numerator: 5, denominator: 0,
    });
    expect(review.conversion.metrics.find((metric) => metric.name === "purchaseRate")).toMatchObject({
      value: null, status: "unknown", reason: "missing_denominator", numerator: 2, denominator: null,
    });
    expect(review.automation.metrics.find((metric) => metric.name === "automaticVerifiedRate"))
      .toMatchObject({ value: 0, numerator: 0, denominator: 1 });
    expect(review.efficiency.causality).toBe("not_established");
    expect(await call<EffectReview>("effect_review_get", { id: review.id, workspaceId })).toEqual(review);

    for (const [entityType, id] of [
      ["approval", approval.id], ["schedule", manual.id], ["publication", completed.id],
      ["metric_snapshot", snapshot.id], ["effect_review", review.id],
    ] as const) {
      const lineage = await call<{ nodes: { entityType: string; id: string }[] }>("lineage_get", {
        entityType, id, workspaceId,
      });
      expect(lineage.nodes).toContainEqual(expect.objectContaining({ entityType, id }));
    }
  });

  it("rejects unknown fields, nested secrets, invalid bounds and statuses before writes", async () => {
    const secret = "synthetic-publishing-secret";
    const valid = scheduleArguments("invalid");
    for (const arguments_ of [
      { ...valid, provider: { command: "/private/provider", env: { API_KEY: secret } } },
      { ...valid, nested: { apiKey: secret } },
      { ...valid, scheduledFor: "not-a-time" },
      { ...valid, timeZone: "Not/A_Timezone" },
      { ...valid, deliveryMode: "published" },
      { ...valid, expectedAssetVersion: 0 },
    ]) {
      const response = await result("schedule_create", arguments_);
      expect(response).toMatchObject({ isError: true });
      expect(JSON.stringify(response)).not.toContain(secret);
    }
    expect(await store.transaction((repos) => repos.schedules.get(valid.id, workspaceId))).toBeUndefined();
    expect(await result("effect_metric_snapshot_import", {
      id: "bad-snapshot", workspaceId, publicationId: "publication-manual", expectedPublicationVersion: 1,
      windowStart: dueNow, windowEnd: "2026-10-30T12:00:00.000Z", observedAt: "2026-10-30T12:00:00.000Z",
      observations: [{ metric: "impressions", evidenceIds: ["evidence-1"], value: -1 }],
      ...context("bad-snapshot"),
    })).toMatchObject({ isError: true });
    expect(await result("delivery_package_get", {
      id: "publication-manual", workspaceId, length: 32_769,
    })).toMatchObject({ isError: true });
  });

  it("keeps tools and manual workflows registered without a provider and reports automatic unavailable", async () => {
    await call("approval_record", {
      id: "approval-1", workspaceId, assetVersionId: "asset-1", expectedAssetVersion: 1,
      decision: "approved", comment: "Human reviewed the exact artifact", ...context("absent-approval"),
    });
    const absentPublishing = new PublishingService(store, clock, ids, artifacts);
    const absentServer = createMcpServer(
      marketing, dataResearch, analysis, {}, dashboard, strategy, benchmark, contentProduction,
      absentPublishing, effect,
    );
    const absentClient = new Client({ name: "absent-publishing-provider", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await absentServer.connect(serverTransport);
      await absentClient.connect(clientTransport);
      expect((await absentClient.listTools()).tools).toHaveLength(71);
      const response = await absentClient.callTool({ name: "marketing_capability_list", arguments: {} });
      const capabilities = JSON.parse((response.content[0] as { text: string }).text) as AnalysisCapability[];
      expect(capabilities.find((capability) => capability.id === "publishing.delivery")!.availability.state).toBe("available");
      expect(capabilities.find((capability) => capability.id === "publishing.automatic")!.availability.state).toBe("unavailable");
      expect(capabilities.find((capability) => capability.id === "effect.review")!.availability.state).toBe("available");
      const gap = await absentClient.callTool({
        name: "schedule_create",
        arguments: { ...scheduleArguments("absent-automatic"), id: "schedule-absent", publicationId: "publication-absent" },
      });
      expect(gap).toMatchObject({ isError: true, structuredContent: { code: "CAPABILITY_UNAVAILABLE" } });
      expect(JSON.stringify(gap)).not.toContain(tempDir);
    } finally {
      await Promise.all([absentClient.close(), absentServer.close()]);
    }
  });

  it("declares approval, scheduler, recovery, manual evidence, formula, and non-causal capabilities and instructions", async () => {
    const capabilities = await call<AnalysisCapability[]>("marketing_capability_list", {});
    const publishingText = capabilities.filter((capability) => capability.id.startsWith("publishing."))
      .map((capability) => JSON.stringify(capability)).join(" ");
    for (const pattern of [
      /exact AssetVersion/i, /artifact hash/i, /process lifetime/i, /startup/i, /overdue/i,
      /MARKETING_PUBLISHING_MCP_COMMAND/, /MARKETING_PUBLISHING_MCP_ARGS/, /MARKETING_PUBLISHING_MCP_ENV_ALLOWLIST/,
      /exact channel and account/i, /operationKey/, /verify/i, /not_found/i, /manual_assisted/,
      /manual_evidence/i, /not automatic/i, /submitted.*not.*verified/i,
    ]) expect(publishingText).toMatch(pattern);
    const effectText = JSON.stringify(capabilities.find((capability) => capability.id === "effect.review"));
    for (const pattern of [
      /owned_operating/, /owned_conversion/, /interactionRate/, /profileVisitRate/, /leadRate/,
      /purchaseRate/, /automaticVerifiedRate/, /zero denominator/i, /unknown/i, /causality/i,
    ]) expect(effectText).toMatch(pattern);
    const instructions = client.getInstructions()!;
    for (const pattern of [
      /submission.*not.*publication/i, /never claim.*unverified/i, /manual.*not.*automatic/i,
      /no causal/i,
    ]) expect(instructions).toMatch(pattern);
  });

  it("fails closed on installed capability mismatches", () => {
    expect(() => createMcpServer(
      marketing, dataResearch, analysis, { publishingConfigured: false }, dashboard, strategy,
      benchmark, contentProduction, publishing, effect, true,
    )).toThrow("publishingConfigured");
    expect(() => createMcpServer(
      marketing, dataResearch, analysis, { effectConfigured: false }, dashboard, strategy,
      benchmark, contentProduction, publishing, effect, true,
    )).toThrow("effectConfigured");
    expect(() => createMcpServer(
      marketing, dataResearch, analysis, { publishingProviderConfigured: true }, dashboard, strategy,
      benchmark, contentProduction,
    )).toThrow("publishingProviderConfigured");
  });
});

async function seedGraph(store: Store, artifact: StoredArtifact): Promise<void> {
  const base = { workspaceId, version: 1, createdAt: initialNow, updatedAt: initialNow };
  const brief = createContentBrief({
    id: "brief-1", workspaceId, createdAt: initialNow, channel: "xhs",
    taskId: "task-1", recommendationId: "recommendation-1", benchmarkAnalysisId: "benchmark-1",
    methodIds: ["method-1"], objective: "Original objective", audience: "Operators",
    copy: {
      hook: { id: "hook", kind: "creative", text: "Original hook" },
      body: [{ id: "body", kind: "creative", text: "Original body" }],
      cta: { id: "cta", kind: "creative", text: "Original call to action" },
    },
    frames: [],
    assetRequirements: [],
    findingIds: [], evidenceIds: [],
    sourceVersions: [
      { entityType: "task", id: "task-1", version: 1 },
      { entityType: "recommendation", id: "recommendation-1", version: 1 },
      { entityType: "benchmark_analysis", id: "benchmark-1", version: 1 },
    ],
  });
  const benchmark = createBenchmarkAnalysis({
    id: "benchmark-1", workspaceId, createdAt: initialNow, modality: "image", status: "completed",
    gaps: [], evidenceIds: ["evidence-1"], competitorDiffId: null,
    methods: [{
      id: "method-1", dimension: "layout", pattern: "Observed layout",
      transferableRule: "Transfer only layout structure", basis: "text", confidence: "medium",
      evidenceAssetRefs: [{
        sourceId: "source-1", evidenceId: "evidence-1", assetId: "benchmark-asset",
        kind: "original", observedAt: initialNow, contentHash: artifact.contentHash,
        byteLength: artifact.byteLength,
      }],
    }],
    sourceVersions: [
      { entityType: "source", id: "source-1", version: 1 },
      { entityType: "evidence", id: "evidence-1", version: 1 },
    ],
    provider: {
      type: "mcp", tool: "reverse_engineer", toolVersion: "fixture-1", inputHash: "a".repeat(64),
      analysisMethod: "fixture", humanReview: "not_performed",
    },
  });
  const asset = createAssetVersion({
    id: "asset-1", workspaceId, createdAt: initialNow, contentId: "content-1", channel: "xhs",
    briefId: brief.id, briefVersion: 1, taskId: brief.taskId, recommendationId: brief.recommendationId,
    parentVersionId: null, parentVersion: null,
    artifact: { id: "asset-1", kind: "primary", mediaType: "image/png", ...artifact },
    sourceMaterials: [],
    modification: {
      summary: "Initial controlled asset", revisionInstructions: "R".repeat(30_000), actor: "agent-1",
      requestId: "request-generate", createdAt: initialNow,
    },
    provider: { type: "mcp", tool: "render", toolVersion: "fixture-1", inputHash: "b".repeat(64) },
    validation: {
      status: "passed", profileId: "xhs_png_1080x1440_v1", guarantee: "internal_acceptance_only",
      decoder: "playwright_chromium", width: 1080, height: 1440,
      durationMs: null, videoCodec: null, audioCodec: null,
    },
    evidenceIds: [], sourceVersions: [{ entityType: "content_brief", id: brief.id, version: 1 }],
  });
  await store.transaction(async (repos) => {
    await repos.workspaces.insert({ ...base, id: workspaceId, name: workspaceId });
    await repos.sources.insert({ ...base, id: "source-1", name: "Source", type: "manual", ownership: "owned" });
    for (const [id, classification, observedAt] of [
      ["evidence-1", "owned_operating", initialNow],
      ["evidence-operating", "owned_operating", "2026-10-30T12:00:00.000Z"],
      ["evidence-conversion", "owned_conversion", "2026-10-30T12:00:00.000Z"],
    ] as const) {
      await repos.evidence.insert({
        ...base, id, sourceId: "source-1", sourceLocator: "fixture", observedAt,
        summary: id, contentHash: artifact.contentHash, classification,
        ...(id === "evidence-1" ? { assets: [{ id: "benchmark-asset", kind: "original" as const, ...artifact }] } : {}),
      });
    }
    await repos.recommendations.insert({
      ...base, id: brief.recommendationId, findingIds: [], hypothesis: "Hypothesis",
      affectedStage: "activation", priority: "high", expectedMetric: "activation", targetChannels: ["xhs"],
    });
    await repos.tasks.insert({
      ...base, id: brief.taskId, recommendationIds: [brief.recommendationId], assignee: "marketer",
      dependencyIds: [], assetRequirements: [], acceptanceCriteria: ["Validated"], state: "ready",
    });
    await repos.benchmarkAnalyses.insert(benchmark);
    await repos.contentBriefs.insert(brief);
    await repos.assetVersions.insert(asset);
  });
}

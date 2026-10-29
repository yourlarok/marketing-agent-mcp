import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../../src/application/commands.js";
import type { Store } from "../../src/application/ports.js";
import { PublicationScheduler } from "../../src/application/publication-scheduler.js";
import type { CreateSchedule } from "../../src/application/publishing-commands.js";
import { PublishingService } from "../../src/application/publishing-service.js";
import {
  createAssetVersion,
  createBenchmarkAnalysis,
  createContentBrief,
} from "../../src/domain/content-production-model.js";
import type { Publication } from "../../src/domain/publishing-model.js";
import { ArtifactStore, type StoredArtifact } from "../../src/infrastructure/artifact-store.js";
import type {
  PublishingProvider,
  PublishingProviderResult,
  PublishingSubmitRequest,
  PublishingVerifyRequest,
} from "../../src/infrastructure/publishing-provider.js";
import { canonicalJson } from "../../src/infrastructure/sqlite.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const workspaceId = "workspace-1";
const initialNow = "2026-10-29T10:00:00.000Z";
const due = "2026-10-30T10:00:00.000Z";

function context(suffix: string): CommandContext {
  return {
    actor: "scheduler-test",
    requestId: `request-${suffix}`,
    idempotencyKey: `scheduler-test-${suffix}`,
  };
}

class FixtureProvider implements PublishingProvider {
  submitCalls = 0;
  verifyCalls = 0;
  submitGate: Promise<void> | undefined;
  submitStarted: (() => void) | undefined;
  submitOutcome: "accepted" | "failed" = "accepted";

  isConfigured(): boolean {
    return true;
  }

  async submit(request: PublishingSubmitRequest): Promise<PublishingProviderResult> {
    this.submitCalls += 1;
    this.submitStarted?.();
    await this.submitGate;
    return {
      status: this.submitOutcome === "accepted" ? "accepted" : "failed",
      inputHash: createHash("sha256").update(canonicalJson({
        operationKey: request.operationKey,
        publicationId: request.publicationId,
        workspaceId: request.workspaceId,
        scheduleId: request.scheduleId,
        assetVersionId: request.assetVersionId,
        assetVersion: request.assetVersion,
        artifactHash: request.artifactHash,
        artifactByteLength: request.artifactByteLength,
        artifactBase64: request.artifactBase64,
        channel: request.channel,
        accountId: request.accountId,
      })).digest("hex"),
      operationKey: request.operationKey,
      channel: request.channel,
      accountId: request.accountId,
      receipt: null,
      externalPublicationId: null,
      publishedAt: null,
      failure: this.submitOutcome === "failed" ? {
        code: "fixture_rejected", message: "Definite fixture rejection", retryable: false,
      } : null,
      toolVersion: "fixture-1",
    };
  }

  async verify(request: PublishingVerifyRequest): Promise<PublishingProviderResult> {
    this.verifyCalls += 1;
    return {
      status: "verified",
      inputHash: request.inputHash,
      operationKey: request.operationKey,
      channel: request.channel,
      accountId: request.accountId,
      receipt: null,
      externalPublicationId: "external-1",
      publishedAt: due,
      failure: null,
      toolVersion: "fixture-1",
    };
  }
}

describe("PublicationScheduler and manual-assisted delivery", () => {
  let tempDir: string;
  let artifactRoot: string;
  let store: Store;
  let artifacts: ArtifactStore;
  let stored: StoredArtifact;
  let provider: FixtureProvider;
  let service: PublishingService;
  let scheduler: PublicationScheduler;
  let now: string;
  let sequence: number;

  beforeEach(async () => {
    tempDir = await createTempDir();
    artifactRoot = await createTempDir();
    store = openStore(join(tempDir, "scheduler.db"));
    artifacts = new ArtifactStore(artifactRoot);
    stored = await artifacts.put(Buffer.from("approved media bytes"));
    provider = new FixtureProvider();
    now = initialNow;
    sequence = 0;
    service = new PublishingService(
      store,
      { now: () => now },
      { next: () => `audit-${++sequence}` },
      artifacts,
      provider,
      provider,
    );
    scheduler = new PublicationScheduler(store, service, { now: () => now });
    await seedGraph(store, stored);
  });

  afterEach(async () => {
    await scheduler.stop();
    store.close();
    await Promise.all([removeTempDir(tempDir), removeTempDir(artifactRoot)]);
  });

  async function schedule(overrides: Partial<CreateSchedule> = {}, suffix = "create"): Promise<void> {
    await service.recordApproval({
      input: {
        id: "approval-1", workspaceId, assetVersionId: "asset-1", expectedAssetVersion: 1,
        decision: "approved", comment: "Approved exact bytes",
      },
      context: context(`approve-${suffix}`),
    });
    await service.createSchedule({
      input: {
        id: "schedule-1", publicationId: "publication-1", workspaceId,
        assetVersionId: "asset-1", expectedAssetVersion: 1, approvalId: "approval-1",
        channel: "xhs", accountId: "account-1", scheduledFor: due, timeZone: "UTC",
        deliveryMode: "automatic", ...overrides,
      },
      context: context(`schedule-${suffix}`),
    });
  }

  async function publication(): Promise<Publication> {
    return (await store.transaction((repos) => repos.publications.get("publication-1", workspaceId)))!;
  }

  it("does nothing before due, then automatically submits and verifies due and overdue work exactly once", async () => {
    await schedule();
    await scheduler.runOnce();
    expect(provider.submitCalls).toBe(0);
    expect(await publication()).toMatchObject({ status: "pending" });

    now = due;
    await Promise.all([scheduler.runOnce(), scheduler.runOnce(), scheduler.recover()]);
    expect(provider.submitCalls).toBe(1);
    expect(provider.verifyCalls).toBe(1);
    expect(await publication()).toMatchObject({
      status: "verified",
      delivery: { method: "provider" },
      verification: { method: "provider" },
    });
    expect(await store.transaction((repos) => repos.schedules.get("schedule-1", workspaceId)))
      .toMatchObject({ status: "completed" });

    now = "2026-11-01T10:00:00.000Z";
    await scheduler.runOnce();
    expect(provider.submitCalls).toBe(1);
    expect(provider.verifyCalls).toBe(1);
  });

  it("does not fire at an old time after reschedule or cancellation", async () => {
    await schedule();
    await service.reschedule({
      input: {
        id: "schedule-1", workspaceId, expectedVersion: 1,
        scheduledFor: "2026-11-02T10:00:00.000Z", timeZone: "UTC",
      },
      context: context("reschedule"),
    });
    now = due;
    await scheduler.runOnce();
    expect(provider.submitCalls).toBe(0);

    await service.cancelSchedule({
      input: { id: "schedule-1", workspaceId, expectedVersion: 2 },
      context: context("cancel"),
    });
    now = "2026-11-03T10:00:00.000Z";
    await scheduler.runOnce();
    expect(provider.submitCalls).toBe(0);
    expect(await publication()).toMatchObject({ status: "cancelled" });
  });

  it.each(["submitting", "submitted", "unknown"] as const)(
    "recovers %s with verification only and reconciles the Schedule",
    async (status) => {
      await schedule();
      now = due;
      await store.transaction(async (repos) => {
        const current = (await repos.publications.get("publication-1", workspaceId))!;
        await repos.publications.update({
          ...current,
          status,
          attempts: status === "submitting" ? [{
            attempt: 1, startedAt: due, completedAt: null, outcome: "submitting",
          }] : current.attempts,
        }, current.version);
      });
      if (status === "submitting") now = "2026-10-30T10:00:31.000Z";
      await scheduler.recover();
      expect(provider.submitCalls).toBe(0);
      expect(provider.verifyCalls).toBe(1);
      expect(await publication()).toMatchObject({ status: "verified" });
      expect(await store.transaction((repos) => repos.schedules.get("schedule-1", workspaceId)))
        .toMatchObject({ status: "completed" });
    },
  );

  it("performs startup recovery and catch-up, and stop prevents later ticks", async () => {
    await schedule();
    now = due;
    await scheduler.start();
    expect(provider.submitCalls).toBe(1);
    expect(provider.verifyCalls).toBe(1);
    await scheduler.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(provider.submitCalls).toBe(1);
  });

  it("stop awaits an in-flight provider call before returning", async () => {
    await schedule();
    now = due;
    let release!: () => void;
    let started!: () => void;
    provider.submitGate = new Promise<void>((resolve) => { release = resolve; });
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    provider.submitStarted = () => started();
    const running = scheduler.runOnce();
    await providerStarted;
    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    release();
    await Promise.all([running, stopping]);
    expect(stopped).toBe(true);
    expect(provider.submitCalls).toBe(1);
    expect(provider.verifyCalls).toBe(1);
    expect(await publication()).toMatchObject({ status: "verified" });
  });

  it("hands manual due work off without any provider call and reads a canonical package in bounded chunks", async () => {
    const largeObjective = "Package objective ".repeat(3_000);
    await seedGraph(store, stored, "workspace-large", "asset-large", largeObjective);
    const largeService = new PublishingService(
      store, { now: () => now }, { next: () => `audit-${++sequence}` }, artifacts, provider, provider,
    );
    await largeService.recordApproval({
      input: {
        id: "approval-large", workspaceId: "workspace-large", assetVersionId: "asset-large",
        expectedAssetVersion: 1, decision: "approved", comment: "Approved exact bytes",
      },
      context: context("large-approve"),
    });
    await largeService.createSchedule({
      input: {
        id: "schedule-large", publicationId: "publication-large", workspaceId: "workspace-large",
        assetVersionId: "asset-large", expectedAssetVersion: 1, approvalId: "approval-large",
        channel: "xhs", accountId: "account-large", scheduledFor: due, timeZone: "UTC",
        deliveryMode: "manual_assisted",
      },
      context: context("large-schedule"),
    });
    now = due;
    await scheduler.runOnce();
    expect(provider.submitCalls).toBe(0);
    expect(provider.verifyCalls).toBe(0);
    expect(await store.transaction((repos) => repos.publications.get("publication-large", "workspace-large")))
      .toMatchObject({ status: "manual_handoff", verification: null, delivery: null });
    expect(await store.transaction((repos) => repos.schedules.get("schedule-large", "workspace-large")))
      .toMatchObject({ status: "triggered" });

    const first = await largeService.getDeliveryPackage({
      id: "publication-large", workspaceId: "workspace-large", offset: 0, length: 32_768,
    });
    expect(first.content).toBeInstanceOf(Buffer);
    expect(first.content.length).toBe(32_768);
    expect(first.totalBytes).toBeGreaterThan(32_768);
    const second = await largeService.getDeliveryPackage({
      id: "publication-large", workspaceId: "workspace-large", offset: first.length, length: 32_768,
    });
    expect(second.content.length).toBeLessThanOrEqual(32_768);
    const bytes = Buffer.concat([first.content, second.content]);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(first.contentHash);
    expect(bytes.toString("utf8")).toBe(canonicalJson(JSON.parse(bytes.toString("utf8"))));
    const packageValue = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    expect(packageValue).toMatchObject({
      status: "not_published",
      accountId: "account-large",
      channel: "xhs",
      operationKey: expect.stringMatching(/^publish:v1:/),
      brief: { id: "workspace-large-brief-1", objective: largeObjective },
      asset: { id: "asset-large", artifact: { contentHash: stored.contentHash } },
      schedule: { id: "schedule-large" },
      approval: { id: "approval-large" },
      artifactHash: stored.contentHash,
    });
    expect(packageValue.briefHash).toBe(createHash("sha256").update(canonicalJson(packageValue.brief)).digest("hex"));
    expect(packageValue.assetHash).toBe(createHash("sha256").update(canonicalJson(packageValue.asset)).digest("hex"));
    expect(JSON.stringify(packageValue)).not.toContain("artifactBase64");
    expect(JSON.stringify(packageValue)).not.toContain("MARKETING_PUBLISHING_MCP_COMMAND");
    await expect(largeService.getDeliveryPackage({
      id: "publication-large", workspaceId: "workspace-large", length: 32_769,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("completes manual handoff only with exact owned operating Evidence and reports manual_evidence", async () => {
    await schedule({ deliveryMode: "manual_assisted" }, "manual-complete");
    now = due;
    await scheduler.runOnce();
    const handoff = await publication();
    const command = {
      input: {
        id: "manual-completion-1", workspaceId, publicationId: handoff.id,
        expectedPublicationVersion: handoff.version, evidenceIds: ["evidence-1"],
        externalPublicationId: "manual-external-1", publishedAt: due,
      },
      context: context("manual-complete"),
    };
    const completed = await service.manualComplete(command);
    expect(completed).toMatchObject({
      status: "verified",
      delivery: {
        method: "manual_evidence", externalPublicationId: "manual-external-1",
        publishedAt: due, evidenceIds: ["evidence-1"],
      },
      verification: { method: "manual_evidence", evidenceIds: ["evidence-1"] },
    });
    expect(completed.verification?.method).not.toBe("provider");
    expect(await store.transaction((repos) => repos.schedules.get("schedule-1", workspaceId)))
      .toMatchObject({ status: "completed" });
    expect(await service.manualComplete(command)).toEqual(completed);
    expect(provider.submitCalls).toBe(0);
    expect(provider.verifyCalls).toBe(0);
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "publication", handoff.id)))
      .toMatchObject([{ action: "publication.manual_handoff" }, { action: "publication.manual_complete" }]);
  });

  it("rejects unknown manual bypass and unauthorized or wrong-class evidence without success residue", async () => {
    await schedule({ deliveryMode: "manual_assisted" }, "manual-validation");
    now = due;
    await store.transaction(async (repos) => {
      const current = (await repos.publications.get("publication-1", workspaceId))!;
      await repos.publications.update({ ...current, status: "unknown" }, current.version);
    });
    const unknown = await publication();
    const bypassContext = context("manual-bypass");
    await expect(service.manualHandoff({
      input: { id: unknown.id, workspaceId, expectedVersion: unknown.version }, context: bypassContext,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(provider.verifyCalls).toBe(0);
    expect(await store.transaction((repos) => repos.idempotency.get(workspaceId, bypassContext.idempotencyKey)))
      .toBeUndefined();

    await store.transaction(async (repos) => {
      const current = (await repos.publications.get("publication-1", workspaceId))!;
      await repos.publications.update({ ...current, status: "pending" }, current.version);
    });
    await scheduler.runOnce();
    const handoff = await publication();
    await store.transaction(async (repos) => {
      const evidence = (await repos.evidence.get("evidence-1", workspaceId))!;
      await repos.evidence.update({ ...evidence, classification: "owned_conversion" }, evidence.version);
    });
    const invalidContext = context("manual-wrong-evidence");
    await expect(service.manualComplete({
      input: {
        id: "manual-completion-invalid", workspaceId, publicationId: handoff.id,
        expectedPublicationVersion: handoff.version, evidenceIds: ["evidence-1"],
        externalPublicationId: "manual-external-1", publishedAt: due,
      }, context: invalidContext,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await publication()).toMatchObject({ status: "manual_handoff" });
    expect(await store.transaction((repos) => repos.idempotency.get(workspaceId, invalidContext.idempotencyKey)))
      .toBeUndefined();
  });

  it("allows a definite automatic failure to become manual handoff without claiming publication", async () => {
    provider.submitOutcome = "failed";
    await schedule({}, "failed-manual");
    now = due;
    await scheduler.runOnce();
    const failed = await publication();
    expect(failed).toMatchObject({ status: "failed", verification: null });
    const handoff = await service.manualHandoff({
      input: { id: failed.id, workspaceId, expectedVersion: failed.version }, context: context("failed-handoff"),
    });
    expect(handoff).toMatchObject({ status: "manual_handoff", verification: null, delivery: null });
    expect(provider.submitCalls).toBe(1);
    expect(provider.verifyCalls).toBe(0);
  });
});

async function seedGraph(
  store: Store,
  artifact: StoredArtifact,
  workspace = workspaceId,
  assetId = "asset-1",
  objective = "Original objective",
): Promise<void> {
  const base = { workspaceId: workspace, version: 1, createdAt: initialNow, updatedAt: initialNow };
  const id = (name: string) => workspace === workspaceId ? name : `${workspace}-${name}`;
  const briefId = id("brief-1");
  const brief = createContentBrief({
    id: briefId, workspaceId: workspace, createdAt: initialNow, channel: "xhs",
    taskId: id("task-1"), recommendationId: id("recommendation-1"), benchmarkAnalysisId: id("benchmark-1"),
    methodIds: [id("method-1")], objective, audience: "Operators",
    copy: {
      hook: { id: id("hook"), kind: "creative", text: "Original hook" },
      body: [{ id: id("body"), kind: "creative", text: "Original body" }],
      cta: { id: id("cta"), kind: "creative", text: "Original call to action" },
    },
    frames: [], assetRequirements: [], findingIds: [], evidenceIds: [],
    sourceVersions: [
      { entityType: "task", id: id("task-1"), version: 1 },
      { entityType: "recommendation", id: id("recommendation-1"), version: 1 },
      { entityType: "benchmark_analysis", id: id("benchmark-1"), version: 1 },
    ],
  });
  const benchmark = createBenchmarkAnalysis({
    id: id("benchmark-1"), workspaceId: workspace, createdAt: initialNow,
    modality: "image", status: "completed", gaps: [], evidenceIds: [id("evidence-1")], competitorDiffId: null,
    methods: [{
      id: id("method-1"), dimension: "layout", pattern: "Observed layout",
      transferableRule: "Transfer only layout structure", basis: "text", confidence: "medium",
      evidenceAssetRefs: [{
        sourceId: id("source-1"), evidenceId: id("evidence-1"), assetId: id("benchmark-asset"),
        kind: "original", observedAt: initialNow, contentHash: artifact.contentHash, byteLength: artifact.byteLength,
      }],
    }],
    sourceVersions: [
      { entityType: "source", id: id("source-1"), version: 1 },
      { entityType: "evidence", id: id("evidence-1"), version: 1 },
    ],
    provider: {
      type: "mcp", tool: "reverse_engineer", toolVersion: "fixture-1", inputHash: "a".repeat(64),
      analysisMethod: "fixture", humanReview: "not_performed",
    },
  });
  const asset = createAssetVersion({
    id: assetId, workspaceId: workspace, createdAt: initialNow, contentId: id("content-1"), channel: "xhs",
    briefId: brief.id, briefVersion: 1, taskId: brief.taskId, recommendationId: brief.recommendationId,
    parentVersionId: null, parentVersion: null,
    artifact: { id: assetId, kind: "primary", mediaType: "image/png", ...artifact },
    sourceMaterials: [],
    modification: {
      summary: "Initial controlled asset", revisionInstructions: "Render", actor: "agent-1",
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
    await repos.workspaces.insert({ ...base, id: workspace, name: workspace });
    await repos.sources.insert({
      ...base, id: id("source-1"), name: "Source", type: "manual", ownership: "owned",
    });
    await repos.evidence.insert({
      ...base, id: id("evidence-1"), sourceId: id("source-1"), sourceLocator: "fixture",
      observedAt: initialNow, summary: "Fixture evidence", contentHash: artifact.contentHash,
      classification: "owned_operating",
      assets: [{ id: id("benchmark-asset"), kind: "original", ...artifact }],
    });
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

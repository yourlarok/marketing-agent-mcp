import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CreateSchedule,
  RecordApproval,
  Reschedule,
} from "../../src/application/publishing-commands.js";
import { PublishingService } from "../../src/application/publishing-service.js";
import type { CommandContext } from "../../src/application/commands.js";
import type { Store } from "../../src/application/ports.js";
import {
  createAssetVersion,
  createBenchmarkAnalysis,
  createContentBrief,
  type AssetVersion,
} from "../../src/domain/content-production-model.js";
import { DomainError } from "../../src/domain/errors.js";
import { createApproval, type Approval } from "../../src/domain/publishing-model.js";
import { ArtifactStore, type StoredArtifact } from "../../src/infrastructure/artifact-store.js";
import { canonicalJson } from "../../src/infrastructure/sqlite.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const workspaceId = "workspace-1";
const initialNow = "2026-10-29T10:00:00.000Z";
const future = "2026-10-30T10:00:00.000Z";

function context(suffix: string, actor = "reviewer-1"): CommandContext {
  return { actor, requestId: `request-${suffix}`, idempotencyKey: `publishing-${suffix}` };
}

describe("PublishingService approval and schedule gates", () => {
  let tempDir: string;
  let artifactRoot: string;
  let storePath: string;
  let store: Store;
  let artifacts: ArtifactStore;
  let stored: StoredArtifact;
  let service: PublishingService;
  let sequence: number;
  let now: string;
  let configuredAccounts: Set<string>;

  beforeEach(async () => {
    tempDir = await createTempDir();
    artifactRoot = await createTempDir();
    storePath = join(tempDir, "publishing.db");
    store = openStore(storePath);
    artifacts = new ArtifactStore(artifactRoot);
    stored = await artifacts.put(Buffer.from("exact approved artifact"));
    sequence = 0;
    now = initialNow;
    configuredAccounts = new Set(["account-1"]);
    service = createService();
    await seedGraph(store, workspaceId, "asset-1", stored);
  });

  afterEach(async () => {
    store.close();
    await Promise.all([removeTempDir(tempDir), removeTempDir(artifactRoot)]);
  });

  function createService(currentStore = store): PublishingService {
    return new PublishingService(
      currentStore,
      { now: () => now },
      { next: () => `audit-${++sequence}` },
      artifacts,
      { isConfigured: (channel, accountId) => channel === "xhs" && configuredAccounts.has(accountId) },
    );
  }

  function approvalInput(overrides: Partial<RecordApproval> = {}): RecordApproval {
    return {
      id: "approval-1",
      workspaceId,
      assetVersionId: "asset-1",
      expectedAssetVersion: 1,
      decision: "approved",
      comment: "Human reviewed the exact rendered asset",
      ...overrides,
    };
  }

  function scheduleInput(overrides: Partial<CreateSchedule> = {}): CreateSchedule {
    return {
      id: "schedule-1",
      publicationId: "publication-1",
      workspaceId,
      assetVersionId: "asset-1",
      expectedAssetVersion: 1,
      approvalId: "approval-1",
      channel: "xhs",
      accountId: "account-1",
      scheduledFor: future,
      timeZone: "UTC",
      deliveryMode: "automatic",
      ...overrides,
    };
  }

  async function approve(overrides: Partial<RecordApproval> = {}, suffix = "approve"): Promise<Approval> {
    return service.recordApproval({ input: approvalInput(overrides), context: context(suffix) });
  }

  async function insertDerivative(id = "asset-2", bytes = "changed derivative artifact"): Promise<AssetVersion> {
    const root = (await store.transaction((repos) => repos.assetVersions.get("asset-1", workspaceId)))!;
    const derivativeStored = await artifacts.put(Buffer.from(bytes));
    const derivative = createAssetVersion({
      ...root,
      id,
      version: 2,
      parentVersionId: root.id,
      parentVersion: 1,
      artifact: { id, kind: "primary", mediaType: "image/png", ...derivativeStored },
      sourceMaterials: [{
        role: "parent",
        assetVersionId: root.id,
        artifactId: root.artifact.id,
        mediaType: root.artifact.mediaType,
        contentHash: root.artifact.contentHash,
        byteLength: root.artifact.byteLength,
      }],
      sourceVersions: [...root.sourceVersions, { entityType: "asset_version", id: root.id, version: 1 }],
    });
    await store.transaction((repos) => repos.assetVersions.insert(derivative));
    return derivative;
  }

  async function expectNoApproval(id: string, key: string): Promise<void> {
    expect(await store.transaction((repos) => repos.approvals.get(id, workspaceId))).toBeUndefined();
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "approval", id))).toEqual([]);
    expect(await store.transaction((repos) => repos.idempotency.get(workspaceId, key))).toBeUndefined();
  }

  async function expectNoSchedule(id: string, key: string): Promise<void> {
    expect(await store.transaction((repos) => repos.schedules.get(id, workspaceId))).toBeUndefined();
    expect(await store.transaction((repos) => repos.publications.getByScheduleId(id, workspaceId))).toBeUndefined();
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "schedule", id))).toEqual([]);
    expect(await store.transaction((repos) => repos.idempotency.get(workspaceId, key))).toBeUndefined();
  }

  it("records the deployment actor as human-attested, hashes actual bytes, and replays without duplicate audit", async () => {
    const command = { input: approvalInput(), context: context("approval-replay", "human-deployment-actor") };
    const first = await service.recordApproval(command);
    expect(first).toMatchObject({
      assetVersionId: "asset-1",
      assetVersion: 1,
      artifactHash: stored.contentHash,
      decision: "approved",
      reviewer: { actor: "human-deployment-actor", attestation: "human_attested" },
      decidedAt: initialNow,
      version: 1,
    });
    expect(await service.getApproval({ id: first.id, workspaceId })).toEqual(first);

    store.close();
    store = openStore(storePath);
    service = createService();
    expect(await service.recordApproval(command)).toEqual(first);
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "approval", first.id))).toHaveLength(1);
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "approval", first.id)))
      .toMatchObject([{ actor: "human-deployment-actor", action: "approval.record", requestId: command.context.requestId }]);
    await expect(service.getApproval({ id: first.id, workspaceId: "workspace-other" }))
      .rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
  });

  it("rejects stale and cross-workspace approval targets without approval, audit, or idempotency residue", async () => {
    const staleContext = context("approval-stale");
    await expect(service.recordApproval({ input: approvalInput({ expectedAssetVersion: 2 }), context: staleContext }))
      .rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await expectNoApproval("approval-1", staleContext.idempotencyKey);

    const otherStored = await artifacts.put(Buffer.from("other workspace artifact"));
    await seedGraph(store, "workspace-2", "asset-other", otherStored);
    const crossContext = context("approval-cross");
    await expect(service.recordApproval({
      input: approvalInput({ id: "approval-cross", assetVersionId: "asset-other" }), context: crossContext,
    })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    await expectNoApproval("approval-cross", crossContext.idempotencyKey);
  });

  it("rejects missing, changed, or wrong-length artifact bytes before recording approval", async () => {
    await writeFile(join(artifactRoot, stored.contentHash), Buffer.from("tampered bytes"));
    const command = { input: approvalInput(), context: context("approval-tampered") };
    await expect(service.recordApproval(command)).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await expectNoApproval("approval-1", command.context.idempotencyKey);
  });

  it("creates Schedule and pending Publication atomically with the exact canonical operation key", async () => {
    await approve();
    const schedule = await service.createSchedule({
      input: scheduleInput({ timeZone: "America/New_York" }), context: context("schedule-create"),
    });
    const publication = await store.transaction((repos) => repos.publications.getByScheduleId(schedule.id, workspaceId));
    const expectedOperationKey = `publish:v1:${createHash("sha256").update(canonicalJson({
      workspaceId,
      scheduleId: schedule.id,
      assetVersionId: "asset-1",
      assetVersion: 1,
      artifactHash: stored.contentHash,
      channel: "xhs",
      accountId: "account-1",
    })).digest("hex")}`;
    expect(schedule).toMatchObject({
      id: "schedule-1", assetVersionId: "asset-1", assetVersion: 1, approvalId: "approval-1",
      channel: "xhs", accountId: "account-1", scheduledFor: future, timeZone: "America/New_York",
      deliveryMode: "automatic", status: "scheduled", version: 1,
    });
    expect(publication).toMatchObject({
      id: "publication-1", scheduleId: schedule.id, scheduleVersion: 1,
      assetVersionId: "asset-1", assetVersion: 1, approvalId: "approval-1",
      artifactHash: stored.contentHash, operationKey: expectedOperationKey,
      channel: "xhs", accountId: "account-1", deliveryMode: "automatic", status: "pending",
      attempts: [], receipts: [], failure: null, delivery: null, verification: null, version: 1,
    });
    expect(publication?.operationKey).toMatch(/^publish:v1:[0-9a-f]{64}$/);
    expect(await service.getSchedule({ id: schedule.id, workspaceId })).toEqual(schedule);
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "schedule", schedule.id))).toHaveLength(1);
  });

  it.each(["unapproved", "rejected", "wrong-version", "wrong-hash"] as const)(
    "rejects %s approval state at scheduling without residue",
    async (scenario) => {
      if (scenario === "rejected") {
        await approve({ decision: "rejected" }, "reject-approval");
      } else if (scenario === "wrong-version" || scenario === "wrong-hash") {
        await store.transaction((repos) => repos.approvals.insert(createApproval({
          id: "approval-1",
          workspaceId,
          createdAt: now,
          assetVersionId: "asset-1",
          assetVersion: scenario === "wrong-version" ? 2 : 1,
          artifactHash: scenario === "wrong-hash" ? "f".repeat(64) : stored.contentHash,
          decision: "approved",
          reviewer: { actor: "human-1", attestation: "human_attested" },
          comment: "Direct fixture for a mismatched terminal approval",
          decidedAt: now,
        })));
      }
      const command = { input: scheduleInput(), context: context(`schedule-${scenario}`) };
      await expect(service.createSchedule(command)).rejects.toMatchObject<DomainError>({
        code: scenario === "unapproved" ? "NOT_FOUND" : "CONFLICT",
      });
      await expectNoSchedule(command.input.id, command.context.idempotencyKey);
    },
  );

  it("does not transfer an old approval to a derivative and accepts its new exact approval", async () => {
    await approve();
    await insertDerivative();
    const oldApprovalCommand = {
      input: scheduleInput({ assetVersionId: "asset-2", expectedAssetVersion: 2 }),
      context: context("derivative-old-approval"),
    };
    await expect(service.createSchedule(oldApprovalCommand)).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await expectNoSchedule("schedule-1", oldApprovalCommand.context.idempotencyKey);

    await approve({ id: "approval-2", assetVersionId: "asset-2", expectedAssetVersion: 2 }, "approve-derivative");
    const scheduled = await service.createSchedule({
      input: scheduleInput({ assetVersionId: "asset-2", expectedAssetVersion: 2, approvalId: "approval-2" }),
      context: context("derivative-new-approval"),
    });
    expect(scheduled).toMatchObject({ assetVersionId: "asset-2", assetVersion: 2, approvalId: "approval-2" });
  });

  it("rejects stale assets, cross-workspace references, channel mismatch, and changed scheduled bytes", async () => {
    await approve();
    for (const [suffix, patch] of [
      ["stale", { expectedAssetVersion: 2 }],
      ["channel", { channel: "channels" }],
    ] as const) {
      const command = { input: scheduleInput({ ...patch, id: `schedule-${suffix}` }), context: context(suffix) };
      await expect(service.createSchedule(command)).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
      await expectNoSchedule(command.input.id, command.context.idempotencyKey);
    }

    const otherStored = await artifacts.put(Buffer.from("other workspace artifact"));
    await seedGraph(store, "workspace-2", "asset-other", otherStored);
    const cross = { input: scheduleInput({ id: "schedule-cross", assetVersionId: "asset-other" }), context: context("schedule-cross") };
    await expect(service.createSchedule(cross)).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    await expectNoSchedule(cross.input.id, cross.context.idempotencyKey);

    await writeFile(join(artifactRoot, stored.contentHash), Buffer.from("changed after approval"));
    const changed = { input: scheduleInput({ id: "schedule-changed" }), context: context("schedule-changed") };
    await expect(service.createSchedule(changed)).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await expectNoSchedule(changed.input.id, changed.context.idempotencyKey);
  });

  it.each([
    ["past", { scheduledFor: "2026-10-29T09:59:59.999Z" }],
    ["equal-now", { scheduledFor: initialNow }],
    ["offset", { scheduledFor: "2026-10-30T06:00:00.000-04:00" }],
    ["invalid-date", { scheduledFor: "2026-02-30T10:00:00.000Z" }],
    ["timezone", { timeZone: "Not/A_Timezone" }],
  ] as const)("rejects invalid schedule time: %s", async (suffix, patch) => {
    await approve();
    const command = { input: scheduleInput({ ...patch }), context: context(`time-${suffix}`) };
    await expect(service.createSchedule(command)).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expectNoSchedule(command.input.id, command.context.idempotencyKey);
  });

  it("requires trusted provider configuration for the exact automatic channel/account only", async () => {
    await approve();
    configuredAccounts.clear();
    const automatic = { input: scheduleInput(), context: context("automatic-unconfigured") };
    await expect(service.createSchedule(automatic)).rejects.toMatchObject<DomainError>({ code: "CAPABILITY_UNAVAILABLE" });
    await expectNoSchedule(automatic.input.id, automatic.context.idempotencyKey);

    const otherAccount = {
      input: scheduleInput({ id: "schedule-other-account", accountId: "account-other" }),
      context: context("automatic-other-account"),
    };
    await expect(service.createSchedule(otherAccount)).rejects.toMatchObject<DomainError>({ code: "CAPABILITY_UNAVAILABLE" });
    await expectNoSchedule(otherAccount.input.id, otherAccount.context.idempotencyKey);

    const manual = await service.createSchedule({
      input: scheduleInput({ id: "schedule-manual", publicationId: "publication-manual", deliveryMode: "manual_assisted", accountId: "account-other" }),
      context: context("manual-unconfigured"),
    });
    expect(manual).toMatchObject({ deliveryMode: "manual_assisted", accountId: "account-other", status: "scheduled" });
  });

  it("enforces optimistic reschedule/cancel, preserves identity and operation key, and replays each command once", async () => {
    await approve();
    const created = await service.createSchedule({ input: scheduleInput(), context: context("mutable-create") });
    const pending = await store.transaction((repos) => repos.publications.getByScheduleId(created.id, workspaceId));
    const rescheduleInput: Reschedule = {
      id: created.id, workspaceId, expectedVersion: 1,
      scheduledFor: "2026-11-01T12:00:00.000Z", timeZone: "Europe/London",
    };
    const rescheduleCommand = { input: rescheduleInput, context: context("reschedule") };
    const rescheduled = await service.reschedule(rescheduleCommand);
    expect(rescheduled).toMatchObject({ version: 2, scheduledFor: rescheduleInput.scheduledFor, timeZone: "Europe/London" });
    expect(await store.transaction((repos) => repos.publications.getByScheduleId(created.id, workspaceId))).toEqual(pending);
    expect(await service.reschedule(rescheduleCommand)).toEqual(rescheduled);

    await expect(service.reschedule({
      input: { ...rescheduleInput, scheduledFor: "2026-11-02T12:00:00.000Z" }, context: context("reschedule-stale"),
    })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });

    const cancelCommand = { input: { id: created.id, workspaceId, expectedVersion: 2 }, context: context("cancel") };
    const cancelled = await service.cancelSchedule(cancelCommand);
    expect(cancelled).toMatchObject({ version: 3, status: "cancelled" });
    expect(await store.transaction((repos) => repos.publications.getByScheduleId(created.id, workspaceId)))
      .toMatchObject({ status: "cancelled", operationKey: pending?.operationKey });
    expect(await service.cancelSchedule(cancelCommand)).toEqual(cancelled);
    await expect(service.cancelSchedule({ input: cancelCommand.input, context: context("cancel-stale") }))
      .rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "schedule", created.id)))
      .toMatchObject([{ action: "schedule.create" }, { action: "schedule.reschedule" }, { action: "schedule.cancel" }]);
  });

  it("replays schedule creation exactly after its target time passes without new audit or state", async () => {
    await approve();
    const command = { input: scheduleInput(), context: context("create-expired-replay") };
    const created = await service.createSchedule(command);
    const publication = await store.transaction((repos) => repos.publications.getByScheduleId(created.id, workspaceId));
    now = "2026-10-31T10:00:00.000Z";

    expect(await service.createSchedule(command)).toEqual(created);
    expect(await store.transaction((repos) => repos.schedules.get(created.id, workspaceId))).toEqual(created);
    expect(await store.transaction((repos) => repos.publications.getByScheduleId(created.id, workspaceId))).toEqual(publication);
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "schedule", created.id))).toHaveLength(1);
  });

  it("replays reschedule exactly after its target time passes without new audit or state", async () => {
    await approve();
    const created = await service.createSchedule({ input: scheduleInput(), context: context("reschedule-expired-create") });
    const command = {
      input: {
        id: created.id, workspaceId, expectedVersion: 1,
        scheduledFor: "2026-11-01T12:00:00.000Z", timeZone: "Europe/London",
      },
      context: context("reschedule-expired-replay"),
    };
    const rescheduled = await service.reschedule(command);
    const publication = await store.transaction((repos) => repos.publications.getByScheduleId(created.id, workspaceId));
    now = "2026-11-02T12:00:00.000Z";

    expect(await service.reschedule(command)).toEqual(rescheduled);
    expect(await store.transaction((repos) => repos.schedules.get(created.id, workspaceId))).toEqual(rescheduled);
    expect(await store.transaction((repos) => repos.publications.getByScheduleId(created.id, workspaceId))).toEqual(publication);
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "schedule", created.id))).toHaveLength(2);
  });

  it.each(["triggered", "completed", "cancelled"] as const)("does not reschedule or cancel a %s Schedule", async (status) => {
    await approve();
    const created = await service.createSchedule({ input: scheduleInput(), context: context(`status-${status}-create`) });
    await store.transaction(async (repos) => {
      const current = (await repos.schedules.get(created.id, workspaceId))!;
      await repos.schedules.update({ ...current, status }, 1);
    });
    for (const [operation, command] of [
      ["reschedule", {
        input: { id: created.id, workspaceId, expectedVersion: 2, scheduledFor: future, timeZone: "UTC" },
        context: context(`status-${status}-reschedule`),
      }],
      ["cancel", { input: { id: created.id, workspaceId, expectedVersion: 2 }, context: context(`status-${status}-cancel`) }],
    ] as const) {
      const attempt = operation === "reschedule" ? service.reschedule(command as never) : service.cancelSchedule(command as never);
      await expect(attempt).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
      expect(await store.transaction((repos) => repos.idempotency.get(workspaceId, command.context.idempotencyKey))).toBeUndefined();
    }
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "schedule", created.id))).toHaveLength(1);
  });

  it("rolls back Schedule when its paired Publication cannot be inserted", async () => {
    await approve();
    await service.createSchedule({ input: scheduleInput(), context: context("atomic-first") });
    const duplicate = {
      input: scheduleInput({ id: "schedule-2" }),
      context: context("atomic-duplicate-publication"),
    };
    await expect(service.createSchedule(duplicate)).rejects.toThrow();
    await expectNoSchedule("schedule-2", duplicate.context.idempotencyKey);
    expect(await store.transaction((repos) => repos.publications.get("publication-1", workspaceId)))
      .toMatchObject({ scheduleId: "schedule-1" });
  });

  it("replays scheduling across restart with one audit and one Publication under the stable key", async () => {
    await approve();
    const command = { input: scheduleInput(), context: context("schedule-replay") };
    const first = await service.createSchedule(command);
    const publication = await store.transaction((repos) => repos.publications.getByScheduleId(first.id, workspaceId));
    store.close();
    store = openStore(storePath);
    service = createService();
    expect(await service.createSchedule(command)).toEqual(first);
    await expect(service.createSchedule({ input: command.input, context: context("schedule-new-outer-key") }))
      .rejects.toThrow();
    expect(await store.transaction((repos) => repos.publications.getByScheduleId(first.id, workspaceId))).toEqual(publication);
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "schedule", first.id))).toHaveLength(1);
    expect(await store.transaction((repos) => repos.idempotency.get(workspaceId, "publishing-schedule-new-outer-key"))).toBeUndefined();
    await expect(service.getSchedule({ id: first.id, workspaceId: "workspace-other" }))
      .rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
  });
});

async function seedGraph(store: Store, workspace: string, assetId: string, artifact: StoredArtifact): Promise<void> {
  const base = { workspaceId: workspace, version: 1, createdAt: initialNow, updatedAt: initialNow };
  const id = (name: string) => workspace === workspaceId ? name : `${workspace}-${name}`;
  const brief = createContentBrief({
    id: id("brief-1"), workspaceId: workspace, createdAt: initialNow, channel: "xhs",
    taskId: id("task-1"), recommendationId: id("recommendation-1"), benchmarkAnalysisId: id("benchmark-1"),
    methodIds: [id("method-1")], objective: "Original objective", audience: "Operators",
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

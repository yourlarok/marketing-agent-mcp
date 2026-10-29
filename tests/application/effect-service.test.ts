import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../../src/application/commands.js";
import type {
  CreateEffectReview,
  ImportMetricSnapshot,
} from "../../src/application/effect-commands.js";
import { EffectService } from "../../src/application/effect-service.js";
import { MarketingService } from "../../src/application/marketing-service.js";
import type { Store } from "../../src/application/ports.js";
import {
  createAssetVersion,
  createBenchmarkAnalysis,
  createContentBrief,
} from "../../src/domain/content-production-model.js";
import type { EffectReviewMetric, MetricSnapshot } from "../../src/domain/effect-model.js";
import type { DomainError } from "../../src/domain/errors.js";
import type { EvidenceClassification, SourceOwnership } from "../../src/domain/model.js";
import {
  createApproval,
  createPublication,
  createSchedule,
  type Publication,
} from "../../src/domain/publishing-model.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const workspaceId = "workspace-1";
const now = "2026-10-29T12:00:00.000Z";
const publishedAt = "2026-10-29T10:05:00.000Z";
const verifiedAt = "2026-10-29T10:10:00.000Z";
const windowStart = publishedAt;
const windowEnd = "2026-10-29T11:00:00.000Z";

function context(suffix: string): CommandContext {
  return { actor: "analyst-1", requestId: `request-${suffix}`, idempotencyKey: `effect-${suffix}` };
}

function metric(section: { metrics: EffectReviewMetric[] }, name: string): EffectReviewMetric {
  const result = section.metrics.find((candidate) => candidate.name === name);
  expect(result, `missing metric ${name}`).toBeDefined();
  return result!;
}

describe("EffectService evidence-bound snapshots and reviews", () => {
  let tempDir: string;
  let storePath: string;
  let store: Store;
  let service: EffectService;
  let sequence: number;
  let publication: Publication;

  beforeEach(async () => {
    tempDir = await createTempDir();
    storePath = join(tempDir, "effect.db");
    store = openStore(storePath);
    sequence = 0;
    service = createService();
    await seedGraph(store);
    publication = await insertPublication(store);
  });

  afterEach(async () => {
    store.close();
    await removeTempDir(tempDir);
  });

  function createService(currentStore = store): EffectService {
    return new EffectService(
      currentStore,
      { now: () => now },
      { next: () => `effect-audit-${++sequence}` },
    );
  }

  function snapshotInput(overrides: Partial<ImportMetricSnapshot> = {}): ImportMetricSnapshot {
    return {
      id: "snapshot-1",
      workspaceId,
      publicationId: publication.id,
      expectedPublicationVersion: publication.version,
      windowStart,
      windowEnd,
      observedAt: windowEnd,
      observations: [
        { metric: "impressions", evidenceIds: ["evidence-operating"], value: 1_000 },
        { metric: "interactions", evidenceIds: ["evidence-operating"], value: 100 },
        { metric: "profile_visits", evidenceIds: ["evidence-operating"], value: 200 },
        { metric: "leads", evidenceIds: ["evidence-conversion"], value: 20 },
        { metric: "purchases", evidenceIds: ["evidence-conversion"], value: 5 },
      ],
      ...overrides,
    };
  }

  function reviewInput(overrides: Partial<CreateEffectReview> = {}): CreateEffectReview {
    return {
      id: "review-1",
      workspaceId,
      publicationRefs: [{ id: publication.id, version: publication.version }],
      metricSnapshotIds: ["snapshot-1"],
      baselineMetricSnapshotIds: [],
      benchmarkEvidenceIds: [],
      ...overrides,
    };
  }

  async function importSnapshot(
    overrides: Partial<ImportMetricSnapshot> = {},
    suffix = "snapshot-import",
  ): Promise<MetricSnapshot> {
    return service.importMetricSnapshot({ input: snapshotInput(overrides), context: context(suffix) });
  }

  async function expectNoSnapshot(id: string, key: string): Promise<void> {
    expect(await store.transaction((repos) => repos.metricSnapshots.get(id, workspaceId))).toBeUndefined();
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "metric_snapshot", id))).toEqual([]);
    expect(await store.transaction((repos) => repos.idempotency.get(workspaceId, key))).toBeUndefined();
  }

  it("imports only an exact verified Publication version and replays immutably across restart", async () => {
    const command = { input: snapshotInput(), context: context("snapshot-replay") };
    const first = await service.importMetricSnapshot(command);
    expect(first).toMatchObject({
      id: "snapshot-1",
      publicationId: publication.id,
      publicationVersion: publication.version,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    expect(await service.getMetricSnapshot({ id: first.id, workspaceId })).toEqual(first);

    store.close();
    store = openStore(storePath);
    service = createService();
    expect(await service.importMetricSnapshot(command)).toEqual(first);
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "metric_snapshot", first.id)))
      .toMatchObject([{ action: "effect_metric_snapshot.import", actor: "analyst-1" }]);
    await expect(service.getMetricSnapshot({ id: first.id, workspaceId: "workspace-other" }))
      .rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
  });

  it.each(["pending", "submitted", "failed", "unknown", "manual_handoff"] as const)(
    "rejects a %s Publication without snapshot, audit, or idempotency residue",
    async (status) => {
      await store.transaction(async (repos) => {
        const current = (await repos.publications.get(publication.id, workspaceId))!;
        publication = await repos.publications.update({ ...current, status }, current.version);
      });
      const command = { input: snapshotInput(), context: context(`unverified-${status}`) };
      await expect(service.importMetricSnapshot(command)).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
      await expectNoSnapshot("snapshot-1", command.context.idempotencyKey);
    },
  );

  it("rejects a stale expected Publication version", async () => {
    const command = {
      input: snapshotInput({ expectedPublicationVersion: publication.version - 1 }),
      context: context("stale-publication"),
    };
    await expect(service.importMetricSnapshot(command)).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await expectNoSnapshot("snapshot-1", command.context.idempotencyKey);
  });

  it.each([
    ["content with conversion Evidence", "impressions", "evidence-conversion"],
    ["conversion with operating Evidence", "leads", "evidence-operating"],
    ["content with public Evidence", "impressions", "evidence-public"],
    ["conversion with public Evidence", "purchases", "evidence-public"],
  ] as const)("rejects %s", async (_label, observedMetric, evidenceId) => {
    const input = snapshotInput({
      observations: [{ metric: observedMetric, evidenceIds: [evidenceId], value: 1 }],
    });
    const command = { input, context: context(`classification-${observedMetric}-${evidenceId}`) };
    await expect(service.importMetricSnapshot(command)).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await expectNoSnapshot(input.id, command.context.idempotencyKey);
  });

  it("accepts authorized owned/classified Evidence and rejects missing or cross-workspace Evidence", async () => {
    const authorized = await importSnapshot({
      id: "snapshot-authorized",
      observations: [{ metric: "impressions", evidenceIds: ["evidence-authorized"], value: 1 }],
    }, "authorized-evidence");
    expect(authorized.observations[0]?.evidenceIds).toEqual(["evidence-authorized"]);

    for (const [suffix, evidenceId] of [["missing", "evidence-missing"], ["cross", "evidence-other"]] as const) {
      const command = {
        input: snapshotInput({
          id: `snapshot-${suffix}`,
          observations: [{ metric: "impressions", evidenceIds: [evidenceId], value: 1 }],
        }),
        context: context(`evidence-${suffix}`),
      };
      await expect(service.importMetricSnapshot(command)).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
      await expectNoSnapshot(command.input.id, command.context.idempotencyKey);
    }
  });

  it.each([
    ["negative", { observations: [{ metric: "leads", evidenceIds: ["evidence-conversion"], value: -1 }] }],
    ["fraction", { observations: [{ metric: "leads", evidenceIds: ["evidence-conversion"], value: 1.5 }] }],
    ["unsafe", { observations: [{ metric: "leads", evidenceIds: ["evidence-conversion"], value: Number.MAX_SAFE_INTEGER + 1 }] }],
    ["reverse-window", { windowStart: windowEnd, windowEnd: windowStart }],
    ["equal-window", { windowStart, windowEnd: windowStart }],
    ["prepublication-window", { windowStart: "2026-10-29T10:04:59.999Z" }],
    ["prepublication-observation", { observedAt: "2026-10-29T10:04:59.999Z" }],
    ["observation-before-window-end", { observedAt: "2026-10-29T10:59:59.999Z" }],
    ["duplicate-metric", { observations: [
      { metric: "impressions", evidenceIds: ["evidence-operating"], value: 1 },
      { metric: "impressions", evidenceIds: ["evidence-operating"], value: 2 },
    ] }],
  ] as const)("rejects invalid snapshot %s", async (suffix, patch) => {
    const command = { input: snapshotInput(patch), context: context(`invalid-${suffix}`) };
    await expect(service.importMetricSnapshot(command)).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expectNoSnapshot("snapshot-1", command.context.idempotencyKey);
  });

  it("computes exact content and conversion rates with evidence and source lineage", async () => {
    await importSnapshot();
    const review = await service.createReview({ input: reviewInput(), context: context("rate-review") });
    expect(metric(review.content, "interactionRate")).toMatchObject({
      value: 0.1, status: "ok", reason: null, numerator: 100, denominator: 1_000,
    });
    expect(metric(review.content, "profileVisitRate")).toMatchObject({
      value: 0.2, status: "ok", numerator: 200, denominator: 1_000,
    });
    expect(metric(review.conversion, "leadRate")).toMatchObject({
      value: 0.1, status: "ok", numerator: 20, denominator: 200,
    });
    expect(metric(review.conversion, "purchaseRate")).toMatchObject({
      value: 0.25, status: "ok", numerator: 5, denominator: 20,
    });
    expect(metric(review.automation, "automaticVerifiedRate")).toMatchObject({
      value: 1, status: "ok", numerator: 1, denominator: 1,
    });
    expect(review.sourceVersions).toEqual([
      { entityType: "publication", id: publication.id, version: publication.version },
      { entityType: "metric_snapshot", id: "snapshot-1", version: 1 },
    ]);
    expect(await service.getReview({ id: review.id, workspaceId })).toEqual(review);
  });

  it("preserves observed operands and returns unknown for missing or zero denominators", async () => {
    await importSnapshot({
      observations: [
        { metric: "interactions", evidenceIds: ["evidence-operating"], value: 7 },
        { metric: "impressions", evidenceIds: ["evidence-operating"], value: 0 },
        { metric: "purchases", evidenceIds: ["evidence-conversion"], value: 3 },
      ],
    });
    const review = await service.createReview({ input: reviewInput(), context: context("unknown-rates") });
    expect(metric(review.content, "interactionRate")).toMatchObject({
      value: null, status: "unknown", reason: "zero_denominator", numerator: 7, denominator: 0,
    });
    expect(metric(review.content, "profileVisitRate")).toMatchObject({
      value: null, status: "unknown", reason: "missing_numerator", numerator: null, denominator: 0,
    });
    expect(metric(review.conversion, "leadRate")).toMatchObject({
      value: null, status: "unknown", reason: "missing_denominator", numerator: null, denominator: null,
    });
    expect(metric(review.conversion, "purchaseRate")).toMatchObject({
      value: null, status: "unknown", reason: "missing_denominator", numerator: 3, denominator: null,
    });
  });

  it("rejects baseline comparisons unless windows and channels are exactly comparable", async () => {
    await importSnapshot();
    const baselinePublication = await insertPublication(store, { id: "publication-baseline" });
    await importSnapshot({
      id: "snapshot-baseline-window",
      publicationId: baselinePublication.id,
      expectedPublicationVersion: baselinePublication.version,
      windowStart: "2026-10-29T12:05:00.000Z",
      windowEnd: "2026-10-29T13:00:00.000Z",
      observedAt: "2026-10-29T13:00:00.000Z",
    }, "baseline-window");
    const windowCommand = {
      input: reviewInput({ baselineMetricSnapshotIds: ["snapshot-baseline-window"] }),
      context: context("incomparable-window"),
    };
    await expect(service.createReview(windowCommand)).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });

    const channelPublication = await insertPublication(store, { id: "publication-channel", channel: "channels" });
    await importSnapshot({
      id: "snapshot-baseline-channel",
      publicationId: channelPublication.id,
      expectedPublicationVersion: channelPublication.version,
    }, "baseline-channel");
    await expect(service.createReview({
      input: reviewInput({ baselineMetricSnapshotIds: ["snapshot-baseline-channel"] }),
      context: context("incomparable-channel"),
    })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    expect(await store.transaction((repos) => repos.effectReviews.get("review-1", workspaceId))).toBeUndefined();
  });

  it("keeps baseline deltas descriptive, includes benchmark Evidence lineage, and never claims causality", async () => {
    await importSnapshot();
    const baselinePublication = await insertPublication(store, { id: "publication-baseline" });
    await importSnapshot({
      id: "snapshot-baseline",
      publicationId: baselinePublication.id,
      expectedPublicationVersion: baselinePublication.version,
      observations: [
        { metric: "impressions", evidenceIds: ["evidence-operating"], value: 1_000 },
        { metric: "interactions", evidenceIds: ["evidence-operating"], value: 50 },
        { metric: "profile_visits", evidenceIds: ["evidence-operating"], value: 100 },
        { metric: "leads", evidenceIds: ["evidence-conversion"], value: 10 },
        { metric: "purchases", evidenceIds: ["evidence-conversion"], value: 2 },
      ],
    }, "descriptive-baseline");
    const review = await service.createReview({
      input: reviewInput({
        baselineMetricSnapshotIds: ["snapshot-baseline"],
        benchmarkEvidenceIds: ["evidence-public"],
      }),
      context: context("descriptive-review"),
    });
    expect(metric(review.content, "interactionRateDelta")).toMatchObject({ value: 0.05, status: "ok" });
    expect(metric(review.content, "profileVisitRateDelta")).toMatchObject({ value: 0.1, status: "ok" });
    expect(metric(review.conversion, "leadRateDelta")).toMatchObject({ value: 0, status: "ok" });
    expect(metric(review.conversion, "purchaseRateDelta").status).toBe("ok");
    expect(metric(review.conversion, "purchaseRateDelta").value).toBeCloseTo(0.05);
    for (const section of [review.efficiency, review.content, review.conversion, review.automation]) {
      expect(section.causality).toBe("not_established");
    }
    expect(review.sourceVersions).toContainEqual({ entityType: "evidence", id: "evidence-public", version: 1 });
    expect(JSON.stringify(review)).not.toMatch(/significance|uplift/i);
  });

  it("does not count manual Evidence completion as automatic and separates manual handoffs", async () => {
    const manual = await insertPublication(store, {
      id: "publication-manual",
      deliveryMode: "manual_assisted",
      verificationMethod: "manual_evidence",
      evidenceIds: ["evidence-operating"],
      receipts: [],
    });
    await importSnapshot({
      publicationId: manual.id,
      expectedPublicationVersion: manual.version,
    });
    const review = await service.createReview({ input: reviewInput({
      publicationRefs: [{ id: manual.id, version: manual.version }],
    }), context: context("manual-not-automatic") });
    expect(metric(review.automation, "automaticVerifiedRate")).toMatchObject({
      value: 0, numerator: 0, denominator: 1,
    });
    expect(metric(review.efficiency, "manualHandoffs")).toMatchObject({ value: 1, numerator: 1 });
    expect(metric(review.efficiency, "timeToVerified")).toMatchObject({
      value: 600_000, numerator: 600_000, denominator: 1,
    });
  });

  it("returns duplicate events as unknown without complete provider verification coverage", async () => {
    const uncovered = await insertPublication(store, { id: "publication-uncovered", receipts: [] });
    await importSnapshot({ publicationId: uncovered.id, expectedPublicationVersion: uncovered.version });
    const review = await service.createReview({ input: reviewInput({
      publicationRefs: [{ id: uncovered.id, version: uncovered.version }],
    }), context: context("duplicate-without-coverage") });
    expect(metric(review.automation, "duplicateEvents")).toMatchObject({
      value: null,
      status: "unknown",
      reason: "verification_coverage_unavailable",
      numerator: null,
      denominator: 1,
    });
  });

  it("enforces explicit versions, selected snapshot ownership, and verified review Publications", async () => {
    await importSnapshot();
    await store.transaction(async (repos) => {
      const current = (await repos.publications.get(publication.id, workspaceId))!;
      publication = await repos.publications.update({ ...current }, current.version);
    });
    await expect(service.createReview({
      input: reviewInput(), context: context("review-stale-ref"),
    })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await expect(service.createReview({
      input: reviewInput({ publicationRefs: [{ id: publication.id, version: publication.version }] }),
      context: context("review-stale-snapshot"),
    })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });

    const other = await insertPublication(store, { id: "publication-other" });
    await expect(service.createReview({
      input: reviewInput({ publicationRefs: [{ id: other.id, version: other.version }] }),
      context: context("review-wrong-snapshot-owner"),
    })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    expect(await store.transaction((repos) => repos.effectReviews.get("review-1", workspaceId))).toBeUndefined();
  });

  it("replays reviews after restart with one audit and complete traversable lineage", async () => {
    await importSnapshot();
    const command = { input: reviewInput(), context: context("review-replay") };
    const first = await service.createReview(command);
    store.close();
    store = openStore(storePath);
    service = createService();
    expect(await service.createReview(command)).toEqual(first);
    expect(await store.transaction((repos) => repos.audit.listForEntity(workspaceId, "effect_review", first.id)))
      .toMatchObject([{ action: "effect_review.create" }]);

    const lineage = await new MarketingService(store, { now: () => now }, { next: () => `lineage-${++sequence}` })
      .getLineage({ workspaceId, entityType: "effect_review", id: first.id });
    expect(lineage.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "effect_review", id: first.id }),
      expect.objectContaining({ entityType: "metric_snapshot", id: "snapshot-1" }),
      expect.objectContaining({ entityType: "publication", id: publication.id }),
      expect.objectContaining({ entityType: "schedule", id: publication.scheduleId }),
      expect.objectContaining({ entityType: "approval", id: publication.approvalId }),
      expect.objectContaining({ entityType: "asset_version", id: publication.assetVersionId }),
      expect.objectContaining({ entityType: "content_brief", id: "brief-1" }),
      expect.objectContaining({ entityType: "task", id: "task-1" }),
      expect.objectContaining({ entityType: "recommendation", id: "recommendation-1" }),
      expect.objectContaining({ entityType: "evidence", id: "evidence-operating" }),
      expect.objectContaining({ entityType: "evidence", id: "evidence-conversion" }),
      expect.objectContaining({ entityType: "source", id: "source-owned" }),
    ]));
  });

  it("returns unknown when any selected snapshot lacks numerator or denominator coverage", async () => {
    const second = await insertPublication(store, { id: "publication-second" });
    await importSnapshot({
      observations: [
        { metric: "impressions", evidenceIds: ["evidence-operating"], value: 1_000 },
        { metric: "interactions", evidenceIds: ["evidence-operating"], value: 100 },
      ],
    });
    await importSnapshot({
      id: "snapshot-second",
      publicationId: second.id,
      expectedPublicationVersion: second.version,
      observations: [{ metric: "impressions", evidenceIds: ["evidence-operating"], value: 1_000 }],
    }, "partial-second");
    const review = await service.createReview({
      input: reviewInput({
        publicationRefs: [
          { id: publication.id, version: publication.version },
          { id: second.id, version: second.version },
        ],
        metricSnapshotIds: ["snapshot-1", "snapshot-second"],
      }),
      context: context("partial-current-coverage"),
    });
    expect(metric(review.content, "interactionRate")).toMatchObject({
      value: null,
      status: "unknown",
      reason: "incomplete_numerator_coverage",
      numerator: 100,
      denominator: 2_000,
    });
  });

  it("applies per-snapshot coverage requirements to baseline aggregates and deltas", async () => {
    await importSnapshot();
    const baselineOne = await insertPublication(store, { id: "publication-baseline-one" });
    const baselineTwo = await insertPublication(store, { id: "publication-baseline-two" });
    await importSnapshot({
      id: "snapshot-baseline-one",
      publicationId: baselineOne.id,
      expectedPublicationVersion: baselineOne.version,
      observations: [
        { metric: "impressions", evidenceIds: ["evidence-operating"], value: 1_000 },
        { metric: "interactions", evidenceIds: ["evidence-operating"], value: 50 },
      ],
    }, "partial-baseline-one");
    await importSnapshot({
      id: "snapshot-baseline-two",
      publicationId: baselineTwo.id,
      expectedPublicationVersion: baselineTwo.version,
      observations: [{ metric: "impressions", evidenceIds: ["evidence-operating"], value: 1_000 }],
    }, "partial-baseline-two");
    const review = await service.createReview({
      input: reviewInput({ baselineMetricSnapshotIds: ["snapshot-baseline-one", "snapshot-baseline-two"] }),
      context: context("partial-baseline-coverage"),
    });
    expect(metric(review.content, "interactionRateDelta")).toMatchObject({
      value: null,
      status: "unknown",
      reason: "baseline_comparison_unknown",
    });
  });

  it("requires exactly one selected snapshot for every selected Publication", async () => {
    const second = await insertPublication(store, { id: "publication-second" });
    await importSnapshot();
    await expect(service.createReview({
      input: reviewInput({
        id: "review-missing-snapshot",
        publicationRefs: [
          { id: publication.id, version: publication.version },
          { id: second.id, version: second.version },
        ],
      }),
      context: context("missing-selected-snapshot"),
    })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });

    await importSnapshot({ id: "snapshot-duplicate-publication" }, "duplicate-publication-snapshot");
    await expect(service.createReview({
      input: reviewInput({
        id: "review-duplicate-snapshot-publication",
        metricSnapshotIds: ["snapshot-1", "snapshot-duplicate-publication"],
      }),
      context: context("duplicate-selected-snapshot-publication"),
    })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
  });

  it("requires identical windows and channels for multi-Publication aggregation without a baseline", async () => {
    const otherWindow = await insertPublication(store, { id: "publication-other-window" });
    await importSnapshot();
    await importSnapshot({
      id: "snapshot-other-window",
      publicationId: otherWindow.id,
      expectedPublicationVersion: otherWindow.version,
      windowStart: "2026-10-29T12:05:00.000Z",
      windowEnd: "2026-10-29T13:00:00.000Z",
      observedAt: "2026-10-29T13:00:00.000Z",
    }, "other-current-window");
    await expect(service.createReview({
      input: reviewInput({
        id: "review-mixed-current-window",
        publicationRefs: [
          { id: publication.id, version: publication.version },
          { id: otherWindow.id, version: otherWindow.version },
        ],
        metricSnapshotIds: ["snapshot-1", "snapshot-other-window"],
      }),
      context: context("mixed-current-window"),
    })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });

    const otherChannel = await insertPublication(store, { id: "publication-other-channel", channel: "channels" });
    await importSnapshot({
      id: "snapshot-other-channel",
      publicationId: otherChannel.id,
      expectedPublicationVersion: otherChannel.version,
    }, "other-current-channel");
    await expect(service.createReview({
      input: reviewInput({
        id: "review-mixed-current-channel",
        publicationRefs: [
          { id: publication.id, version: publication.version },
          { id: otherChannel.id, version: otherChannel.version },
        ],
        metricSnapshotIds: ["snapshot-1", "snapshot-other-channel"],
      }),
      context: context("mixed-current-channel"),
    })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
  });

  it.each([
    ["before-publication", "2026-10-29T10:04:59.999Z", windowEnd],
    ["after-snapshot-observation", "2026-10-29T11:00:00.001Z", windowEnd],
  ] as const)("rejects Evidence observed %s", async (suffix, evidenceObservedAt, observedAt) => {
    await store.transaction((repos) => insertEvidence(
      repos,
      `evidence-${suffix}`,
      "source-owned",
      "owned_operating",
      workspaceId,
      evidenceObservedAt,
    ));
    const command = {
      input: snapshotInput({
        observedAt,
        observations: [{ metric: "impressions", evidenceIds: [`evidence-${suffix}`], value: 1 }],
      }),
      context: context(`evidence-temporal-${suffix}`),
    };
    await expect(service.importMetricSnapshot(command)).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await expectNoSnapshot("snapshot-1", command.context.idempotencyKey);
  });

  it("allows Evidence collected after the window when it is captured by snapshot observedAt", async () => {
    await store.transaction((repos) => insertEvidence(
      repos,
      "evidence-late-collection",
      "source-owned",
      "owned_operating",
      workspaceId,
      "2026-10-29T11:30:00.000Z",
    ));
    const snapshot = await importSnapshot({
      observedAt: now,
      observations: [{ metric: "impressions", evidenceIds: ["evidence-late-collection"], value: 1 }],
    }, "late-evidence-collection");
    expect(snapshot.observedAt).toBe(now);
  });

  it("counts genuine duplicate events only within provider, channel, account, and external ID scope", async () => {
    const duplicate = await insertPublication(store, {
      id: "publication-duplicate",
      externalPublicationId: "external-shared",
    });
    await store.transaction(async (repos) => {
      const current = (await repos.publications.get(publication.id, workspaceId))!;
      publication = await repos.publications.update({
        ...current,
        delivery: { ...current.delivery!, externalPublicationId: "external-shared" },
        verification: { ...current.verification!, externalPublicationId: "external-shared" },
      }, current.version);
    });
    await importSnapshot({ expectedPublicationVersion: publication.version });
    await importSnapshot({
      id: "snapshot-duplicate",
      publicationId: duplicate.id,
      expectedPublicationVersion: duplicate.version,
    }, "same-scope-duplicate");
    const review = await service.createReview({
      input: reviewInput({
        publicationRefs: [
          { id: publication.id, version: publication.version },
          { id: duplicate.id, version: duplicate.version },
        ],
        metricSnapshotIds: ["snapshot-1", "snapshot-duplicate"],
      }),
      context: context("same-scope-duplicate-review"),
    });
    expect(metric(review.automation, "duplicateEvents")).toMatchObject({ value: 1, status: "ok", numerator: 1 });
  });

  it("does not count the same external ID on different accounts as a duplicate", async () => {
    const otherAccount = await insertPublication(store, {
      id: "publication-other-account",
      accountId: "account-2",
      externalPublicationId: "external-shared",
    });
    await store.transaction(async (repos) => {
      const current = (await repos.publications.get(publication.id, workspaceId))!;
      publication = await repos.publications.update({
        ...current,
        delivery: { ...current.delivery!, externalPublicationId: "external-shared" },
        verification: { ...current.verification!, externalPublicationId: "external-shared" },
      }, current.version);
    });
    await importSnapshot({ expectedPublicationVersion: publication.version });
    await importSnapshot({
      id: "snapshot-other-account",
      publicationId: otherAccount.id,
      expectedPublicationVersion: otherAccount.version,
    }, "other-account-snapshot");
    const review = await service.createReview({
      input: reviewInput({
        publicationRefs: [
          { id: publication.id, version: publication.version },
          { id: otherAccount.id, version: otherAccount.version },
        ],
        metricSnapshotIds: ["snapshot-1", "snapshot-other-account"],
      }),
      context: context("different-account-duplicate-review"),
    });
    expect(metric(review.automation, "duplicateEvents")).toMatchObject({ value: 0, status: "ok", numerator: 0 });
  });

  it("returns duplicate events unknown when verification and delivery scopes disagree", async () => {
    const inconsistent = await insertPublication(store, {
      id: "publication-inconsistent-scope",
      externalPublicationId: "external-verified",
      deliveryExternalPublicationId: "external-delivered",
    });
    await importSnapshot({
      publicationId: inconsistent.id,
      expectedPublicationVersion: inconsistent.version,
    });
    const review = await service.createReview({
      input: reviewInput({ publicationRefs: [{ id: inconsistent.id, version: inconsistent.version }] }),
      context: context("inconsistent-duplicate-scope"),
    });
    expect(metric(review.automation, "duplicateEvents")).toMatchObject({
      value: null,
      status: "unknown",
      reason: "verification_scope_incomparable",
      numerator: null,
    });
  });

  it("rejects references above conservative review bounds", async () => {
    await importSnapshot();
    const benchmarkEvidenceIds = ["evidence-public"];
    await store.transaction(async (repos) => {
      for (let index = 1; index <= 100; index += 1) {
        const id = `evidence-over-bound-${index}`;
        benchmarkEvidenceIds.push(id);
        await insertEvidence(repos, id, "source-public", "external_observation", workspaceId);
      }
    });
    await expect(service.createReview({
      input: reviewInput({ benchmarkEvidenceIds }),
      context: context("review-reference-bound"),
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it("rejects a review whose actual complete lineage would exceed 1000 nodes and rolls back", async () => {
    const evidenceIds: string[] = [];
    await store.transaction(async (repos) => {
      for (let index = 0; index < 800; index += 1) {
        const sourceId = `source-lineage-bound-${index}`;
        const evidenceId = `evidence-lineage-bound-${index}`;
        evidenceIds.push(evidenceId);
        await repos.sources.insert({
          id: sourceId,
          workspaceId,
          version: 1,
          createdAt: now,
          updatedAt: now,
          name: sourceId,
          type: "manual",
          ownership: "owned",
        });
        const classification = index < 400 ? "owned_operating" : "owned_conversion";
        await insertEvidence(repos, evidenceId, sourceId, classification, workspaceId);
      }
    });
    await importSnapshot({
      observations: ([
        "impressions", "interactions", "followers_gained", "profile_visits",
        "leads", "consultations", "trials", "purchases",
      ] as const).map((observedMetric, index) => ({
        metric: observedMetric,
        evidenceIds: evidenceIds.slice(index * 100, index * 100 + 100),
        value: 1,
      })),
    }, "over-lineage-snapshot");
    const command = { input: reviewInput(), context: context("over-lineage-review") };
    await expect(service.createReview(command)).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    expect(await store.transaction((repos) => repos.effectReviews.get("review-1", workspaceId))).toBeUndefined();
    expect(await store.transaction((repos) => repos.idempotency.get(workspaceId, command.context.idempotencyKey)))
      .toBeUndefined();
  });

  it("traverses a maximal-direct-reference review within the lineage and response bounds", async () => {
    const publicationRefs = [{ id: publication.id, version: publication.version }];
    const metricSnapshotIds = ["snapshot-1"];
    await importSnapshot();
    for (let index = 1; index < 10; index += 1) {
      const current = await insertPublication(store, { id: `publication-current-${index}` });
      publicationRefs.push({ id: current.id, version: current.version });
      const snapshotId = `snapshot-current-${index}`;
      metricSnapshotIds.push(snapshotId);
      await importSnapshot({
        id: snapshotId,
        publicationId: current.id,
        expectedPublicationVersion: current.version,
      }, `max-current-${index}`);
    }
    const baselineMetricSnapshotIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const current = await insertPublication(store, { id: `publication-max-baseline-${index}` });
      const snapshotId = `snapshot-max-baseline-${index}`;
      baselineMetricSnapshotIds.push(snapshotId);
      await importSnapshot({
        id: snapshotId,
        publicationId: current.id,
        expectedPublicationVersion: current.version,
      }, `max-baseline-${index}`);
    }
    const benchmarkEvidenceIds = ["evidence-public"];
    await store.transaction(async (repos) => {
      for (let index = 1; index < 100; index += 1) {
        const id = `evidence-max-benchmark-${index}`;
        benchmarkEvidenceIds.push(id);
        await insertEvidence(repos, id, "source-public", "external_observation", workspaceId);
      }
    });
    const review = await service.createReview({
      input: reviewInput({ publicationRefs, metricSnapshotIds, baselineMetricSnapshotIds, benchmarkEvidenceIds }),
      context: context("maximal-reference-review"),
    });
    expect(Buffer.byteLength(JSON.stringify(review), "utf8")).toBeLessThanOrEqual(64 * 1024);
    const lineage = await new MarketingService(store, { now: () => now }, { next: () => `max-lineage-${++sequence}` })
      .getLineage({ workspaceId, entityType: "effect_review", id: review.id });
    expect(lineage.nodes.length).toBeLessThanOrEqual(1_000);
    expect(lineage.nodes).toEqual(expect.arrayContaining(
      benchmarkEvidenceIds.map((id) => expect.objectContaining({ entityType: "evidence", id })),
    ));
  });

  it("enforces strict command shapes and the 64 KiB response bound without residue", async () => {
    const extra = { ...snapshotInput(), unexpected: true } as ImportMetricSnapshot;
    await expect(service.importMetricSnapshot({ input: extra, context: context("strict-shape") }))
      .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    const oversized = {
      ...snapshotInput(),
      observations: ([
        "impressions", "interactions", "followers_gained", "profile_visits",
        "leads", "consultations", "trials", "purchases",
      ] as const).map((observedMetric) => ({
        metric: observedMetric,
        evidenceIds: Array.from({ length: 100 }, (_, index) => `${index}-${"e".repeat(250)}`),
        value: 1,
      })),
    };
    const command = { input: oversized, context: context("oversized-snapshot") };
    await expect(service.importMetricSnapshot(command)).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expectNoSnapshot("snapshot-1", command.context.idempotencyKey);
  });
});

interface PublicationFixture {
  id?: string;
  channel?: "xhs" | "channels";
  accountId?: string;
  provider?: string;
  externalPublicationId?: string;
  deliveryExternalPublicationId?: string;
  deliveryMode?: "automatic" | "manual_assisted";
  verificationMethod?: "provider" | "manual_evidence";
  evidenceIds?: string[];
  receipts?: Publication["receipts"];
}

async function insertPublication(store: Store, fixture: PublicationFixture = {}): Promise<Publication> {
  const id = fixture.id ?? "publication-1";
  const scheduleId = id.replace("publication", "schedule");
  const channel = fixture.channel ?? "xhs";
  const accountId = fixture.accountId ?? "account-1";
  const externalPublicationId = fixture.externalPublicationId ?? `external-${id}`;
  const deliveryMode = fixture.deliveryMode ?? "automatic";
  const verificationMethod = fixture.verificationMethod ?? "provider";
  const evidenceIds = fixture.evidenceIds ?? [];
  const schedule = createSchedule({
    id: scheduleId,
    workspaceId,
    createdAt: "2026-10-29T10:00:00.000Z",
    assetVersionId: "asset-1",
    assetVersion: 1,
    approvalId: "approval-1",
    channel,
    accountId,
    scheduledFor: publishedAt,
    timeZone: "UTC",
    deliveryMode,
    status: "completed",
  });
  const publication = createPublication({
    id,
    workspaceId,
    createdAt: "2026-10-29T10:00:00.000Z",
    scheduleId,
    scheduleVersion: 1,
    assetVersionId: "asset-1",
    assetVersion: 1,
    approvalId: "approval-1",
    artifactHash: "a".repeat(64),
    operationKey: `publish:v1:${id.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "0")}`,
    channel,
    accountId,
    deliveryMode,
    status: "verified",
    attempts: [],
    receipts: fixture.receipts ?? [{
      kind: "verify",
      provider: fixture.provider ?? "fixture",
      receiptId: `receipt-${id}`,
      receivedAt: verifiedAt,
      contentHash: "b".repeat(64),
    }],
    failure: null,
    delivery: {
      method: verificationMethod,
      externalPublicationId: fixture.deliveryExternalPublicationId ?? externalPublicationId,
      publishedAt,
      evidenceIds,
    },
    verification: {
      method: verificationMethod,
      verifiedAt,
      externalPublicationId,
      evidenceIds,
    },
    version: 3,
    updatedAt: verifiedAt,
  } as unknown as Omit<Publication, "version" | "updatedAt"> & Pick<Publication, "version" | "updatedAt">);
  return store.transaction(async (repos) => {
    await repos.schedules.insert(schedule);
    await repos.publications.insert(publication);
    await repos.publications.update({ ...publication, updatedAt: verifiedAt }, 1);
    return repos.publications.update({ ...publication, updatedAt: verifiedAt }, 2);
  });
}

async function seedGraph(store: Store): Promise<void> {
  const createdAt = "2026-10-29T09:00:00.000Z";
  const base = { workspaceId, version: 1, createdAt, updatedAt: createdAt };
  const artifact = { contentHash: "a".repeat(64), byteLength: 1 };
  const brief = createContentBrief({
    id: "brief-1", workspaceId, createdAt, channel: "xhs", taskId: "task-1",
    recommendationId: "recommendation-1", benchmarkAnalysisId: "benchmark-1", methodIds: ["method-1"],
    objective: "Original objective", audience: "Operators",
    copy: {
      hook: { id: "hook-1", kind: "creative", text: "Original hook" },
      body: [{ id: "body-1", kind: "creative", text: "Original body" }],
      cta: { id: "cta-1", kind: "creative", text: "Original call to action" },
    },
    frames: [], assetRequirements: [], findingIds: [], evidenceIds: [],
    sourceVersions: [
      { entityType: "task", id: "task-1", version: 1 },
      { entityType: "recommendation", id: "recommendation-1", version: 1 },
      { entityType: "benchmark_analysis", id: "benchmark-1", version: 1 },
    ],
  });
  const benchmark = createBenchmarkAnalysis({
    id: "benchmark-1", workspaceId, createdAt, modality: "image", status: "completed", gaps: [],
    evidenceIds: ["evidence-benchmark"], competitorDiffId: null,
    methods: [{
      id: "method-1", dimension: "layout", pattern: "Observed layout",
      transferableRule: "Transfer only layout structure", basis: "text", confidence: "medium",
      evidenceAssetRefs: [{
        sourceId: "source-public", evidenceId: "evidence-benchmark", assetId: "benchmark-asset-1",
        kind: "original", observedAt: createdAt, contentHash: artifact.contentHash, byteLength: 1,
      }],
    }],
    sourceVersions: [
      { entityType: "source", id: "source-public", version: 1 },
      { entityType: "evidence", id: "evidence-benchmark", version: 1 },
    ],
    provider: {
      type: "mcp", tool: "reverse_engineer", toolVersion: "fixture-1", inputHash: "c".repeat(64),
      analysisMethod: "fixture", humanReview: "not_performed",
    },
  });
  const asset = createAssetVersion({
    id: "asset-1", workspaceId, createdAt, contentId: "content-1", channel: "xhs",
    briefId: brief.id, briefVersion: 1, taskId: brief.taskId, recommendationId: brief.recommendationId,
    parentVersionId: null, parentVersion: null,
    artifact: { id: "artifact-1", kind: "primary", mediaType: "image/png", ...artifact },
    sourceMaterials: [],
    modification: {
      summary: "Initial controlled asset", revisionInstructions: "Render", actor: "agent-1",
      requestId: "request-generate", createdAt,
    },
    provider: { type: "mcp", tool: "render", toolVersion: "fixture-1", inputHash: "d".repeat(64) },
    validation: {
      status: "passed", profileId: "xhs_png_1080x1440_v1", guarantee: "internal_acceptance_only",
      decoder: "playwright_chromium", width: 1080, height: 1440,
      durationMs: null, videoCodec: null, audioCodec: null,
    },
    evidenceIds: [], sourceVersions: [{ entityType: "content_brief", id: brief.id, version: 1 }],
  });
  const approval = createApproval({
    id: "approval-1", workspaceId, createdAt, assetVersionId: asset.id, assetVersion: 1,
    artifactHash: artifact.contentHash, decision: "approved",
    reviewer: { actor: "human-1", attestation: "human_attested" },
    comment: "Approved exact fixture", decidedAt: createdAt,
  });
  await store.transaction(async (repos) => {
    await repos.workspaces.insert({ ...base, id: workspaceId, name: workspaceId });
    await repos.workspaces.insert({ ...base, id: "workspace-other", workspaceId: "workspace-other", name: "Other" });
    for (const [id, ownership] of [
      ["source-owned", "owned"],
      ["source-authorized", "authorized"],
      ["source-public", "external_public"],
    ] as const) {
      await repos.sources.insert({ ...base, id, name: id, type: "manual", ownership: ownership as SourceOwnership });
    }
    for (const [id, sourceId, classification] of [
      ["evidence-operating", "source-owned", "owned_operating"],
      ["evidence-conversion", "source-owned", "owned_conversion"],
      ["evidence-authorized", "source-authorized", "owned_operating"],
      ["evidence-public", "source-public", "external_observation"],
      ["evidence-benchmark", "source-public", "external_observation"],
    ] as const) {
      await insertEvidence(repos, id, sourceId, classification as EvidenceClassification, workspaceId);
    }
    await repos.sources.insert({
      ...base, id: "source-other", workspaceId: "workspace-other", name: "Other", type: "manual", ownership: "owned",
    });
    await insertEvidence(repos, "evidence-other", "source-other", "owned_operating", "workspace-other");
    await repos.recommendations.insert({
      ...base, id: "recommendation-1", findingIds: [], hypothesis: "Hypothesis", affectedStage: "activation",
      priority: "high", expectedMetric: "activation", targetChannels: ["xhs"],
    });
    await repos.tasks.insert({
      ...base, id: "task-1", recommendationIds: ["recommendation-1"], assignee: "marketer",
      dependencyIds: [], assetRequirements: [], acceptanceCriteria: ["Validated"], state: "ready",
    });
    await repos.benchmarkAnalyses.insert(benchmark);
    await repos.contentBriefs.insert(brief);
    await repos.assetVersions.insert(asset);
    await repos.approvals.insert(approval);
  });
}

async function insertEvidence(
  repos: Parameters<Parameters<Store["transaction"]>[0]>[0],
  id: string,
  sourceId: string,
  classification: EvidenceClassification,
  workspace: string,
  observedAt = windowEnd,
): Promise<void> {
  await repos.evidence.insert({
    id,
    workspaceId: workspace,
    version: 1,
    createdAt: "2026-10-29T09:00:00.000Z",
    updatedAt: "2026-10-29T09:00:00.000Z",
    sourceId,
    sourceLocator: "fixture",
    observedAt,
    summary: id,
    contentHash: "e".repeat(64),
    classification,
  });
}

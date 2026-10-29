import { assertRecord } from "../domain/contract-validation.js";
import {
  createEffectReview,
  createMetricSnapshot,
  type EffectMetricName,
  type EffectReview,
  type EffectReviewMetric,
  type EffectReviewSection,
  type EffectSourceVersionRef,
  type MetricSnapshot,
} from "../domain/effect-model.js";
import { DomainError } from "../domain/errors.js";
import type { Evidence, Source } from "../domain/model.js";
import type { Publication } from "../domain/publishing-model.js";
import { AuditableCommandPipeline, type Command, type CommandPipeline } from "./commands.js";
import type {
  CreateEffectReview,
  GetEffectReview,
  GetMetricSnapshot,
  ImportMetricSnapshot,
} from "./effect-commands.js";
import { resolveLineage } from "./marketing-service.js";
import type { Clock, IdGenerator, Repositories, Store } from "./ports.js";

const VALIDATION_TIME = "1970-01-01T00:00:00.000Z";
const SNAPSHOT_KEYS = [
  "id", "workspaceId", "publicationId", "expectedPublicationVersion",
  "windowStart", "windowEnd", "observedAt", "observations",
] as const;
const REVIEW_KEYS = [
  "id", "workspaceId", "publicationRefs", "metricSnapshotIds",
  "baselineMetricSnapshotIds", "benchmarkEvidenceIds",
] as const;
const GET_KEYS = ["id", "workspaceId"] as const;
const CONTENT_METRICS = new Set<EffectMetricName>([
  "impressions", "interactions", "followers_gained", "profile_visits",
]);
const CONVERSION_METRICS = new Set<EffectMetricName>([
  "leads", "consultations", "trials", "purchases",
]);

interface LoadedReview {
  publications: Publication[];
  snapshots: MetricSnapshot[];
  baselines: MetricSnapshot[];
  sourceVersions: EffectSourceVersionRef[];
}

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

function conflict(message: string): never {
  throw new DomainError("CONFLICT", message);
}

function notFound(message: string, details: Record<string, string>): never {
  throw new DomainError("NOT_FOUND", message, false, details);
}

function emptySection(): EffectReviewSection {
  return { metrics: [], notes: [], limitations: [], causality: "not_established" };
}

function validateSnapshotInput(input: ImportMetricSnapshot): void {
  assertRecord(input, "ImportMetricSnapshot", SNAPSHOT_KEYS);
  createMetricSnapshot({
    id: input.id,
    workspaceId: input.workspaceId,
    createdAt: VALIDATION_TIME,
    publicationId: input.publicationId,
    publicationVersion: input.expectedPublicationVersion,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    observedAt: input.observedAt,
    observations: input.observations,
  });
  if (Date.parse(input.observedAt) < Date.parse(input.windowEnd)) {
    invalid("observedAt must not precede windowEnd");
  }
}

function reviewSourceVersions(input: CreateEffectReview): EffectSourceVersionRef[] {
  return [
    ...input.publicationRefs.map((reference) => ({
      entityType: "publication" as const,
      id: reference.id,
      version: reference.version,
    })),
    ...input.metricSnapshotIds.map((id) => ({ entityType: "metric_snapshot" as const, id, version: 1 })),
    ...(input.baselineMetricSnapshotIds ?? []).map((id) => ({
      entityType: "metric_snapshot" as const, id, version: 1,
    })),
    ...(input.benchmarkEvidenceIds ?? []).map((id) => ({ entityType: "evidence" as const, id, version: 1 })),
  ];
}

function validateReviewInput(input: CreateEffectReview): void {
  assertRecord(input, "CreateEffectReview", REVIEW_KEYS);
  createEffectReview({
    id: input.id,
    workspaceId: input.workspaceId,
    createdAt: VALIDATION_TIME,
    publicationRefs: input.publicationRefs,
    metricSnapshotIds: input.metricSnapshotIds,
    baselineMetricSnapshotIds: input.baselineMetricSnapshotIds ?? [],
    benchmarkEvidenceIds: input.benchmarkEvidenceIds ?? [],
    sourceVersions: reviewSourceVersions(input),
    efficiency: emptySection(),
    content: emptySection(),
    conversion: emptySection(),
    automation: emptySection(),
  });
}

async function requirePublication(
  repos: Repositories,
  workspaceId: string,
  id: string,
  expectedVersion?: number,
): Promise<Publication> {
  const publication = await repos.publications.get(id, workspaceId);
  if (!publication) notFound("Publication not found in workspace", { publicationId: id, workspaceId });
  if (expectedVersion !== undefined && publication.version !== expectedVersion) {
    conflict("Publication version does not match the expected version");
  }
  if (publication.status !== "verified" || !publication.verification) {
    conflict("Effect analysis requires a verified Publication");
  }
  return publication;
}

async function requireSnapshot(
  repos: Repositories,
  workspaceId: string,
  id: string,
): Promise<MetricSnapshot> {
  const snapshot = await repos.metricSnapshots.get(id, workspaceId);
  if (!snapshot) notFound("MetricSnapshot not found in workspace", { metricSnapshotId: id, workspaceId });
  return snapshot;
}

interface MetricTotal {
  value: number | null;
  missingSnapshots: number;
}

function total(snapshots: MetricSnapshot[], name: EffectMetricName): MetricTotal {
  let found = false;
  let value = 0;
  let missingSnapshots = 0;
  for (const snapshot of snapshots) {
    const observation = snapshot.observations.find((candidate) => candidate.metric === name);
    if (!observation) {
      missingSnapshots += 1;
      continue;
    }
    found = true;
    value += observation.value;
    if (!Number.isSafeInteger(value)) conflict("Metric aggregate exceeds the safe integer bound");
  }
  return { value: found ? value : null, missingSnapshots };
}

function rate(
  name: string,
  snapshots: MetricSnapshot[],
  numeratorMetric: EffectMetricName,
  denominatorMetric: EffectMetricName,
): EffectReviewMetric {
  const numeratorTotal = total(snapshots, numeratorMetric);
  const denominatorTotal = total(snapshots, denominatorMetric);
  const numerator = numeratorTotal.value;
  const denominator = denominatorTotal.value;
  if (denominatorTotal.missingSnapshots > 0) {
    const reason = denominator === null ? "missing_denominator" : "incomplete_denominator_coverage";
    return { name, value: null, status: "unknown", reason, numerator, denominator };
  }
  if (numeratorTotal.missingSnapshots > 0) {
    const reason = numerator === null ? "missing_numerator" : "incomplete_numerator_coverage";
    return { name, value: null, status: "unknown", reason, numerator, denominator };
  }
  if (denominator === 0) {
    return { name, value: null, status: "unknown", reason: "zero_denominator", numerator, denominator };
  }
  const value = numerator! / denominator!;
  if (!Number.isFinite(value)) conflict("Effect rate must remain finite");
  return { name, value, status: "ok", reason: null, numerator, denominator };
}

function descriptiveDelta(current: EffectReviewMetric, baseline: EffectReviewMetric): EffectReviewMetric {
  if (current.status !== "ok" || baseline.status !== "ok" || current.value === null || baseline.value === null) {
    return {
      name: `${current.name}Delta`,
      value: null,
      status: "unknown",
      reason: "baseline_comparison_unknown",
      numerator: current.numerator,
      denominator: current.denominator,
    };
  }
  const value = current.value - baseline.value;
  if (!Number.isFinite(value)) conflict("Baseline delta must remain finite");
  return {
    name: `${current.name}Delta`,
    value,
    status: "ok",
    reason: null,
    numerator: current.numerator,
    denominator: current.denominator,
  };
}

function contentMetrics(snapshots: MetricSnapshot[], baselines: MetricSnapshot[]): EffectReviewMetric[] {
  const metrics = [
    rate("interactionRate", snapshots, "interactions", "impressions"),
    rate("profileVisitRate", snapshots, "profile_visits", "impressions"),
  ];
  if (baselines.length > 0) {
    metrics.push(
      descriptiveDelta(metrics[0]!, rate("interactionRate", baselines, "interactions", "impressions")),
      descriptiveDelta(metrics[1]!, rate("profileVisitRate", baselines, "profile_visits", "impressions")),
    );
  }
  return metrics;
}

function conversionMetrics(snapshots: MetricSnapshot[], baselines: MetricSnapshot[]): EffectReviewMetric[] {
  const metrics = [
    rate("leadRate", snapshots, "leads", "profile_visits"),
    rate("purchaseRate", snapshots, "purchases", "leads"),
  ];
  if (baselines.length > 0) {
    metrics.push(
      descriptiveDelta(metrics[0]!, rate("leadRate", baselines, "leads", "profile_visits")),
      descriptiveDelta(metrics[1]!, rate("purchaseRate", baselines, "purchases", "leads")),
    );
  }
  return metrics;
}

function efficiencyMetrics(publications: Publication[]): { metrics: EffectReviewMetric[]; limitations: string[] } {
  let durationTotal = 0;
  let measured = 0;
  let unavailable = 0;
  for (const publication of publications) {
    const verifiedAt = Date.parse(publication.verification?.verifiedAt ?? "");
    const createdAt = Date.parse(publication.createdAt);
    const duration = verifiedAt - createdAt;
    if (!Number.isFinite(duration) || duration < 0) {
      unavailable += 1;
      continue;
    }
    durationTotal += duration;
    if (!Number.isSafeInteger(durationTotal)) conflict("Efficiency duration aggregate exceeds the safe integer bound");
    measured += 1;
  }
  const timeToVerified: EffectReviewMetric = measured === 0
    ? {
      name: "timeToVerified", value: null, status: "unknown", reason: "timestamps_unavailable",
      numerator: null, denominator: 0,
    }
    : {
      name: "timeToVerified", value: durationTotal / measured, status: "ok", reason: null,
      numerator: durationTotal, denominator: measured,
    };
  const manualHandoffs = publications.filter((publication) =>
    publication.deliveryMode === "manual_assisted" || publication.verification?.method === "manual_evidence"
  ).length;
  return {
    metrics: [timeToVerified, {
      name: "manualHandoffs",
      value: manualHandoffs,
      status: "ok",
      reason: null,
      numerator: manualHandoffs,
      denominator: null,
    }],
    limitations: unavailable > 0 ? ["Some Publications lack usable measured verification timestamps."] : [],
  };
}

function automationMetrics(publications: Publication[]): EffectReviewMetric[] {
  const automaticVerified = publications.filter((publication) =>
    publication.deliveryMode === "automatic" && publication.verification?.method === "provider"
  ).length;
  let covered = true;
  let incomparable = false;
  const duplicateKeys: string[] = [];
  for (const publication of publications) {
    const verifyReceipts = publication.receipts.filter((receipt) => receipt.kind === "verify");
    if (publication.deliveryMode !== "automatic" || publication.verification?.method !== "provider" ||
        verifyReceipts.length === 0) {
      covered = false;
      continue;
    }
    const providers = new Set(verifyReceipts.map((receipt) => receipt.provider));
    const externalPublicationId = publication.verification.externalPublicationId;
    if (providers.size !== 1 || !externalPublicationId ||
        publication.delivery?.externalPublicationId !== externalPublicationId) {
      incomparable = true;
      continue;
    }
    duplicateKeys.push(JSON.stringify([
      verifyReceipts[0]!.provider,
      publication.channel,
      publication.accountId,
      externalPublicationId,
    ]));
  }
  let duplicateEvents: EffectReviewMetric;
  if (!covered || incomparable) {
    duplicateEvents = {
      name: "duplicateEvents",
      value: null,
      status: "unknown",
      reason: covered ? "verification_scope_incomparable" : "verification_coverage_unavailable",
      numerator: null,
      denominator: publications.length,
    };
  } else {
    const duplicates = duplicateKeys.length - new Set(duplicateKeys).size;
    duplicateEvents = {
      name: "duplicateEvents",
      value: duplicates,
      status: "ok",
      reason: null,
      numerator: duplicates,
      denominator: publications.length,
    };
  }
  return [{
    name: "automaticVerifiedRate",
    value: automaticVerified / publications.length,
    status: "ok",
    reason: null,
    numerator: automaticVerified,
    denominator: publications.length,
  }, duplicateEvents];
}

export class EffectService {
  private readonly commands: CommandPipeline;

  constructor(
    private readonly store: Store,
    clock: Clock,
    ids: IdGenerator,
  ) {
    this.commands = new AuditableCommandPipeline(store, clock, ids);
  }

  async importMetricSnapshot(command: Command<ImportMetricSnapshot>): Promise<MetricSnapshot> {
    validateSnapshotInput(command.input);
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "effect_metric_snapshot.import",
      entityType: "metric_snapshot",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        const publication = await requirePublication(
          repos,
          input.workspaceId,
          input.publicationId,
          input.expectedPublicationVersion,
        );
        const publishedAt = publication.delivery?.publishedAt;
        if (!publishedAt) conflict("Verified Publication has no measured publishedAt timestamp");
        if (Date.parse(input.windowStart) < Date.parse(publishedAt) ||
            Date.parse(input.observedAt) < Date.parse(publishedAt)) {
          invalid("Metric observations must not precede publication");
        }
        const checkedEvidence = new Map<string, Evidence>();
        for (const observation of input.observations) {
          for (const evidenceId of observation.evidenceIds) {
            let evidence = checkedEvidence.get(evidenceId);
            if (!evidence) {
              evidence = await repos.evidence.get(evidenceId, input.workspaceId) as Evidence | undefined;
              if (!evidence) notFound("Metric Evidence not found in workspace", {
                evidenceId,
                workspaceId: input.workspaceId,
              });
              const source = await repos.sources.get(evidence.sourceId, input.workspaceId) as Source | undefined;
              if (!source || !["owned", "authorized"].includes(source.ownership)) {
                conflict("Metric Evidence requires an owned or authorized workspace Source");
              }
              checkedEvidence.set(evidenceId, evidence);
            }
            const expectedClassification = CONTENT_METRICS.has(observation.metric)
              ? "owned_operating"
              : CONVERSION_METRICS.has(observation.metric) ? "owned_conversion" : null;
            if (!expectedClassification || evidence.classification !== expectedClassification) {
              conflict(`${observation.metric} requires ${expectedClassification ?? "supported"} Evidence`);
            }
            const evidenceObservedAt = Date.parse(evidence.observedAt);
            if (!Number.isFinite(evidenceObservedAt) || evidenceObservedAt < Date.parse(publishedAt) ||
                evidenceObservedAt > Date.parse(input.observedAt)) {
              conflict("Metric Evidence observedAt must be between publication and snapshot observedAt");
            }
          }
        }
        return repos.metricSnapshots.insert(createMetricSnapshot({
          id: input.id,
          workspaceId: input.workspaceId,
          createdAt: timestamp,
          publicationId: publication.id,
          publicationVersion: publication.version,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          observedAt: input.observedAt,
          observations: input.observations.map((observation) => ({
            metric: observation.metric,
            evidenceIds: [...observation.evidenceIds],
            value: observation.value,
          })),
        }));
      },
    });
  }

  getMetricSnapshot(query: GetMetricSnapshot): Promise<MetricSnapshot> {
    assertRecord(query, "GetMetricSnapshot", GET_KEYS);
    return this.store.transaction((repos) => requireSnapshot(repos, query.workspaceId, query.id));
  }

  async createReview(command: Command<CreateEffectReview>): Promise<EffectReview> {
    validateReviewInput(command.input);
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "effect_review.create",
      entityType: "effect_review",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        const loaded = await this.loadReview(repos, input);
        const content = contentMetrics(loaded.snapshots, loaded.baselines);
        const conversion = conversionMetrics(loaded.snapshots, loaded.baselines);
        const efficiency = efficiencyMetrics(loaded.publications);
        const baselineNotes = loaded.baselines.length > 0
          ? ["Baseline deltas are descriptive arithmetic differences between exact comparable windows and channels."]
          : [];
        const benchmarkNotes = (input.benchmarkEvidenceIds ?? []).length > 0
          ? ["Benchmark Evidence is retained as lineage only; no numeric benchmark value is inferred."]
          : [];
        const review = await repos.effectReviews.insert(createEffectReview({
          id: input.id,
          workspaceId: input.workspaceId,
          createdAt: timestamp,
          publicationRefs: input.publicationRefs.map((reference) => ({ ...reference })),
          metricSnapshotIds: [...input.metricSnapshotIds],
          baselineMetricSnapshotIds: [...input.baselineMetricSnapshotIds ?? []],
          benchmarkEvidenceIds: [...input.benchmarkEvidenceIds ?? []],
          sourceVersions: loaded.sourceVersions,
          efficiency: {
            metrics: efficiency.metrics,
            notes: [
              "timeToVerified is the mean of verification.verifiedAt minus Publication.createdAt in milliseconds for measured Publications only.",
              "Manual handoffs are counted separately from automatic verification.",
            ],
            limitations: [
              "Unrecorded human processing time is not estimated.",
              ...efficiency.limitations,
            ],
            causality: "not_established",
          },
          content: {
            metrics: content,
            notes: [
              "interactionRate = interactions / impressions; profileVisitRate = profile_visits / impressions.",
              ...baselineNotes,
              ...benchmarkNotes,
            ],
            limitations: ["Content observations are descriptive and do not establish causality."],
            causality: "not_established",
          },
          conversion: {
            metrics: conversion,
            notes: [
              "leadRate = leads / profile_visits; purchaseRate = purchases / leads.",
              ...baselineNotes,
            ],
            limitations: [
              "Missing downstream observations remain unknown and are never replaced by content interactions.",
            ],
            causality: "not_established",
          },
          automation: {
            metrics: automationMetrics(loaded.publications),
            notes: [
              "automaticVerifiedRate counts only automatic Publications verified by the provider.",
              "duplicateEvents requires provider verification coverage for every selected Publication.",
            ],
            limitations: ["Manual Evidence completion is not automatic provider verification."],
            causality: "not_established",
          },
        }));
        await resolveLineage(repos, {
          workspaceId: input.workspaceId,
          entityType: "effect_review",
          id: review.id,
        });
        return review;
      },
    });
  }

  getReview(query: GetEffectReview): Promise<EffectReview> {
    assertRecord(query, "GetEffectReview", GET_KEYS);
    return this.store.transaction(async (repos) => {
      const review = await repos.effectReviews.get(query.id, query.workspaceId);
      if (!review) notFound("EffectReview not found in workspace", { effectReviewId: query.id, workspaceId: query.workspaceId });
      return review;
    });
  }

  private async loadReview(repos: Repositories, input: CreateEffectReview): Promise<LoadedReview> {
    const publications: Publication[] = [];
    const sourceVersions: EffectSourceVersionRef[] = [];
    for (const reference of input.publicationRefs) {
      const publication = await requirePublication(repos, input.workspaceId, reference.id, reference.version);
      publications.push(publication);
      sourceVersions.push({ entityType: "publication", id: publication.id, version: publication.version });
    }
    const selectedByPublication = new Map(publications.map((publication) => [publication.id, publication]));
    const coveredPublications = new Set<string>();
    const snapshots: MetricSnapshot[] = [];
    for (const id of input.metricSnapshotIds) {
      const snapshot = await requireSnapshot(repos, input.workspaceId, id);
      const publication = selectedByPublication.get(snapshot.publicationId);
      if (!publication || snapshot.publicationVersion !== publication.version) {
        conflict("Selected MetricSnapshot must match an explicit versioned Publication ref");
      }
      if (coveredPublications.has(snapshot.publicationId)) {
        conflict("Each selected Publication must have exactly one selected MetricSnapshot");
      }
      coveredPublications.add(snapshot.publicationId);
      snapshots.push(snapshot);
      sourceVersions.push({ entityType: "metric_snapshot", id: snapshot.id, version: snapshot.version });
    }
    if (coveredPublications.size !== publications.length) {
      conflict("Every selected Publication must have exactly one selected MetricSnapshot");
    }
    const baselines: MetricSnapshot[] = [];
    const baselinePublications: Publication[] = [];
    const baselinePublicationIds = new Set<string>();
    for (const id of input.baselineMetricSnapshotIds ?? []) {
      const snapshot = await requireSnapshot(repos, input.workspaceId, id);
      const publication = await requirePublication(
        repos,
        input.workspaceId,
        snapshot.publicationId,
        snapshot.publicationVersion,
      );
      if (baselinePublicationIds.has(publication.id)) {
        conflict("Each baseline Publication must have at most one baseline MetricSnapshot");
      }
      baselinePublicationIds.add(publication.id);
      baselinePublications.push(publication);
      baselines.push(snapshot);
      sourceVersions.push({ entityType: "metric_snapshot", id: snapshot.id, version: snapshot.version });
    }
    if (publications.length > 1 || baselines.length > 0) {
      const first = snapshots[0]!;
      const channel = publications.find((publication) => publication.id === first.publicationId)!.channel;
      for (const snapshot of [...snapshots, ...baselines]) {
        if (snapshot.windowStart !== first.windowStart || snapshot.windowEnd !== first.windowEnd) {
          conflict("Aggregation requires exactly equal metric windows");
        }
      }
      for (const publication of [...publications, ...baselinePublications]) {
        if (publication.channel !== channel) conflict("Aggregation requires exactly equal channels");
      }
    }
    for (const id of input.benchmarkEvidenceIds ?? []) {
      const evidence = await repos.evidence.get(id, input.workspaceId) as Evidence | undefined;
      if (!evidence) notFound("Benchmark Evidence not found in workspace", { evidenceId: id, workspaceId: input.workspaceId });
      sourceVersions.push({ entityType: "evidence", id: evidence.id, version: evidence.version });
    }
    return { publications, snapshots, baselines, sourceVersions };
  }
}

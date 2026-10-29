import type { EntityRecord } from "../application/ports.js";
import {
  assertEntityReferenceId,
  assertJsonValue,
  assertRecord,
  assertStableId,
  assertUtcInstant,
  invalid,
} from "./contract-validation.js";

export const EFFECT_METRICS = [
  "impressions",
  "interactions",
  "followers_gained",
  "profile_visits",
  "leads",
  "consultations",
  "trials",
  "purchases",
] as const;
export const MAX_EFFECT_ENTITY_BYTES = 64 * 1024;
export const MAX_EFFECT_REVIEW_PUBLICATIONS = 10;
export const MAX_EFFECT_REVIEW_BASELINE_SNAPSHOTS = 10;
export const MAX_EFFECT_REVIEW_BENCHMARK_EVIDENCE = 100;
export const MAX_EFFECT_REVIEW_SOURCE_VERSIONS = 130;

export type EffectMetricName = (typeof EFFECT_METRICS)[number];

export interface MetricObservation {
  metric: EffectMetricName;
  evidenceIds: string[];
  value: number;
}

export interface MetricSnapshot extends EntityRecord {
  publicationId: string;
  publicationVersion: number;
  windowStart: string;
  windowEnd: string;
  observedAt: string;
  observations: MetricObservation[];
}

export interface EffectPublicationRef {
  id: string;
  version: number;
}

export interface EffectSourceVersionRef {
  entityType: "publication" | "metric_snapshot" | "evidence";
  id: string;
  version: number;
}

export interface EffectReviewMetric {
  name: string;
  value: number | null;
  status: "ok" | "unknown";
  reason: string | null;
  numerator: number | null;
  denominator: number | null;
}

export interface EffectReviewSection {
  metrics: EffectReviewMetric[];
  notes: string[];
  limitations: string[];
  causality: "not_established";
}

export interface EffectReview extends EntityRecord {
  publicationRefs: EffectPublicationRef[];
  metricSnapshotIds: string[];
  baselineMetricSnapshotIds: string[];
  benchmarkEvidenceIds: string[];
  sourceVersions: EffectSourceVersionRef[];
  efficiency: EffectReviewSection;
  content: EffectReviewSection;
  conversion: EffectReviewSection;
  automation: EffectReviewSection;
}

export type CreateMetricSnapshotInput = Omit<MetricSnapshot, "version" | "updatedAt">;
export type CreateEffectReviewInput = Omit<EffectReview, "version" | "updatedAt">;

const ENTITY_KEYS = ["id", "workspaceId", "version", "createdAt", "updatedAt"] as const;
const SNAPSHOT_KEYS = [
  ...ENTITY_KEYS,
  "publicationId",
  "publicationVersion",
  "windowStart",
  "windowEnd",
  "observedAt",
  "observations",
] as const;
const REVIEW_KEYS = [
  ...ENTITY_KEYS,
  "publicationRefs",
  "metricSnapshotIds",
  "baselineMetricSnapshotIds",
  "benchmarkEvidenceIds",
  "sourceVersions",
  "efficiency",
  "content",
  "conversion",
  "automation",
] as const;
const SECTION_KEYS = ["metrics", "notes", "limitations", "causality"] as const;
const SOURCE_VERSION_TYPES = ["publication", "metric_snapshot", "evidence"] as const;

function assertNonEmptyString(value: unknown, label: string, maximum = 4096): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    invalid(`${label} must be a non-empty string of at most ${maximum} UTF-16 code units`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid(`${label} must be a positive safe integer`);
  }
}

function assertReferenceIds(
  value: unknown,
  label: string,
  options: { nonEmpty?: boolean; maximum?: number } = {},
): asserts value is string[] {
  const maximum = options.maximum ?? 1000;
  if (!Array.isArray(value) || value.length > maximum || (options.nonEmpty && value.length === 0)) {
    invalid(`${label} must be a bounded array`);
  }
  for (const id of value) assertEntityReferenceId(id, label);
  if (new Set(value).size !== value.length) invalid(`${label} must not contain duplicates`);
}

function assertEntityBase(record: EntityRecord, label: string): void {
  assertStableId(record.id, `${label} ID`);
  assertEntityReferenceId(record.workspaceId, `${label} workspaceId`);
  assertPositiveInteger(record.version, `${label} version`);
  assertUtcInstant(record.createdAt, `${label} createdAt`);
  assertUtcInstant(record.updatedAt, `${label} updatedAt`);
}

function assertImmutableEntity(record: EntityRecord, label: string): void {
  assertEntityBase(record, label);
  if (record.version !== 1) invalid(`${label} is immutable and must have version 1`);
  assertJsonValue(record, label);
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_EFFECT_ENTITY_BYTES) {
    invalid(`${label} must not exceed 64 KiB`);
  }
}

export function metricSnapshotEvidenceIds(snapshot: MetricSnapshot): string[] {
  const ids: string[] = [];
  for (const observation of snapshot.observations) {
    for (const id of observation.evidenceIds) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

export function validateMetricSnapshot(snapshot: MetricSnapshot): void {
  assertRecord(snapshot, "MetricSnapshot", SNAPSHOT_KEYS);
  assertImmutableEntity(snapshot, "MetricSnapshot");
  assertEntityReferenceId(snapshot.publicationId, "MetricSnapshot publicationId");
  assertPositiveInteger(snapshot.publicationVersion, "MetricSnapshot publicationVersion");
  assertUtcInstant(snapshot.windowStart, "MetricSnapshot windowStart");
  assertUtcInstant(snapshot.windowEnd, "MetricSnapshot windowEnd");
  if (Date.parse(snapshot.windowStart) >= Date.parse(snapshot.windowEnd)) {
    invalid("MetricSnapshot windowStart must precede windowEnd");
  }
  assertUtcInstant(snapshot.observedAt, "MetricSnapshot observedAt");
  if (!Array.isArray(snapshot.observations) || snapshot.observations.length === 0 ||
      snapshot.observations.length > EFFECT_METRICS.length) {
    invalid("MetricSnapshot observations must be a non-empty bounded array");
  }
  const metrics = new Set<string>();
  for (const observation of snapshot.observations) {
    assertRecord(observation, "Metric observation", ["metric", "evidenceIds", "value"]);
    if (!(EFFECT_METRICS as readonly string[]).includes(observation.metric)) {
      invalid("Metric observation metric must be supported");
    }
    if (metrics.has(observation.metric)) invalid("MetricSnapshot observations must not contain duplicate metrics");
    metrics.add(observation.metric);
    assertReferenceIds(observation.evidenceIds, "Metric observation evidenceIds", { nonEmpty: true, maximum: 100 });
    if (!Number.isSafeInteger(observation.value) || observation.value < 0) {
      invalid("Metric observation value must be a nonnegative safe integer");
    }
  }
}

export function createMetricSnapshot(input: CreateMetricSnapshotInput): MetricSnapshot {
  const snapshot = { ...input, version: 1, updatedAt: input.createdAt } as MetricSnapshot;
  validateMetricSnapshot(snapshot);
  return snapshot;
}

function validateStringList(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 100) invalid(`${label} must be a bounded array`);
  for (const entry of value) assertNonEmptyString(entry, label);
}

function validateSection(section: EffectReviewSection, label: string): void {
  assertRecord(section, label, SECTION_KEYS);
  if (!Array.isArray(section.metrics) || section.metrics.length > 100) {
    invalid(`${label} metrics must be a bounded array`);
  }
  const names = new Set<string>();
  for (const metric of section.metrics) {
    assertRecord(metric, `${label} metric`, ["name", "value", "status", "reason", "numerator", "denominator"]);
    assertNonEmptyString(metric.name, `${label} metric name`, 128);
    if (names.has(metric.name)) invalid(`${label} metric names must not contain duplicates`);
    names.add(metric.name);
    if (metric.status !== "ok" && metric.status !== "unknown") invalid(`${label} metric status must be ok or unknown`);
    if (metric.status === "ok") {
      if (typeof metric.value !== "number" || !Number.isFinite(metric.value) || metric.reason !== null) {
        invalid(`${label} known metric requires a finite value and null reason`);
      }
    } else if (metric.value !== null) {
      invalid(`${label} unknown metric requires a null value`);
    } else {
      assertNonEmptyString(metric.reason, `${label} unknown metric reason`, 256);
    }
    for (const [field, value] of [["numerator", metric.numerator], ["denominator", metric.denominator]] as const) {
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
        invalid(`${label} metric ${field} must be finite or null`);
      }
    }
  }
  validateStringList(section.notes, `${label} notes`);
  validateStringList(section.limitations, `${label} limitations`);
  if (section.causality !== "not_established") invalid(`${label} causality must be not_established`);
}

function validateSourceVersions(review: EffectReview): void {
  if (!Array.isArray(review.sourceVersions) || review.sourceVersions.length > MAX_EFFECT_REVIEW_SOURCE_VERSIONS) {
    invalid("EffectReview sourceVersions must be a bounded array");
  }
  const expected = new Map<string, number>();
  for (const reference of review.publicationRefs) expected.set(`publication:${reference.id}`, reference.version);
  for (const id of review.metricSnapshotIds) expected.set(`metric_snapshot:${id}`, 1);
  for (const id of review.baselineMetricSnapshotIds) expected.set(`metric_snapshot:${id}`, 1);
  for (const id of review.benchmarkEvidenceIds) expected.set(`evidence:${id}`, 1);
  const actual = new Map<string, number>();
  for (const reference of review.sourceVersions) {
    assertRecord(reference, "EffectReview source version", ["entityType", "id", "version"]);
    if (!(SOURCE_VERSION_TYPES as readonly string[]).includes(reference.entityType)) {
      invalid("EffectReview source version entityType must be supported");
    }
    assertEntityReferenceId(reference.id, "EffectReview source version ID");
    assertPositiveInteger(reference.version, "EffectReview source version");
    const key = `${reference.entityType}:${reference.id}`;
    if (actual.has(key)) invalid("EffectReview sourceVersions must not contain duplicates");
    actual.set(key, reference.version);
  }
  if (actual.size !== expected.size || [...expected].some(([key, version]) => actual.get(key) !== version)) {
    invalid("EffectReview sourceVersions must exactly cover every direct reference");
  }
}

export function validateEffectReview(review: EffectReview): void {
  assertRecord(review, "EffectReview", REVIEW_KEYS);
  assertImmutableEntity(review, "EffectReview");
  if (!Array.isArray(review.publicationRefs) || review.publicationRefs.length === 0 ||
      review.publicationRefs.length > MAX_EFFECT_REVIEW_PUBLICATIONS) {
    invalid("EffectReview publicationRefs must be a non-empty bounded array");
  }
  const publicationIds = new Set<string>();
  for (const reference of review.publicationRefs) {
    assertRecord(reference, "EffectReview publication ref", ["id", "version"]);
    assertEntityReferenceId(reference.id, "EffectReview publication ID");
    assertPositiveInteger(reference.version, "EffectReview publication version");
    if (publicationIds.has(reference.id)) invalid("EffectReview publicationRefs must not contain duplicates");
    publicationIds.add(reference.id);
  }
  assertReferenceIds(review.metricSnapshotIds, "EffectReview metricSnapshotIds", {
    nonEmpty: true,
    maximum: MAX_EFFECT_REVIEW_PUBLICATIONS,
  });
  assertReferenceIds(review.baselineMetricSnapshotIds, "EffectReview baselineMetricSnapshotIds", {
    maximum: MAX_EFFECT_REVIEW_BASELINE_SNAPSHOTS,
  });
  assertReferenceIds(review.benchmarkEvidenceIds, "EffectReview benchmarkEvidenceIds", {
    maximum: MAX_EFFECT_REVIEW_BENCHMARK_EVIDENCE,
  });
  if (review.baselineMetricSnapshotIds.some((id) => review.metricSnapshotIds.includes(id))) {
    invalid("EffectReview baseline snapshots must be distinct from selected snapshots");
  }
  validateSourceVersions(review);
  validateSection(review.efficiency, "EffectReview efficiency section");
  validateSection(review.content, "EffectReview content section");
  validateSection(review.conversion, "EffectReview conversion section");
  validateSection(review.automation, "EffectReview automation section");
}

export function createEffectReview(input: CreateEffectReviewInput): EffectReview {
  const review = { ...input, version: 1, updatedAt: input.createdAt } as EffectReview;
  validateEffectReview(review);
  return review;
}

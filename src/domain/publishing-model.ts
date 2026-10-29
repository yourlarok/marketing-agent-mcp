import type { EntityRecord } from "../application/ports.js";
import {
  assertEntityReferenceId,
  assertJsonValue,
  assertRecord,
  assertStableId,
  assertUtcInstant,
  invalid,
} from "./contract-validation.js";
import { CONTENT_CHANNELS, type ContentChannel } from "./content-production-model.js";

export const APPROVAL_DECISIONS = ["approved", "rejected"] as const;
export const DELIVERY_MODES = ["automatic", "manual_assisted"] as const;
export const SCHEDULE_STATUSES = ["scheduled", "triggered", "completed", "cancelled"] as const;
export const PUBLICATION_STATUSES = [
  "pending",
  "submitting",
  "submitted",
  "verified",
  "failed",
  "unknown",
  "manual_handoff",
  "cancelled",
] as const;
export const MAX_PUBLICATION_ATTEMPTS = 5;
export const MAX_PUBLICATION_RECEIPTS = 20;
export const MAX_PUBLISHING_ENTITY_BYTES = 64 * 1024;

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
export type DeliveryMode = (typeof DELIVERY_MODES)[number];
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export interface Approval extends EntityRecord {
  assetVersionId: string;
  assetVersion: number;
  artifactHash: string;
  decision: ApprovalDecision;
  reviewer: {
    actor: string;
    attestation: "human_attested";
  };
  comment: string;
  decidedAt: string;
}

export interface Schedule extends EntityRecord {
  assetVersionId: string;
  assetVersion: number;
  approvalId: string;
  channel: ContentChannel;
  accountId: string;
  scheduledFor: string;
  timeZone: string;
  deliveryMode: DeliveryMode;
  status: ScheduleStatus;
}

export interface PublicationAttempt {
  attempt: number;
  startedAt: string;
  completedAt: string | null;
  outcome: "submitting" | "submitted" | "failed" | "unknown";
}

export interface PublicationReceipt {
  kind: "submit" | "verify";
  provider: string;
  receiptId: string;
  receivedAt: string;
  contentHash: string;
}

export interface PublicationFailure {
  code: string;
  message: string;
  failedAt: string;
  retryable: boolean;
}

export interface PublicationDelivery {
  method: "provider" | "manual_evidence";
  externalPublicationId: string | null;
  publishedAt: string | null;
  evidenceIds: string[];
}

export interface PublicationVerification {
  method: "provider" | "manual_evidence";
  verifiedAt: string;
  externalPublicationId: string | null;
  evidenceIds: string[];
}

export interface Publication extends EntityRecord {
  scheduleId: string;
  scheduleVersion: number;
  assetVersionId: string;
  assetVersion: number;
  approvalId: string;
  artifactHash: string;
  operationKey: string;
  channel: ContentChannel;
  accountId: string;
  deliveryMode: DeliveryMode;
  status: PublicationStatus;
  attempts: PublicationAttempt[];
  receipts: PublicationReceipt[];
  failure: PublicationFailure | null;
  delivery: PublicationDelivery | null;
  verification: PublicationVerification | null;
}

export type CreateApprovalInput = Omit<Approval, "version" | "updatedAt">;
export type CreateScheduleInput = Omit<Schedule, "version" | "updatedAt">;
export type CreatePublicationInput = Omit<Publication, "version" | "updatedAt">;

const ENTITY_KEYS = ["id", "workspaceId", "version", "createdAt", "updatedAt"] as const;
const APPROVAL_KEYS = [
  ...ENTITY_KEYS,
  "assetVersionId",
  "assetVersion",
  "artifactHash",
  "decision",
  "reviewer",
  "comment",
  "decidedAt",
] as const;
const SCHEDULE_KEYS = [
  ...ENTITY_KEYS,
  "assetVersionId",
  "assetVersion",
  "approvalId",
  "channel",
  "accountId",
  "scheduledFor",
  "timeZone",
  "deliveryMode",
  "status",
] as const;
const PUBLICATION_KEYS = [
  ...ENTITY_KEYS,
  "scheduleId",
  "scheduleVersion",
  "assetVersionId",
  "assetVersion",
  "approvalId",
  "artifactHash",
  "operationKey",
  "channel",
  "accountId",
  "deliveryMode",
  "status",
  "attempts",
  "receipts",
  "failure",
  "delivery",
  "verification",
] as const;

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

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    invalid(`${label} must be a lowercase SHA-256 hexadecimal hash`);
  }
}

function assertReferenceIds(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 100) invalid(`${label} must be a bounded array`);
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

function assertEntitySize(record: EntityRecord, label: string): void {
  assertJsonValue(record, label);
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_PUBLISHING_ENTITY_BYTES) {
    invalid(`${label} must not exceed 64 KiB`);
  }
}

function assertChannel(value: unknown): asserts value is ContentChannel {
  if (!(CONTENT_CHANNELS as readonly string[]).includes(value as string)) {
    invalid("channel must be supported");
  }
}

function assertDeliveryMode(value: unknown): asserts value is DeliveryMode {
  if (!(DELIVERY_MODES as readonly string[]).includes(value as string)) {
    invalid("deliveryMode must be supported");
  }
}

function assertNullableExternalId(value: unknown, label: string): void {
  if (value !== null) assertEntityReferenceId(value, label);
}

function validateTimeZone(value: unknown): asserts value is string {
  assertNonEmptyString(value, "Schedule timeZone", 64);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    invalid("Schedule timeZone must be a bounded IANA time zone");
  }
}

export function validateApproval(approval: Approval): void {
  assertRecord(approval, "Approval", APPROVAL_KEYS);
  assertEntityBase(approval, "Approval");
  if (approval.version !== 1) invalid("Approval is immutable and must have version 1");
  assertEntityReferenceId(approval.assetVersionId, "Approval assetVersionId");
  assertPositiveInteger(approval.assetVersion, "Approval assetVersion");
  assertHash(approval.artifactHash, "Approval artifactHash");
  if (!(APPROVAL_DECISIONS as readonly string[]).includes(approval.decision)) {
    invalid("Approval decision must be approved or rejected");
  }
  assertRecord(approval.reviewer, "Approval reviewer", ["actor", "attestation"]);
  assertNonEmptyString(approval.reviewer.actor, "Approval reviewer actor", 256);
  if (approval.reviewer.attestation !== "human_attested") {
    invalid("Approval reviewer attestation must be human_attested");
  }
  assertNonEmptyString(approval.comment, "Approval comment");
  assertUtcInstant(approval.decidedAt, "Approval decidedAt");
  assertEntitySize(approval, "Approval");
}

export function createApproval(input: CreateApprovalInput): Approval {
  const approval = { ...input, version: 1, updatedAt: input.createdAt } as Approval;
  validateApproval(approval);
  return approval;
}

export function validateSchedule(schedule: Schedule): void {
  assertRecord(schedule, "Schedule", SCHEDULE_KEYS);
  assertEntityBase(schedule, "Schedule");
  assertEntityReferenceId(schedule.assetVersionId, "Schedule assetVersionId");
  assertPositiveInteger(schedule.assetVersion, "Schedule assetVersion");
  assertEntityReferenceId(schedule.approvalId, "Schedule approvalId");
  assertChannel(schedule.channel);
  assertEntityReferenceId(schedule.accountId, "Schedule accountId");
  assertUtcInstant(schedule.scheduledFor, "Schedule scheduledFor");
  validateTimeZone(schedule.timeZone);
  assertDeliveryMode(schedule.deliveryMode);
  if (!(SCHEDULE_STATUSES as readonly string[]).includes(schedule.status)) {
    invalid("Schedule status must be supported");
  }
  assertEntitySize(schedule, "Schedule");
}

export function createSchedule(input: CreateScheduleInput): Schedule {
  const schedule = { ...input, version: 1, updatedAt: input.createdAt } as Schedule;
  validateSchedule(schedule);
  return schedule;
}

function validateAttempts(attempts: PublicationAttempt[]): void {
  if (!Array.isArray(attempts) || attempts.length > MAX_PUBLICATION_ATTEMPTS) {
    invalid(`Publication attempts must contain at most ${MAX_PUBLICATION_ATTEMPTS} entries`);
  }
  for (const [index, attempt] of attempts.entries()) {
    assertRecord(attempt, "Publication attempt", ["attempt", "startedAt", "completedAt", "outcome"]);
    if (attempt.attempt !== index + 1) invalid("Publication attempt numbers must be consecutive starting at 1");
    assertUtcInstant(attempt.startedAt, "Publication attempt startedAt");
    if (attempt.completedAt !== null) {
      assertUtcInstant(attempt.completedAt, "Publication attempt completedAt");
      if (Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt)) {
        invalid("Publication attempt completedAt must not precede startedAt");
      }
    }
    if (!["submitting", "submitted", "failed", "unknown"].includes(attempt.outcome)) {
      invalid("Publication attempt outcome must be supported");
    }
  }
}

function validateReceipts(receipts: PublicationReceipt[]): void {
  if (!Array.isArray(receipts) || receipts.length > MAX_PUBLICATION_RECEIPTS) {
    invalid(`Publication receipts must contain at most ${MAX_PUBLICATION_RECEIPTS} entries`);
  }
  const seen = new Set<string>();
  for (const receipt of receipts) {
    assertRecord(receipt, "Publication receipt", ["kind", "provider", "receiptId", "receivedAt", "contentHash"]);
    if (receipt.kind !== "submit" && receipt.kind !== "verify") invalid("Publication receipt kind must be submit or verify");
    assertNonEmptyString(receipt.provider, "Publication receipt provider", 256);
    assertNonEmptyString(receipt.receiptId, "Publication receipt receiptId", 256);
    const key = JSON.stringify([receipt.kind, receipt.receiptId]);
    if (seen.has(key)) invalid("Publication receipts must not contain duplicates");
    seen.add(key);
    assertUtcInstant(receipt.receivedAt, "Publication receipt receivedAt");
    assertHash(receipt.contentHash, "Publication receipt contentHash");
  }
}

function validateFailure(failure: PublicationFailure | null): void {
  if (failure === null) return;
  assertRecord(failure, "Publication failure", ["code", "message", "failedAt", "retryable"]);
  assertNonEmptyString(failure.code, "Publication failure code", 256);
  assertNonEmptyString(failure.message, "Publication failure message");
  assertUtcInstant(failure.failedAt, "Publication failure failedAt");
  if (typeof failure.retryable !== "boolean") invalid("Publication failure retryable must be a boolean");
}

function validateDelivery(delivery: PublicationDelivery | null): void {
  if (delivery === null) return;
  assertRecord(delivery, "Publication delivery", ["method", "externalPublicationId", "publishedAt", "evidenceIds"]);
  if (delivery.method !== "provider" && delivery.method !== "manual_evidence") {
    invalid("Publication delivery method must be provider or manual_evidence");
  }
  assertNullableExternalId(delivery.externalPublicationId, "Publication delivery externalPublicationId");
  if (delivery.publishedAt !== null) assertUtcInstant(delivery.publishedAt, "Publication delivery publishedAt");
  assertReferenceIds(delivery.evidenceIds, "Publication delivery evidenceIds");
  if (delivery.method === "manual_evidence" && delivery.evidenceIds.length === 0) {
    invalid("Manual-evidence delivery requires Evidence refs");
  }
}

function validateVerification(verification: PublicationVerification | null): void {
  if (verification === null) return;
  assertRecord(verification, "Publication verification", ["method", "verifiedAt", "externalPublicationId", "evidenceIds"]);
  if (verification.method !== "provider" && verification.method !== "manual_evidence") {
    invalid("Publication verification method must be provider or manual_evidence");
  }
  assertUtcInstant(verification.verifiedAt, "Publication verification verifiedAt");
  assertNullableExternalId(verification.externalPublicationId, "Publication verification externalPublicationId");
  assertReferenceIds(verification.evidenceIds, "Publication verification evidenceIds");
  if (verification.method === "manual_evidence" && verification.evidenceIds.length === 0) {
    invalid("Manual-evidence verification requires Evidence refs");
  }
}

export function publicationEvidenceIds(publication: Publication): string[] {
  const ids: string[] = [];
  for (const descriptor of [publication.delivery, publication.verification]) {
    for (const id of descriptor?.evidenceIds ?? []) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

export function validatePublication(publication: Publication): void {
  assertRecord(publication, "Publication", PUBLICATION_KEYS);
  assertEntityBase(publication, "Publication");
  assertEntityReferenceId(publication.scheduleId, "Publication scheduleId");
  assertPositiveInteger(publication.scheduleVersion, "Publication scheduleVersion");
  assertEntityReferenceId(publication.assetVersionId, "Publication assetVersionId");
  assertPositiveInteger(publication.assetVersion, "Publication assetVersion");
  assertEntityReferenceId(publication.approvalId, "Publication approvalId");
  assertHash(publication.artifactHash, "Publication artifactHash");
  assertNonEmptyString(publication.operationKey, "Publication operationKey", 256);
  assertChannel(publication.channel);
  assertEntityReferenceId(publication.accountId, "Publication accountId");
  assertDeliveryMode(publication.deliveryMode);
  if (!(PUBLICATION_STATUSES as readonly string[]).includes(publication.status)) {
    invalid("Publication status must be supported");
  }
  validateAttempts(publication.attempts);
  validateReceipts(publication.receipts);
  validateFailure(publication.failure);
  validateDelivery(publication.delivery);
  validateVerification(publication.verification);
  assertEntitySize(publication, "Publication");
}

export function createPublication(input: CreatePublicationInput): Publication {
  const publication = { ...input, version: 1, updatedAt: input.createdAt } as Publication;
  validatePublication(publication);
  return publication;
}

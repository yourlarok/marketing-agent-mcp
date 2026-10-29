import { describe, expect, it } from "vitest";
import {
  APPROVAL_DECISIONS,
  DELIVERY_MODES,
  MAX_PUBLICATION_ATTEMPTS,
  MAX_PUBLICATION_RECEIPTS,
  PUBLICATION_STATUSES,
  SCHEDULE_STATUSES,
  createApproval,
  createPublication,
  createSchedule,
  publicationEvidenceIds,
  validateApproval,
  validatePublication,
  validateSchedule,
  type Approval,
  type Publication,
  type Schedule,
} from "../../src/domain/publishing-model.js";

const now = "2026-10-29T12:00:00.000Z";
const later = "2026-10-29T12:01:00.000Z";
const hash = "a".repeat(64);

function approval(overrides: Record<string, unknown> = {}): Approval {
  return createApproval({
    id: "approval-1",
    workspaceId: "workspace-1",
    createdAt: now,
    assetVersionId: "asset-1",
    assetVersion: 3,
    artifactHash: hash,
    decision: "approved",
    reviewer: { actor: "reviewer-1", attestation: "human_attested" },
    comment: "Approved the exact artifact",
    decidedAt: now,
    ...overrides,
  });
}

function schedule(overrides: Record<string, unknown> = {}): Schedule {
  return createSchedule({
    id: "schedule-1",
    workspaceId: "workspace-1",
    createdAt: now,
    assetVersionId: "asset-1",
    assetVersion: 3,
    approvalId: "approval-1",
    channel: "xhs",
    accountId: "account-1",
    scheduledFor: later,
    timeZone: "Asia/Shanghai",
    deliveryMode: "automatic",
    status: "scheduled",
    ...overrides,
  });
}

function publication(overrides: Record<string, unknown> = {}): Publication {
  return createPublication({
    id: "publication-1",
    workspaceId: "workspace-1",
    createdAt: now,
    scheduleId: "schedule-1",
    scheduleVersion: 1,
    assetVersionId: "asset-1",
    assetVersion: 3,
    approvalId: "approval-1",
    artifactHash: hash,
    operationKey: `publish:v1:${"b".repeat(64)}`,
    channel: "xhs",
    accountId: "account-1",
    deliveryMode: "automatic",
    status: "pending",
    attempts: [],
    receipts: [],
    failure: null,
    delivery: null,
    verification: null,
    ...overrides,
  });
}

describe("publishing domain contracts", () => {
  it("locks an Approval to an exact immutable AssetVersion and artifact", () => {
    expect(APPROVAL_DECISIONS).toEqual(["approved", "rejected"]);
    expect(approval()).toMatchObject({ version: 1, updatedAt: now, assetVersion: 3, artifactHash: hash });
    expect(approval({ decision: "rejected" }).decision).toBe("rejected");
    expect(() => validateApproval(approval())).not.toThrow();
    expect(() => approval({ assetVersion: 0 })).toThrow(/version/i);
    expect(() => approval({ artifactHash: "A".repeat(64) })).toThrow(/hash/i);
    expect(() => validateApproval({ ...approval(), version: 2 })).toThrow(/immutable/i);
    expect(() => approval({ reviewer: { actor: "agent", attestation: "cryptographic_proof" } })).toThrow(/attestation/i);
  });

  it("accepts only the specified Schedule and Publication statuses and delivery modes", () => {
    expect(SCHEDULE_STATUSES).toEqual(["scheduled", "triggered", "completed", "cancelled"]);
    expect(PUBLICATION_STATUSES).toEqual([
      "pending", "submitting", "submitted", "verified", "failed", "unknown", "manual_handoff", "cancelled",
    ]);
    expect(DELIVERY_MODES).toEqual(["automatic", "manual_assisted"]);
    for (const status of SCHEDULE_STATUSES) expect(schedule({ status }).status).toBe(status);
    for (const status of PUBLICATION_STATUSES) expect(publication({ status }).status).toBe(status);
    expect(schedule({ deliveryMode: "manual_assisted" }).deliveryMode).toBe("manual_assisted");
    expect(() => schedule({ status: "published" })).toThrow(/status/i);
    expect(() => publication({ status: "published" })).toThrow(/status/i);
  });

  it("requires UTC schedule instants and bounded real IANA time zones", () => {
    for (const timeZone of ["UTC", "America/New_York", "Asia/Shanghai"]) {
      expect(schedule({ timeZone }).timeZone).toBe(timeZone);
    }
    for (const timeZone of ["", "UTC+8", "Not/A_Zone", "x".repeat(65)]) {
      expect(() => schedule({ timeZone })).toThrow(/timeZone|IANA/i);
    }
    expect(() => schedule({ scheduledFor: "2026-10-29T20:00:00+08:00" })).toThrow(/UTC/i);
    expect(() => schedule({ scheduledFor: "2026-02-30T00:00:00Z" })).toThrow(/date|instant/i);
  });

  it("preserves existing 256-character reference IDs while bounding new entity IDs", () => {
    const referenceId = `r${"x".repeat(255)}`;
    expect(approval({ assetVersionId: referenceId }).assetVersionId).toBe(referenceId);
    expect(() => approval({ assetVersionId: `${referenceId}x` })).toThrow(/256|reference/i);
    expect(() => approval({ id: `a${"x".repeat(128)}` })).toThrow(/ID/i);
  });

  it("bounds ordered attempts and receipts and validates all publication descriptors", () => {
    const value = publication({
      status: "verified",
      attempts: [{
        attempt: 1,
        startedAt: now,
        completedAt: later,
        outcome: "submitted",
      }],
      receipts: [{
        kind: "verify",
        provider: "trusted-fixture",
        receiptId: "receipt-1",
        receivedAt: later,
        contentHash: hash,
      }],
      delivery: {
        method: "manual_evidence",
        externalPublicationId: "external-1",
        publishedAt: later,
        evidenceIds: ["evidence-1"],
      },
      verification: {
        method: "manual_evidence",
        verifiedAt: later,
        externalPublicationId: "external-1",
        evidenceIds: ["evidence-1", "evidence-2"],
      },
    });
    expect(value.version).toBe(1);
    expect(publicationEvidenceIds(value)).toEqual(["evidence-1", "evidence-2"]);
    expect(publicationEvidenceIds(value)).not.toBe(publicationEvidenceIds(value));
    expect(MAX_PUBLICATION_ATTEMPTS).toBe(5);
    expect(MAX_PUBLICATION_RECEIPTS).toBe(20);
    expect(() => publication({
      attempts: Array.from({ length: 6 }, (_, index) => ({
        attempt: index + 1, startedAt: now, completedAt: later, outcome: "failed",
      })),
    })).toThrow(/attempt/i);
    expect(() => publication({
      receipts: Array.from({ length: 21 }, (_, index) => ({
        kind: "submit", provider: "fixture", receiptId: `receipt-${index}`, receivedAt: now, contentHash: hash,
      })),
    })).toThrow(/receipt/i);
    expect(() => publication({ failure: { code: "x", message: "x", failedAt: now, retryable: "yes" } })).toThrow(/retryable/i);
    expect(() => publication({ verification: { method: "manual_evidence", verifiedAt: now, externalPublicationId: null, evidenceIds: [] } })).toThrow(/evidence/i);
  });

  it("rejects unsupported fields and invalid optimistic versions", () => {
    expect(() => validateSchedule({ ...schedule(), providerCommand: "secret" } as Schedule)).toThrow(/unsupported/i);
    expect(() => validatePublication({ ...publication(), rawReceipt: {} } as Publication)).toThrow(/unsupported/i);
    expect(() => validateSchedule({ ...schedule(), version: 0 })).toThrow(/version/i);
    expect(() => validatePublication({ ...publication(), version: 1.5 })).toThrow(/version/i);
    expect(() => publication({ operationKey: "x".repeat(257) })).toThrow(/operationKey/i);
  });
});

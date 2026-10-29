import { describe, expect, it } from "vitest";
import {
  EFFECT_METRICS,
  createEffectReview,
  createMetricSnapshot,
  metricSnapshotEvidenceIds,
  validateEffectReview,
  validateMetricSnapshot,
  type EffectReview,
  type EffectReviewSection,
  type MetricSnapshot,
} from "../../src/domain/effect-model.js";

const now = "2026-10-29T12:00:00.000Z";
const later = "2026-10-29T13:00:00.000Z";

function snapshot(overrides: Record<string, unknown> = {}): MetricSnapshot {
  return createMetricSnapshot({
    id: "snapshot-1",
    workspaceId: "workspace-1",
    createdAt: now,
    publicationId: "publication-1",
    publicationVersion: 2,
    windowStart: now,
    windowEnd: later,
    observedAt: later,
    observations: [
      { metric: "impressions", evidenceIds: ["evidence-1"], value: 100 },
      { metric: "purchases", evidenceIds: ["evidence-2", "evidence-1"], value: 0 },
    ],
    ...overrides,
  });
}

function section(name: string): EffectReviewSection {
  return {
    metrics: [{
      name,
      value: null,
      status: "unknown",
      reason: "zero_denominator",
      numerator: 5,
      denominator: 0,
    }],
    notes: ["Observed values are descriptive"],
    limitations: ["No causal comparison"],
    causality: "not_established",
  };
}

function review(overrides: Record<string, unknown> = {}): EffectReview {
  return createEffectReview({
    id: "review-1",
    workspaceId: "workspace-1",
    createdAt: later,
    publicationRefs: [{ id: "publication-1", version: 2 }],
    metricSnapshotIds: ["snapshot-1"],
    baselineMetricSnapshotIds: ["baseline-1"],
    benchmarkEvidenceIds: ["evidence-3"],
    sourceVersions: [
      { entityType: "publication", id: "publication-1", version: 2 },
      { entityType: "metric_snapshot", id: "snapshot-1", version: 1 },
      { entityType: "metric_snapshot", id: "baseline-1", version: 1 },
      { entityType: "evidence", id: "evidence-3", version: 1 },
    ],
    efficiency: section("timeToVerified"),
    content: section("interactionRate"),
    conversion: section("purchaseRate"),
    automation: section("automaticVerifiedRate"),
    ...overrides,
  });
}

describe("effect domain contracts", () => {
  it("supports exactly the bounded content and conversion metric vocabulary", () => {
    expect(EFFECT_METRICS).toEqual([
      "impressions", "interactions", "followers_gained", "profile_visits",
      "leads", "consultations", "trials", "purchases",
    ]);
    for (const metric of EFFECT_METRICS) {
      expect(snapshot({ observations: [{ metric, evidenceIds: ["evidence-1"], value: 0 }] }).observations[0]).toMatchObject({ metric, value: 0 });
    }
    expect(() => snapshot({ observations: [{ metric: "revenue", evidenceIds: ["evidence-1"], value: 1 }] })).toThrow(/metric/i);
  });

  it("keeps snapshots immutable and observations evidence-bound, ordered, unique, and nonnegative", () => {
    expect(snapshot()).toMatchObject({ version: 1, updatedAt: now });
    expect(metricSnapshotEvidenceIds(snapshot())).toEqual(["evidence-1", "evidence-2"]);
    expect(() => validateMetricSnapshot({ ...snapshot(), version: 2 })).toThrow(/immutable/i);
    expect(() => snapshot({ observations: [] })).toThrow(/observation/i);
    expect(() => snapshot({ observations: [snapshot().observations[0]!, snapshot().observations[0]!] })).toThrow(/duplicate/i);
    expect(() => snapshot({ observations: [{ metric: "leads", evidenceIds: [], value: 1 }] })).toThrow(/evidence/i);
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => snapshot({ observations: [{ metric: "leads", evidenceIds: ["evidence-1"], value }] })).toThrow(/integer|finite/i);
    }
  });

  it("requires an ordered UTC window and bounds snapshot size", () => {
    expect(() => snapshot({ windowStart: later, windowEnd: now })).toThrow(/window/i);
    expect(() => snapshot({ windowStart: now, windowEnd: now })).toThrow(/window/i);
    expect(() => snapshot({ windowStart: "2026-10-29T20:00:00+08:00" })).toThrow(/UTC/i);
    expect(() => snapshot({ observedAt: "not-a-time" })).toThrow(/UTC|instant/i);
    expect(() => snapshot({
      observations: Array.from({ length: 9 }, (_, index) => ({ metric: EFFECT_METRICS[index % 8]!, evidenceIds: [`evidence-${index}`], value: index })),
    })).toThrow(/duplicate|observation/i);
    expect(() => snapshot({ observations: [{ metric: "leads", evidenceIds: Array.from({ length: 101 }, (_, i) => `e-${i}`), value: 1 }] })).toThrow(/evidence/i);
  });

  it("stores explicit versioned refs and immutable source versions without formulas", () => {
    const value = review();
    expect(value).toMatchObject({ version: 1, updatedAt: later });
    expect(value).not.toHaveProperty("causality");
    expect(Object.keys(value)).not.toContain("interactionRate");
    expect(() => validateEffectReview({ ...value, version: 2 })).toThrow(/immutable/i);
    expect(() => review({ publicationRefs: [{ id: "publication-1" }] })).toThrow(/version/i);
    expect(() => review({ sourceVersions: value.sourceVersions.slice(1) })).toThrow(/sourceVersions/i);
    expect(() => review({ sourceVersions: [...value.sourceVersions, value.sourceVersions[0]!] })).toThrow(/duplicate/i);
    expect(() => review({ metricSnapshotIds: [] })).toThrow(/metricSnapshot/i);
  });

  it("requires all four strict bounded review sections and explicit unknown reasons", () => {
    for (const key of ["efficiency", "content", "conversion", "automation"] as const) {
      const incomplete = { ...review() } as Record<string, unknown>;
      delete incomplete[key];
      expect(() => validateEffectReview(incomplete as EffectReview)).toThrow(/object|section|unsupported/i);
    }
    expect(() => review({ content: { ...section("interactionRate"), causality: "established" } })).toThrow(/causality/i);
    expect(() => review({ content: {
      ...section("interactionRate"),
      metrics: [{ name: "interactionRate", value: null, status: "unknown", reason: null, numerator: 0, denominator: 0 }],
    } })).toThrow(/reason/i);
    expect(() => review({ content: {
      ...section("interactionRate"),
      metrics: [{ name: "interactionRate", value: null, status: "ok", reason: null, numerator: 0, denominator: 1 }],
    } })).toThrow(/value|status/i);
    expect(() => validateEffectReview({ ...review(), extra: true } as EffectReview)).toThrow(/unsupported/i);
  });
});

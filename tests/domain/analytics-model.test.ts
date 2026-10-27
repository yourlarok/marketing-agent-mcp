import { describe, expect, it } from "vitest";
import {
  ANOMALY_V1_FORMULA,
  TREND_V1_FORMULA,
  FUNNEL_V1_FORMULA,
  computeAnomalyReference,
  computeFunnelReference,
  computeTrendReference,
  validateAnalyticsOperation,
  validateAnalyticsResult,
} from "../../src/domain/analytics-model.js";
import { DomainError } from "../../src/domain/errors.js";

const trendOperation = {
  operation: "trend_v1",
  datasetId: "dataset-1",
  parameters: { timeField: "observedAt", valueField: "revenue", grain: "day" },
} as const;

const funnelOperation = {
  operation: "funnel_v1",
  datasetId: "dataset-1",
  parameters: { stageFields: ["impressions", "clicks", "conversions"] },
} as const;

const anomalyOperation = {
  operation: "anomaly_v1",
  datasetId: "dataset-1",
  parameters: { valueField: "revenue" },
} as const;

function expectInvalid(operation: () => void): void {
  expect(operation).toThrowError(
    expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
  );
}

describe("controlled analytics operations and results", () => {
  it("accepts only versioned trend, funnel, and anomaly operations", () => {
    for (const operation of [trendOperation, funnelOperation, anomalyOperation]) {
      expect(() => validateAnalyticsOperation(operation)).not.toThrow();
    }
    for (const operation of ["trend", "arbitrary_python", "__proto__", "constructor"]) {
      expectInvalid(() => validateAnalyticsOperation({ ...trendOperation, operation }));
    }
  });

  it("validates field identifiers, stage ordering, and prototype keys", () => {
    for (const field of ["bad.field", "bad;field", "__proto__", "constructor", "prototype", ""]) {
      expectInvalid(() => validateAnalyticsOperation({
        ...trendOperation,
        parameters: { ...trendOperation.parameters, valueField: field },
      }));
    }
    expectInvalid(() => validateAnalyticsOperation({
      ...funnelOperation,
      parameters: { stageFields: ["clicks"] },
    }));
    expectInvalid(() => validateAnalyticsOperation({
      ...funnelOperation,
      parameters: { stageFields: ["clicks", "clicks"] },
    }));
    expectInvalid(() => validateAnalyticsOperation({
      ...trendOperation,
      parameters: JSON.parse('{"timeField":"observedAt","valueField":"revenue","grain":"day","__proto__":{}}'),
    }));
    expectInvalid(() => validateAnalyticsOperation({ ...trendOperation, datasetId: "" }));
  });

  it("rejects malformed, non-finite, or internally inconsistent results", () => {
    const trend = computeTrendReference(trendOperation, [
      { observedAt: "2026-01-01T00:00:00.000Z", revenue: 1 },
    ]);
    const funnel = computeFunnelReference(funnelOperation, [
      { impressions: 10, clicks: 5, conversions: 1 },
    ]);
    const anomaly = computeAnomalyReference(anomalyOperation, [9, 10, 11, 12, 100]);
    for (const result of [trend, funnel, anomaly]) {
      expect(() => validateAnalyticsResult(result)).not.toThrow();
    }
    expectInvalid(() => validateAnalyticsResult({ ...trend, operation: "other" }));
    expectInvalid(() => validateAnalyticsResult({ ...trend, coverage: Number.NaN }));
    expectInvalid(() => validateAnalyticsResult({ ...trend, coverage: 1.1 }));
    expectInvalid(() => validateAnalyticsResult({ ...trend, status: "unknown" }));
    expectInvalid(() => validateAnalyticsResult({ ...funnel, datasetId: "" }));
    expectInvalid(() => validateAnalyticsResult({
      ...anomaly,
      anomalies: [{ index: -1, value: 100, modifiedZScore: 4 }],
    }));
  });
});

describe("public deterministic analytics formulas", () => {
  it("publishes the exact formulas needed for independent provider recomputation", () => {
    expect(TREND_V1_FORMULA).toMatch(/UTC/i);
    expect(TREND_V1_FORMULA).toMatch(/compensated/i);
    expect(FUNNEL_V1_FORMULA).toMatch(/previous/i);
    expect(FUNNEL_V1_FORMULA).toMatch(/first/i);
    expect(ANOMALY_V1_FORMULA).toContain("0.6745");
    expect(ANOMALY_V1_FORMULA).toContain("3.5");
    expect(ANOMALY_V1_FORMULA).toMatch(/median.*absolute.*deviation|MAD/i);
  });

  it("aggregates UTC daily windows with compensated sums and explicit missing coverage", () => {
    const result = computeTrendReference(trendOperation, [
      { observedAt: "2026-01-04T12:00:00.000Z", revenue: 4 },
      { observedAt: "2026-01-01T23:00:00-01:00", revenue: 1e16 },
      { observedAt: "2026-01-02T01:00:00.000Z", revenue: 1 },
      { observedAt: "2026-01-02T02:00:00.000Z", revenue: 1 },
      { observedAt: "2026-01-02T03:00:00.000Z", revenue: -1e16 },
    ]);

    expect(result).toMatchObject({
      operation: "trend_v1",
      datasetId: "dataset-1",
      status: "ok",
      unknownReason: null,
      missingWindows: ["2026-01-03"],
      coverage: 2 / 3,
    });
    expect(result.points).toEqual([
      { window: "2026-01-02", value: 2, rowCount: 4 },
      { window: "2026-01-03", value: null, rowCount: 0 },
      { window: "2026-01-04", value: 4, rowCount: 1 },
    ]);
  });

  it("uses Monday-start UTC weeks and returns unknown for no rows", () => {
    const operation = {
      ...trendOperation,
      parameters: { ...trendOperation.parameters, grain: "week" },
    } as const;
    expect(computeTrendReference(operation, [
      { observedAt: "2026-01-04T23:59:59.999Z", revenue: 2 },
      { observedAt: "2026-01-05T00:00:00.000Z", revenue: 3 },
    ]).points).toEqual([
      { window: "2025-12-29", value: 2, rowCount: 1 },
      { window: "2026-01-05", value: 3, rowCount: 1 },
    ]);
    expect(computeTrendReference(trendOperation, [])).toEqual({
      operation: "trend_v1",
      datasetId: "dataset-1",
      status: "unknown",
      unknownReason: "NO_VALID_ROWS",
      points: [],
      missingWindows: [],
      coverage: 0,
    });
  });

  it("computes adjacent and first-to-last funnel conversion with compensated totals", () => {
    const result = computeFunnelReference(funnelOperation, [
      { impressions: 60, clicks: 30, conversions: 6 },
      { impressions: "40", clicks: "20", conversions: "4" },
    ]);

    expect(result).toEqual({
      operation: "funnel_v1",
      datasetId: "dataset-1",
      status: "ok",
      stages: [
        { field: "impressions", total: 100, conversionFromPrevious: null, conversionUnknownReason: null },
        { field: "clicks", total: 50, conversionFromPrevious: 0.5, conversionUnknownReason: null },
        { field: "conversions", total: 10, conversionFromPrevious: 0.2, conversionUnknownReason: null },
      ],
      overallConversion: 0.1,
      overallUnknownReason: null,
    });
  });

  it("marks funnel rates unknown instead of dividing by zero", () => {
    const result = computeFunnelReference(funnelOperation, [
      { impressions: 0, clicks: 5, conversions: 1 },
    ]);
    expect(result.stages[1]).toMatchObject({
      conversionFromPrevious: null,
      conversionUnknownReason: "ZERO_DENOMINATOR",
    });
    expect(result).toMatchObject({ overallConversion: null, overallUnknownReason: "ZERO_DENOMINATOR" });
  });

  it("uses the versioned median/MAD modified z-score reference rule", () => {
    const result = computeAnomalyReference(anomalyOperation, [10, 11, 9, 10, 12, 100]);
    expect(result).toMatchObject({
      operation: "anomaly_v1",
      datasetId: "dataset-1",
      status: "ok",
      unknownReason: null,
      median: 10.5,
      mad: 1,
      modifiedZScoreThreshold: 3.5,
      threshold: 3.5 / 0.6745,
    });
    expect(result.anomalies).toEqual([{
      index: 5,
      value: 100,
      modifiedZScore: 0.6745 * (100 - 10.5),
    }]);
  });

  it("returns explicit unknown for insufficient samples and zero MAD", () => {
    expect(computeAnomalyReference(anomalyOperation, [1, 2])).toMatchObject({
      status: "unknown",
      unknownReason: "INSUFFICIENT_SAMPLES",
      median: null,
      mad: null,
      threshold: null,
      anomalies: [],
    });
    expect(computeAnomalyReference(anomalyOperation, [1, 1, 1, 1])).toMatchObject({
      status: "unknown",
      unknownReason: "ZERO_MAD",
      median: 1,
      mad: 0,
      threshold: null,
      anomalies: [],
    });
  });

  it("rejects invalid numeric inputs and never leaks non-finite totals", () => {
    expectInvalid(() => computeTrendReference(trendOperation, [
      { observedAt: "2026-01-01T00:00:00.000Z", revenue: " 1" },
    ]));
    expectInvalid(() => computeTrendReference(trendOperation, [
      { observedAt: "not-a-date", revenue: 1 },
    ]));
    expectInvalid(() => computeFunnelReference(funnelOperation, [
      { impressions: -1, clicks: 0, conversions: 0 },
    ]));
    expectInvalid(() => computeAnomalyReference(anomalyOperation, [1, Number.NaN, 2]));
    expectInvalid(() => computeTrendReference(trendOperation, [
      { observedAt: "2026-01-01T00:00:00.000Z", revenue: 1e308 },
      { observedAt: "2026-01-01T01:00:00.000Z", revenue: 1e308 },
    ]));
  });
});

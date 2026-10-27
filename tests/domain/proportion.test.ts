import { describe, expect, it } from "vitest";
import {
  assessMetricProportion,
  wilsonScore95,
} from "../../src/domain/proportion.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  assessMetricReference,
  computeMetric,
} from "../../src/domain/metric-catalog.js";

function expectInvalid(operation: () => void): void {
  expect(operation).toThrowError(
    expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
  );
}

describe("Wilson 95% score interval", () => {
  it("matches published reference values without normal approximation", () => {
    expect(wilsonScore95(50, 100).lower).toBeCloseTo(0.4038315303659956, 10);
    expect(wilsonScore95(50, 100).upper).toBeCloseTo(0.5961684696340044, 10);
    expect(wilsonScore95(50, 100)).toMatchObject({
      method: "wilson_score",
      confidenceLevel: 0.95,
    });
  });

  it("handles all failures and all successes with bounded asymmetric intervals", () => {
    const zero = wilsonScore95(0, 100);
    expect(zero.lower).toBe(0);
    expect(zero.upper).toBeCloseTo(0.03699349820698568, 10);
    const all = wilsonScore95(100, 100);
    expect(all.lower).toBeCloseTo(0.9630065017930143, 10);
    expect(all.upper).toBe(1);
    for (const result of [zero, all, wilsonScore95(1, 2)]) {
      expect(result.lower).toBeGreaterThanOrEqual(0);
      expect(result.upper).toBeLessThanOrEqual(1);
      expect(result.lower).toBeLessThanOrEqual(result.upper);
    }
  });

  it.each([
    [0, 0],
    [1, 0],
    [-1, 100],
    [101, 100],
    [1.5, 100],
    [1, 100.5],
    [Number.NaN, 100],
    [1, Number.POSITIVE_INFINITY],
    [1, -100],
  ])("rejects invalid count boundary numerator=%s denominator=%s", (numerator, denominator) => {
    expectInvalid(() => wilsonScore95(numerator, denominator));
  });
});

describe("metric proportion applicability", () => {
  it("provides Wilson only for an eligible, sufficient integer proportion", () => {
    const computation = computeMetric("ctr_v1", [{ clicks: 100, impressions: 1000 }]);
    expect(assessMetricProportion("ctr_v1", computation, "owned")).toMatchObject({
      status: "applicable",
      reason: null,
      interval: {
        method: "wilson_score",
        confidenceLevel: 0.95,
      },
    });
    expect(assessMetricProportion("ctr_v1", computation, "owned").assumptions.join(" ")).toMatch(
      /independent.*Bernoulli|iid.*Bernoulli/i,
    );
  });

  it("does not treat composite engagement or interaction composition as binomial proportions", () => {
    for (const [metricId, rows] of [
      ["engagement_rate_v1", [{ likes: 10, saves: 2, comments: 3, impressions: 1000 }]],
      ["save_like_ratio_v1", [{ saves: 10, likes: 100 }]],
    ] as const) {
      expect(assessMetricProportion(metricId, computeMetric(metricId, rows), "owned")).toEqual({
        status: "not_applicable",
        reason: "METRIC_NOT_BINOMIAL_ELIGIBLE",
        interval: null,
        assumptions: [],
      });
    }
  });

  it.each([
    ["NON_INTEGER_COUNTS", computeMetric("ctr_v1", [{ clicks: 1.5, impressions: 1000 }])],
    ["NUMERATOR_EXCEEDS_DENOMINATOR", computeMetric("ctr_v1", [{ clicks: 1001, impressions: 1000 }])],
    ["SAMPLE_BELOW_MINIMUM", computeMetric("ctr_v1", [{ clicks: 1, impressions: 999 }])],
    ["ZERO_DENOMINATOR", computeMetric("ctr_v1", [{ clicks: 0, impressions: 0 }])],
    ["NO_VALID_ROWS", computeMetric("ctr_v1", [])],
  ])("returns not_applicable with %s", (reason, computation) => {
    expect(assessMetricProportion("ctr_v1", computation, "authorized")).toEqual({
      status: "not_applicable",
      reason,
      interval: null,
      assumptions: [],
    });
  });

  it("rejects conversion rates from external_public sources in proportion and reference paths", () => {
    const computation = computeMetric("conversion_rate_v1", [{ conversions: 10, clicks: 100 }]);
    expectInvalid(() => assessMetricProportion("conversion_rate_v1", computation, "external_public"));
    expectInvalid(() => assessMetricReference("conversion_rate_v1", computation, {
      ownership: "external_public",
      stale: false,
    }));
  });

  it("rejects mismatched computations and invalid source ownership", () => {
    const computation = computeMetric("ctr_v1", [{ clicks: 10, impressions: 1000 }]);
    expectInvalid(() => assessMetricProportion("conversion_rate_v1", computation, "owned"));
    expectInvalid(() => assessMetricProportion("ctr_v1", computation, "untrusted" as never));
  });
});

describe("new metric formulas and complete-case aggregation", () => {
  it("computes engagement from likes, saves, and comments over impressions", () => {
    const result = computeMetric("engagement_rate_v1", [
      { likes: 10, saves: 2, comments: 3, impressions: 500 },
      { likes: "5", saves: "1", comments: "2", impressions: "500" },
      { likes: 100, saves: 10, comments: 10, impressions: 500 },
    ]);
    expect(result).toMatchObject({
      metricId: "engagement_rate_v1",
      numerator: 143,
      denominator: 1500,
      value: 143 / 1500,
      includedRowCount: 3,
      excludedRowCount: 0,
    });
    expect(result.formula).toBe("(sum(likes) + sum(saves) + sum(comments)) / sum(impressions)");
  });

  it("requires every engagement component and the denominator for a complete case", () => {
    const result = computeMetric("engagement_rate_v1", [
      { likes: 10, saves: 2, impressions: 1000 },
      { likes: 10, saves: 2, comments: "bad", impressions: 1000 },
      { likes: 10, saves: 2, comments: 3, impressions: 1000 },
    ]);
    expect(result).toMatchObject({ includedRowCount: 1, excludedRowCount: 2, numerator: 15 });
    expect(result.excludedRows).toEqual([
      { rowIndex: 0, reasons: ["MISSING_NUMERATOR"] },
      { rowIndex: 1, reasons: ["INVALID_NUMERATOR"] },
    ]);
  });

  it("computes conversion only from conversions and clicks and preserves zero-denominator unknown", () => {
    expect(computeMetric("conversion_rate_v1", [
      { conversions: 5, clicks: 50 },
      { conversions: "5", clicks: "50" },
    ])).toMatchObject({ numerator: 10, denominator: 100, value: 0.1 });
    expect(computeMetric("conversion_rate_v1", [{ conversions: 1, clicks: 0 }])).toMatchObject({
      status: "unknown",
      unknownReason: "ZERO_DENOMINATOR",
      value: null,
    });
  });
});

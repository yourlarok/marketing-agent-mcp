import { describe, expect, it } from "vitest";
import {
  METRIC_CATALOG,
  REFERENCE_ASSESSMENT_RUBRIC,
  assessMetricReference,
  compensatedSum,
  computeMetric,
  getMetricDefinition,
} from "../../src/domain/metric-catalog.js";
import { DomainError } from "../../src/domain/errors.js";

describe("controlled metric catalog", () => {
  it("declares exact formulas, roles, precision, and monitoring contracts", () => {
    expect(Object.keys(METRIC_CATALOG)).toEqual(["ctr_v1", "save_like_ratio_v1"]);
    expect(METRIC_CATALOG.ctr_v1).toMatchObject({
      id: "ctr_v1",
      version: 1,
      unit: "ratio",
      numeratorField: "clicks",
      denominatorField: "impressions",
      formula: "sum(clicks) / sum(impressions)",
      minimumDenominator: 1000,
      precision: "ieee754_compensated_sum",
    });
    expect(METRIC_CATALOG.ctr_v1.role).toMatch(/impression.*click|exposure.*click/i);
    expect(METRIC_CATALOG.save_like_ratio_v1).toMatchObject({
      numeratorField: "saves",
      denominatorField: "likes",
      formula: "sum(saves) / sum(likes)",
      minimumDenominator: 30,
    });
    expect(METRIC_CATALOG.save_like_ratio_v1.role).toMatch(/engagement|interaction/i);
    expect(METRIC_CATALOG.save_like_ratio_v1.limitations.join(" ")).toMatch(/not a save rate|not.*conversion/i);
    for (const definition of Object.values(METRIC_CATALOG)) {
      expect(definition.monitoring.requiredFields).toEqual([
        definition.numeratorField,
        definition.denominatorField,
      ]);
      expect(definition.monitoring.minimumDenominator).toBe(definition.minimumDenominator);
      expect(definition.monitoring.guardrails.length).toBeGreaterThan(0);
      expect(definition.monitoring.reviewConditions.length).toBeGreaterThan(0);
    }
    expect(() => getMetricDefinition("arbitrary_formula" as never)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
    );
  });

  it.each(["toString", "constructor", "__proto__"])(
    "rejects inherited catalog property %s in lookup and computation",
    (metricId) => {
      for (const operation of [
        () => getMetricDefinition(metricId as never),
        () => computeMetric(metricId as never, []),
      ]) {
        expect(operation).toThrowError(
          expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
        );
      }
    },
  );

  it("states deterministic reference thresholds and downgrade order", () => {
    expect(REFERENCE_ASSESSMENT_RUBRIC).toMatchObject({
      unknownWhen: ["NO_VALID_ROWS", "ZERO_DENOMINATOR", "NON_FINITE_TOTAL"],
      downgradeOrder: [
        "NO_VALID_ROWS",
        "ZERO_DENOMINATOR",
        "NON_FINITE_TOTAL",
        "COMPARABILITY_NOT_COMPARABLE",
        "SAMPLE_BELOW_MINIMUM",
        "STALE_DATA",
        "EXCLUDED_ROWS",
        "EXTERNAL_PUBLIC",
        "COMPARABILITY_NOT_ASSESSED",
      ],
    });
    expect(REFERENCE_ASSESSMENT_RUBRIC.rules.join(" ")).toMatch(/two or more/i);
    expect(REFERENCE_ASSESSMENT_RUBRIC.rules.join(" ")).toMatch(/exactly one/i);
    expect(REFERENCE_ASSESSMENT_RUBRIC.rules.join(" ")).toMatch(/external_public/i);
  });
});

describe("metric calculation", () => {
  it("uses compensated summation without display rounding", () => {
    expect(compensatedSum([1e16, 1, 1, -1e16])).toBe(2);
    const result = computeMetric("ctr_v1", [
      { clicks: 1e16, impressions: 2 },
      { clicks: 1, impressions: 2 },
      { clicks: 1, impressions: 2 },
    ]);

    expect(result.numerator).toBe(10000000000000002);
    expect(result.denominator).toBe(6);
    expect(result.value).toBe(10000000000000002 / 6);
    expect(result.precision).toBe("ieee754_compensated_sum");
  });

  it("uses two-field complete-case rows and records every exclusion reason", () => {
    const result = computeMetric("save_like_ratio_v1", [
      { saves: 2, likes: 4 },
      { saves: 1 },
      { saves: Number.NaN, likes: 5 },
      { saves: 1, likes: Number.POSITIVE_INFINITY },
      { saves: -1, likes: 5 },
      { saves: 1, likes: -5 },
      { saves: "1", likes: 5 },
      { saves: 1, likes: null },
      { saves: 0, likes: 2 },
    ]);

    expect(result).toMatchObject({
      status: "ok",
      numerator: 3,
      denominator: 11,
      value: 3 / 11,
      includedRowCount: 3,
      excludedRowCount: 6,
      totalRowCount: 9,
    });
    expect(result.excludedRows).toEqual([
      { rowIndex: 1, reasons: ["MISSING_DENOMINATOR"] },
      { rowIndex: 2, reasons: ["INVALID_NUMERATOR"] },
      { rowIndex: 3, reasons: ["INVALID_DENOMINATOR"] },
      { rowIndex: 4, reasons: ["INVALID_NUMERATOR"] },
      { rowIndex: 5, reasons: ["INVALID_DENOMINATOR"] },
      { rowIndex: 7, reasons: ["MISSING_DENOMINATOR"] },
    ]);
  });

  it("excludes a row when both fields are invalid instead of treating them as zero", () => {
    const result = computeMetric("ctr_v1", [{ clicks: -1, impressions: Number.NaN }]);
    expect(result).toMatchObject({
      status: "unknown",
      value: null,
      numerator: 0,
      denominator: 0,
      includedRowCount: 0,
      excludedRowCount: 1,
      unknownReason: "NO_VALID_ROWS",
    });
    expect(result.excludedRows).toEqual([{
      rowIndex: 0,
      reasons: ["INVALID_NUMERATOR", "INVALID_DENOMINATOR"],
    }]);
  });

  it("normalizes only complete decimal or scientific numeric strings with declared IEEE-754 semantics", () => {
    expect(computeMetric("ctr_v1", [{ clicks: "1e2", impressions: "1.0e3" }])).toMatchObject({
      status: "ok",
      numerator: 100,
      denominator: 1000,
      value: 0.1,
      numericInputNormalization: "strict_decimal_scientific_to_ieee754",
      precision: "ieee754_compensated_sum",
    });
    for (const value of ["NaN", "Infinity", "0x64", "100 clicks", " 100", "100 ", "1e400", ""]) {
      expect(computeMetric("ctr_v1", [{ clicks: value, impressions: 1000 }])).toMatchObject({
        status: "unknown",
        includedRowCount: 0,
        excludedRowCount: 1,
        numerator: 0,
      });
    }
  });

  it("returns unknown for empty data and zero denominators, never zero or infinity", () => {
    expect(computeMetric("ctr_v1", [])).toMatchObject({
      status: "unknown",
      value: null,
      unknownReason: "NO_VALID_ROWS",
      includedRowCount: 0,
      excludedRowCount: 0,
    });
    expect(computeMetric("ctr_v1", [
      { clicks: 5, impressions: 0 },
      { clicks: 0, impressions: 0 },
    ])).toMatchObject({
      status: "unknown",
      value: null,
      numerator: 5,
      denominator: 0,
      unknownReason: "ZERO_DENOMINATOR",
      includedRowCount: 2,
    });
  });

  it("does not expose non-finite totals if finite inputs overflow", () => {
    const result = computeMetric("ctr_v1", [
      { clicks: 1, impressions: 1e308 },
      { clicks: 1, impressions: 1e308 },
    ]);
    expect(result).toMatchObject({
      status: "unknown",
      value: null,
      denominator: null,
      unknownReason: "NON_FINITE_TOTAL",
    });
    expect(JSON.stringify(result)).not.toContain("Infinity");
  });
});

describe("deterministic reference assessment", () => {
  const calculated = computeMetric("ctr_v1", [{ clicks: 100, impressions: 1000 }]);

  it("allows high only for owned or authorized, fresh, sufficient, complete, comparable data", () => {
    for (const ownership of ["owned", "authorized"] as const) {
      const result = assessMetricReference("ctr_v1", calculated, {
        ownership,
        stale: false,
        comparability: "comparable",
      });
      expect(result).toMatchObject({
        level: "high",
        reasons: [],
        dimensions: {
          provenance: ownership,
          freshness: "fresh",
          comparability: "comparable",
        },
      });
      expect(result.dimensions.sample).toMatchObject({
        status: "sufficient",
        denominator: 1000,
        minimumDenominator: 1000,
      });
      expect(result.dimensions.missingness).toMatchObject({
        status: "complete",
        includedRowCount: 1,
        excludedRowCount: 0,
      });
    }
  });

  it.each([
    ["ownership", { ownership: "untrusted", stale: false, comparability: "comparable" }],
    ["comparability", { ownership: "owned", stale: false, comparability: "similar" }],
    ["null comparability", { ownership: "owned", stale: false, comparability: null }],
    ["string stale", { ownership: "owned", stale: "false", comparability: "comparable" }],
    ["numeric stale", { ownership: "owned", stale: 0, comparability: "comparable" }],
  ])("rejects invalid runtime reference input: %s", (_name, input) => {
    expect(() => assessMetricReference("ctr_v1", calculated, input as never)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
    );
  });

  it("rejects a computation whose metric ID differs from the requested definition", () => {
    const mismatched = computeMetric("save_like_ratio_v1", [{ saves: 10, likes: 100 }]);
    expect(() => assessMetricReference("ctr_v1", mismatched, {
      ownership: "owned",
      stale: false,
      comparability: "comparable",
    })).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }));
  });

  it("marks comparability not_assessed by default and caps otherwise high data at medium", () => {
    const result = assessMetricReference("ctr_v1", calculated, {
      ownership: "owned",
      stale: false,
    });
    expect(result.level).toBe("medium");
    expect(result.dimensions.comparability).toBe("not_assessed");
    expect(result.reasons.map((reason) => reason.code)).toEqual(["COMPARABILITY_NOT_ASSESSED"]);
    expect(result.reasons[0]!.message.length).toBeGreaterThan(0);
  });

  it.each([
    ["sample", { impressions: 999, clicks: 100 }, "SAMPLE_BELOW_MINIMUM"],
    ["stale", { impressions: 1000, clicks: 100 }, "STALE_DATA"],
    ["exclusions", { impressions: 1000, clicks: 100, extra: true }, "EXCLUDED_ROWS"],
  ])("downgrades exactly one owned-data quality issue to medium: %s", (_name, row, reasonCode) => {
    const value = reasonCode === "EXCLUDED_ROWS"
      ? computeMetric("ctr_v1", [row, { clicks: -1, impressions: 10 }])
      : computeMetric("ctr_v1", [row]);
    const result = assessMetricReference("ctr_v1", value, {
      ownership: "owned",
      stale: reasonCode === "STALE_DATA",
      comparability: "comparable",
    });
    expect(result.level).toBe("medium");
    expect(result.reasons.map((reason) => reason.code)).toContain(reasonCode);
  });

  it("downgrades two or more sample, freshness, or exclusion issues to low", () => {
    const value = computeMetric("ctr_v1", [
      { clicks: 10, impressions: 999 },
      { clicks: -1, impressions: 10 },
    ]);
    const result = assessMetricReference("ctr_v1", value, {
      ownership: "authorized",
      stale: true,
      comparability: "comparable",
    });
    expect(result.level).toBe("low");
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "SAMPLE_BELOW_MINIMUM",
      "STALE_DATA",
      "EXCLUDED_ROWS",
    ]);
  });

  it("caps clean external public data at medium and downgrades one issue to low", () => {
    expect(assessMetricReference("ctr_v1", calculated, {
      ownership: "external_public",
      stale: false,
      comparability: "comparable",
    })).toMatchObject({ level: "medium" });
    expect(assessMetricReference("ctr_v1", calculated, {
      ownership: "external_public",
      stale: true,
      comparability: "comparable",
    })).toMatchObject({ level: "low" });
  });

  it("always downgrades failed comparability to low", () => {
    const result = assessMetricReference("ctr_v1", calculated, {
      ownership: "owned",
      stale: false,
      comparability: "not_comparable",
    });
    expect(result.level).toBe("low");
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "COMPARABILITY_NOT_COMPARABLE",
    ]);
  });

  it("returns unknown without inventing probabilities for unusable values", () => {
    const unknown = computeMetric("ctr_v1", [{ clicks: 0, impressions: 0 }]);
    const result = assessMetricReference("ctr_v1", unknown, {
      ownership: "external_public",
      stale: true,
    });
    expect(result).toMatchObject({
      level: "unknown",
      dimensions: { comparability: "not_assessed" },
    });
    expect(result.reasons.map((reason) => reason.code)).toEqual(["ZERO_DENOMINATOR"]);
    expect(result).not.toHaveProperty("probability");
    expect(result).not.toHaveProperty("confidence");
  });
});

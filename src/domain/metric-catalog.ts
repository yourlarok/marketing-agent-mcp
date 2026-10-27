import type { SourceOwnership } from "./model.js";
import { DomainError } from "./errors.js";

export const METRIC_IDS = ["ctr_v1", "save_like_ratio_v1"] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export interface MetricMonitoringDefinition {
  requiredFields: readonly string[];
  minimumDenominator: number;
  guardrails: readonly string[];
  reviewConditions: readonly string[];
}

export interface MetricDefinition {
  id: MetricId;
  version: 1;
  unit: "ratio";
  role: string;
  limitations: readonly string[];
  numeratorField: string;
  denominatorField: string;
  formula: string;
  minimumDenominator: number;
  precision: "ieee754_compensated_sum";
  monitoring: MetricMonitoringDefinition;
}

export const METRIC_CATALOG: Readonly<Record<MetricId, MetricDefinition>> = {
  ctr_v1: {
    id: "ctr_v1",
    version: 1,
    unit: "ratio",
    role: "Process efficiency from impressions to clicks.",
    limitations: ["Does not measure conversion or establish causation."],
    numeratorField: "clicks",
    denominatorField: "impressions",
    formula: "sum(clicks) / sum(impressions)",
    minimumDenominator: 1000,
    precision: "ieee754_compensated_sum",
    monitoring: {
      requiredFields: ["clicks", "impressions"],
      minimumDenominator: 1000,
      guardrails: [
        "Compare the same definition and comparable placements or audiences.",
        "A zero denominator or unknown baseline or current value cannot produce a delta.",
      ],
      reviewConditions: [
        "Review when the denominator crosses the minimum threshold.",
        "Review changes in exclusions, freshness, provenance, or comparability alongside value changes.",
      ],
    },
  },
  save_like_ratio_v1: {
    id: "save_like_ratio_v1",
    version: 1,
    unit: "ratio",
    role: "Composition of interactions: saves relative to likes.",
    limitations: [
      "This is not a save rate or a conversion rate.",
      "Public interaction composition does not establish CTR, conversion, or causation.",
    ],
    numeratorField: "saves",
    denominatorField: "likes",
    formula: "sum(saves) / sum(likes)",
    minimumDenominator: 30,
    precision: "ieee754_compensated_sum",
    monitoring: {
      requiredFields: ["saves", "likes"],
      minimumDenominator: 30,
      guardrails: [
        "Compare the same definition and comparable content or audiences.",
        "Do not interpret interaction composition as conversion performance.",
      ],
      reviewConditions: [
        "Review when likes cross the minimum denominator threshold.",
        "Review changes in exclusions, freshness, provenance, or comparability alongside value changes.",
      ],
    },
  },
};

export const REFERENCE_REASON_CODES = [
  "NO_VALID_ROWS",
  "ZERO_DENOMINATOR",
  "NON_FINITE_TOTAL",
  "COMPARABILITY_NOT_COMPARABLE",
  "SAMPLE_BELOW_MINIMUM",
  "STALE_DATA",
  "EXCLUDED_ROWS",
  "EXTERNAL_PUBLIC",
  "COMPARABILITY_NOT_ASSESSED",
] as const;
export type ReferenceReasonCode = (typeof REFERENCE_REASON_CODES)[number];

export const REFERENCE_ASSESSMENT_RUBRIC = {
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
  rules: [
    "Unknown computation status always produces unknown reference.",
    "Failed comparability always produces low reference.",
    "Two or more of sample below minimum, stale data, and excluded rows produce low reference.",
    "Exactly one of those issues produces medium for owned or authorized data and low for external_public data.",
    "Without those issues, external_public is capped at medium.",
    "Without those issues, owned or authorized data is high only when comparability is comparable; not_assessed comparability caps it at medium.",
  ],
} as const;

const REFERENCE_REASON_MESSAGES: Readonly<Record<ReferenceReasonCode, string>> = {
  NO_VALID_ROWS: "No rows contain finite, non-negative numerator and denominator values.",
  ZERO_DENOMINATOR: "The included denominator sums to zero.",
  NON_FINITE_TOTAL: "The compensated total exceeds finite numeric range.",
  COMPARABILITY_NOT_COMPARABLE: "A comparable benchmark check found the inputs not comparable.",
  SAMPLE_BELOW_MINIMUM: "The denominator is below this metric's minimum threshold.",
  STALE_DATA: "The evidence is stale.",
  EXCLUDED_ROWS: "One or more rows were excluded by complete-case validation.",
  EXTERNAL_PUBLIC: "External public evidence is capped below high reference.",
  COMPARABILITY_NOT_ASSESSED: "Comparable-benchmark assessment has not been performed.",
};

export type MetricRow = Readonly<Record<string, unknown>>;
export type MetricComputationStatus = "ok" | "unknown";
export type MetricUnknownReason = "NO_VALID_ROWS" | "ZERO_DENOMINATOR" | "NON_FINITE_TOTAL";
export type MetricExclusionReason =
  | "MISSING_NUMERATOR"
  | "INVALID_NUMERATOR"
  | "MISSING_DENOMINATOR"
  | "INVALID_DENOMINATOR";

export interface MetricExcludedRow {
  rowIndex: number;
  reasons: MetricExclusionReason[];
}

export interface MetricComputation {
  metricId: MetricId;
  definitionVersion: number;
  formula: string;
  unit: "ratio";
  status: MetricComputationStatus;
  numerator: number | null;
  denominator: number | null;
  value: number | null;
  unknownReason: MetricUnknownReason | null;
  precision: "ieee754_compensated_sum";
  totalRowCount: number;
  includedRowCount: number;
  excludedRowCount: number;
  excludedRows: MetricExcludedRow[];
}

export type ReferenceLevel = "high" | "medium" | "low" | "unknown";
export type ReferenceComparability = "not_assessed" | "comparable" | "not_comparable";

export interface ReferenceReason {
  code: ReferenceReasonCode;
  message: string;
}

export interface ReferenceAssessment {
  level: ReferenceLevel;
  reasons: ReferenceReason[];
  dimensions: {
    provenance: SourceOwnership;
    freshness: "fresh" | "stale";
    sample: {
      status: "unknown" | "sufficient" | "below_minimum";
      denominator: number | null;
      minimumDenominator: number;
    };
    missingness: {
      status: "unknown" | "complete" | "excluded_rows";
      includedRowCount: number;
      excludedRowCount: number;
    };
    comparability: ReferenceComparability;
  };
}

export interface ReferenceAssessmentInput {
  ownership: SourceOwnership;
  stale: boolean;
  comparability?: ReferenceComparability;
}

export function getMetricDefinition(metricId: MetricId): MetricDefinition {
  const definition = METRIC_CATALOG[metricId];
  if (definition === undefined) {
    throw new DomainError("INVALID_INPUT", `Unknown controlled metric: ${String(metricId)}`);
  }
  return definition;
}

export function compensatedSum(values: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const next = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    sum = next;
  }
  return sum + compensation;
}

function exclusionReason(value: unknown, field: "NUMERATOR" | "DENOMINATOR"): MetricExclusionReason | null {
  if (value === undefined || value === null || value === "") {
    return `MISSING_${field}`;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return `INVALID_${field}`;
  }
  return null;
}

export function computeMetric(metricId: MetricId, rows: readonly MetricRow[]): MetricComputation {
  const definition = getMetricDefinition(metricId);
  const numerators: number[] = [];
  const denominators: number[] = [];
  const excludedRows: MetricExcludedRow[] = [];
  rows.forEach((row, rowIndex) => {
    const numeratorReason = exclusionReason(row[definition.numeratorField], "NUMERATOR");
    const denominatorReason = exclusionReason(row[definition.denominatorField], "DENOMINATOR");
    const reasons = [numeratorReason, denominatorReason].filter(
      (reason): reason is MetricExclusionReason => reason !== null,
    );
    if (reasons.length > 0) {
      excludedRows.push({ rowIndex, reasons });
      return;
    }
    numerators.push(row[definition.numeratorField] as number);
    denominators.push(row[definition.denominatorField] as number);
  });

  const numeratorTotal = compensatedSum(numerators);
  const denominatorTotal = compensatedSum(denominators);
  let status: MetricComputationStatus = "ok";
  let unknownReason: MetricUnknownReason | null = null;
  let value: number | null = null;
  if (numerators.length === 0) {
    status = "unknown";
    unknownReason = "NO_VALID_ROWS";
  } else if (denominatorTotal === 0) {
    status = "unknown";
    unknownReason = "ZERO_DENOMINATOR";
  } else if (!Number.isFinite(numeratorTotal) || !Number.isFinite(denominatorTotal)) {
    status = "unknown";
    unknownReason = "NON_FINITE_TOTAL";
  } else {
    value = numeratorTotal / denominatorTotal;
    if (!Number.isFinite(value)) {
      status = "unknown";
      unknownReason = "NON_FINITE_TOTAL";
      value = null;
    }
  }

  return {
    metricId,
    definitionVersion: definition.version,
    formula: definition.formula,
    unit: definition.unit,
    status,
    numerator: Number.isFinite(numeratorTotal) ? numeratorTotal : null,
    denominator: Number.isFinite(denominatorTotal) ? denominatorTotal : null,
    value,
    unknownReason,
    precision: definition.precision,
    totalRowCount: rows.length,
    includedRowCount: numerators.length,
    excludedRowCount: excludedRows.length,
    excludedRows,
  };
}

export function assessMetricReference(
  metricId: MetricId,
  computation: MetricComputation,
  input: ReferenceAssessmentInput,
): ReferenceAssessment {
  const definition = getMetricDefinition(metricId);
  const comparability = input.comparability ?? "not_assessed";
  const reasons: ReferenceReason[] = [];
  const addReason = (code: ReferenceReasonCode): void => {
    reasons.push({ code, message: REFERENCE_REASON_MESSAGES[code] });
  };

  if (computation.status === "unknown") {
    addReason(computation.unknownReason ?? "NO_VALID_ROWS");
  } else {
    const belowMinimum = computation.denominator === null || computation.denominator < definition.minimumDenominator;
    const qualityIssueCount = Number(belowMinimum) + Number(input.stale) + Number(computation.excludedRowCount > 0);
    if (comparability === "not_comparable") {
      addReason("COMPARABILITY_NOT_COMPARABLE");
    }
    if (belowMinimum) addReason("SAMPLE_BELOW_MINIMUM");
    if (input.stale) addReason("STALE_DATA");
    if (computation.excludedRowCount > 0) addReason("EXCLUDED_ROWS");
    if (input.ownership === "external_public") addReason("EXTERNAL_PUBLIC");
    if (comparability === "not_assessed") addReason("COMPARABILITY_NOT_ASSESSED");

    let level: Exclude<ReferenceLevel, "unknown">;
    if (comparability === "not_comparable" || qualityIssueCount >= 2) {
      level = "low";
    } else if (qualityIssueCount === 1) {
      level = input.ownership === "external_public" ? "low" : "medium";
    } else if (input.ownership === "external_public" || comparability === "not_assessed") {
      level = "medium";
    } else {
      level = "high";
    }
    return referenceAssessment(level, reasons, computation, input, comparability, definition);
  }

  return referenceAssessment("unknown", reasons, computation, input, comparability, definition);
}

function referenceAssessment(
  level: ReferenceLevel,
  reasons: ReferenceReason[],
  computation: MetricComputation,
  input: ReferenceAssessmentInput,
  comparability: ReferenceComparability,
  definition: MetricDefinition,
): ReferenceAssessment {
  const denominator = computation.denominator;
  return {
    level,
    reasons,
    dimensions: {
      provenance: input.ownership,
      freshness: input.stale ? "stale" : "fresh",
      sample: {
        status: denominator === null || denominator === 0
          ? "unknown"
          : denominator < definition.minimumDenominator ? "below_minimum" : "sufficient",
        denominator,
        minimumDenominator: definition.minimumDenominator,
      },
      missingness: {
        status: computation.includedRowCount === 0
          ? "unknown"
          : computation.excludedRowCount > 0 ? "excluded_rows" : "complete",
        includedRowCount: computation.includedRowCount,
        excludedRowCount: computation.excludedRowCount,
      },
      comparability,
    },
  };
}

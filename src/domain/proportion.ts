import { DomainError } from "./errors.js";
import {
  getMetricDefinition,
  type MetricComputation,
  type MetricId,
} from "./metric-catalog.js";
import { SOURCE_OWNERSHIPS, type SourceOwnership } from "./model.js";

export const WILSON_95_Z = 1.959963984540054;

export interface WilsonInterval {
  lower: number;
  upper: number;
  method: "wilson_score";
  confidenceLevel: 0.95;
}

export type ProportionNotApplicableReason =
  | "METRIC_NOT_BINOMIAL_ELIGIBLE"
  | "NO_VALID_ROWS"
  | "ZERO_DENOMINATOR"
  | "NON_FINITE_TOTAL"
  | "NON_INTEGER_COUNTS"
  | "NUMERATOR_EXCEEDS_DENOMINATOR"
  | "SAMPLE_BELOW_MINIMUM";

export interface ProportionAssessment {
  status: "applicable" | "not_applicable";
  reason: ProportionNotApplicableReason | null;
  interval: WilsonInterval | null;
  assumptions: string[];
}

export const BINOMIAL_PROPORTION_ASSUMPTIONS = [
  "Numerator and denominator are counts from independent and identically distributed Bernoulli trials.",
  "The interval describes sampling uncertainty for this proportion only; it is not a probability of marketing lift or a causal interval.",
] as const;

export function wilsonScore95(numerator: number, denominator: number): WilsonInterval {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) ||
      numerator < 0 || denominator <= 0 || numerator > denominator) {
    throw new DomainError(
      "INVALID_INPUT",
      "Wilson interval requires non-negative safe-integer counts with 0 <= numerator <= denominator and denominator > 0",
    );
  }
  const proportion = numerator / denominator;
  const zSquared = WILSON_95_Z * WILSON_95_Z;
  const scale = 1 + zSquared / denominator;
  const center = (proportion + zSquared / (2 * denominator)) / scale;
  const margin = WILSON_95_Z * Math.sqrt(
    proportion * (1 - proportion) / denominator + zSquared / (4 * denominator * denominator),
  ) / scale;
  return {
    lower: numerator === 0 ? 0 : Math.max(0, center - margin),
    upper: numerator === denominator ? 1 : Math.min(1, center + margin),
    method: "wilson_score",
    confidenceLevel: 0.95,
  };
}

function notApplicable(reason: ProportionNotApplicableReason): ProportionAssessment {
  return { status: "not_applicable", reason, interval: null, assumptions: [] };
}

export function assessMetricProportion(
  metricId: MetricId,
  computation: MetricComputation,
  ownership: SourceOwnership,
): ProportionAssessment {
  const definition = getMetricDefinition(metricId);
  if (computation.metricId !== metricId) {
    throw new DomainError("INVALID_INPUT", "Metric computation and requested definition must match");
  }
  if (!SOURCE_OWNERSHIPS.includes(ownership)) {
    throw new DomainError("INVALID_INPUT", `Invalid source ownership: ${String(ownership)}`);
  }
  if (metricId === "conversion_rate_v1" && ownership === "external_public") {
    throw new DomainError(
      "INVALID_INPUT",
      "conversion_rate_v1 requires owned or authorized source data; external_public conversion is not permitted",
    );
  }
  if (!definition.binomialEligible) return notApplicable("METRIC_NOT_BINOMIAL_ELIGIBLE");
  if (computation.status === "unknown") {
    return notApplicable(computation.unknownReason ?? "NO_VALID_ROWS");
  }
  const numerator = computation.numerator;
  const denominator = computation.denominator;
  if (numerator === null || denominator === null) return notApplicable("NON_FINITE_TOTAL");
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    return notApplicable("NON_INTEGER_COUNTS");
  }
  if (numerator > denominator) return notApplicable("NUMERATOR_EXCEEDS_DENOMINATOR");
  if (denominator < definition.minimumDenominator) return notApplicable("SAMPLE_BELOW_MINIMUM");
  return {
    status: "applicable",
    reason: null,
    interval: wilsonScore95(numerator, denominator),
    assumptions: [...BINOMIAL_PROPORTION_ASSUMPTIONS],
  };
}

import {
  assertIdentifier,
  assertRecord,
  assertStableId,
  assertUtcInstant,
  invalid,
} from "./contract-validation.js";
import { compensatedSum } from "./metric-catalog.js";

export const ANALYTICS_OPERATIONS = ["trend_v1", "funnel_v1", "anomaly_v1"] as const;
export type AnalyticsOperationKind = (typeof ANALYTICS_OPERATIONS)[number];

export const TREND_V1_FORMULA =
  "Bucket rows by UTC calendar day or Monday-start UTC week; sum each numeric field with ieee754 compensated summation; emit every window from first through last, null for missing windows, and coverage = observed windows / emitted windows.";
export const FUNNEL_V1_FORMULA =
  "Sum each ordered stage with ieee754 compensated summation; conversionFromPrevious = current stage total / previous stage total; overallConversion = last stage total / first stage total; a zero denominator is unknown.";
export const ANOMALY_V1_FORMULA =
  "modifiedZScore = 0.6745 * (value - median) / MAD, where MAD = median absolute deviation from the median; flag absolute modifiedZScore > 3.5, equivalently absolute value deviation > 3.5 * MAD / 0.6745; fewer than 3 samples or zero MAD is unknown.";

export interface TrendAnalyticsOperation {
  operation: "trend_v1";
  datasetId: string;
  parameters: {
    timeField: string;
    valueField: string;
    grain: "day" | "week";
  };
}

export interface FunnelAnalyticsOperation {
  operation: "funnel_v1";
  datasetId: string;
  parameters: {
    stageFields: string[];
  };
}

export interface AnomalyAnalyticsOperation {
  operation: "anomaly_v1";
  datasetId: string;
  parameters: {
    valueField: string;
  };
}

export type AnalyticsOperation =
  | TrendAnalyticsOperation
  | FunnelAnalyticsOperation
  | AnomalyAnalyticsOperation;

export interface TrendPoint {
  window: string;
  value: number | null;
  rowCount: number;
}

export interface TrendAnalyticsResult {
  operation: "trend_v1";
  datasetId: string;
  status: "ok" | "unknown";
  unknownReason: "NO_VALID_ROWS" | null;
  points: TrendPoint[];
  missingWindows: string[];
  coverage: number;
}

export interface FunnelStageResult {
  field: string;
  total: number;
  conversionFromPrevious: number | null;
  conversionUnknownReason: "ZERO_DENOMINATOR" | null;
}

export interface FunnelAnalyticsResult {
  operation: "funnel_v1";
  datasetId: string;
  status: "ok";
  stages: FunnelStageResult[];
  overallConversion: number | null;
  overallUnknownReason: "ZERO_DENOMINATOR" | null;
}

export interface AnomalyPoint {
  index: number;
  value: number;
  modifiedZScore: number;
}

export interface AnomalyAnalyticsResult {
  operation: "anomaly_v1";
  datasetId: string;
  status: "ok" | "unknown";
  unknownReason: "INSUFFICIENT_SAMPLES" | "ZERO_MAD" | null;
  median: number | null;
  mad: number | null;
  modifiedZScoreThreshold: 3.5;
  threshold: number | null;
  anomalies: AnomalyPoint[];
}

export type AnalyticsResult =
  | TrendAnalyticsResult
  | FunnelAnalyticsResult
  | AnomalyAnalyticsResult;

export type AnalyticsRow = Readonly<Record<string, unknown>>;

function assertFiniteNumber(value: unknown, label: string, nonNegative = false): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || (nonNegative && value < 0)) {
    invalid(`${label} must be a finite${nonNegative ? " non-negative" : ""} number`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) invalid(`${label} must be a non-negative integer`);
}

function assertWindow(value: unknown, label = "Analytics window"): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ||
      new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    invalid(`${label} must be a valid UTC calendar day`);
  }
}

function assertCommonOperation(value: unknown): asserts value is Record<string, unknown> {
  assertRecord(value, "Analytics operation", ["operation", "datasetId", "parameters"]);
  if (!(ANALYTICS_OPERATIONS as readonly string[]).includes(value.operation as string)) {
    invalid("Unsupported analytics operation");
  }
  assertStableId(value.datasetId, "Analytics datasetId");
}

export function validateAnalyticsOperation(value: unknown): asserts value is AnalyticsOperation {
  assertCommonOperation(value);
  if (value.operation === "trend_v1") {
    assertRecord(value.parameters, "Trend parameters", ["timeField", "valueField", "grain"]);
    assertIdentifier(value.parameters.timeField, "Trend timeField");
    assertIdentifier(value.parameters.valueField, "Trend valueField");
    if (value.parameters.grain !== "day" && value.parameters.grain !== "week") {
      invalid("Trend grain must be day or week");
    }
    return;
  }
  if (value.operation === "funnel_v1") {
    assertRecord(value.parameters, "Funnel parameters", ["stageFields"]);
    const fields = value.parameters.stageFields;
    if (!Array.isArray(fields) || fields.length < 2 || fields.length > 500) {
      invalid("Funnel stageFields must contain between 2 and 500 stages");
    }
    for (const field of fields) assertIdentifier(field, "Funnel stage field");
    if (new Set(fields).size !== fields.length) invalid("Funnel stageFields must be unique and ordered");
    return;
  }
  assertRecord(value.parameters, "Anomaly parameters", ["valueField"]);
  assertIdentifier(value.parameters.valueField, "Anomaly valueField");
}

function assertCommonResult(value: unknown): asserts value is Record<string, unknown> {
  assertRecord(value, "Analytics result");
  if (!(ANALYTICS_OPERATIONS as readonly string[]).includes(value.operation as string)) {
    invalid("Unsupported analytics result operation");
  }
  assertStableId(value.datasetId, "Analytics result datasetId");
}

function validateTrendResult(value: Record<string, unknown>): void {
  assertRecord(value, "Trend result", [
    "operation",
    "datasetId",
    "status",
    "unknownReason",
    "points",
    "missingWindows",
    "coverage",
  ]);
  if (value.status !== "ok" && value.status !== "unknown") invalid("Invalid trend status");
  if (value.unknownReason !== null && value.unknownReason !== "NO_VALID_ROWS") {
    invalid("Invalid trend unknownReason");
  }
  if ((value.status === "ok") !== (value.unknownReason === null)) {
    invalid("Trend status and unknownReason are inconsistent");
  }
  if (!Array.isArray(value.points)) invalid("Trend points must be an array");
  for (const point of value.points) {
    assertRecord(point, "Trend point", ["window", "value", "rowCount"]);
    assertWindow(point.window);
    if (point.value !== null) assertFiniteNumber(point.value, "Trend point value");
    assertNonNegativeInteger(point.rowCount, "Trend point rowCount");
    if ((point.value === null) !== (point.rowCount === 0)) {
      invalid("Trend missing points must have null value and zero rows");
    }
  }
  if (!Array.isArray(value.missingWindows)) invalid("Trend missingWindows must be an array");
  for (const window of value.missingWindows) assertWindow(window, "Trend missing window");
  assertFiniteNumber(value.coverage, "Trend coverage");
  if (value.coverage < 0 || value.coverage > 1) invalid("Trend coverage must be between zero and one");
  if (value.status === "unknown") {
    if (value.points.length !== 0 || value.missingWindows.length !== 0 || value.coverage !== 0) {
      invalid("Unknown trend results must not contain computed points, missing windows, or coverage");
    }
  } else if (value.points.length === 0 || value.coverage === 0) {
    invalid("Successful trend results require points and positive coverage");
  }
}

function validateFunnelResult(value: Record<string, unknown>): void {
  assertRecord(value, "Funnel result", [
    "operation",
    "datasetId",
    "status",
    "stages",
    "overallConversion",
    "overallUnknownReason",
  ]);
  if (value.status !== "ok") invalid("Invalid funnel status");
  if (!Array.isArray(value.stages) || value.stages.length < 2) invalid("Funnel stages must be an array");
  for (const [index, stage] of value.stages.entries()) {
    assertRecord(stage, "Funnel stage", [
      "field",
      "total",
      "conversionFromPrevious",
      "conversionUnknownReason",
    ]);
    assertIdentifier(stage.field, "Funnel result field");
    assertFiniteNumber(stage.total, "Funnel total", true);
    if (stage.conversionFromPrevious !== null) {
      assertFiniteNumber(stage.conversionFromPrevious, "Funnel conversion", true);
    }
    if (stage.conversionUnknownReason !== null && stage.conversionUnknownReason !== "ZERO_DENOMINATOR") {
      invalid("Invalid funnel conversion unknownReason");
    }
    if (index === 0) {
      if (stage.conversionFromPrevious !== null || stage.conversionUnknownReason !== null) {
        invalid("The first funnel stage must not have a previous-stage conversion");
      }
    } else if ((stage.conversionFromPrevious === null) !==
        (stage.conversionUnknownReason === "ZERO_DENOMINATOR")) {
      invalid("Funnel conversion and unknownReason are inconsistent");
    }
  }
  if (value.overallConversion !== null) assertFiniteNumber(value.overallConversion, "Funnel overallConversion", true);
  if (value.overallUnknownReason !== null && value.overallUnknownReason !== "ZERO_DENOMINATOR") {
    invalid("Invalid funnel overallUnknownReason");
  }
  if ((value.overallConversion === null) !== (value.overallUnknownReason === "ZERO_DENOMINATOR")) {
    invalid("Funnel overallConversion and overallUnknownReason are inconsistent");
  }
}

function validateAnomalyResult(value: Record<string, unknown>): void {
  assertRecord(value, "Anomaly result", [
    "operation",
    "datasetId",
    "status",
    "unknownReason",
    "median",
    "mad",
    "modifiedZScoreThreshold",
    "threshold",
    "anomalies",
  ]);
  if (value.status !== "ok" && value.status !== "unknown") invalid("Invalid anomaly status");
  if (![null, "INSUFFICIENT_SAMPLES", "ZERO_MAD"].includes(value.unknownReason as string | null)) {
    invalid("Invalid anomaly unknownReason");
  }
  if ((value.status === "ok") !== (value.unknownReason === null)) {
    invalid("Anomaly status and unknownReason are inconsistent");
  }
  if (value.median !== null) assertFiniteNumber(value.median, "Anomaly median");
  if (value.mad !== null) assertFiniteNumber(value.mad, "Anomaly MAD", true);
  if (value.modifiedZScoreThreshold !== 3.5) invalid("Anomaly modified z-score threshold must be 3.5");
  if (value.threshold !== null) assertFiniteNumber(value.threshold, "Anomaly threshold", true);
  if (!Array.isArray(value.anomalies)) invalid("Anomaly anomalies must be an array");
  for (const anomaly of value.anomalies) {
    assertRecord(anomaly, "Anomaly point", ["index", "value", "modifiedZScore"]);
    assertNonNegativeInteger(anomaly.index, "Anomaly index");
    assertFiniteNumber(anomaly.value, "Anomaly value");
    assertFiniteNumber(anomaly.modifiedZScore, "Anomaly modifiedZScore");
  }
  if (value.status === "unknown") {
    if (value.threshold !== null || value.anomalies.length !== 0) {
      invalid("Unknown anomaly results must not contain a threshold or anomalies");
    }
    if (value.unknownReason === "INSUFFICIENT_SAMPLES" &&
        (value.median !== null || value.mad !== null)) {
      invalid("Insufficient anomaly samples must not contain median or MAD");
    }
    if (value.unknownReason === "ZERO_MAD" && (value.median === null || value.mad !== 0)) {
      invalid("Zero-MAD anomaly results require a median and zero MAD");
    }
  } else if (value.median === null || value.mad === null || value.mad <= 0 ||
      value.threshold === null || value.threshold <= 0) {
    invalid("Successful anomaly results require median, positive MAD, and a positive threshold");
  }
}

export function validateAnalyticsResult(value: unknown): asserts value is AnalyticsResult {
  assertCommonResult(value);
  if (value.operation === "trend_v1") validateTrendResult(value);
  else if (value.operation === "funnel_v1") validateFunnelResult(value);
  else validateAnomalyResult(value);
}

const STRICT_DECIMAL_SCIENTIFIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function strictFiniteNumber(value: unknown, nonNegative: boolean): number {
  if (typeof value === "string" && !STRICT_DECIMAL_SCIENTIFIC.test(value)) {
    invalid("Analytics numeric strings must be complete decimal or scientific notation");
  }
  if (typeof value === "string" && nonNegative) {
    const significand = value.split(/[eE]/, 1)[0]!;
    if (significand.startsWith("-") && /[1-9]/.test(significand)) {
      invalid("Funnel values must be non-negative");
    }
  }
  if (typeof value !== "number" && typeof value !== "string") invalid("Analytics value must be numeric");
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || (nonNegative && normalized < 0)) {
    invalid(`Analytics value must be finite${nonNegative ? " and non-negative" : ""}`);
  }
  return normalized;
}

function timestamp(value: unknown): number {
  assertUtcInstant(value, "Trend timestamp");
  return Date.parse(value);
}

function utcWindow(time: number, grain: "day" | "week"): string {
  const date = new Date(time);
  date.setUTCHours(0, 0, 0, 0);
  if (grain === "week") date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

function assertOperation<T extends AnalyticsOperation>(
  operation: AnalyticsOperation,
  expected: AnalyticsOperationKind,
): asserts operation is T {
  validateAnalyticsOperation(operation);
  if (operation.operation !== expected) invalid(`Expected ${expected} operation`);
}

export function computeTrendReference(
  operation: TrendAnalyticsOperation,
  rows: readonly AnalyticsRow[],
): TrendAnalyticsResult {
  assertOperation<TrendAnalyticsOperation>(operation, "trend_v1");
  if (rows.length === 0) {
    return {
      operation: "trend_v1",
      datasetId: operation.datasetId,
      status: "unknown",
      unknownReason: "NO_VALID_ROWS",
      points: [],
      missingWindows: [],
      coverage: 0,
    };
  }
  const groups = new Map<string, { values: number[]; rowCount: number }>();
  for (const row of rows) {
    assertRecord(row, "Trend row");
    const window = utcWindow(timestamp(row[operation.parameters.timeField]), operation.parameters.grain);
    const value = strictFiniteNumber(row[operation.parameters.valueField], false);
    const group = groups.get(window) ?? { values: [], rowCount: 0 };
    group.values.push(value);
    group.rowCount += 1;
    groups.set(window, group);
  }
  const windows = [...groups.keys()].sort();
  const first = Date.parse(`${windows[0]!}T00:00:00.000Z`);
  const last = Date.parse(`${windows.at(-1)!}T00:00:00.000Z`);
  const step = operation.parameters.grain === "day" ? 86_400_000 : 7 * 86_400_000;
  if ((last - first) / step > 100_000) invalid("Trend window span exceeds the bounded reference limit");
  const points: TrendPoint[] = [];
  const missingWindows: string[] = [];
  for (let time = first; time <= last; time += step) {
    const window = new Date(time).toISOString().slice(0, 10);
    const group = groups.get(window);
    if (group === undefined) {
      points.push({ window, value: null, rowCount: 0 });
      missingWindows.push(window);
      continue;
    }
    const value = compensatedSum(group.values);
    if (!Number.isFinite(value)) invalid("Trend compensated total must remain finite");
    points.push({ window, value, rowCount: group.rowCount });
  }
  return {
    operation: "trend_v1",
    datasetId: operation.datasetId,
    status: "ok",
    unknownReason: null,
    points,
    missingWindows,
    coverage: groups.size / points.length,
  };
}

export function computeFunnelReference(
  operation: FunnelAnalyticsOperation,
  rows: readonly AnalyticsRow[],
): FunnelAnalyticsResult {
  assertOperation<FunnelAnalyticsOperation>(operation, "funnel_v1");
  const values = operation.parameters.stageFields.map(() => [] as number[]);
  for (const row of rows) {
    assertRecord(row, "Funnel row");
    operation.parameters.stageFields.forEach((field, index) => {
      values[index]!.push(strictFiniteNumber(row[field], true));
    });
  }
  const totals = values.map((stageValues) => {
    const total = compensatedSum(stageValues);
    if (!Number.isFinite(total)) invalid("Funnel compensated total must remain finite");
    return total;
  });
  const stages = operation.parameters.stageFields.map((field, index): FunnelStageResult => {
    if (index === 0) {
      return { field, total: totals[index]!, conversionFromPrevious: null, conversionUnknownReason: null };
    }
    const denominator = totals[index - 1]!;
    return {
      field,
      total: totals[index]!,
      conversionFromPrevious: denominator === 0 ? null : totals[index]! / denominator,
      conversionUnknownReason: denominator === 0 ? "ZERO_DENOMINATOR" : null,
    };
  });
  const first = totals[0]!;
  const last = totals.at(-1)!;
  return {
    operation: "funnel_v1",
    datasetId: operation.datasetId,
    status: "ok",
    stages,
    overallConversion: first === 0 ? null : last / first,
    overallUnknownReason: first === 0 ? "ZERO_DENOMINATOR" : null,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  const lower = sorted[middle - 1]!;
  const upper = sorted[middle]!;
  return lower + (upper - lower) / 2;
}

export function computeAnalyticsReference(
  operation: AnalyticsOperation,
  rows: readonly AnalyticsRow[],
): AnalyticsResult {
  if (operation.operation === "trend_v1") return computeTrendReference(operation, rows);
  if (operation.operation === "funnel_v1") return computeFunnelReference(operation, rows);
  validateAnalyticsOperation(operation);
  const values = rows.map((row) => {
    assertRecord(row, "Anomaly row");
    return strictFiniteNumber(row[operation.parameters.valueField], false);
  });
  return computeAnomalyReference(operation, values);
}

export function computeAnomalyReference(
  operation: AnomalyAnalyticsOperation,
  values: readonly number[],
): AnomalyAnalyticsResult {
  assertOperation<AnomalyAnalyticsOperation>(operation, "anomaly_v1");
  for (const value of values) assertFiniteNumber(value, "Anomaly input");
  const base = {
    operation: "anomaly_v1" as const,
    datasetId: operation.datasetId,
    modifiedZScoreThreshold: 3.5 as const,
    anomalies: [],
  };
  if (values.length < 3) {
    return {
      ...base,
      status: "unknown",
      unknownReason: "INSUFFICIENT_SAMPLES",
      median: null,
      mad: null,
      threshold: null,
    };
  }
  const center = median(values);
  const deviation = median(values.map((value) => Math.abs(value - center)));
  if (deviation === 0) {
    return {
      ...base,
      status: "unknown",
      unknownReason: "ZERO_MAD",
      median: center,
      mad: deviation,
      threshold: null,
    };
  }
  const threshold = 3.5 * deviation / 0.6745;
  if (!Number.isFinite(threshold)) invalid("Anomaly threshold must remain finite");
  const anomalies = values.flatMap((value, index) => {
    const modifiedZScore = 0.6745 * (value - center) / deviation;
    if (!Number.isFinite(modifiedZScore)) invalid("Anomaly score must remain finite");
    return Math.abs(modifiedZScore) > 3.5 ? [{ index, value, modifiedZScore }] : [];
  });
  return {
    ...base,
    status: "ok",
    unknownReason: null,
    median: center,
    mad: deviation,
    threshold,
    anomalies,
  };
}

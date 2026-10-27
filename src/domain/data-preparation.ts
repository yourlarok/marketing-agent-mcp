import { DomainError } from "./errors.js";

export const QUESTION_TYPES = [
  "content_performance",
  "lead_funnel",
  "conversion",
  "competitor_content",
] as const;

export const PLAN_STATES = ["awaiting_data", "ready", "partial", "blocked"] as const;
export const DATASET_FIELD_TYPES = ["empty", "string", "number", "boolean", "mixed"] as const;
export const PARSED_ISSUE_CODES = [
  "DUPLICATE_HEADER",
  "EMPTY_HEADER",
  "INCONSISTENT_COLUMNS",
  "DUPLICATE_ROW",
  "TYPE_INCONSISTENCY",
  "MISSING_CACHED_FORMULA_RESULT",
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];
export type PlanState = (typeof PLAN_STATES)[number];
export type DataQualityCategory = "missing" | "duplicate" | "type" | "format" | "freshness";

export interface DataSourceLayer {
  id: string;
  acceptedFields: readonly string[];
}

export interface DataQuestionDefinition {
  prompt: string;
  acceptedFields: readonly string[];
  sourceLayers: readonly DataSourceLayer[];
}

export const DATA_QUESTION_CATALOG: Readonly<Record<QuestionType, DataQuestionDefinition>> = {
  content_performance: {
    prompt: "Provide content identifiers, publication dates, reach, and click metrics.",
    acceptedFields: ["content_id", "published_at", "impressions", "clicks"],
    sourceLayers: [
      { id: "content_identity", acceptedFields: ["content_id", "published_at"] },
      { id: "content_metrics", acceptedFields: ["impressions", "clicks"] },
    ],
  },
  lead_funnel: {
    prompt: "Provide lead identifiers, funnel stages, and stage transition dates.",
    acceptedFields: ["lead_id", "stage", "stage_changed_at"],
    sourceLayers: [
      { id: "lead_identity", acceptedFields: ["lead_id"] },
      { id: "funnel_stages", acceptedFields: ["stage", "stage_changed_at"] },
    ],
  },
  conversion: {
    prompt: "Provide conversion identifiers, conversion dates, and conversion values.",
    acceptedFields: ["conversion_id", "converted_at", "conversion_value"],
    sourceLayers: [
      { id: "conversion_events", acceptedFields: ["conversion_id", "converted_at"] },
      { id: "conversion_values", acceptedFields: ["conversion_value"] },
    ],
  },
  competitor_content: {
    prompt: "Provide competitor names, public content URLs, publication dates, and public engagement metrics.",
    acceptedFields: ["competitor", "content_url", "published_at", "engagement"],
    sourceLayers: [
      { id: "competitor_identity", acceptedFields: ["competitor", "content_url"] },
      { id: "competitor_publication", acceptedFields: ["published_at"] },
      { id: "competitor_engagement", acceptedFields: ["engagement"] },
    ],
  },
};

export interface DataQualityIssue {
  category: DataQualityCategory;
  code: string;
  message: string;
  rowNumber?: number;
  columnNumber?: number;
}

export interface DatasetQualityStatistics {
  rowCount: number;
  columnCount: number;
  duplicateRowCount: number;
  emptyRowCount: number;
  typeInconsistencyCount: number;
}

export interface QualityDataset {
  source: {
    path: string;
    fileName: string;
    format: "csv" | "xlsx";
    sizeBytes: number;
    sheetName?: string;
  };
  fields: { name: string; index: number; inferredType: string }[];
  rowsJsonl: string;
  quality: DatasetQualityStatistics;
  issues: {
    code: string;
    message: string;
    rowNumber?: number;
    columnNumber?: number;
  }[];
}

export interface QualityBatch {
  datasets: QualityDataset[];
}

export interface FreshnessAssessment {
  observedAt?: string;
  evaluatedAt?: string;
  maxAgeHours?: number;
}

export interface CellMissingStatistics {
  missingCellCount: number;
  missingCellsByField: Record<string, number>;
}

export interface DataQualityReport {
  source: QualityDataset["source"];
  statistics: DatasetQualityStatistics & CellMissingStatistics;
  issues: DataQualityIssue[];
  coverageStart: string | null;
  coverageEnd: string | null;
}

export interface DataRequestDatasetDescriptor {
  datasetId?: string;
  source: QualityDataset["source"];
  fields: string[];
  rowCount: number;
  missingCellsByField: Record<string, number>;
  stale: boolean;
  coverageStart: string | null;
  coverageEnd: string | null;
}

export interface DataRequestQuestion {
  questionType: QuestionType;
  sourceLayer: string;
  prompt: string;
  acceptedFields: readonly string[];
  missingFields: string[];
}

export interface DataRequestRound {
  round: number;
  state: PlanState;
  questions: DataRequestQuestion[];
  answerableQuestionTypes: QuestionType[];
  declinedQuestionType?: QuestionType;
  limitation?: string;
}

export interface PlannedDataRequestRound extends Omit<DataRequestRound, "round"> {}

export interface DataRequestPlanDetails {
  objective: string;
  questionTypes: QuestionType[];
  availableFields: string[];
  state: PlanState;
  round: number;
  questions: DataRequestQuestion[];
  answerableQuestionTypes: QuestionType[];
  declinedQuestionTypes: QuestionType[];
  limitations: string[];
  qualityReports: DataQualityReport[];
  datasetDescriptors: DataRequestDatasetDescriptor[];
  ingestionBatchIds: string[];
  rounds: DataRequestRound[];
}

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

function assertQuestionTypes(value: unknown, allowEmpty = false): asserts value is QuestionType[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    invalid("questionTypes must be a non-empty array");
  }
  for (const questionType of value) {
    if (typeof questionType !== "string" || !(QUESTION_TYPES as readonly string[]).includes(questionType)) {
      invalid("questionTypes must contain only supported question types");
    }
  }
  if (new Set(value).size !== value.length) {
    invalid("questionTypes must not contain duplicates");
  }
}

function assertAvailableFields(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((field) => typeof field !== "string" || field.trim().length === 0)) {
    invalid("availableFields must be an array of non-empty strings");
  }
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    invalid(`${field} must be a valid UTC ISO-8601 instant`);
  }
  return parsed;
}

function qualityCategory(code: string): DataQualityCategory {
  switch (code) {
    case "DUPLICATE_ROW":
    case "DUPLICATE_HEADER":
      return "duplicate";
    case "TYPE_INCONSISTENCY":
      return "type";
    case "MISSING_CACHED_FORMULA_RESULT":
      return "missing";
    case "EMPTY_HEADER":
    case "INCONSISTENT_COLUMNS":
      return "format";
    default:
      return invalid(`Unsupported parsed dataset issue code: ${code}`);
  }
}

const COVERAGE_FIELDS = new Set(["published_at", "converted_at", "stage_changed_at"]);

function datasetProfile(dataset: QualityDataset): CellMissingStatistics & {
  coverageStart: string | null;
  coverageEnd: string | null;
} {
  const missingCellsByField = Object.fromEntries(dataset.fields.map((field) => [field.name, 0]));
  const coverageTimes: number[] = [];
  const lines = dataset.rowsJsonl.length === 0 ? [] : dataset.rowsJsonl.trimEnd().split("\n");
  for (const line of lines) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      invalid("dataset rowsJsonl must contain one JSON object per line");
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      invalid("dataset rowsJsonl must contain one JSON object per line");
    }
    for (const field of dataset.fields) {
      const value = (row as Record<string, unknown>)[field.name];
      if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
        missingCellsByField[field.name] = (missingCellsByField[field.name] ?? 0) + 1;
      } else if (COVERAGE_FIELDS.has(field.name) &&
        (typeof value === "string" || typeof value === "number")) {
        const parsed = Date.parse(String(value));
        if (Number.isFinite(parsed)) {
          coverageTimes.push(parsed);
        }
      }
    }
  }
  return {
    missingCellCount: Object.values(missingCellsByField).reduce((sum, count) => sum + count, 0),
    missingCellsByField,
    coverageStart: coverageTimes.length > 0 ? new Date(Math.min(...coverageTimes)).toISOString() : null,
    coverageEnd: coverageTimes.length > 0 ? new Date(Math.max(...coverageTimes)).toISOString() : null,
  };
}

export function createDataQualityReports(
  batch: QualityBatch,
  freshness: FreshnessAssessment = {},
): DataQualityReport[] {
  if (batch === null || typeof batch !== "object" || !Array.isArray(batch.datasets)) {
    invalid("batch must contain a datasets array");
  }
  const hasObservedAt = freshness.observedAt !== undefined;
  const hasEvaluatedAt = freshness.evaluatedAt !== undefined;
  if (hasObservedAt !== hasEvaluatedAt) {
    invalid("observedAt and evaluatedAt must be supplied together");
  }
  if (
    freshness.maxAgeHours !== undefined &&
    (typeof freshness.maxAgeHours !== "number" || !Number.isFinite(freshness.maxAgeHours) || freshness.maxAgeHours <= 0)
  ) {
    invalid("maxAgeHours must be a positive finite number");
  }
  let stale = false;
  if (hasObservedAt && hasEvaluatedAt) {
    const observedAt = timestamp(freshness.observedAt!, "observedAt");
    const evaluatedAt = timestamp(freshness.evaluatedAt!, "evaluatedAt");
    if (observedAt > evaluatedAt) {
      invalid("observedAt must not be after evaluatedAt");
    }
    stale = evaluatedAt - observedAt > (freshness.maxAgeHours ?? 24) * 60 * 60 * 1000;
  }

  return batch.datasets.map((dataset) => {
    if (dataset === null || typeof dataset !== "object" || !Array.isArray(dataset.issues)) {
      invalid("Each dataset must contain an issues array");
    }
    const issues: DataQualityIssue[] = dataset.issues.map((issue) => ({
      category: qualityCategory(issue.code),
      code: issue.code,
      message: issue.message,
      ...(issue.rowNumber === undefined ? {} : { rowNumber: issue.rowNumber }),
      ...(issue.columnNumber === undefined ? {} : { columnNumber: issue.columnNumber }),
    }));
    if (dataset.quality.emptyRowCount > 0) {
      issues.push({
        category: "missing",
        code: "EMPTY_ROW",
        message: `${dataset.quality.emptyRowCount} row(s) contain no values`,
      });
    }
    if (dataset.quality.duplicateRowCount > 0 && !issues.some((issue) => issue.code === "DUPLICATE_ROW")) {
      issues.push({
        category: "duplicate",
        code: "DUPLICATE_ROW",
        message: `${dataset.quality.duplicateRowCount} duplicate row(s) detected`,
      });
    }
    if (dataset.quality.typeInconsistencyCount > 0 && !issues.some((issue) => issue.category === "type")) {
      issues.push({
        category: "type",
        code: "TYPE_INCONSISTENCY",
        message: `${dataset.quality.typeInconsistencyCount} column(s) contain inconsistent types`,
      });
    }
    if (stale) {
      issues.push({
        category: "freshness",
        code: "STALE_DATA",
        message: "Dataset exceeds the allowed observation age",
      });
    }
    const profile = datasetProfile(dataset);
    return {
      source: { ...dataset.source },
      statistics: {
        ...dataset.quality,
        missingCellCount: profile.missingCellCount,
        missingCellsByField: profile.missingCellsByField,
      },
      issues,
      coverageStart: profile.coverageStart,
      coverageEnd: profile.coverageEnd,
    };
  });
}

export function createDataRequestDatasetDescriptors(
  batch: QualityBatch,
  freshness: FreshnessAssessment = {},
): DataRequestDatasetDescriptor[] {
  return createDataQualityReports(batch, freshness).map((report, index) => ({
    source: { ...report.source },
    fields: batch.datasets[index]!.fields.map((field) => field.name),
    rowCount: report.statistics.rowCount,
    missingCellsByField: { ...report.statistics.missingCellsByField },
    stale: report.issues.some((issue) => issue.code === "STALE_DATA"),
    coverageStart: report.coverageStart,
    coverageEnd: report.coverageEnd,
  }));
}

export function planDataRequestRound(
  questionTypes: QuestionType[],
  availableFields: string[],
  declinedQuestionTypes: QuestionType[] = [],
  datasetDescriptors: DataRequestDatasetDescriptor[] = [],
): PlannedDataRequestRound {
  assertQuestionTypes(questionTypes);
  assertAvailableFields(availableFields);
  assertQuestionTypes(declinedQuestionTypes, true);
  if (declinedQuestionTypes.some((questionType) => !questionTypes.includes(questionType))) {
    invalid("declinedQuestionTypes must belong to questionTypes");
  }
  const available = new Set(availableFields);
  const declined = new Set(declinedQuestionTypes);
  const active = questionTypes.filter((questionType) => !declined.has(questionType));
  const answerableQuestionTypes = active.filter((questionType) => {
    const requiredFields = DATA_QUESTION_CATALOG[questionType].acceptedFields;
    return datasetDescriptors.some((dataset) =>
      !dataset.stale && dataset.rowCount > 0 && requiredFields.every((field) =>
        dataset.fields.includes(field) && (dataset.missingCellsByField[field] ?? 0) < dataset.rowCount
      )
    );
  });
  const answerable = new Set(answerableQuestionTypes);
  const questions: DataRequestQuestion[] = [];
  for (const questionType of active) {
    if (answerable.has(questionType)) {
      continue;
    }
    const definition = DATA_QUESTION_CATALOG[questionType];
    const layer = definition.sourceLayers.find((candidate) =>
      candidate.acceptedFields.some((field) => !available.has(field))
    ) ?? definition.sourceLayers[0]!;
    const missingFields = layer.acceptedFields.filter((field) => !available.has(field));
    questions.push({
      questionType,
      sourceLayer: layer.id,
      prompt: definition.prompt,
      acceptedFields: layer.acceptedFields,
      missingFields,
    });
    break;
  }
  const hasAnyData = active.some((questionType) =>
    DATA_QUESTION_CATALOG[questionType].acceptedFields.some((field) => available.has(field))
  );
  const state: PlanState = active.length === 0
    ? "blocked"
    : answerableQuestionTypes.length === active.length
      ? "ready"
      : hasAnyData
        ? "partial"
        : "awaiting_data";
  return { state, questions, answerableQuestionTypes };
}

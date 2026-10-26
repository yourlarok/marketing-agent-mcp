import { DomainError } from "./errors.js";

export const QUESTION_TYPES = [
  "content_performance",
  "lead_funnel",
  "conversion",
  "competitor_content",
] as const;

export const PLAN_STATES = ["awaiting_data", "ready", "partial", "blocked"] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];
export type PlanState = (typeof PLAN_STATES)[number];
export type DataQualityCategory = "missing" | "duplicate" | "type" | "format" | "freshness";

export interface DataQuestionDefinition {
  prompt: string;
  acceptedFields: readonly string[];
}

export const DATA_QUESTION_CATALOG: Readonly<Record<QuestionType, DataQuestionDefinition>> = {
  content_performance: {
    prompt: "Provide content identifiers, publication dates, reach, and click metrics.",
    acceptedFields: ["content_id", "published_at", "impressions", "clicks"],
  },
  lead_funnel: {
    prompt: "Provide lead identifiers, funnel stages, and stage transition dates.",
    acceptedFields: ["lead_id", "stage", "stage_changed_at"],
  },
  conversion: {
    prompt: "Provide conversion identifiers, conversion dates, and conversion values.",
    acceptedFields: ["conversion_id", "converted_at", "conversion_value"],
  },
  competitor_content: {
    prompt: "Provide competitor names, public content URLs, publication dates, and public engagement metrics.",
    acceptedFields: ["competitor", "content_url", "published_at", "engagement"],
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

export interface DataQualityReport {
  source: QualityDataset["source"];
  statistics: DatasetQualityStatistics;
  issues: DataQualityIssue[];
}

export interface DataRequestQuestion {
  questionType: QuestionType;
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
  if (code === "DUPLICATE_ROW" || code === "DUPLICATE_HEADER") {
    return "duplicate";
  }
  if (code === "TYPE_INCONSISTENCY") {
    return "type";
  }
  if (code === "MISSING_CACHED_FORMULA_RESULT") {
    return "missing";
  }
  return "format";
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
    return {
      source: { ...dataset.source },
      statistics: { ...dataset.quality },
      issues,
    };
  });
}

export function planDataRequestRound(
  questionTypes: QuestionType[],
  availableFields: string[],
  declinedQuestionTypes: QuestionType[] = [],
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
  const questions = active.flatMap((questionType) => {
    const definition = DATA_QUESTION_CATALOG[questionType];
    const missingFields = definition.acceptedFields.filter((field) => !available.has(field));
    return missingFields.length === 0 ? [] : [{
      questionType,
      prompt: definition.prompt,
      acceptedFields: definition.acceptedFields,
      missingFields,
    }];
  });
  const answerableQuestionTypes = active.filter((questionType) =>
    DATA_QUESTION_CATALOG[questionType].acceptedFields.every((field) => available.has(field))
  );
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

import type {
  FreshnessAssessment,
  QuestionType,
} from "../domain/data-preparation.js";
import type { ParsedFileBatch } from "../infrastructure/file-ingestor.js";

export interface CreateDataRequestPlan {
  id: string;
  workspaceId: string;
  objective: string;
  questionTypes: QuestionType[];
  availableFields: string[];
  batch?: ParsedFileBatch;
  freshness?: FreshnessAssessment;
}

export interface ReconcileDataRequestPlan {
  planId: string;
  workspaceId: string;
  expectedPlanVersion: number;
  availableFields: string[];
  batch?: ParsedFileBatch;
  freshness?: FreshnessAssessment;
}

export interface DeclineDataRound {
  planId: string;
  workspaceId: string;
  expectedPlanVersion: number;
  questionType: QuestionType;
  reason: string;
}

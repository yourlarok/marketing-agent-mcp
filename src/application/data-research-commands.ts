import type {
  FreshnessAssessment,
  QuestionType,
} from "../domain/data-preparation.js";
import type { EvidenceAsset } from "../domain/model.js";
import type { IngestLimits, ParsedFileBatch } from "../infrastructure/file-ingestor.js";

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

export interface ImportFiles {
  id: string;
  workspaceId: string;
  paths: string[];
  limits?: IngestLimits;
  planId?: string;
  expectedPlanVersion?: number;
  freshness?: FreshnessAssessment;
}

export interface IngestTemporaryApi {
  id: string;
  workspaceId: string;
  url: string;
  ownership: "owned" | "authorized";
  expiresAt: string;
  credentialRef?: string;
  limits?: IngestLimits;
  planId?: string;
  expectedPlanVersion?: number;
  freshness?: FreshnessAssessment;
}

export interface EvidenceAssetQuery {
  workspaceId: string;
  evidenceId: string;
  assetId: string;
}

export interface EvidenceAssetContent extends EvidenceAsset {
  content: Buffer;
}

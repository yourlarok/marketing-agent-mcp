import type {
  FreshnessAssessment,
  QuestionType,
} from "../domain/data-preparation.js";
import type { StructuredTableQuery } from "../domain/connector-model.js";
import type { EvidenceAsset, SourceOwnership } from "../domain/model.js";
import type { ResearchExpansion, ResearchLimits, ResearchScope } from "../domain/data-research-model.js";
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
  ownership?: SourceOwnership;
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

export interface IngestSqlite {
  id: string;
  workspaceId: string;
  query: StructuredTableQuery;
  ownership: "owned" | "authorized";
  planId?: string;
  expectedPlanVersion?: number;
  freshness?: FreshnessAssessment;
}

export interface IngestContentLinks {
  id: string;
  workspaceId: string;
  links: {
    url: string;
    fields?: Record<string, string>;
  }[];
}

export interface CreateResearchSession {
  id: string;
  workspaceId: string;
  goal: string;
  seeds: string[];
  expansion: boolean;
  scope: ResearchScope;
}

export interface SetResearchPermission {
  id: string;
  workspaceId: string;
  expectedVersion: number;
  expansion: Extract<ResearchExpansion, "allowed" | "denied">;
}

export interface RunResearch {
  id: string;
  workspaceId: string;
  expectedVersion: number;
  limits?: Partial<ResearchLimits>;
}

export interface ConfirmCompetitor {
  id: string;
  workspaceId: string;
  expectedVersion: number;
  status: "confirmed" | "excluded";
}

export interface CreateCompetitorDiff {
  id: string;
  workspaceId: string;
  competitorIds: [string, string];
  dimensions: string[];
}

export interface DataResearchGetQuery {
  entityType: "data_request_plan" | "ingestion_batch" | "research_session" | "competitor" | "competitor_diff";
  id: string;
  workspaceId: string;
}

export interface EvidenceAssetQuery {
  workspaceId: string;
  evidenceId: string;
  assetId: string;
  offset?: number;
  length?: number;
}

export interface EvidenceAssetContent extends EvidenceAsset {
  content: Buffer;
  offset: number;
  totalBytes: number;
}

import type { EntityRecord } from "../application/ports.js";
import type { DataRequestPlanDetails } from "./data-preparation.js";

export interface DataRequestPlan extends EntityRecord, Partial<DataRequestPlanDetails> {
  objective?: string;
}

export const INGESTION_BATCH_STATES = ["completed", "partial", "blocked"] as const;
export type IngestionBatchState = (typeof INGESTION_BATCH_STATES)[number];

export interface IngestionFileFailure {
  path: string;
  message: string;
}

export interface IngestionBatch extends EntityRecord {
  state: IngestionBatchState;
  sourceIds: string[];
  datasetIds: string[];
  evidenceIds: string[];
  failures: IngestionFileFailure[];
  competitorIds?: string[];
}

export const RESEARCH_EXPANSION_STATES = [
  "not_requested",
  "awaiting_permission",
  "allowed",
  "denied",
] as const;
export type ResearchExpansion = (typeof RESEARCH_EXPANSION_STATES)[number];

export const RESEARCH_SESSION_STATES = [
  "awaiting_permission",
  "ready",
  "completed",
  "partial",
  "blocked",
] as const;
export type ResearchSessionState = (typeof RESEARCH_SESSION_STATES)[number];

export const RESEARCH_LIMIT_CEILINGS = {
  maxDepth: 2,
  maxPages: 20,
  maxDurationMs: 60_000,
  maxBytes: 20 * 1024 * 1024,
} as const;

export const RESEARCH_LIMIT_MINIMA = {
  maxDepth: 0,
  maxPages: 1,
  maxDurationMs: 1,
  maxBytes: 1,
} as const;

export interface ResearchLimits {
  maxDepth: number;
  maxPages: number;
  maxDurationMs: number;
  maxBytes: number;
}

export interface ResearchScope extends ResearchLimits {
  hosts: string[];
  pathPrefixes: string[];
}

export interface ResearchGap {
  url: string;
  reason: string;
  message: string;
}

export interface ResearchFrontierItem {
  url: string;
  depth: number;
}

export interface ResearchSession extends EntityRecord {
  goal: string;
  seeds: string[];
  scope: ResearchScope;
  limits: ResearchLimits;
  expansion: ResearchExpansion;
  state: ResearchSessionState;
  stopReason: string | null;
  gaps: ResearchGap[];
  evidenceIds: string[];
  frontier: ResearchFrontierItem[];
  visitedUrls: string[];
  attemptCount: number;
  candidateBytes: number;
  elapsedMs: number;
}

export const COMPETITOR_STATUSES = ["confirmed", "excluded"] as const;
export type CompetitorStatus = (typeof COMPETITOR_STATUSES)[number];

export const COMPETITOR_DIFF_RESULTS = ["same", "different", "unknown"] as const;
export type CompetitorDiffResult = (typeof COMPETITOR_DIFF_RESULTS)[number];

export interface CompetitorDiffEntry {
  dimension: string;
  result: CompetitorDiffResult;
  evidenceIds: string[];
}

export interface Competitor extends EntityRecord {
  status: CompetitorStatus;
  evidenceIds: string[];
}

export interface CompetitorDiff extends EntityRecord {
  competitorIds: string[];
  entries: CompetitorDiffEntry[];
  findingIds: string[];
}

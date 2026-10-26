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
}

export interface ResearchSession extends EntityRecord {
  evidenceIds: string[];
}

export interface Competitor extends EntityRecord {
  evidenceIds: string[];
}

export interface CompetitorDiff extends EntityRecord {
  findingIds: string[];
}

import type { EntityRecord } from "../application/ports.js";
import type { DataRequestPlanDetails } from "./data-preparation.js";

export interface DataRequestPlan extends EntityRecord, Partial<DataRequestPlanDetails> {
  objective?: string;
}

export interface IngestionBatch extends EntityRecord {
  sourceIds: string[];
  datasetIds: string[];
  evidenceIds: string[];
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

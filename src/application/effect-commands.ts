import type { EffectPublicationRef, MetricObservation } from "../domain/effect-model.js";

export interface ImportMetricSnapshot {
  id: string;
  workspaceId: string;
  publicationId: string;
  expectedPublicationVersion: number;
  windowStart: string;
  windowEnd: string;
  observedAt: string;
  observations: MetricObservation[];
}

export interface GetMetricSnapshot {
  id: string;
  workspaceId: string;
}

export interface CreateEffectReview {
  id: string;
  workspaceId: string;
  publicationRefs: EffectPublicationRef[];
  metricSnapshotIds: string[];
  baselineMetricSnapshotIds?: string[];
  benchmarkEvidenceIds?: string[];
}

export interface GetEffectReview {
  id: string;
  workspaceId: string;
}

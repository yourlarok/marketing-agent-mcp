import type { EntityRecord, JsonValue } from "../application/ports.js";

export interface Workspace extends EntityRecord {
  name: string;
  metadata?: JsonValue;
}

export const SOURCE_TYPES = ["file", "link", "api", "manual", "database"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_OWNERSHIPS = ["owned", "authorized", "external_public"] as const;
export type SourceOwnership = (typeof SOURCE_OWNERSHIPS)[number];

export interface Source extends EntityRecord {
  name: string;
  type: SourceType;
  ownership: SourceOwnership;
  metadata?: JsonValue;
}

export interface Dataset extends EntityRecord {
  sourceId: string;
  name: string;
  coverageStart: string;
  coverageEnd: string;
  fieldDefinitions: JsonValue;
  metricDefinitions: JsonValue;
  limitations: JsonValue;
}

export const EVIDENCE_CLASSIFICATIONS = [
  "owned_operating",
  "owned_conversion",
  "external_observation",
] as const;
export type EvidenceClassification = (typeof EVIDENCE_CLASSIFICATIONS)[number];

export interface Evidence extends EntityRecord {
  sourceId: string;
  sourceLocator: string;
  observedAt: string;
  summary: string;
  contentHash: string;
  classification: EvidenceClassification;
}

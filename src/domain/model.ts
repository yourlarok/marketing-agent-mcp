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
  ingestionBatchId?: string;
  name: string;
  coverageStart: string | null;
  coverageEnd: string | null;
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

export interface ToolHealthEvidence {
  purpose: "tool_health";
  capabilityId: string;
  healthy: boolean;
  checkedAt: string;
  toolVersion: string;
}

export const ARTIFACT_KINDS = [
  "original",
  "normalized_jsonl",
  "quality_report",
  "page_text",
  "screenshot",
  "api_response",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface EvidenceAsset {
  id: string;
  kind: ArtifactKind;
  contentHash: string;
  byteLength: number;
}

export interface Evidence extends EntityRecord {
  sourceId: string;
  sourceLocator: string;
  observedAt: string;
  summary: string;
  contentHash: string;
  classification: EvidenceClassification;
  assets?: EvidenceAsset[];
  toolHealth?: ToolHealthEvidence;
}

export const FINDING_KINDS = ["fact", "inference", "unknown"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding extends EntityRecord {
  kind: FindingKind;
  statement: string;
  evidenceIds: string[];
  limitations?: string;
  unknownReason?: string;
}

export interface Recommendation extends EntityRecord {
  findingIds: string[];
  hypothesis: string;
  affectedStage: string;
  priority: string;
  expectedMetric: string;
}

export const TASK_STATES = [
  "draft",
  "ready",
  "in_progress",
  "blocked",
  "completed",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface Task extends EntityRecord {
  recommendationIds: string[];
  assignee: string;
  dependencyIds: string[];
  assetRequirements: string[];
  acceptanceCriteria: string[];
  state: TaskState;
}

export const CAPABILITY_ADAPTER_KINDS = [
  "mcp",
  "api_cli",
  "script_adapter",
  "temporary_connector",
] as const;
export type CapabilityAdapterKind = (typeof CAPABILITY_ADAPTER_KINDS)[number];

export const CAPABILITY_STATES = [
  "registered",
  "configured",
  "verified",
  "unavailable",
] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export const CAPABILITY_ORIGINS = ["controlled_catalog", "user_extension"] as const;
export type CapabilityOrigin = (typeof CAPABILITY_ORIGINS)[number];

export interface ToolCapability extends EntityRecord {
  name: string;
  adapterKind: CapabilityAdapterKind;
  origin: CapabilityOrigin;
  state: CapabilityState;
  configuration?: JsonValue;
  checkedAt?: string;
  toolVersion?: string;
  evidenceId?: string;
  unavailableReason?: string;
}

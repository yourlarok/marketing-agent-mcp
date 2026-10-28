import type {
  AnalysisGraphEdge,
  AnalysisGraphNode,
  AnalysisRecommendedAction,
  ScenarioLabel,
} from "../domain/analysis-model.js";
import type { AnalyticsOperation } from "../domain/analytics-model.js";
import type { MetricId, ReferenceComparability } from "../domain/metric-catalog.js";
import type { IngestContentLinks, IngestTemporaryApi } from "./data-research-commands.js";

export const ANALYSIS_INPUT_MODES = ["none", "links", "dataset", "api"] as const;
export type AnalysisInputMode = (typeof ANALYSIS_INPUT_MODES)[number];

export interface StartAnalysis {
  id: string;
  workspaceId: string;
  objective: string;
  channel?: string;
  inputMode?: AnalysisInputMode;
  referenceId?: string;
  links?: IngestContentLinks["links"];
  url?: IngestTemporaryApi["url"];
  ownership?: IngestTemporaryApi["ownership"];
  expiresAt?: IngestTemporaryApi["expiresAt"];
  credentialRef?: IngestTemporaryApi["credentialRef"];
}

export interface GetAnalysisGraph {
  id: string;
  workspaceId: string;
}

export interface ExpandAnalysisGraph {
  id: string;
  workspaceId: string;
  expectedVersion: number;
  nodes: AnalysisGraphNode[];
  edges: AnalysisGraphEdge[];
  recommendedActions?: AnalysisRecommendedAction[];
}

export interface ForkAnalysisGraph {
  id: string;
  workspaceId: string;
  parentGraphId: string;
  expectedVersion: number;
  forkNodeId: string;
}

export interface ComputeMetric {
  id: string;
  workspaceId: string;
  expectedVersion: number;
  batchId: string;
  datasetId: string;
  evidenceId: string;
  assetId: string;
  metricId: MetricId;
  comparability?: ReferenceComparability;
}

export interface RunProfessionalAnalytics {
  id: string;
  workspaceId: string;
  expectedVersion: number;
  batchId: string;
  datasetId: string;
  evidenceId: string;
  assetId: string;
  operation: AnalyticsOperation;
}

export interface CreateMetricScenario {
  id: string;
  workspaceId: string;
  expectedVersion: number;
  metricNodeId: string;
  targetValue: number;
  projectedDenominator: number;
  label: ScenarioLabel;
}

export interface CompareMetricMonitor {
  id: string;
  workspaceId: string;
  expectedVersion: number;
  baselineMetricNodeId: string;
  batchId: string;
  datasetId: string;
  evidenceId: string;
  assetId: string;
  scenarioNodeId?: string;
  comparability?: ReferenceComparability;
}

export type AnalysisCapabilityAvailability =
  | "available"
  | "unavailable"
  | "host_provided"
  | "not_installed"
  | "not_implemented";

export interface AnalysisCapability {
  id: string;
  operation: string;
  description: string;
  requiredInputs: string[];
  configuration: string[];
  availability: {
    state: AnalysisCapabilityAvailability;
    detail: string;
  };
  fallback: string[];
  limitations: string[];
}

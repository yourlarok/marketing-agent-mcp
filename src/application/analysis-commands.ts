import type {
  AnalysisGraphEdge,
  AnalysisGraphNode,
  AnalysisRecommendedAction,
} from "../domain/analysis-model.js";

export const ANALYSIS_INPUT_MODES = ["none", "links", "dataset", "api"] as const;
export type AnalysisInputMode = (typeof ANALYSIS_INPUT_MODES)[number];

export interface StartAnalysis {
  id: string;
  workspaceId: string;
  objective: string;
  channel?: string;
  inputMode?: AnalysisInputMode;
  referenceId?: string;
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

export type AnalysisCapabilityAvailability =
  | "available"
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

import type {
  DashboardAnalysisGraphRef,
  DashboardDatasetDescriptor,
  DashboardEvidenceDescriptor,
  DashboardSourceDescriptor,
  DashboardViewInput,
} from "../domain/dashboard-model.js";

export interface RenderDashboard {
  id: string;
  workspaceId: string;
  expectedVersion?: number;
  views: DashboardViewInput[];
}

export interface GetDashboard {
  id: string;
  workspaceId: string;
}

export interface GetDashboardDrilldown {
  id: string;
  workspaceId: string;
  viewId: string;
  datumId: string;
}

export interface GetDashboardArtifact {
  id: string;
  workspaceId: string;
  artifactId: string;
  offset?: number;
  length?: number;
}

export interface DashboardArtifactContent {
  content: Buffer;
  offset: number;
  length: number;
  totalBytes: number;
  contentHash: string;
  mediaType: "text/html; charset=utf-8" | "application/json";
}

export interface DashboardDrilldown {
  id: string;
  workspaceId: string;
  viewId: string;
  datumId: string;
  analysisGraphRefs: DashboardAnalysisGraphRef[];
  sources: DashboardSourceDescriptor[];
  datasets: DashboardDatasetDescriptor[];
  evidence: DashboardEvidenceDescriptor[];
}

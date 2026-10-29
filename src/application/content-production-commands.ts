import type {
  ContentChannel,
  ContentCopy,
  ContentFrame,
} from "../domain/content-production-model.js";

export interface CreateContentBrief {
  id: string;
  workspaceId: string;
  taskId: string;
  expectedTaskVersion: number;
  recommendationId: string;
  expectedRecommendationVersion: number;
  benchmarkAnalysisId: string;
  expectedBenchmarkVersion: number;
  channel: ContentChannel;
  methodIds: string[];
  objective: string;
  audience: string;
  copy: ContentCopy;
  frames: ContentFrame[];
  assetRequirements: string[];
}

export interface GetContentBrief {
  id: string;
  workspaceId: string;
}

export interface ProductionSourceMaterial {
  evidenceId: string;
  assetId: string;
}

export interface GenerateAssetVersion {
  id: string;
  workspaceId: string;
  contentId: string;
  briefId: string;
  expectedBriefVersion: number;
  sourceMaterials: ProductionSourceMaterial[];
  revisionInstructions: string;
}

export interface DeriveAssetVersion {
  id: string;
  workspaceId: string;
  contentId: string;
  parentVersionId: string;
  expectedParentVersion: number;
  briefId: string;
  expectedBriefVersion: number;
  sourceMaterials: ProductionSourceMaterial[];
  revisionInstructions: string;
}

export interface GetAssetVersion {
  id: string;
  workspaceId: string;
}

export interface GetContentArtifact {
  id: string;
  workspaceId: string;
  artifactId: string;
  offset?: number;
  length?: number;
}

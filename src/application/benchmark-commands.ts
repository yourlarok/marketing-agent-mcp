export interface ReverseBenchmark {
  id: string;
  workspaceId: string;
  modality: "image" | "video";
  evidenceIds: string[];
  competitorDiffId?: string;
  expectedCompetitorDiffVersion?: number;
}

export interface GetBenchmarkAnalysis {
  id: string;
  workspaceId: string;
}

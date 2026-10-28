import type { CreateTask } from "./commands.js";
import type {
  AffectedStage,
  RecommendationExpectedMetric,
  StrategyPriority,
} from "../domain/strategy-model.js";
import type { TaskState } from "../domain/model.js";

export interface GenerateRecommendation {
  id: string;
  workspaceId: string;
  findingIds: string[];
  hypothesis: string;
  affectedStage: AffectedStage;
  targetChannels: string[];
  priority: StrategyPriority;
  expectedMetrics: RecommendationExpectedMetric[];
  analysisGraphId?: string;
  analysisNodeIds?: string[];
}

export interface SupplementTask extends CreateTask {
  title: string;
  priority: StrategyPriority;
  rank: number;
}

export interface UpdateStrategyTask {
  id: string;
  workspaceId: string;
  expectedVersion: number;
  recommendationIds?: string[];
  title?: string;
  assignee?: string;
  priority?: StrategyPriority;
  dependencyIds?: string[];
  assetRequirements?: string[];
  acceptanceCriteria?: string[];
}

export interface RejectStrategyTask {
  id: string;
  workspaceId: string;
  expectedVersion: number;
  reason: string;
}

export interface ReorderStrategyTask {
  id: string;
  workspaceId: string;
  expectedVersion: number;
  rank: number;
}

export interface GetStrategyTask {
  id: string;
  workspaceId: string;
}

export interface StrategyTaskCursor {
  rank: number | null;
  id: string;
}

export interface ListStrategyTasks {
  workspaceId: string;
  limit?: number;
  cursor?: StrategyTaskCursor;
}

export interface StrategyTaskSummary {
  id: string;
  version: number;
  title: string | null;
  assignee: string;
  priority: StrategyPriority | null;
  rank: number | null;
  state: TaskState;
  updatedAt: string;
}

export interface StrategyTaskPage {
  tasks: StrategyTaskSummary[];
  nextCursor: StrategyTaskCursor | null;
}

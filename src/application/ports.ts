import type {
  Competitor,
  CompetitorDiff,
  DataRequestPlan,
  IngestionBatch,
  ResearchSession,
} from "../domain/data-research-model.js";
import type { AnalysisGraph } from "../domain/analysis-model.js";
import type { Dashboard } from "../domain/dashboard-model.js";
import type {
  AssetVersion,
  BenchmarkAnalysis,
  ContentBrief,
} from "../domain/content-production-model.js";
import type { Approval, Publication, Schedule } from "../domain/publishing-model.js";
import type { EffectReview, MetricSnapshot } from "../domain/effect-model.js";

export type Id = string;
export type Instant = string;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface EntityRecord {
  id: Id;
  workspaceId: Id;
  version: number;
  createdAt: Instant;
  updatedAt: Instant;
  [key: string]: unknown;
}

export interface EntityRepository<T extends EntityRecord = EntityRecord> {
  get(id: Id, workspaceId: Id): Promise<T | undefined>;
  insert(record: T): Promise<T>;
  update(record: T, expectedVersion: number): Promise<T>;
}

export interface AnalysisGraphRepository {
  get(id: Id, workspaceId: Id): Promise<AnalysisGraph | undefined>;
  insert(record: AnalysisGraph): Promise<AnalysisGraph>;
  update(record: AnalysisGraph, expectedVersion: number): Promise<AnalysisGraph>;
}

export interface AssetVersionRepository {
  get(id: Id, workspaceId: Id): Promise<AssetVersion | undefined>;
  insert(record: AssetVersion): Promise<AssetVersion>;
  latest(contentId: Id, workspaceId: Id): Promise<AssetVersion | undefined>;
}

export interface ImmutableEntityRepository<T extends EntityRecord> {
  get(id: Id, workspaceId: Id): Promise<T | undefined>;
  insert(record: T): Promise<T>;
}

export type ApprovalRepository = ImmutableEntityRepository<Approval>;

export interface ScheduleRepository extends EntityRepository<Schedule> {
  listDue(workspaceId: Id, dueBy: Instant, limit?: number): Promise<Schedule[]>;
}

export interface PublicationRepository extends EntityRepository<Publication> {
  listRecoveryCandidates(workspaceId: Id, limit?: number): Promise<Publication[]>;
  getByScheduleId(scheduleId: Id, workspaceId: Id): Promise<Publication | undefined>;
}

export type MetricSnapshotRepository = ImmutableEntityRepository<MetricSnapshot>;
export type EffectReviewRepository = ImmutableEntityRepository<EffectReview>;

export interface TaskRepository extends EntityRepository {
  list(workspaceId: Id): Promise<EntityRecord[]>;
}

export interface CapabilityRepository extends EntityRepository {
  list(workspaceId: Id): Promise<EntityRecord[]>;
}

export interface AuditRecord {
  id: Id;
  workspaceId: Id;
  requestId: Id;
  actor: string;
  action: string;
  entityType: string;
  entityId: Id;
  details: JsonValue;
  createdAt: Instant;
}

export type LineageEntityType =
  | "source"
  | "dataset"
  | "evidence"
  | "finding"
  | "recommendation"
  | "task"
  | "data_request_plan"
  | "ingestion_batch"
  | "research_session"
  | "competitor"
  | "competitor_diff"
  | "analysis_graph"
  | "dashboard"
  | "benchmark_analysis"
  | "content_brief"
  | "asset_version"
  | "approval"
  | "schedule"
  | "publication"
  | "metric_snapshot"
  | "effect_review";

export interface EntityRef {
  entityType: LineageEntityType;
  id: Id;
}

export interface LineageNode extends EntityRef {
  version: number;
  auditRequestIds: Id[];
}

export interface LineageEdge {
  from: EntityRef;
  to: EntityRef;
}

export interface Lineage {
  workspaceId: Id;
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export interface AuditRepository {
  append(record: AuditRecord): Promise<AuditRecord>;
  get(id: Id, workspaceId: Id): Promise<AuditRecord | undefined>;
  listForEntity(
    workspaceId: Id,
    entityType: string,
    entityId: Id,
  ): Promise<AuditRecord[]>;
}

export interface IdempotencyRecord {
  workspaceId: Id;
  key: string;
  requestHash: string;
  response: JsonValue;
  createdAt: Instant;
}

export interface IdempotencyRepository {
  get(workspaceId: Id, key: string): Promise<IdempotencyRecord | undefined>;
  put(record: IdempotencyRecord): Promise<IdempotencyRecord>;
}

export interface Repositories {
  workspaces: EntityRepository;
  sources: EntityRepository;
  datasets: EntityRepository;
  evidence: EntityRepository;
  findings: EntityRepository;
  recommendations: EntityRepository;
  tasks: TaskRepository;
  dataRequestPlans: EntityRepository<DataRequestPlan>;
  ingestionBatches: EntityRepository<IngestionBatch>;
  researchSessions: EntityRepository<ResearchSession>;
  competitors: EntityRepository<Competitor>;
  competitorDiffs: EntityRepository<CompetitorDiff>;
  analysisGraphs: AnalysisGraphRepository;
  dashboards: EntityRepository<Dashboard>;
  benchmarkAnalyses: EntityRepository<BenchmarkAnalysis>;
  contentBriefs: EntityRepository<ContentBrief>;
  assetVersions: AssetVersionRepository;
  approvals: ApprovalRepository;
  schedules: ScheduleRepository;
  publications: PublicationRepository;
  metricSnapshots: MetricSnapshotRepository;
  effectReviews: EffectReviewRepository;
  capabilities: CapabilityRepository;
  audit: AuditRepository;
  idempotency: IdempotencyRepository;
}

export interface Store {
  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
  close(): void;
}

export interface Clock {
  now(): Instant;
}

export interface IdGenerator {
  next(): Id;
}

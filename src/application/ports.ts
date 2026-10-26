import type {
  Competitor,
  CompetitorDiff,
  DataRequestPlan,
  IngestionBatch,
  ResearchSession,
} from "../domain/data-research-model.js";

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
  | "competitor_diff";

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
  tasks: EntityRepository;
  dataRequestPlans: EntityRepository<DataRequestPlan>;
  ingestionBatches: EntityRepository<IngestionBatch>;
  researchSessions: EntityRepository<ResearchSession>;
  competitors: EntityRepository<Competitor>;
  competitorDiffs: EntityRepository<CompetitorDiff>;
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

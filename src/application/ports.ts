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

export interface AuditRepository {
  append(record: AuditRecord): Promise<AuditRecord>;
  get(id: Id, workspaceId: Id): Promise<AuditRecord | undefined>;
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
  capabilities: EntityRepository;
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

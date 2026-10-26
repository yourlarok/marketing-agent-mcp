import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DomainError } from "../domain/errors.js";
import type {
  AuditRecord,
  AuditRepository,
  CapabilityRepository,
  EntityRecord,
  EntityRepository,
  IdempotencyRecord,
  IdempotencyRepository,
  Repositories,
  Store,
} from "../application/ports.js";
import { assertUtcInstant, canonicalJson, openDatabase } from "./sqlite.js";

interface TransactionCoordinator {
  queue: Promise<void>;
  references: number;
}

const coordinators = new Map<string, TransactionCoordinator>();

function acquireCoordinator(path: string): {
  coordinator: TransactionCoordinator;
  key?: string;
} {
  if (path === ":memory:") {
    return { coordinator: { queue: Promise.resolve(), references: 1 } };
  }
  const key = resolve(path);
  let coordinator = coordinators.get(key);
  if (!coordinator) {
    coordinator = { queue: Promise.resolve(), references: 0 };
    coordinators.set(key, coordinator);
  }
  coordinator.references += 1;
  return { coordinator, key };
}

function releaseCoordinator(key: string | undefined, coordinator: TransactionCoordinator): void {
  if (!key) {
    return;
  }
  coordinator.references -= 1;
  if (coordinator.references === 0 && coordinators.get(key) === coordinator) {
    coordinators.delete(key);
  }
}

interface ReferenceTable {
  table: string;
  ownerColumn: string;
  targetColumn: string;
  recordKey: string;
}

interface EntityConfig {
  table: string;
  referenceColumn?: "source_id" | "evidence_id";
  referenceKey?: "sourceId" | "evidenceId";
  references?: ReferenceTable;
}

const entityConfigs: Record<string, EntityConfig> = {
  workspaces: { table: "workspaces" },
  sources: { table: "sources" },
  datasets: {
    table: "datasets",
    referenceColumn: "source_id",
    referenceKey: "sourceId",
  },
  evidence: {
    table: "evidence",
    referenceColumn: "source_id",
    referenceKey: "sourceId",
  },
  findings: {
    table: "findings",
    references: {
      table: "finding_evidence",
      ownerColumn: "finding_id",
      targetColumn: "evidence_id",
      recordKey: "evidenceIds",
    },
  },
  recommendations: {
    table: "recommendations",
    references: {
      table: "recommendation_findings",
      ownerColumn: "recommendation_id",
      targetColumn: "finding_id",
      recordKey: "findingIds",
    },
  },
  tasks: {
    table: "tasks",
    references: {
      table: "task_recommendations",
      ownerColumn: "task_id",
      targetColumn: "recommendation_id",
      recordKey: "recommendationIds",
    },
  },
  capabilities: {
    table: "capabilities",
    referenceColumn: "evidence_id",
    referenceKey: "evidenceId",
  },
};

function assertId(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function assertEntity(record: EntityRecord): void {
  assertId(record.id, "Entity id");
  assertId(record.workspaceId, "Workspace id");
  if (!Number.isInteger(record.version) || record.version < 1) {
    throw new TypeError("Entity version must be a positive integer");
  }
  assertUtcInstant(record.createdAt);
  assertUtcInstant(record.updatedAt);
  canonicalJson(record);
}

function hasMessage(error: unknown, text: string): boolean {
  return error instanceof Error && error.message.includes(text);
}

function conflict(message: string, id: string): DomainError {
  return new DomainError("CONFLICT", message, false, { id });
}

class SqliteEntityRepository implements EntityRepository {
  constructor(
    protected readonly database: DatabaseSync,
    private readonly config: EntityConfig,
  ) {}

  async get(id: string, workspaceId: string): Promise<EntityRecord | undefined> {
    const row = this.database
      .prepare(`SELECT payload FROM ${this.config.table} WHERE id = ? AND workspace_id = ?`)
      .get(id, workspaceId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as EntityRecord) : undefined;
  }

  async insert(record: EntityRecord): Promise<EntityRecord> {
    assertEntity(record);
    if (record.version !== 1) {
      throw new TypeError("New entities must have version 1");
    }
    const reference = this.scalarReference(record);
    const columns = ["id", "workspace_id"];
    const values: (string | null)[] = [record.id, record.workspaceId];
    if (this.config.referenceColumn) {
      columns.push(this.config.referenceColumn);
      values.push(reference);
    }
    columns.push("version", "created_at", "updated_at", "payload");
    values.push("1", record.createdAt, record.updatedAt, canonicalJson(record));

    try {
      this.database
        .prepare(
          `INSERT INTO ${this.config.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .run(...values);
      this.insertReferences(record);
      return record;
    } catch (error) {
      if (hasMessage(error, "UNIQUE constraint failed")) {
        throw conflict("Entity already exists", record.id);
      }
      throw error;
    }
  }

  async update(record: EntityRecord, expectedVersion: number): Promise<EntityRecord> {
    assertEntity(record);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("Expected version must be a positive integer");
    }
    const updated = { ...record, version: expectedVersion + 1 };
    const reference = this.scalarReference(updated);
    const assignments = ["version = ?", "created_at = ?", "updated_at = ?", "payload = ?"];
    const values: (string | null)[] = [
      String(updated.version),
      updated.createdAt,
      updated.updatedAt,
      canonicalJson(updated),
    ];
    if (this.config.referenceColumn) {
      assignments.push(`${this.config.referenceColumn} = ?`);
      values.push(reference);
    }
    values.push(record.id, record.workspaceId, String(expectedVersion));

    const result = this.database
      .prepare(
        `UPDATE ${this.config.table} SET ${assignments.join(", ")} WHERE id = ? AND workspace_id = ? AND version = ?`,
      )
      .run(...values);
    if (result.changes !== 1) {
      throw conflict("Entity version conflict", record.id);
    }
    this.replaceReferences(updated);
    return updated;
  }

  private scalarReference(record: EntityRecord): string | null {
    if (!this.config.referenceKey) {
      return null;
    }
    const value = record[this.config.referenceKey];
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "string") {
      throw new TypeError(`${this.config.referenceKey} must be a string or null`);
    }
    return value;
  }

  private insertReferences(record: EntityRecord): void {
    const references = this.config.references;
    if (!references) {
      return;
    }
    const ids = record[references.recordKey] ?? [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new TypeError(`${references.recordKey} must be an array of strings`);
    }
    const statement = this.database.prepare(
      `INSERT INTO ${references.table} (workspace_id, ${references.ownerColumn}, ${references.targetColumn}, position) VALUES (?, ?, ?, ?)`,
    );
    ids.forEach((id, position) => {
      statement.run(record.workspaceId, record.id, id, position);
    });
  }

  private replaceReferences(record: EntityRecord): void {
    const references = this.config.references;
    if (!references) {
      return;
    }
    this.database
      .prepare(`DELETE FROM ${references.table} WHERE ${references.ownerColumn} = ?`)
      .run(record.id);
    this.insertReferences(record);
  }
}

class SqliteCapabilityRepository
  extends SqliteEntityRepository
  implements CapabilityRepository
{
  async list(workspaceId: string): Promise<EntityRecord[]> {
    const rows = this.database
      .prepare(
        "SELECT payload FROM capabilities WHERE workspace_id = ? ORDER BY created_at, id",
      )
      .all(workspaceId) as unknown as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as EntityRecord);
  }
}

class SqliteTaskRepository extends SqliteEntityRepository {
  override async insert(record: EntityRecord): Promise<EntityRecord> {
    const inserted = await super.insert(record);
    this.database.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(record.id);
    await this.insertDependencies(record);
    return inserted;
  }

  override async update(record: EntityRecord, expectedVersion: number): Promise<EntityRecord> {
    const updated = await super.update(record, expectedVersion);
    this.database.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(record.id);
    await this.insertDependencies(updated);
    return updated;
  }

  private async insertDependencies(record: EntityRecord): Promise<void> {
    const ids = record.dependencyIds ?? [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new TypeError("dependencyIds must be an array of strings");
    }
    const statement = this.database.prepare(
      "INSERT INTO task_dependencies (workspace_id, task_id, dependency_id, position) VALUES (?, ?, ?, ?)",
    );
    ids.forEach((id, position) => {
      statement.run(record.workspaceId, record.id, id, position);
    });
  }
}

interface AuditRow {
  id: string;
  workspace_id: string;
  request_id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: string;
  created_at: string;
}

class SqliteAuditRepository implements AuditRepository {
  constructor(private readonly database: DatabaseSync) {}

  async append(record: AuditRecord): Promise<AuditRecord> {
    assertId(record.id, "Audit id");
    assertId(record.workspaceId, "Workspace id");
    assertUtcInstant(record.createdAt);
    const details = canonicalJson(record.details);
    this.database
      .prepare(
        "INSERT INTO audit_records (id, workspace_id, request_id, actor, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.workspaceId,
        record.requestId,
        record.actor,
        record.action,
        record.entityType,
        record.entityId,
        details,
        record.createdAt,
      );
    return record;
  }

  async get(id: string, workspaceId: string): Promise<AuditRecord | undefined> {
    const row = this.database
      .prepare("SELECT * FROM audit_records WHERE id = ? AND workspace_id = ?")
      .get(id, workspaceId) as AuditRow | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  async listForEntity(
    workspaceId: string,
    entityType: string,
    entityId: string,
  ): Promise<AuditRecord[]> {
    const rows = this.database
      .prepare(
        "SELECT * FROM audit_records WHERE workspace_id = ? AND entity_type = ? AND entity_id = ? ORDER BY rowid",
      )
      .all(workspaceId, entityType, entityId) as unknown as AuditRow[];
    return rows.map((row) => this.toRecord(row));
  }

  private toRecord(row: AuditRow): AuditRecord {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      requestId: row.request_id,
      actor: row.actor,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: JSON.parse(row.details) as AuditRecord["details"],
      createdAt: row.created_at,
    };
  }
}

class SqliteIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly database: DatabaseSync) {}

  async get(workspaceId: string, key: string): Promise<IdempotencyRecord | undefined> {
    const row = this.database
      .prepare(
        "SELECT workspace_id, key, request_hash, response, created_at FROM idempotency_records WHERE workspace_id = ? AND key = ?",
      )
      .get(workspaceId, key) as
      | {
          workspace_id: string;
          key: string;
          request_hash: string;
          response: string;
          created_at: string;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      workspaceId: row.workspace_id,
      key: row.key,
      requestHash: row.request_hash,
      response: JSON.parse(row.response) as IdempotencyRecord["response"],
      createdAt: row.created_at,
    };
  }

  async put(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    assertId(record.workspaceId, "Workspace id");
    assertId(record.key, "Idempotency key");
    assertUtcInstant(record.createdAt);
    try {
      this.database
        .prepare(
          "INSERT INTO idempotency_records (workspace_id, key, request_hash, response, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          record.workspaceId,
          record.key,
          record.requestHash,
          canonicalJson(record.response),
          record.createdAt,
        );
      return record;
    } catch (error) {
      if (hasMessage(error, "UNIQUE constraint failed")) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key already exists",
          false,
          { key: record.key },
        );
      }
      throw error;
    }
  }
}

class SqliteStore implements Store {
  private closed = false;

  constructor(
    private readonly database: DatabaseSync,
    private readonly coordinator: TransactionCoordinator,
    private readonly coordinatorKey?: string,
  ) {}

  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Store is closed"));
    }
    const result = this.coordinator.queue.then(() => this.execute(work));
    this.coordinator.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        this.database.close();
      } finally {
        releaseCoordinator(this.coordinatorKey, this.coordinator);
      }
    }
  }

  private async execute<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error("Store is closed");
    }
    const repositories = this.createRepositories();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = await work(repositories);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  private createRepositories(): Repositories {
    const repository = (name: string): EntityRepository =>
      name === "tasks"
        ? new SqliteTaskRepository(this.database, entityConfigs[name]!)
        : new SqliteEntityRepository(this.database, entityConfigs[name]!);
    return {
      workspaces: repository("workspaces"),
      sources: repository("sources"),
      datasets: repository("datasets"),
      evidence: repository("evidence"),
      findings: repository("findings"),
      recommendations: repository("recommendations"),
      tasks: repository("tasks"),
      capabilities: new SqliteCapabilityRepository(
        this.database,
        entityConfigs.capabilities!,
      ),
      audit: new SqliteAuditRepository(this.database),
      idempotency: new SqliteIdempotencyRepository(this.database),
    };
  }
}

export function openStore(path: string): Store {
  const database = openDatabase(path);
  const { coordinator, key } = acquireCoordinator(path);
  return new SqliteStore(database, coordinator, key);
}

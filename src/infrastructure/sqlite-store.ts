import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DomainError } from "../domain/errors.js";
import { validateAnalysisGraph, type AnalysisGraph } from "../domain/analysis-model.js";
import { validateDashboard, type Dashboard } from "../domain/dashboard-model.js";
import {
  validateAssetVersion,
  validateBenchmarkAnalysis,
  validateContentBrief,
  type AssetVersion,
  type BenchmarkAnalysis,
  type ContentBrief,
} from "../domain/content-production-model.js";
import type {
  AnalysisGraphRepository,
  AssetVersionRepository,
  AuditRecord,
  AuditRepository,
  CapabilityRepository,
  EntityRecord,
  EntityRepository,
  IdempotencyRecord,
  IdempotencyRepository,
  Repositories,
  Store,
  TaskRepository,
} from "../application/ports.js";
import {
  analysisGraphReferenceIds,
  assertUtcInstant,
  canonicalJson,
  openDatabase,
} from "./sqlite.js";

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

interface ScalarReference {
  column: string;
  key: string;
}

interface EntityConfig {
  table: string;
  referenceColumn?: "source_id" | "evidence_id" | "parent_graph_id";
  referenceKey?: "sourceId" | "evidenceId" | "parentGraphId";
  scalarReferences?: ScalarReference[];
  references?: ReferenceTable | ReferenceTable[];
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
  dataRequestPlans: { table: "data_request_plans" },
  ingestionBatches: {
    table: "ingestion_batches",
    references: [
      {
        table: "ingestion_batch_sources",
        ownerColumn: "batch_id",
        targetColumn: "source_id",
        recordKey: "sourceIds",
      },
      {
        table: "ingestion_batch_datasets",
        ownerColumn: "batch_id",
        targetColumn: "dataset_id",
        recordKey: "datasetIds",
      },
      {
        table: "ingestion_batch_evidence",
        ownerColumn: "batch_id",
        targetColumn: "evidence_id",
        recordKey: "evidenceIds",
      },
    ],
  },
  researchSessions: {
    table: "research_sessions",
    references: {
      table: "research_session_evidence",
      ownerColumn: "session_id",
      targetColumn: "evidence_id",
      recordKey: "evidenceIds",
    },
  },
  competitors: {
    table: "competitors",
    references: {
      table: "competitor_evidence",
      ownerColumn: "competitor_id",
      targetColumn: "evidence_id",
      recordKey: "evidenceIds",
    },
  },
  competitorDiffs: {
    table: "competitor_diffs",
    references: {
      table: "competitor_diff_findings",
      ownerColumn: "diff_id",
      targetColumn: "finding_id",
      recordKey: "findingIds",
    },
  },
  analysisGraphs: {
    table: "analysis_graphs",
    referenceColumn: "parent_graph_id",
    referenceKey: "parentGraphId",
    references: [
      {
        table: "analysis_graph_datasets",
        ownerColumn: "graph_id",
        targetColumn: "dataset_id",
        recordKey: "datasetIds",
      },
      {
        table: "analysis_graph_evidence",
        ownerColumn: "graph_id",
        targetColumn: "evidence_id",
        recordKey: "evidenceIds",
      },
    ],
  },
  dashboards: {
    table: "dashboards",
    references: [
      {
        table: "dashboard_sources",
        ownerColumn: "dashboard_id",
        targetColumn: "source_id",
        recordKey: "sourceIds",
      },
      {
        table: "dashboard_datasets",
        ownerColumn: "dashboard_id",
        targetColumn: "dataset_id",
        recordKey: "datasetIds",
      },
      {
        table: "dashboard_evidence",
        ownerColumn: "dashboard_id",
        targetColumn: "evidence_id",
        recordKey: "evidenceIds",
      },
      {
        table: "dashboard_analysis_graphs",
        ownerColumn: "dashboard_id",
        targetColumn: "graph_id",
        recordKey: "graphIds",
      },
      {
        table: "dashboard_competitor_diffs",
        ownerColumn: "dashboard_id",
        targetColumn: "diff_id",
        recordKey: "competitorDiffIds",
      },
      {
        table: "dashboard_tasks",
        ownerColumn: "dashboard_id",
        targetColumn: "task_id",
        recordKey: "taskIds",
      },
    ],
  },
  benchmarkAnalyses: {
    table: "benchmark_analyses",
    scalarReferences: [{ column: "competitor_diff_id", key: "competitorDiffId" }],
    references: [
      {
        table: "benchmark_analysis_evidence",
        ownerColumn: "analysis_id",
        targetColumn: "evidence_id",
        recordKey: "evidenceIds",
      },
      {
        table: "benchmark_analysis_sources",
        ownerColumn: "analysis_id",
        targetColumn: "source_id",
        recordKey: "sourceIds",
      },
    ],
  },
  contentBriefs: {
    table: "content_briefs",
    scalarReferences: [
      { column: "task_id", key: "taskId" },
      { column: "recommendation_id", key: "recommendationId" },
      { column: "benchmark_analysis_id", key: "benchmarkAnalysisId" },
    ],
    references: [
      {
        table: "content_brief_findings",
        ownerColumn: "brief_id",
        targetColumn: "finding_id",
        recordKey: "findingIds",
      },
      {
        table: "content_brief_evidence",
        ownerColumn: "brief_id",
        targetColumn: "evidence_id",
        recordKey: "evidenceIds",
      },
      {
        table: "content_brief_sources",
        ownerColumn: "brief_id",
        targetColumn: "source_id",
        recordKey: "sourceIds",
      },
    ],
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
    const references = this.scalarReferences(record);
    const columns = ["id", "workspace_id", ...references.map((reference) => reference.column)];
    const values: (string | null)[] = [
      record.id,
      record.workspaceId,
      ...references.map((reference) => reference.value),
    ];
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
    const references = this.scalarReferences(updated);
    const assignments = ["version = ?", "created_at = ?", "updated_at = ?", "payload = ?"];
    const values: (string | null)[] = [
      String(updated.version),
      updated.createdAt,
      updated.updatedAt,
      canonicalJson(updated),
    ];
    for (const reference of references) {
      assignments.push(`${reference.column} = ?`);
      values.push(reference.value);
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

  private scalarReferences(record: EntityRecord): { column: string; value: string | null }[] {
    const configured = [
      ...(this.config.referenceColumn && this.config.referenceKey
        ? [{ column: this.config.referenceColumn as string, key: this.config.referenceKey as string }]
        : []),
      ...(this.config.scalarReferences ?? []),
    ];
    return configured.map(({ column, key }) => {
      const value = record[key];
      if (value !== undefined && value !== null && typeof value !== "string") {
        throw new TypeError(`${key} must be a string or null`);
      }
      return { column, value: value ?? null };
    });
  }

  private referenceTables(): ReferenceTable[] {
    const references = this.config.references;
    if (!references) {
      return [];
    }
    return Array.isArray(references) ? references : [references];
  }

  protected referenceIds(record: EntityRecord, recordKey: string): unknown {
    return record[recordKey] ?? [];
  }

  private insertReferences(record: EntityRecord): void {
    for (const references of this.referenceTables()) {
      const ids = this.referenceIds(record, references.recordKey);
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
  }

  private replaceReferences(record: EntityRecord): void {
    for (const references of this.referenceTables()) {
      this.database
        .prepare(`DELETE FROM ${references.table} WHERE ${references.ownerColumn} = ?`)
        .run(record.id);
    }
    this.insertReferences(record);
  }
}

class SqliteAnalysisGraphRepository extends SqliteEntityRepository {
  override async insert(record: EntityRecord): Promise<EntityRecord> {
    validateAnalysisGraph(record as unknown as AnalysisGraph);
    return super.insert(record);
  }

  override async update(record: EntityRecord, expectedVersion: number): Promise<EntityRecord> {
    validateAnalysisGraph(record as unknown as AnalysisGraph);
    return super.update(record, expectedVersion);
  }

  protected override referenceIds(record: EntityRecord, recordKey: string): unknown {
    if (recordKey === "datasetIds" || recordKey === "evidenceIds") {
      return analysisGraphReferenceIds(record as unknown as AnalysisGraph)[recordKey];
    }
    return super.referenceIds(record, recordKey);
  }
}

class SqliteDashboardRepository extends SqliteEntityRepository {
  override async insert(record: EntityRecord): Promise<EntityRecord> {
    validateDashboard(record as unknown as Dashboard);
    return super.insert(record);
  }

  override async update(record: EntityRecord, expectedVersion: number): Promise<EntityRecord> {
    validateDashboard(record as unknown as Dashboard);
    return super.update(record, expectedVersion);
  }
}

function contentSourceIds(record: EntityRecord): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  const sourceVersions = record.sourceVersions as BenchmarkAnalysis["sourceVersions"] | undefined;
  for (const reference of sourceVersions ?? []) {
    if (reference.entityType === "source") add(reference.id);
  }
  const methods = record.methods as BenchmarkAnalysis["methods"] | undefined;
  for (const method of methods ?? []) {
    for (const reference of method.evidenceAssetRefs) add(reference.sourceId);
  }
  const materials = record.sourceMaterials as AssetVersion["sourceMaterials"] | undefined;
  for (const material of materials ?? []) {
    if (material.role === "source") add(material.source.sourceId);
  }
  return ids;
}

class SqliteBenchmarkAnalysisRepository extends SqliteEntityRepository {
  override async insert(record: EntityRecord): Promise<EntityRecord> {
    validateBenchmarkAnalysis(record as unknown as BenchmarkAnalysis);
    return super.insert(record);
  }

  override async update(record: EntityRecord, expectedVersion: number): Promise<EntityRecord> {
    validateBenchmarkAnalysis(record as unknown as BenchmarkAnalysis);
    return super.update(record, expectedVersion);
  }

  protected override referenceIds(record: EntityRecord, recordKey: string): unknown {
    return recordKey === "sourceIds" ? contentSourceIds(record) : super.referenceIds(record, recordKey);
  }
}

class SqliteContentBriefRepository extends SqliteEntityRepository {
  override async insert(record: EntityRecord): Promise<EntityRecord> {
    validateContentBrief(record as unknown as ContentBrief);
    return super.insert(record);
  }

  override async update(record: EntityRecord, expectedVersion: number): Promise<EntityRecord> {
    validateContentBrief(record as unknown as ContentBrief);
    return super.update(record, expectedVersion);
  }

  protected override referenceIds(record: EntityRecord, recordKey: string): unknown {
    return recordKey === "sourceIds" ? contentSourceIds(record) : super.referenceIds(record, recordKey);
  }
}

class SqliteAssetVersionRepository implements AssetVersionRepository {
  constructor(private readonly database: DatabaseSync) {}

  async get(id: string, workspaceId: string): Promise<AssetVersion | undefined> {
    const row = this.database
      .prepare("SELECT payload FROM asset_versions WHERE id = ? AND workspace_id = ?")
      .get(id, workspaceId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as AssetVersion) : undefined;
  }

  async latest(contentId: string, workspaceId: string): Promise<AssetVersion | undefined> {
    const row = this.database
      .prepare("SELECT payload FROM asset_versions WHERE content_id = ? AND workspace_id = ? ORDER BY version DESC LIMIT 1")
      .get(contentId, workspaceId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as AssetVersion) : undefined;
  }

  async insert(record: AssetVersion): Promise<AssetVersion> {
    assertEntity(record);
    validateAssetVersion(record);
    if (record.version > 1) {
      const parent = await this.get(record.parentVersionId!, record.workspaceId);
      const latest = await this.latest(record.contentId, record.workspaceId);
      if (!parent || latest?.id !== parent.id || parent.version !== record.parentVersion ||
          parent.contentId !== record.contentId || parent.channel !== record.channel ||
          parent.taskId !== record.taskId || parent.recommendationId !== record.recommendationId) {
        throw new TypeError("Derivative AssetVersion must reference the latest matching parent version");
      }
    }
    try {
      this.database.prepare(
        `INSERT INTO asset_versions (
          id, workspace_id, content_id, brief_id, task_id, recommendation_id,
          parent_version_id, version, created_at, updated_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.workspaceId,
        record.contentId,
        record.briefId,
        record.taskId,
        record.recommendationId,
        record.parentVersionId,
        String(record.version),
        record.createdAt,
        record.updatedAt,
        canonicalJson(record),
      );
      this.insertReferences(record, "asset_version_evidence", "evidence_id", record.evidenceIds);
      this.insertReferences(record, "asset_version_sources", "source_id", contentSourceIds(record));
      return record;
    } catch (error) {
      if (hasMessage(error, "UNIQUE constraint failed")) {
        throw conflict("AssetVersion already exists or parent already has a child", record.id);
      }
      throw error;
    }
  }

  private insertReferences(
    record: AssetVersion,
    table: string,
    targetColumn: string,
    ids: string[],
  ): void {
    const statement = this.database.prepare(
      `INSERT INTO ${table} (workspace_id, asset_version_id, ${targetColumn}, position) VALUES (?, ?, ?, ?)`,
    );
    ids.forEach((id, position) => statement.run(record.workspaceId, record.id, id, position));
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

class SqliteTaskRepository extends SqliteEntityRepository implements TaskRepository {
  async list(workspaceId: string): Promise<EntityRecord[]> {
    const rows = this.database
      .prepare("SELECT payload FROM tasks WHERE workspace_id = ? ORDER BY created_at, id")
      .all(workspaceId) as unknown as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as EntityRecord);
  }

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
    const repository = <T extends EntityRecord>(name: string): EntityRepository<T> =>
      (name === "tasks"
        ? new SqliteTaskRepository(this.database, entityConfigs[name]!)
        : name === "analysisGraphs"
          ? new SqliteAnalysisGraphRepository(this.database, entityConfigs[name]!)
          : name === "dashboards"
            ? new SqliteDashboardRepository(this.database, entityConfigs[name]!)
            : name === "benchmarkAnalyses"
              ? new SqliteBenchmarkAnalysisRepository(this.database, entityConfigs[name]!)
              : name === "contentBriefs"
                ? new SqliteContentBriefRepository(this.database, entityConfigs[name]!)
                : new SqliteEntityRepository(this.database, entityConfigs[name]!)) as unknown as EntityRepository<T>;
    return {
      workspaces: repository("workspaces"),
      sources: repository("sources"),
      datasets: repository("datasets"),
      evidence: repository("evidence"),
      findings: repository("findings"),
      recommendations: repository("recommendations"),
      tasks: repository("tasks") as TaskRepository,
      dataRequestPlans: repository("dataRequestPlans"),
      ingestionBatches: repository("ingestionBatches"),
      researchSessions: repository("researchSessions"),
      competitors: repository("competitors"),
      competitorDiffs: repository("competitorDiffs"),
      analysisGraphs: repository("analysisGraphs") as unknown as AnalysisGraphRepository,
      dashboards: repository("dashboards"),
      benchmarkAnalyses: repository("benchmarkAnalyses"),
      contentBriefs: repository("contentBriefs"),
      assetVersions: new SqliteAssetVersionRepository(this.database),
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

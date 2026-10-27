import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../../src/application/commands.js";
import { DataResearchService } from "../../src/application/data-research-service.js";
import type { EntityRecord, Store } from "../../src/application/ports.js";
import type { StructuredTableQuery } from "../../src/domain/connector-model.js";
import { DomainError } from "../../src/domain/errors.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import { SqliteConnector } from "../../src/infrastructure/sqlite-connector.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const observedAt = "2026-10-27T01:02:03.000Z";
const writtenAt = "2026-10-27T02:03:04.000Z";

function query(patch: Partial<StructuredTableQuery> = {}): StructuredTableQuery {
  return {
    databaseId: "marketing",
    table: "daily_metrics",
    columns: ["content_id", "published_at", "channel", "active", "impressions", "clicks", "note"],
    filters: { channel: "owned", active: true },
    order: [{ column: "published_at", direction: "asc" }],
    limit: 100,
    ...patch,
  };
}

function entity(id: string, workspaceId: string): EntityRecord {
  return {
    id,
    workspaceId,
    version: 1,
    createdAt: writtenAt,
    updatedAt: writtenAt,
    name: id,
  };
}

describe("DataResearchService SQLite connector ingest", () => {
  let tempDir: string;
  let databaseRoot: string;
  let artifactRoot: string;
  let databasePath: string;
  let storePath: string;
  let store: Store;
  let connector: SqliteConnector;
  let service: DataResearchService;
  let sequence: number;

  const context = (suffix: string): CommandContext => ({
    actor: "agent-1",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  });

  function command(id: string, patch: Record<string, unknown> = {}) {
    return {
      input: {
        id,
        workspaceId: "workspace-1",
        query: query(),
        ownership: "authorized" as const,
        ...patch,
      },
      context: context(id),
    };
  }

  function createService(currentStore = store): DataResearchService {
    return new DataResearchService(
      currentStore,
      { now: () => writtenAt },
      { next: () => `sqlite-${++sequence}` },
      new ArtifactStore(artifactRoot),
      undefined,
      undefined,
      connector,
    );
  }

  beforeEach(async () => {
    tempDir = await createTempDir();
    databaseRoot = join(tempDir, "databases");
    artifactRoot = join(tempDir, "artifacts");
    databasePath = join(databaseRoot, "marketing.sqlite");
    storePath = join(tempDir, "store.db");
    await mkdir(databaseRoot);
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE daily_metrics (
          id INTEGER,
          content_id TEXT,
          published_at TEXT,
          channel TEXT,
          active BOOLEAN,
          impressions INTEGER,
          clicks INTEGER,
          note TEXT
        );
        INSERT INTO daily_metrics VALUES
          (1, 'content-1', '2026-10-26T00:00:00.000Z', 'owned', 1, 100, 10, NULL),
          (2, 'content-1', '2026-10-26T00:00:00.000Z', 'owned', 1, 100, 10, NULL),
          (3, 'content-2', '2026-10-25T00:00:00.000Z', 'partner', 1, 200, 20, 'excluded'),
          (4, 'content-3', '2026-10-27T00:00:00.000Z', 'owned', 0, 300, 30, 'excluded');
      `);
    } finally {
      database.close();
    }
    store = openStore(storePath);
    sequence = 0;
    connector = new SqliteConnector(databaseRoot, { now: () => observedAt });
    service = createService();
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(entity("workspace-1", "workspace-1"));
      await repos.workspaces.insert(entity("workspace-2", "workspace-2"));
    });
  });

  afterEach(async () => {
    store.close();
    await removeTempDir(tempDir);
  });

  it("discovers through the service without exposing another authorized file", () => {
    expect(service.connectorSqliteDiscover({ databaseId: "marketing" })).toEqual({
      databaseId: "marketing",
      tables: [{
        name: "daily_metrics",
        columns: [
          { name: "id", type: "number" },
          { name: "content_id", type: "string" },
          { name: "published_at", type: "string" },
          { name: "channel", type: "string" },
          { name: "active", type: "number" },
          { name: "impressions", type: "number" },
          { name: "clicks", type: "number" },
          { name: "note", type: "string" },
        ],
      }],
    });
  });

  it("atomically persists typed rows, quality, snapshot provenance, evidence, and replay across restart", async () => {
    const batchCommand = command("sqlite-import");
    const batch = await service.ingestSqlite(batchCommand);
    expect(batch).toMatchObject({ state: "completed", failures: [] });
    expect(batch.sourceIds).toHaveLength(1);
    expect(batch.datasetIds).toHaveLength(1);
    expect(batch.evidenceIds).toHaveLength(1);

    const persisted = await store.transaction(async (repos) => ({
      source: await repos.sources.get(batch.sourceIds[0]!, "workspace-1"),
      dataset: await repos.datasets.get(batch.datasetIds[0]!, "workspace-1"),
      evidence: await repos.evidence.get(batch.evidenceIds[0]!, "workspace-1"),
      audit: await repos.audit.listForEntity("workspace-1", "ingestion_batch", batch.id),
    }));
    expect(persisted.source).toMatchObject({
      type: "database",
      ownership: "authorized",
      name: "marketing.sqlite",
      metadata: {
        acquisition: "connector",
        connectorId: "sqlite-readonly",
        connectorVersion: 1,
        databaseId: "marketing",
        table: "daily_metrics",
        query: query(),
        queryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        observedAt,
      },
    });
    expect(JSON.stringify(persisted.source?.metadata)).not.toContain(databaseRoot);
    expect(persisted.dataset).toMatchObject({
      name: "marketing.sqlite#daily_metrics",
      fieldDefinitions: [
        { name: "content_id", inferredType: "string" },
        { name: "published_at", inferredType: "string" },
        { name: "channel", inferredType: "string" },
        { name: "active", inferredType: "number" },
        { name: "impressions", inferredType: "number" },
        { name: "clicks", inferredType: "number" },
        { name: "note", inferredType: "empty" },
      ],
      quality: {
        rowCount: 2,
        columnCount: 7,
        duplicateRowCount: 1,
        emptyRowCount: 0,
        typeInconsistencyCount: 0,
        missingCellCount: 2,
      },
    });
    expect(persisted.evidence).toMatchObject({
      observedAt,
      sourceLocator: "sqlite://marketing#daily_metrics",
      classification: "owned_operating",
    });
    expect(persisted.audit).toHaveLength(1);
    expect(persisted.audit[0]).toMatchObject({ action: "ingestion_batch.connector_sqlite" });

    const assets = persisted.evidence!.assets!;
    expect(assets.map((asset) => asset.kind)).toEqual(["snapshot", "normalized_jsonl", "quality_report"]);
    const snapshotAsset = assets.find((asset) => asset.kind === "snapshot")!;
    const normalizedAsset = assets.find((asset) => asset.kind === "normalized_jsonl")!;
    const qualityAsset = assets.find((asset) => asset.kind === "quality_report")!;
    const snapshotContent = await service.getEvidenceAsset({
      workspaceId: "workspace-1",
      evidenceId: batch.evidenceIds[0]!,
      assetId: snapshotAsset.id,
    });
    const snapshot = JSON.parse(snapshotContent.content.toString("utf8"));
    expect(snapshot).toMatchObject({
      observedAt,
      queryHash: (persisted.source!.metadata as Record<string, unknown>).queryHash,
      sourceDescriptor: {
        connectorId: "sqlite-readonly",
        databaseId: "marketing",
        table: "daily_metrics",
        query: query(),
      },
    });
    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.rows[0]).toEqual({
      content_id: "content-1",
      published_at: "2026-10-26T00:00:00.000Z",
      channel: "owned",
      active: 1,
      impressions: 100,
      clicks: 10,
      note: null,
    });

    const normalized = await service.getEvidenceAsset({
      workspaceId: "workspace-1",
      evidenceId: batch.evidenceIds[0]!,
      assetId: normalizedAsset.id,
    });
    expect(normalized.content.toString("utf8")).toBe(
      `${JSON.stringify(snapshot.rows[0])}\n${JSON.stringify(snapshot.rows[1])}\n`,
    );
    const quality = await service.getEvidenceAsset({
      workspaceId: "workspace-1",
      evidenceId: batch.evidenceIds[0]!,
      assetId: qualityAsset.id,
    });
    expect(JSON.parse(quality.content.toString("utf8"))).toMatchObject({
      statistics: { duplicateRowCount: 1, missingCellCount: 2 },
      issues: [{ category: "duplicate", code: "DUPLICATE_ROW" }],
    });

    await expect(service.ingestSqlite(batchCommand)).resolves.toEqual(batch);
    store.close();
    store = openStore(storePath);
    service = createService(store);
    await expect(service.getDataResearch({
      entityType: "ingestion_batch",
      id: batch.id,
      workspaceId: "workspace-1",
    })).resolves.toMatchObject({
      entity: batch,
      descriptors: {
        sources: [{ id: batch.sourceIds[0] }],
        datasets: [{ id: batch.datasetIds[0] }],
        evidence: [{ id: batch.evidenceIds[0] }],
      },
    });
  });

  it("replays before database or artifact I/O even when the source snapshot is gone", async () => {
    const batchCommand = command("sqlite-replay");
    const batch = await service.ingestSqlite(batchCommand);
    await unlink(databasePath);
    await expect(service.ingestSqlite(batchCommand)).resolves.toEqual(batch);
    await expect(service.ingestSqlite({
      ...batchCommand,
      input: { ...batchCommand.input, query: query({ limit: 1 }) },
    })).rejects.toMatchObject<DomainError>({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects cross-workspace persistence and evidence access", async () => {
    await expect(service.ingestSqlite(command("sqlite-cross", { workspaceId: "workspace-missing" })))
      .rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    const batch = await service.ingestSqlite(command("sqlite-isolation"));
    await expect(service.getDataResearch({
      entityType: "ingestion_batch",
      id: batch.id,
      workspaceId: "workspace-2",
    })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    const assetId = (await store.transaction((repos) =>
      repos.evidence.get(batch.evidenceIds[0]!, "workspace-1")
    ))!.assets![0]!.id;
    await expect(service.getEvidenceAsset({
      workspaceId: "workspace-2",
      evidenceId: batch.evidenceIds[0]!,
      assetId,
    })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
  });

  it("rejects public ownership, arbitrary SQL forms, and excessive limits without a batch", async () => {
    const cases = [
      command("sqlite-public", { ownership: "external_public" }),
      command("sqlite-sql", { query: { ...query(), table: "daily_metrics; DROP TABLE daily_metrics" } }),
      command("sqlite-arbitrary", { query: { ...query(), sql: "DELETE FROM daily_metrics" } }),
      command("sqlite-limit", { query: query({ limit: 100_001 }) }),
    ];
    for (const invalid of cases) {
      await expect(service.ingestSqlite(invalid)).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
      await expect(store.transaction((repos) =>
        repos.ingestionBatches.get(invalid.input.id, "workspace-1")
      )).resolves.toBeUndefined();
    }
  });

  it("rolls back Source, Dataset, Evidence, audit, and idempotency on a write failure", async () => {
    const failingStore: Store = {
      close: () => store.close(),
      transaction: (work) => store.transaction(async (repos) => work({
        ...repos,
        ingestionBatches: {
          ...repos.ingestionBatches,
          insert: () => Promise.reject(new Error("injected SQLite batch failure")),
        },
      })),
    };
    const failing = createService(failingStore);
    await expect(failing.ingestSqlite(command("sqlite-rollback"))).rejects.toThrow("injected SQLite batch failure");
    const residue = await store.transaction(async (repos) => ({
      sourceCount: (await repos.sources.get("sqlite-1", "workspace-1")) === undefined ? 0 : 1,
      batch: await repos.ingestionBatches.get("sqlite-rollback", "workspace-1"),
      audit: await repos.audit.listForEntity("workspace-1", "ingestion_batch", "sqlite-rollback"),
      idempotency: await repos.idempotency.get("workspace-1", "command-sqlite-rollback"),
    }));
    expect(residue).toEqual({ sourceCount: 0, batch: undefined, audit: [], idempotency: undefined });
    const raw = new DatabaseSync(storePath, { readOnly: true });
    try {
      for (const table of ["sources", "datasets", "evidence"]) {
        expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    } finally {
      raw.close();
    }
  });

  it("returns capability unavailable when MARKETING_DATABASE_ROOT is not configured", async () => {
    const unavailable = new DataResearchService(
      store,
      { now: () => writtenAt },
      { next: () => `unavailable-${++sequence}` },
      new ArtifactStore(artifactRoot),
      undefined,
      undefined,
      new SqliteConnector(undefined, { now: () => observedAt }),
    );
    expect(() => unavailable.connectorSqliteDiscover({ databaseId: "marketing" })).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "CAPABILITY_UNAVAILABLE" }),
    );
    await expect(unavailable.ingestSqlite(command("sqlite-unavailable"))).rejects.toMatchObject<DomainError>({
      code: "CAPABILITY_UNAVAILABLE",
    });
  });
});

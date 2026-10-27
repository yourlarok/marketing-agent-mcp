import { readFileSync } from "node:fs";
import { copyFile, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
import { MarketingService } from "../../src/application/marketing-service.js";
import { DataResearchService } from "../../src/application/data-research-service.js";
import type { CommandContext } from "../../src/application/commands.js";
import type {
  EntityRecord,
  EntityRepository,
  Repositories,
  Store,
} from "../../src/application/ports.js";
import type {
  Competitor,
  CompetitorDiff,
  DataRequestPlan,
  IngestionBatch,
  ResearchSession,
} from "../../src/domain/data-research-model.js";
import { DomainError } from "../../src/domain/errors.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import { AcquisitionRouter, type AcquiredPage, type AcquisitionProvider } from "../../src/infrastructure/acquisition-router.js";
import { SafeHttpClient } from "../../src/infrastructure/safe-http.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-26T12:30:00.000Z";
const stage1Migration = readFileSync(
  new URL("../../migrations/001_initial.sql", import.meta.url),
  "utf8",
);

function entity(id: string, workspaceId = "workspace-1"): EntityRecord {
  return {
    id,
    workspaceId,
    version: 1,
    createdAt: now,
    updatedAt: now,
    name: `Entity ${id}`,
  };
}

function dataRequestPlan(id = "plan-1"): DataRequestPlan {
  return { ...entity(id), objective: "Research the category" };
}

function ingestionBatch(id = "batch-1"): IngestionBatch {
  return {
    ...entity(id),
    sourceIds: ["source-2", "source-1"],
    datasetIds: ["dataset-2", "dataset-1"],
    evidenceIds: ["evidence-2", "evidence-1"],
  };
}

function researchSession(id = "session-1"): ResearchSession {
  return {
    ...entity(id),
    goal: "Research public pages",
    seeds: ["https://example.com/research"],
    scope: {
      hosts: ["example.com"], pathPrefixes: ["/research"], maxDepth: 2,
      maxPages: 20, maxDurationMs: 60_000, maxBytes: 20 * 1024 * 1024,
    },
    limits: { maxDepth: 2, maxPages: 20, maxDurationMs: 60_000, maxBytes: 20 * 1024 * 1024 },
    expansion: "not_requested",
    state: "ready",
    stopReason: null,
    gaps: [],
    evidenceIds: ["evidence-2", "evidence-1"],
    frontier: [],
    visitedUrls: [],
    attemptCount: 0,
    candidateBytes: 0,
    elapsedMs: 0,
  };
}

function competitor(id = "competitor-1"): Competitor {
  return {
    ...entity(id),
    status: "confirmed",
    evidenceIds: ["evidence-2", "evidence-1"],
  };
}

function competitorDiff(id = "diff-1"): CompetitorDiff {
  return {
    ...entity(id),
    competitorIds: ["competitor-1", "competitor-2"],
    entries: [],
    findingIds: ["finding-2", "finding-1"],
  };
}

async function insertBaseEntities(repos: Repositories): Promise<void> {
  await repos.workspaces.insert(entity("workspace-1", "workspace-1"));
  await repos.workspaces.insert(entity("workspace-2", "workspace-2"));
  for (const id of ["source-1", "source-2"]) {
    await repos.sources.insert(entity(id));
  }
  for (const id of ["dataset-1", "dataset-2"]) {
    await repos.datasets.insert({ ...entity(id), sourceId: "source-1" });
  }
  for (const id of ["evidence-1", "evidence-2"]) {
    await repos.evidence.insert({ ...entity(id), sourceId: "source-1" });
  }
  for (const id of ["finding-1", "finding-2"]) {
    await repos.findings.insert({ ...entity(id), evidenceIds: ["evidence-1"] });
  }
}

async function insertResearchEntities(repos: Repositories): Promise<void> {
  await repos.dataRequestPlans.insert(dataRequestPlan());
  await repos.ingestionBatches.insert(ingestionBatch());
  await repos.researchSessions.insert(researchSession());
  await repos.competitors.insert(competitor());
  await repos.competitorDiffs.insert(competitorDiff());
}

describe("versioned data-research storage", () => {
  let tempDir: string;
  let databasePath: string;
  let stores: Store[];

  beforeEach(async () => {
    tempDir = await createTempDir();
    databasePath = join(tempDir, "store.db");
    stores = [];
  });

  afterEach(async () => {
    for (const store of stores) {
      store.close();
    }
    await removeTempDir(tempDir);
  });

  function open(path = databasePath): Store {
    const store = openStore(path);
    stores.push(store);
    return store;
  }

  function createStage1Database(): void {
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(stage1Migration);
      database
        .prepare(
          "INSERT INTO workspaces (id, workspace_id, version, created_at, updated_at, payload) VALUES (?, ?, 1, ?, ?, ?)",
        )
        .run(
          "workspace-1",
          "workspace-1",
          now,
          now,
          JSON.stringify(entity("workspace-1", "workspace-1")),
        );
    } finally {
      database.close();
    }
  }

  it("upgrades a real stage-1 database once and preserves records on repeat open", async () => {
    createStage1Database();
    const first = open();
    expect(
      await first.transaction((repos) =>
        repos.workspaces.get("workspace-1", "workspace-1"),
      ),
    ).toEqual(entity("workspace-1", "workspace-1"));
    first.close();

    const migrationTimes = new DatabaseSync(databasePath);
    let before: unknown;
    try {
      before = migrationTimes
        .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
        .all();
      expect(before).toEqual([
        { version: 1, applied_at: expect.any(String) },
        { version: 2, applied_at: expect.any(String) },
      ]);
    } finally {
      migrationTimes.close();
    }

    const second = open();
    expect(
      await second.transaction((repos) =>
        repos.workspaces.get("workspace-1", "workspace-1"),
      ),
    ).toEqual(entity("workspace-1", "workspace-1"));
    const afterRepeat = new DatabaseSync(databasePath);
    try {
      expect(
        afterRepeat
          .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual(before);
    } finally {
      afterRepeat.close();
    }
  });

  it("rejects a database newer than the program without upgrading it", () => {
    createStage1Database();
    const database = new DatabaseSync(databasePath);
    try {
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)")
        .run(now);
    } finally {
      database.close();
    }

    expect(() => openStore(databasePath)).toThrow(/newer/i);
    const after = new DatabaseSync(databasePath);
    try {
      expect(
        after
          .prepare("SELECT name FROM sqlite_master WHERE name = 'data_request_plans'")
          .get(),
      ).toBeUndefined();
      expect(
        after.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      ).toEqual([{ version: 1 }, { version: 3 }]);
    } finally {
      after.close();
    }
  });

  it("rolls back a failed 002 upgrade and succeeds after repair", async () => {
    createStage1Database();
    const broken = new DatabaseSync(databasePath);
    try {
      broken.exec("CREATE TABLE research_sessions (broken TEXT)");
    } finally {
      broken.close();
    }

    expect(() => openStore(databasePath)).toThrow();
    const afterFailure = new DatabaseSync(databasePath);
    try {
      expect(
        afterFailure.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
      ).toEqual({ version: 1 });
      expect(
        afterFailure
          .prepare("SELECT name FROM sqlite_master WHERE name = 'data_request_plans'")
          .get(),
      ).toBeUndefined();
      afterFailure.exec("DROP TABLE research_sessions");
    } finally {
      afterFailure.close();
    }

    const repaired = open();
    await expect(
      repaired.transaction((repos) => repos.dataRequestPlans.get("missing", "workspace-1")),
    ).resolves.toBeUndefined();
  });

  it("round trips every new typed repository and enforces optimistic versions", async () => {
    const first = open();
    await first.transaction(async (repos) => {
      await insertBaseEntities(repos);
      await insertResearchEntities(repos);
    });
    first.close();

    const second = open();
    const restored = await second.transaction(async (repos) => ({
      plan: await repos.dataRequestPlans.get("plan-1", "workspace-1"),
      batch: await repos.ingestionBatches.get("batch-1", "workspace-1"),
      session: await repos.researchSessions.get("session-1", "workspace-1"),
      competitor: await repos.competitors.get("competitor-1", "workspace-1"),
      diff: await repos.competitorDiffs.get("diff-1", "workspace-1"),
    }));
    expect(restored).toEqual({
      plan: dataRequestPlan(),
      batch: ingestionBatch(),
      session: researchSession(),
      competitor: competitor(),
      diff: competitorDiff(),
    });

    await second.transaction(async (repos) => {
      const cases: [EntityRepository, EntityRecord][] = [
        [repos.dataRequestPlans, dataRequestPlan()],
        [repos.ingestionBatches, ingestionBatch()],
        [repos.researchSessions, researchSession()],
        [repos.competitors, competitor()],
        [repos.competitorDiffs, competitorDiff()],
      ];
      for (const [repository, record] of cases) {
        await expect(
          repository.update({ ...record, name: "updated" }, 1),
        ).resolves.toMatchObject({ version: 2, name: "updated" });
        await expect(repository.update(record, 1)).rejects.toMatchObject<DomainError>({
          code: "CONFLICT",
        });
      }
    });
  });

  it("persists ordered references and rejects every cross-workspace reference", async () => {
    const store = open();
    await store.transaction(insertBaseEntities);
    await store.transaction(insertResearchEntities);

    const raw = new DatabaseSync(databasePath);
    try {
      const expectations: [string, string, string, string[]][] = [
        ["ingestion_batch_sources", "batch-1", "source_id", ["source-2", "source-1"]],
        ["ingestion_batch_datasets", "batch-1", "dataset_id", ["dataset-2", "dataset-1"]],
        ["ingestion_batch_evidence", "batch-1", "evidence_id", ["evidence-2", "evidence-1"]],
        ["research_session_evidence", "session-1", "evidence_id", ["evidence-2", "evidence-1"]],
        ["competitor_evidence", "competitor-1", "evidence_id", ["evidence-2", "evidence-1"]],
        ["competitor_diff_findings", "diff-1", "finding_id", ["finding-2", "finding-1"]],
      ];
      for (const [table, owner, target, ids] of expectations) {
        const ownerColumn = table === "competitor_diff_findings"
          ? "diff_id"
          : table === "competitor_evidence"
            ? "competitor_id"
            : table === "research_session_evidence"
              ? "session_id"
              : "batch_id";
        expect(
          raw
            .prepare(`SELECT ${target} AS id, position FROM ${table} WHERE ${ownerColumn} = ? ORDER BY position`)
            .all(owner),
        ).toEqual(ids.map((id, position) => ({ id, position })));
      }
    } finally {
      raw.close();
    }

    await store.transaction(async (repos) => {
      await repos.sources.insert({ ...entity("other-source", "workspace-2") });
      await repos.datasets.insert({
        ...entity("other-dataset", "workspace-2"),
        sourceId: "other-source",
      });
      await repos.evidence.insert({
        ...entity("other-evidence", "workspace-2"),
        sourceId: "other-source",
      });
      await repos.findings.insert({
        ...entity("other-finding", "workspace-2"),
        evidenceIds: ["other-evidence"],
      });
    });

    const invalidRecords: [keyof Repositories, EntityRecord][] = [
      ["ingestionBatches", { ...ingestionBatch("cross-source"), sourceIds: ["other-source"] }],
      ["ingestionBatches", { ...ingestionBatch("cross-dataset"), sourceIds: [], datasetIds: ["other-dataset"], evidenceIds: [] }],
      ["ingestionBatches", { ...ingestionBatch("cross-evidence"), sourceIds: [], datasetIds: [], evidenceIds: ["other-evidence"] }],
      ["researchSessions", { ...researchSession("cross-session"), evidenceIds: ["other-evidence"] }],
      ["competitors", { ...competitor("cross-competitor"), evidenceIds: ["other-evidence"] }],
      ["competitorDiffs", { ...competitorDiff("cross-diff"), findingIds: ["other-finding"] }],
    ];
    for (const [repositoryName, record] of invalidRecords) {
      await expect(
        store.transaction(async (repos) => {
          const repository = repos[repositoryName] as EntityRepository;
          await repository.insert({ ...record, workspaceId: "workspace-1" });
        }),
      ).rejects.toThrow(/FOREIGN KEY/);
      expect(
        await store.transaction((repos) =>
          (repos[repositoryName] as EntityRepository).get(record.id, "workspace-1"),
        ),
      ).toBeUndefined();
    }
  });

  it("traces lineage from every new root with ordered upstream references", async () => {
    const store = open();
    await store.transaction(async (repos) => {
      await insertBaseEntities(repos);
      await insertResearchEntities(repos);
    });
    const service = new MarketingService(store, { now: () => now }, { next: () => "unused" });

    await expect(
      service.getLineage({ entityType: "data_request_plan", id: "plan-1", workspaceId: "workspace-1" }),
    ).resolves.toEqual({
      workspaceId: "workspace-1",
      nodes: [{ entityType: "data_request_plan", id: "plan-1", version: 1, auditRequestIds: [] }],
      edges: [],
    });

    const batch = await service.getLineage({
      entityType: "ingestion_batch",
      id: "batch-1",
      workspaceId: "workspace-1",
    });
    expect(batch.nodes.map(({ entityType, id }) => ({ entityType, id }))).toEqual([
      { entityType: "source", id: "source-2" },
      { entityType: "source", id: "source-1" },
      { entityType: "dataset", id: "dataset-2" },
      { entityType: "dataset", id: "dataset-1" },
      { entityType: "evidence", id: "evidence-2" },
      { entityType: "evidence", id: "evidence-1" },
      { entityType: "ingestion_batch", id: "batch-1" },
    ]);
    expect(batch.edges).toContainEqual({
      from: { entityType: "evidence", id: "evidence-2" },
      to: { entityType: "ingestion_batch", id: "batch-1" },
    });

    for (const [entityType, id] of [
      ["research_session", "session-1"],
      ["competitor", "competitor-1"],
    ] as const) {
      const lineage = await service.getLineage({ entityType, id, workspaceId: "workspace-1" });
      expect(lineage.edges).toEqual([
        { from: { entityType: "source", id: "source-1" }, to: { entityType: "evidence", id: "evidence-2" } },
        { from: { entityType: "source", id: "source-1" }, to: { entityType: "evidence", id: "evidence-1" } },
        { from: { entityType: "evidence", id: "evidence-2" }, to: { entityType, id } },
        { from: { entityType: "evidence", id: "evidence-1" }, to: { entityType, id } },
      ]);
    }

    const diff = await service.getLineage({
      entityType: "competitor_diff",
      id: "diff-1",
      workspaceId: "workspace-1",
    });
    expect(diff.edges).toContainEqual({
      from: { entityType: "finding", id: "finding-2" },
      to: { entityType: "competitor_diff", id: "diff-1" },
    });
    expect(diff.edges).toContainEqual({
      from: { entityType: "finding", id: "finding-1" },
      to: { entityType: "competitor_diff", id: "diff-1" },
    });
  });

  it("applies the existing 1,000-node lineage limit to a new root", async () => {
    const store = open();
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(entity("workspace-1", "workspace-1"));
      await repos.sources.insert(entity("source-1"));
      const evidenceIds: string[] = [];
      for (let index = 0; index < 1_001; index += 1) {
        const id = `bounded-evidence-${index}`;
        evidenceIds.push(id);
        await repos.evidence.insert({ ...entity(id), sourceId: "source-1" });
      }
      await repos.competitors.insert({ ...competitor(), evidenceIds });
    });
    const service = new MarketingService(store, { now: () => now }, { next: () => "unused" });

    await expect(
      service.getLineage({
        entityType: "competitor",
        id: "competitor-1",
        workspaceId: "workspace-1",
      }),
    ).rejects.toMatchObject<DomainError>({
      code: "CONFLICT",
      details: { limit: 1_000 },
    });
  });
});

describe("DataResearchService guided data rounds", () => {
  let store: Store;
  let service: DataResearchService;
  let auditSequence: number;

  const commandContext = (suffix: string): CommandContext => ({
    actor: "agent-1",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  });

  function parsedBatch() {
    return {
      datasets: [{
        source: { path: "/imports/data.csv", fileName: "data.csv", format: "csv" as const, sizeBytes: 10 },
        fields: [{ name: "content_id", index: 0, inferredType: "string" as const }],
        rowsJsonl: "",
        quality: { rowCount: 0, columnCount: 1, duplicateRowCount: 0, emptyRowCount: 0, typeInconsistencyCount: 0 },
        issues: [],
      }],
    };
  }

  async function expectNoCreateResidue(planId: string, key: string): Promise<void> {
    const residue = await store.transaction(async (repos) => ({
      plan: await repos.dataRequestPlans.get(planId, "workspace-1"),
      batch: await repos.ingestionBatches.get(planId, "workspace-1"),
      audits: await repos.audit.listForEntity("workspace-1", "data_request_plan", planId),
      idempotency: await repos.idempotency.get("workspace-1", key),
    }));
    expect(residue).toEqual({ plan: undefined, batch: undefined, audits: [], idempotency: undefined });
  }

  async function expectNoUpdateResidue(planId: string, keys: string[]): Promise<void> {
    const residue = await store.transaction(async (repos) => ({
      plan: await repos.dataRequestPlans.get(planId, "workspace-1"),
      audits: await repos.audit.listForEntity("workspace-1", "data_request_plan", planId),
      idempotency: await Promise.all(keys.map((key) => repos.idempotency.get("workspace-1", key))),
    }));
    expect(residue.plan?.version).toBe(1);
    expect(residue.audits).toHaveLength(1);
    expect(residue.idempotency).toEqual(keys.map(() => undefined));
  }

  beforeEach(async () => {
    store = openStore(":memory:");
    auditSequence = 0;
    service = new DataResearchService(
      store,
      { now: () => now },
      { next: () => `audit-${++auditSequence}` },
    );
    await store.transaction((repos) => repos.workspaces.insert(entity("workspace-1")));
  });

  afterEach(() => {
    store.close();
  });

  it("persists the deterministic first round with its quality report and audit", async () => {
    const plan = await service.planDataRequests({
      input: {
        id: "guided-plan",
        workspaceId: "workspace-1",
        objective: "Understand content performance",
        questionTypes: ["content_performance"],
        availableFields: ["content_id", "published_at"],
        batch: {
          datasets: [{
            source: { path: "/imports/content.csv", fileName: "content.csv", format: "csv", sizeBytes: 10 },
            fields: [{ name: "content_id", index: 0, inferredType: "string" }],
            rowsJsonl: "",
            quality: { rowCount: 0, columnCount: 1, duplicateRowCount: 0, emptyRowCount: 0, typeInconsistencyCount: 0 },
            issues: [],
          }],
        },
      },
      context: commandContext("plan"),
    });

    expect(plan).toMatchObject({
      id: "guided-plan",
      version: 1,
      state: "partial",
      round: 1,
      answerableQuestionTypes: [],
      qualityReports: [{ source: { fileName: "content.csv" }, issues: [] }],
    });
    expect(plan.questions[0]!.missingFields).toEqual(["impressions", "clicks"]);
    const persisted = await store.transaction(async (repos) => ({
      plan: await repos.dataRequestPlans.get("guided-plan", "workspace-1"),
      audit: await repos.audit.get("audit-1", "workspace-1"),
    }));
    expect(persisted.plan).toEqual(plan);
    expect(persisted.audit).toMatchObject({
      action: "data_request_plan.create",
      entityType: "data_request_plan",
      entityId: "guided-plan",
    });
  });

  it("does not request an answerable type when a complete batch has no declared available fields", async () => {
    const plan = await service.planDataRequests({
      input: {
        id: "complete-batch-plan",
        workspaceId: "workspace-1",
        objective: "Understand content performance",
        questionTypes: ["content_performance"],
        availableFields: [],
        batch: {
          datasets: [{
            source: { path: "/imports/content.csv", fileName: "content.csv", format: "csv", sizeBytes: 100 },
            fields: [
              { name: "content_id", index: 0, inferredType: "string" },
              { name: "published_at", index: 1, inferredType: "string" },
              { name: "impressions", index: 2, inferredType: "number" },
              { name: "clicks", index: 3, inferredType: "number" },
            ],
            rowsJsonl: '{"content_id":"content-1","published_at":"2026-10-26T12:00:00.000Z","impressions":10,"clicks":2}\n',
            quality: { rowCount: 1, columnCount: 4, duplicateRowCount: 0, emptyRowCount: 0, typeInconsistencyCount: 0 },
            issues: [],
          }],
        },
      },
      context: commandContext("complete-batch-plan"),
    });

    expect(plan).toMatchObject({
      state: "ready",
      answerableQuestionTypes: ["content_performance"],
      questions: [],
    });
    expect(plan.questions.map((question) => question.questionType))
      .not.toContain("content_performance");
  });

  it("reconciles imported fields into later source layers and questions without a decline", async () => {
    const created = await service.planDataRequests({
      input: {
        id: "guided-plan",
        workspaceId: "workspace-1",
        objective: "Understand content and conversion",
        questionTypes: ["content_performance", "conversion"],
        availableFields: [],
      },
      context: commandContext("plan"),
    });
    expect(created.questions[0]).toMatchObject({ sourceLayer: "content_identity" });

    const metrics = await service.reconcileDataRequests({
      input: {
        planId: created.id,
        workspaceId: "workspace-1",
        expectedPlanVersion: 1,
        availableFields: ["content_id", "published_at"],
      },
      context: commandContext("reconcile-metrics"),
    });
    expect(metrics).toMatchObject({ version: 2, round: 2 });
    expect(metrics.questions).toHaveLength(1);
    expect(metrics.questions[0]).toMatchObject({
      questionType: "content_performance",
      sourceLayer: "content_metrics",
      missingFields: ["impressions", "clicks"],
    });

    const conversion = await service.reconcileDataRequests({
      input: {
        planId: created.id,
        workspaceId: "workspace-1",
        expectedPlanVersion: 2,
        availableFields: ["impressions", "clicks"],
        batch: {
          datasets: [{
            source: { path: "/imports/performance.csv", fileName: "performance.csv", format: "csv", sizeBytes: 100 },
            fields: [
              { name: "content_id", index: 0, inferredType: "string" },
              { name: "published_at", index: 1, inferredType: "string" },
              { name: "impressions", index: 2, inferredType: "number" },
              { name: "clicks", index: 3, inferredType: "number" },
            ],
            rowsJsonl: '{"content_id":"content-1","published_at":"2026-10-26T12:00:00.000Z","impressions":10,"clicks":2}\n',
            quality: { rowCount: 1, columnCount: 4, duplicateRowCount: 0, emptyRowCount: 0, typeInconsistencyCount: 0 },
            issues: [],
          }],
        },
      },
      context: commandContext("reconcile-conversion"),
    });
    expect(conversion).toMatchObject({
      version: 3,
      round: 3,
      answerableQuestionTypes: ["content_performance"],
    });
    expect(conversion.questions).toHaveLength(1);
    expect(conversion.questions[0]).toMatchObject({
      questionType: "conversion",
      sourceLayer: "conversion_events",
      missingFields: ["conversion_id", "converted_at"],
    });
    expect(conversion.rounds.map((round) => round.questions[0]?.sourceLayer)).toEqual([
      "content_identity",
      "content_metrics",
      "conversion_events",
    ]);
  });

  it("allows declining an active question during the initial awaiting-data round", async () => {
    const created = await service.planDataRequests({
      input: {
        id: "guided-plan",
        workspaceId: "workspace-1",
        objective: "Understand content and conversion",
        questionTypes: ["content_performance", "conversion"],
        availableFields: [],
      },
      context: commandContext("plan"),
    });
    expect(created.state).toBe("awaiting_data");

    const declined = await service.declineDataRound({
      input: {
        planId: created.id,
        workspaceId: "workspace-1",
        expectedPlanVersion: 1,
        questionType: "content_performance",
        reason: "No content export is available",
      },
      context: commandContext("decline-awaiting"),
    });

    expect(declined).toMatchObject({
      state: "awaiting_data",
      answerableQuestionTypes: [],
      declinedQuestionTypes: ["content_performance"],
      limitations: ["content_performance: No content export is available"],
    });
    expect(declined.questions).toHaveLength(1);
    expect(declined.questions[0]).toMatchObject({
      questionType: "conversion",
      sourceLayer: "conversion_events",
    });
  });

  it("reduces answerable scope and records an explicit limitation when a round is declined", async () => {
    const created = await service.planDataRequests({
      input: {
        id: "guided-plan",
        workspaceId: "workspace-1",
        objective: "Measure conversion",
        questionTypes: ["conversion"],
        availableFields: ["conversion_id", "converted_at", "conversion_value"],
        batch: {
          datasets: [{
            source: { path: "/imports/conversions.csv", fileName: "conversions.csv", format: "csv", sizeBytes: 100 },
            fields: [
              { name: "conversion_id", index: 0, inferredType: "string" },
              { name: "converted_at", index: 1, inferredType: "string" },
              { name: "conversion_value", index: 2, inferredType: "number" },
            ],
            rowsJsonl: '{"conversion_id":"c-1","converted_at":"2026-10-26T12:00:00.000Z","conversion_value":20}\n',
            quality: { rowCount: 1, columnCount: 3, duplicateRowCount: 0, emptyRowCount: 0, typeInconsistencyCount: 0 },
            issues: [],
          }],
        },
      },
      context: commandContext("plan"),
    });

    const declined = await service.declineDataRound({
      input: {
        planId: created.id,
        workspaceId: "workspace-1",
        expectedPlanVersion: 1,
        questionType: "conversion",
        reason: "Conversion exports are not authorized",
      },
      context: commandContext("decline"),
    });

    expect(created.answerableQuestionTypes).toEqual(["conversion"]);
    expect(declined).toMatchObject({
      version: 2,
      state: "blocked",
      answerableQuestionTypes: [],
      declinedQuestionTypes: ["conversion"],
      limitations: ["conversion: Conversion exports are not authorized"],
    });
    await expect(
      store.transaction((repos) => repos.audit.get("audit-2", "workspace-1")),
    ).resolves.toMatchObject({ action: "data_request_plan.decline" });
  });

  it("rejects direct untrusted JavaScript input without plan, batch, audit, or idempotency residue", async () => {
    await expect(service.planDataRequests({
      input: {
        id: "bad-plan",
        workspaceId: "workspace-1",
        objective: "Bad input",
        questionTypes: ["conversion", "unknown"],
        availableFields: [],
      },
      context: commandContext("bad"),
    } as never)).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expectNoCreateResidue("bad-plan", "command-bad");

    const cases: [string, (batch: ReturnType<typeof parsedBatch>) => void][] = [
      ["bad-batch-plan", (batch) => { batch.datasets[0]!.source = { fileName: 42 } as never; }],
      ["bad-inferred-type", (batch) => { batch.datasets[0]!.fields[0]!.inferredType = "date" as never; }],
      ["bad-issue-code", (batch) => { batch.datasets[0]!.issues = [{ code: "UNTRUSTED_CODE", message: "Unknown" }] as never; }],
      ["bad-row-number", (batch) => { batch.datasets[0]!.issues = [{ code: "DUPLICATE_ROW", message: "Duplicate", rowNumber: 0 }] as never; }],
      ["bad-column-number", (batch) => { batch.datasets[0]!.issues = [{ code: "DUPLICATE_ROW", message: "Duplicate", columnNumber: -1 }] as never; }],
    ];
    for (const [id, corrupt] of cases) {
      const batch = parsedBatch();
      corrupt(batch);
      await expect(service.planDataRequests({
        input: {
          id,
          workspaceId: "workspace-1",
          objective: "Bad batch",
          questionTypes: ["conversion"],
          availableFields: [],
          batch,
        },
        context: commandContext(id),
      } as never)).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
      await expectNoCreateResidue(id, `command-${id}`);
    }
  });

  it("loads declines only from the same workspace and enforces the expected plan version", async () => {
    await service.planDataRequests({
      input: {
        id: "guided-plan",
        workspaceId: "workspace-1",
        objective: "Measure conversion",
        questionTypes: ["conversion"],
        availableFields: ["conversion_id", "converted_at", "conversion_value"],
      },
      context: commandContext("plan"),
    });
    await store.transaction((repos) => repos.workspaces.insert(entity("workspace-2", "workspace-2")));

    await expect(service.declineDataRound({
      input: {
        planId: "guided-plan",
        workspaceId: "workspace-2",
        expectedPlanVersion: 1,
        questionType: "conversion",
        reason: "Wrong workspace",
      },
      context: commandContext("cross-workspace"),
    })).rejects.toMatchObject<DomainError>({
      code: "NOT_FOUND",
      details: { planId: "guided-plan", workspaceId: "workspace-2" },
    });
    await expect(service.declineDataRound({
      input: {
        planId: "guided-plan",
        workspaceId: "workspace-1",
        expectedPlanVersion: 2,
        questionType: "conversion",
        reason: "Stale version",
      },
      context: commandContext("stale"),
    })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await expectNoUpdateResidue("guided-plan", ["command-cross-workspace", "command-stale"]);
  });
});

describe("DataResearchService atomic imports and evidence assets", () => {
  let tempDir: string;
  let importRoot: string;
  let artifactRoot: string;
  let store: Store;
  let service: DataResearchService;
  let sequence: number;
  let originalImportRoot: string | undefined;
  let originalArtifactRoot: string | undefined;

  const commandContext = (suffix: string): CommandContext => ({
    actor: "agent-1",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  });

  beforeEach(async () => {
    tempDir = await createTempDir();
    importRoot = await createTempDir();
    artifactRoot = await createTempDir();
    originalImportRoot = process.env.MARKETING_IMPORT_ROOT;
    originalArtifactRoot = process.env.MARKETING_ARTIFACT_DIR;
    process.env.MARKETING_IMPORT_ROOT = importRoot;
    process.env.MARKETING_ARTIFACT_DIR = artifactRoot;
    await Promise.all([
      copyFile(resolve("tests/fixtures/csv/marketing.csv"), join(importRoot, "marketing.csv")),
      copyFile(resolve("tests/fixtures/xlsx/marketing.xlsx"), join(importRoot, "marketing.xlsx")),
      writeFile(join(importRoot, "broken.csv"), Buffer.from([0xff, 0xfe, 0xfd])),
    ]);
    store = openStore(join(tempDir, "store.db"));
    sequence = 0;
    service = new DataResearchService(
      store,
      { now: () => now },
      { next: () => `generated-${++sequence}` },
    );
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(entity("workspace-1"));
      await repos.workspaces.insert(entity("workspace-2", "workspace-2"));
    });
  });

  afterEach(async () => {
    store.close();
    vi.mocked(readFile).mockReset();
    if (originalImportRoot === undefined) {
      delete process.env.MARKETING_IMPORT_ROOT;
    } else {
      process.env.MARKETING_IMPORT_ROOT = originalImportRoot;
    }
    if (originalArtifactRoot === undefined) {
      delete process.env.MARKETING_ARTIFACT_DIR;
    } else {
      process.env.MARKETING_ARTIFACT_DIR = originalArtifactRoot;
    }
    await Promise.all([removeTempDir(tempDir), removeTempDir(importRoot), removeTempDir(artifactRoot)]);
  });

  function importCommand(id: string, paths: string[], extra: Record<string, unknown> = {}) {
    return {
      input: { id, workspaceId: "workspace-1", paths, ...extra },
      context: commandContext(id),
    };
  }

  it("creates one Source per file and Dataset/Evidence/assets per sheet with exact replay", async () => {
    const plan = await service.planDataRequests({
      input: {
        id: "import-plan",
        workspaceId: "workspace-1",
        objective: "Understand imported performance",
        questionTypes: ["content_performance"],
        availableFields: [],
      },
      context: commandContext("import-plan"),
    });
    const command = importCommand("import-complete", ["marketing.csv", "marketing.xlsx"], {
      planId: plan.id,
      expectedPlanVersion: 1,
    });

    const batch = await service.importFiles(command);
    expect(batch).toMatchObject({ state: "completed", failures: [] });
    expect(batch.sourceIds).toHaveLength(2);
    expect(batch.datasetIds).toHaveLength(3);
    expect(batch.evidenceIds).toHaveLength(3);

    const graph = await store.transaction(async (repos) => ({
      sources: await Promise.all(batch.sourceIds.map((id) => repos.sources.get(id, "workspace-1"))),
      datasets: await Promise.all(batch.datasetIds.map((id) => repos.datasets.get(id, "workspace-1"))),
      evidence: await Promise.all(batch.evidenceIds.map((id) => repos.evidence.get(id, "workspace-1"))),
      updatedPlan: await repos.dataRequestPlans.get(plan.id, "workspace-1"),
    }));
    expect(graph.datasets.map((dataset) => dataset?.sourceId)).toEqual([
      batch.sourceIds[0], batch.sourceIds[1], batch.sourceIds[1],
    ]);
    expect(graph.datasets.map((dataset) => dataset?.name)).toEqual([
      "marketing.csv", "marketing.xlsx#Leads", "marketing.xlsx#Spend",
    ]);
    for (const evidence of graph.evidence) {
      const assets = evidence?.assets as { kind: string; byteLength: number; contentHash: string }[];
      expect(assets.map((asset) => asset.kind)).toEqual(["original", "normalized_jsonl", "quality_report"]);
      expect(assets.every((asset) => asset.byteLength > 0 && /^[0-9a-f]{64}$/.test(asset.contentHash))).toBe(true);
    }
    expect(graph.updatedPlan).toMatchObject({ version: 2, round: 2 });
    expect(graph.updatedPlan?.availableFields).toEqual(expect.arrayContaining(["name", "channel", "amount"]));

    await expect(service.importFiles(command)).resolves.toEqual(batch);
    const raw = new DatabaseSync(join(tempDir, "store.db"));
    try {
      for (const table of ["sources", "datasets", "evidence", "ingestion_batches"]) {
        expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: table === "sources" ? 2 : table === "datasets" || table === "evidence" ? 3 : 1 });
      }
    } finally {
      raw.close();
    }

    const original = (graph.evidence[0]!.assets as { id: string; kind: string }[])
      .find((asset) => asset.kind === "original")!;
    const content = await service.getEvidenceAsset({
      workspaceId: "workspace-1",
      evidenceId: batch.evidenceIds[0]!,
      assetId: original.id,
    });
    expect(content.content).toEqual(readFileSync(join(importRoot, "marketing.csv")));
    expect(content.kind).toBe("original");
    await expect(service.getEvidenceAsset({
      workspaceId: "workspace-2",
      evidenceId: batch.evidenceIds[0]!,
      assetId: original.id,
    })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    await expect(service.getEvidenceAsset({
      workspaceId: "workspace-1",
      evidenceId: batch.evidenceIds[0]!,
      assetId: "../../marketing.csv",
    })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
  });

  it("stores original bytes from the same safe import snapshot as normalized rows", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from("name\nForged replacement\n"));
    const batch = await service.importFiles(importCommand("import-snapshot", ["marketing.csv"]));
    const evidence = await store.transaction((repos) =>
      repos.evidence.get(batch.evidenceIds[0]!, "workspace-1")
    );
    const assets = evidence!.assets as { id: string; kind: string }[];
    const original = assets.find((asset) => asset.kind === "original")!;
    const normalized = assets.find((asset) => asset.kind === "normalized_jsonl")!;

    const originalContent = await service.getEvidenceAsset({
      workspaceId: "workspace-1",
      evidenceId: evidence!.id,
      assetId: original.id,
    });
    const normalizedContent = await service.getEvidenceAsset({
      workspaceId: "workspace-1",
      evidenceId: evidence!.id,
      assetId: normalized.id,
    });
    expect(originalContent.content).toEqual(readFileSync(join(importRoot, "marketing.csv")));
    expect(normalizedContent.content.toString("utf8")).toContain("Acme, Inc");
    expect(normalizedContent.content.toString("utf8")).not.toContain("Forged replacement");
  });

  it("replays without source or artifact I/O after the original files become unavailable", async () => {
    const command = importCommand("replay-without-io", ["marketing.csv"]);
    const first = await service.importFiles(command);
    vi.mocked(readFile).mockClear();
    await unlink(join(importRoot, "marketing.csv"));
    process.env.MARKETING_IMPORT_ROOT = join(tempDir, "missing-import-root");
    process.env.MARKETING_ARTIFACT_DIR = join(tempDir, "missing-artifact-root");

    await expect(service.importFiles(command)).resolves.toEqual(first);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects same-key different input before creating any artifact", async () => {
    await writeFile(join(importRoot, "extra.csv"), "name\nExtra\n");
    const command = importCommand("replay-conflict", ["marketing.csv"]);
    await service.importFiles(command);
    const conflictArtifacts = await createTempDir();
    process.env.MARKETING_ARTIFACT_DIR = conflictArtifacts;
    try {
      await expect(service.importFiles({
        ...command,
        input: { ...command.input, paths: ["extra.csv"] },
      })).rejects.toMatchObject<DomainError>({ code: "IDEMPOTENCY_CONFLICT" });
      expect(await readdir(conflictArtifacts)).toEqual([]);
    } finally {
      await removeTempDir(conflictArtifacts);
    }
  });

  it("persists successful files as partial and records a blocked batch when every file fails", async () => {
    const partial = await service.importFiles(importCommand("import-partial", ["marketing.csv", "broken.csv"]));
    expect(partial).toMatchObject({ state: "partial" });
    expect(partial.sourceIds).toHaveLength(1);
    expect(partial.datasetIds).toHaveLength(1);
    expect(partial.evidenceIds).toHaveLength(1);
    expect(partial.failures).toEqual([{ path: "broken.csv", message: expect.stringMatching(/UTF-8/) }]);

    const blocked = await service.importFiles(importCommand("import-blocked", ["broken.csv"]));
    expect(blocked).toMatchObject({
      state: "blocked",
      sourceIds: [],
      datasetIds: [],
      evidenceIds: [],
    });
    expect(blocked.failures).toHaveLength(1);
  });

  it("enforces batch-wide ingestion limits while isolating per-file failures", async () => {
    await writeFile(join(importRoot, "extra.csv"), "name\nExtra\n");
    const partial = await service.importFiles(importCommand(
      "import-row-limit",
      ["marketing.csv", "extra.csv"],
      { limits: { maxRows: 2 } },
    ));
    expect(partial.state).toBe("partial");
    expect(partial.sourceIds).toHaveLength(1);
    expect(partial.failures).toEqual([{ path: "extra.csv", message: expect.stringMatching(/row limit/) }]);

    await expect(service.importFiles(importCommand(
      "import-file-limit",
      ["marketing.csv", "extra.csv"],
      { limits: { maxFiles: 1 } },
    ))).rejects.toThrow("file limit");
    await expect(
      store.transaction((repos) => repos.ingestionBatches.get("import-file-limit", "workspace-1")),
    ).resolves.toBeUndefined();
  });

  it("rolls back the whole graph, plan, audit, and idempotency record on an injected database failure", async () => {
    const plan = await service.planDataRequests({
      input: {
        id: "rollback-plan",
        workspaceId: "workspace-1",
        objective: "Measure conversion",
        questionTypes: ["conversion"],
        availableFields: [],
      },
      context: commandContext("rollback-plan"),
    });
    const failingStore: Store = {
      close: () => store.close(),
      transaction: (work) => store.transaction(async (repos) => work({
        ...repos,
        ingestionBatches: {
          ...repos.ingestionBatches,
          insert: () => Promise.reject(new Error("injected batch insert failure")),
        },
      })),
    };
    const failing = new DataResearchService(
      failingStore,
      { now: () => now },
      { next: () => `failure-${++sequence}` },
    );

    await expect(failing.importFiles(importCommand("import-rollback", ["marketing.csv"], {
      planId: plan.id,
      expectedPlanVersion: 1,
    }))).rejects.toThrow("injected batch insert failure");
    const residue = await store.transaction(async (repos) => ({
      batch: await repos.ingestionBatches.get("import-rollback", "workspace-1"),
      plan: await repos.dataRequestPlans.get(plan.id, "workspace-1"),
      audits: await repos.audit.listForEntity("workspace-1", "ingestion_batch", "import-rollback"),
      idempotency: await repos.idempotency.get("workspace-1", "command-import-rollback"),
    }));
    expect(residue).toEqual({ batch: undefined, plan, audits: [], idempotency: undefined });
    const raw = new DatabaseSync(join(tempDir, "store.db"));
    try {
      for (const table of ["sources", "datasets", "evidence"]) {
        expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    } finally {
      raw.close();
    }
  });

  it("rejects assets supplied through the public evidence_record command", async () => {
    const marketing = new MarketingService(store, { now: () => now }, { next: () => `public-${++sequence}` });
    await marketing.registerSource({
      input: {
        id: "public-source",
        workspaceId: "workspace-1",
        name: "Public source",
        type: "manual",
        ownership: "owned",
      },
      context: commandContext("public-source"),
    });

    await expect(marketing.recordEvidence({
      input: {
        id: "forged-evidence",
        workspaceId: "workspace-1",
        sourceId: "public-source",
        sourceLocator: "manual",
        observedAt: now,
        summary: "Forged assets must not be accepted",
        contentHash: "a".repeat(64),
        classification: "owned_operating",
        assets: [{ id: "forged", kind: "original", contentHash: "a".repeat(64), byteLength: 1 }],
      },
      context: commandContext("forged-evidence"),
    } as never)).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expect(
      store.transaction((repos) => repos.evidence.get("forged-evidence", "workspace-1")),
    ).resolves.toBeUndefined();
  });

  function apiCommand(id: string, url: string, extra: Record<string, unknown> = {}) {
    return {
      input: {
        id,
        workspaceId: "workspace-1",
        url,
        ownership: "owned" as const,
        expiresAt: "2026-10-26T13:00:00.000Z",
        ...extra,
      },
      context: commandContext(id),
    };
  }

  function apiService(): DataResearchService {
    return new DataResearchService(
      store,
      { now: () => now },
      { next: () => `api-${++sequence}` },
      new ArtifactStore(),
      new SafeHttpClient({
        allowlist: ["127.0.0.1"],
        credentialAllowlist: ["TEMPORARY_API_TOKEN"],
        env: { TEMPORARY_API_TOKEN: "database-secret-must-not-leak" },
        now: () => now,
      }),
    );
  }

  async function withApiServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
    run: (url: string, hits: () => number) => Promise<void>,
  ): Promise<void> {
    let hits = 0;
    const server = createServer((request, response) => {
      hits += 1;
      handler(request, response);
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`, () => hits);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }

  it("ingests JSON through real authenticated HTTP and atomically reconciles its quality graph", async () => {
    const plan = await service.planDataRequests({
      input: {
        id: "api-plan",
        workspaceId: "workspace-1",
        objective: "Understand API performance",
        questionTypes: ["content_performance"],
        availableFields: [],
      },
      context: commandContext("api-plan"),
    });
    const payload = JSON.stringify([{
      content_id: "content-1",
      published_at: "2026-10-26T12:00:00.000Z",
      impressions: 10,
      clicks: 2,
    }]);

    await withApiServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer database-secret-must-not-leak");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(payload);
    }, async (url) => {
      const batch = await apiService().ingestTemporaryApi(apiCommand("api-json", `${url}/metrics`, {
        credentialRef: "env:TEMPORARY_API_TOKEN",
        planId: plan.id,
        expectedPlanVersion: 1,
      }));
      expect(batch).toMatchObject({ state: "completed", failures: [] });
      expect(batch.sourceIds).toHaveLength(1);
      expect(batch.datasetIds).toHaveLength(1);
      expect(batch.evidenceIds).toHaveLength(1);

      const graph = await store.transaction(async (repos) => ({
        source: await repos.sources.get(batch.sourceIds[0]!, "workspace-1"),
        dataset: await repos.datasets.get(batch.datasetIds[0]!, "workspace-1"),
        evidence: await repos.evidence.get(batch.evidenceIds[0]!, "workspace-1"),
        plan: await repos.dataRequestPlans.get(plan.id, "workspace-1"),
        audit: await repos.audit.listForEntity("workspace-1", "ingestion_batch", batch.id),
      }));
      expect(graph.source).toMatchObject({ type: "api", ownership: "owned" });
      expect(graph.dataset).toMatchObject({
        name: "metrics.json",
        coverageStart: "2026-10-26T12:00:00.000Z",
        coverageEnd: "2026-10-26T12:00:00.000Z",
        quality: { rowCount: 1, columnCount: 4, missingCellCount: 0 },
      });
      expect(graph.plan).toMatchObject({ version: 2, round: 2, answerableQuestionTypes: ["content_performance"] });
      expect(graph.plan?.qualityReports).toHaveLength(1);
      expect(graph.audit).toHaveLength(1);
      const assets = graph.evidence?.assets as { id: string; kind: string }[];
      expect(assets.map((asset) => asset.kind)).toEqual(["api_response", "normalized_jsonl", "quality_report"]);
      const original = assets.find((asset) => asset.kind === "api_response")!;
      const content = await apiService().getEvidenceAsset({
        workspaceId: "workspace-1",
        evidenceId: batch.evidenceIds[0]!,
        assetId: original.id,
      });
      expect(content.content.toString("utf8")).toBe(payload);

      const raw = new DatabaseSync(join(tempDir, "store.db"));
      try {
        const persisted = [
          ...raw.prepare("SELECT payload FROM sources").all(),
          ...raw.prepare("SELECT payload FROM evidence").all(),
          ...raw.prepare("SELECT details FROM audit_records").all(),
        ];
        expect(JSON.stringify(persisted)).not.toContain("database-secret-must-not-leak");
      } finally {
        raw.close();
      }
    });
  });

  it("ingests authorized CSV responses with normalized rows and quality artifacts", async () => {
    await withApiServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
      response.end("name,amount\nAcme,12\nAcme,12\n");
    }, async (url) => {
      const batch = await apiService().ingestTemporaryApi(apiCommand("api-csv", `${url}/export.csv`, {
        ownership: "authorized",
      }));
      const graph = await store.transaction(async (repos) => ({
        source: await repos.sources.get(batch.sourceIds[0]!, "workspace-1"),
        dataset: await repos.datasets.get(batch.datasetIds[0]!, "workspace-1"),
      }));
      expect(graph.source?.ownership).toBe("authorized");
      expect(graph.dataset).toMatchObject({
        name: "export.csv",
        quality: { rowCount: 2, duplicateRowCount: 1 },
      });
    });
  });

  it("normalizes missing keys to null across a union of flat JSON object keys", async () => {
    await withApiServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('[{"a":1},{"b":2}]');
    }, async (url) => {
      const batch = await apiService().ingestTemporaryApi(apiCommand("api-sparse-json", `${url}/data`));
      const evidence = await store.transaction((repos) =>
        repos.evidence.get(batch.evidenceIds[0]!, "workspace-1")
      );
      const dataset = await store.transaction((repos) =>
        repos.datasets.get(batch.datasetIds[0]!, "workspace-1")
      );
      const normalized = (evidence?.assets as { id: string; kind: string }[])
        .find((asset) => asset.kind === "normalized_jsonl")!;
      const content = await apiService().getEvidenceAsset({
        workspaceId: "workspace-1",
        evidenceId: evidence!.id,
        assetId: normalized.id,
      });
      expect(content.content.toString("utf8")).toBe('{"a":"1","b":""}\n{"a":"","b":"2"}\n');
      expect(dataset?.quality).toMatchObject({ rowCount: 2, columnCount: 2, emptyRowCount: 0 });
    });
  });

  it("accepts explicit null JSON values in empty-row quality statistics", async () => {
    await withApiServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('[{"a":1},{"a":null}]');
    }, async (url) => {
      const batch = await apiService().ingestTemporaryApi(apiCommand("api-null-json", `${url}/data`));
      const evidence = await store.transaction((repos) =>
        repos.evidence.get(batch.evidenceIds[0]!, "workspace-1")
      );
      const dataset = await store.transaction((repos) =>
        repos.datasets.get(batch.datasetIds[0]!, "workspace-1")
      );
      const normalized = (evidence?.assets as { id: string; kind: string }[])
        .find((asset) => asset.kind === "normalized_jsonl")!;
      const content = await apiService().getEvidenceAsset({
        workspaceId: "workspace-1",
        evidenceId: evidence!.id,
        assetId: normalized.id,
      });
      expect(content.content.toString("utf8")).toBe('{"a":"1"}\n{"a":""}\n');
      expect(dataset?.quality).toMatchObject({ rowCount: 2, emptyRowCount: 1 });
    });
  });

  it("continues to reject nested JSON objects and arrays", async () => {
    for (const [id, payload] of [["object", { nested: true }], ["array", [1]]] as const) {
      await withApiServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ a: payload }]));
      }, async (url) => {
        await expect(apiService().ingestTemporaryApi(apiCommand(`api-nested-${id}`, `${url}/data`)))
          .rejects.toThrow(/scalar values/i);
        await expect(store.transaction((repos) =>
          repos.ingestionBatches.get(`api-nested-${id}`, "workspace-1")
        )).resolves.toBeUndefined();
      });
    }
  });

  it("replays and detects conflicts before temporary API network or artifact I/O", async () => {
    let command: ReturnType<typeof apiCommand>;
    let first: IngestionBatch;
    await withApiServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('[{"name":"Acme"}]');
    }, async (url, hits) => {
      command = apiCommand("api-replay", `${url}/data`);
      first = await apiService().ingestTemporaryApi(command);
      expect(hits()).toBe(1);
    });

    process.env.MARKETING_ARTIFACT_DIR = join(tempDir, "missing-artifact-root");
    await expect(apiService().ingestTemporaryApi(command!)).resolves.toEqual(first!);
    await expect(apiService().ingestTemporaryApi({
      ...command!,
      input: { ...command!.input, url: "http://127.0.0.1:1/conflict" },
    })).rejects.toMatchObject<DomainError>({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects plaintext credentials and non-owned API sources before network I/O", async () => {
    await withApiServer((_request, response) => response.end("unexpected"), async (url, hits) => {
      await expect(apiService().ingestTemporaryApi(apiCommand("api-plaintext", `${url}/data`, {
        credential: "database-secret-must-not-leak",
      }) as never)).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
      await expect(apiService().ingestTemporaryApi(apiCommand("api-public", `${url}/data`, {
        ownership: "external_public",
      }) as never)).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
      expect(hits()).toBe(0);
    });
  });
});

describe("DataResearchService permission-bounded research", () => {
  const seed = "https://example.com/research/start";
  let store: Store;
  let artifacts: ArtifactStore;
  let artifactRoot: string;
  let provider: FakeAcquisitionProvider;
  let service: DataResearchService;
  let sequence: number;

  class FakeAcquisitionProvider implements AcquisitionProvider {
    readonly pages = new Map<string, AcquiredPage>();
    readonly failures = new Map<string, Error>();
    readonly hits: string[] = [];
    delayMs = 0;

    add(url: string, links: string[] = [], text = `Observed ${url}`): void {
      this.pages.set(new URL(url).href, {
        url: new URL(url).href,
        finalUrl: new URL(url).href,
        title: `Title ${new URL(url).pathname}`,
        text,
        fields: {},
        links,
        screenshot: Buffer.from(`screenshot:${url}`),
        provider: "playwright",
        toolVersion: "fixture-1",
      });
    }

    async acquire(request: { url: string }): Promise<AcquiredPage> {
      this.hits.push(request.url);
      if (this.delayMs > 0) {
        await new Promise((resolveWait) => setTimeout(resolveWait, this.delayMs));
      }
      const failure = this.failures.get(new URL(request.url).href);
      if (failure) {
        throw failure;
      }
      const page = this.pages.get(new URL(request.url).href);
      if (!page) {
        throw new Error(`Unexpected acquisition: ${request.url}`);
      }
      return { ...page, url: request.url };
    }
  }

  function context(suffix: string): CommandContext {
    return { actor: "agent-1", requestId: `request-${suffix}`, idempotencyKey: `command-${suffix}` };
  }

  function createCommand(id: string, extra: Record<string, unknown> = {}) {
    return {
      input: {
        id,
        workspaceId: "workspace-1",
        goal: "Map public competitor evidence",
        seeds: [seed],
        expansion: true,
        scope: {
          hosts: ["example.com"],
          pathPrefixes: ["/research"],
          maxDepth: 2,
          maxPages: 10,
          maxDurationMs: 1_000,
          maxBytes: 100_000,
        },
        ...extra,
      },
      context: context(`${id}-create`),
    };
  }

  async function create(id: string, extra: Record<string, unknown> = {}): Promise<ResearchSession> {
    return service.createResearchSession(createCommand(id, extra));
  }

  function permissionCommand(id: string, expectedVersion: number, expansion: "allowed" | "denied") {
    return {
      input: { id, workspaceId: "workspace-1", expectedVersion, expansion },
      context: context(`${id}-${expansion}`),
    };
  }

  function runCommand(id: string, expectedVersion: number, limits: Record<string, number> = {}) {
    return {
      input: { id, workspaceId: "workspace-1", expectedVersion, limits },
      context: context(`${id}-run`),
    };
  }

  beforeEach(async () => {
    store = openStore(":memory:");
    artifactRoot = await createTempDir();
    artifacts = new ArtifactStore(artifactRoot);
    provider = new FakeAcquisitionProvider();
    provider.add(seed, [
      `${seed}#cycle`,
      "https://example.com/research/child?b=2&a=1#fragment",
      "https://other.example/research/off-host",
      "https://example.com/outside/off-path",
    ]);
    provider.add("https://example.com/research/child?b=2&a=1", [
      "https://example.com/research/grand",
      "https://example.com/research/child?b=2&a=1#duplicate",
    ]);
    provider.add("https://example.com/research/grand", ["https://example.com/research/too-deep"]);
    provider.add("https://example.com/research/too-deep");
    sequence = 0;
    service = new DataResearchService(
      store,
      { now: () => now },
      { next: () => `research-${++sequence}` },
      artifacts,
      undefined,
      provider,
    );
    await store.transaction((repos) => repos.workspaces.insert(entity("workspace-1")));
  });

  afterEach(async () => {
    store.close();
    await removeTempDir(artifactRoot);
  });

  it("does not expand before permission or after denial, while still processing seeds", async () => {
    const awaiting = await create("awaiting-research");
    expect(awaiting).toMatchObject({ expansion: "awaiting_permission", state: "awaiting_permission" });
    expect(await store.transaction((repos) => repos.researchSessions.get(awaiting.id, "workspace-1"))).toEqual(awaiting);

    const unapproved = await service.runResearch(runCommand(awaiting.id, 1));
    expect(unapproved).toMatchObject({
      expansion: "awaiting_permission",
      state: "partial",
      stopReason: "permission_required",
    });
    expect(unapproved.evidenceIds).toHaveLength(1);
    expect(provider.hits).toEqual([seed]);

    const deniedSession = await create("denied-research");
    const denied = await service.setResearchPermission(permissionCommand(deniedSession.id, 1, "denied"));
    expect(denied).toMatchObject({ expansion: "denied", state: "ready" });
    const result = await service.runResearch(runCommand(deniedSession.id, 2));
    expect(result).toMatchObject({ expansion: "denied", state: "completed", stopReason: "permission_denied" });
    expect(result.evidenceIds).toHaveLength(1);
    expect(provider.hits).toEqual([seed, seed]);
  });

  it("accepts maxDepth zero at create and run for seed-only research", async () => {
    const created = await create("seed-only-research", {
      scope: {
        hosts: ["example.com"],
        pathPrefixes: ["/research"],
        maxDepth: 0,
        maxPages: 10,
        maxDurationMs: 1_000,
        maxBytes: 100_000,
      },
    });
    expect(created).toMatchObject({ state: "awaiting_permission", limits: { maxDepth: 0 } });
    await service.setResearchPermission(permissionCommand(created.id, 1, "allowed"));

    const result = await service.runResearch(runCommand(created.id, 2, { maxDepth: 0 }));
    expect(result).toMatchObject({ state: "partial", stopReason: "max_depth", limits: { maxDepth: 0 } });
    expect(result.evidenceIds).toHaveLength(1);
    expect(provider.hits).toEqual([seed]);
  });

  it("crawls only approved in-scope canonical URLs within depth and replays without browsing", async () => {
    const created = await create("allowed-research", { seeds: [`${seed}#first`, seed] });
    await service.setResearchPermission(permissionCommand(created.id, 1, "allowed"));
    const command = runCommand(created.id, 2);

    const result = await service.runResearch(command);
    expect(result).toMatchObject({ state: "partial", stopReason: "max_depth" });
    expect(result.evidenceIds).toHaveLength(3);
    expect(provider.hits).toEqual([
      seed,
      "https://example.com/research/child?b=2&a=1",
      "https://example.com/research/grand",
    ]);

    const evidence = await store.transaction(async (repos) => Promise.all(
      result.evidenceIds.map((id) => repos.evidence.get(id, "workspace-1")),
    ));
    expect(evidence.every((item) => item?.classification === "external_observation")).toBe(true);
    expect(evidence.map((item) => item?.sourceLocator)).toEqual([
      seed,
      "https://example.com/research/child?b=2&a=1",
      "https://example.com/research/grand",
    ]);

    await expect(service.runResearch(command)).resolves.toEqual(result);
    expect(provider.hits).toHaveLength(3);
  });

  it("accepts the 20 MiB research ceiling and rejects one byte above it before I/O", async () => {
    const scope = {
      hosts: ["example.com"], pathPrefixes: ["/research"], maxDepth: 2,
      maxPages: 10, maxDurationMs: 1_000, maxBytes: 20 * 1024 * 1024,
    };
    const accepted = await create("byte-ceiling", { scope });
    expect(accepted.limits.maxBytes).toBe(20 * 1024 * 1024);

    await expect(create("byte-ceiling-exceeded", {
      scope: { ...scope, maxBytes: 20 * 1024 * 1024 + 1 },
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    expect(provider.hits).toEqual([]);
    await expect(store.transaction((repos) =>
      repos.researchSessions.get("byte-ceiling-exceeded", "workspace-1")
    )).resolves.toBeUndefined();
  });

  it("lets callers lower page limits but rejects raising configured ceilings before I/O", async () => {
    const created = await create("limited-research");
    await service.setResearchPermission(permissionCommand(created.id, 1, "allowed"));

    const limited = await service.runResearch(runCommand(created.id, 2, { maxPages: 1, maxDepth: 1 }));
    expect(limited).toMatchObject({ stopReason: "max_pages" });
    expect(limited.evidenceIds).toHaveLength(1);
    expect(provider.hits).toEqual([seed]);

    const rejected = await create("excessive-research", {
      scope: {
        hosts: ["example.com"], pathPrefixes: ["/research"], maxDepth: 2,
        maxPages: 1_000_000, maxDurationMs: 1_000, maxBytes: 100_000,
      },
    }).catch((error: unknown) => error);
    expect(rejected).toMatchObject({ code: "INVALID_INPUT" });

    const excessiveRun = await create("excessive-run");
    await service.setResearchPermission(permissionCommand(excessiveRun.id, 1, "allowed"));
    const hits = provider.hits.length;
    await expect(service.runResearch(runCommand(excessiveRun.id, 2, { maxPages: 11 })))
      .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    expect(provider.hits).toHaveLength(hits);
  });

  it("continues an awaiting session from retained seeds after permission and rejects stale versions", async () => {
    const created = await create("continuation-research");
    const seeds = await service.runResearch(runCommand(created.id, 1));
    expect(seeds).toMatchObject({ expansion: "awaiting_permission", stopReason: "permission_required" });
    expect(seeds.evidenceIds).toHaveLength(1);
    expect(provider.hits).toEqual([seed]);

    await expect(service.setResearchPermission(permissionCommand(created.id, 1, "allowed")))
      .rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    const allowed = await service.setResearchPermission(permissionCommand(created.id, 2, "allowed"));
    expect(allowed).toMatchObject({ version: 3, state: "ready", evidenceIds: seeds.evidenceIds });
    const continued = await service.runResearch({
      ...runCommand(created.id, 3),
      context: context("continuation-research-expand"),
    });
    expect(continued).toMatchObject({ expansion: "allowed", state: "partial", stopReason: "max_depth" });
    expect(continued.evidenceIds).toHaveLength(3);
    expect(continued.evidenceIds.slice(0, 1)).toEqual(seeds.evidenceIds);
    expect(provider.hits).toEqual([
      seed,
      "https://example.com/research/child?b=2&a=1",
      "https://example.com/research/grand",
    ]);
  });

  it("keeps an awaiting seed run seed-only when permission is subsequently denied", async () => {
    const created = await create("denied-continuation");
    const seeds = await service.runResearch(runCommand(created.id, 1));
    expect(seeds.evidenceIds).toHaveLength(1);
    await service.setResearchPermission(permissionCommand(created.id, 2, "denied"));

    const result = await service.runResearch({
      ...runCommand(created.id, 3),
      context: context("denied-continuation-final"),
    });
    expect(result).toMatchObject({ state: "completed", stopReason: "permission_denied" });
    expect(result.evidenceIds).toEqual(seeds.evidenceIds);
    expect(provider.hits).toEqual([seed]);
  });

  it("turns per-page artifact failures into gaps without rolling back other pages", async () => {
    const failed = "https://example.com/research/artifact-failure";
    provider.add(failed);
    const failingArtifacts = new ArtifactStore(artifactRoot);
    const put = failingArtifacts.put.bind(failingArtifacts);
    vi.spyOn(failingArtifacts, "put").mockImplementation(async (content) => {
      if (Buffer.from(content).includes(Buffer.from("artifact-failure"))) {
        throw new Error("injected artifact failure");
      }
      return put(content);
    });
    service = new DataResearchService(
      store, { now: () => now }, { next: () => `artifact-${++sequence}` },
      failingArtifacts, undefined, provider,
    );
    const created = await create("artifact-partial", { seeds: [seed, failed], expansion: false });

    const result = await service.runResearch(runCommand(created.id, 1));
    expect(result).toMatchObject({ state: "partial" });
    expect(result.evidenceIds).toHaveLength(1);
    expect(result.gaps).toEqual([{
      url: failed,
      reason: "artifact_failed",
      message: "injected artifact failure",
    }]);
  });

  it("charges candidate payload bytes across multiple pages before retaining evidence", async () => {
    const second = "https://example.com/research/grand";
    provider.add(seed, [], "x".repeat(100));
    provider.add(second, [], "y".repeat(100));
    const created = await create("multi-page-bytes", {
      seeds: [seed, second], expansion: false,
      scope: {
        hosts: ["example.com"], pathPrefixes: ["/research"], maxDepth: 2,
        maxPages: 10, maxDurationMs: 1_000, maxBytes: 200,
      },
    });

    const result = await service.runResearch(runCommand(created.id, 1));
    expect(result).toMatchObject({ state: "partial", stopReason: "max_bytes" });
    expect(result.evidenceIds).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ url: second, reason: "max_bytes" });
    expect(provider.hits).toEqual([seed, second]);
  });

  it("includes a failed MCP candidate and successful fallback in session candidateBytes", async () => {
    const mcp: AcquisitionProvider = {
      acquire: async () => {
        throw new DomainError("CAPABILITY_UNAVAILABLE", "MCP failed after reading", false, { payloadBytes: 40 });
      },
    };
    const fallback: AcquisitionProvider = {
      acquire: async () => ({
        url: seed, finalUrl: seed, title: "Fallback", text: "ok", fields: {},
        screenshot: Buffer.from("12345"), provider: "playwright", toolVersion: "fake",
      }),
    };
    service = new DataResearchService(
      store, { now: () => now }, { next: () => `router-${++sequence}` }, artifacts, undefined,
      new AcquisitionRouter({ mcp, playwright: fallback }),
    );
    const created = await create("router-fallback-bytes", { expansion: false });

    const result = await service.runResearch(runCommand(created.id, 1));
    expect(result).toMatchObject({ state: "completed", candidateBytes: 47 });
    expect(result.evidenceIds).toHaveLength(1);
  });

  it("preserves failed MCP and timed-out fallback candidate bytes in session candidateBytes", async () => {
    const mcp: AcquisitionProvider = {
      acquire: async () => {
        throw new DomainError("CAPABILITY_UNAVAILABLE", "MCP failed after reading", false, { payloadBytes: 40 });
      },
    };
    const fallback: AcquisitionProvider = {
      acquire: async () => {
        throw new DomainError("CAPABILITY_UNAVAILABLE", "Fallback timed out after reading", false, {
          reason: "max_duration", payloadBytes: 5,
        });
      },
    };
    service = new DataResearchService(
      store, { now: () => now }, { next: () => `timeout-${++sequence}` }, artifacts, undefined,
      new AcquisitionRouter({ mcp, playwright: fallback }),
    );
    const created = await create("router-timeout-bytes", { expansion: false });

    const result = await service.runResearch(runCommand(created.id, 1));
    expect(result).toMatchObject({ state: "blocked", stopReason: "max_duration", candidateBytes: 45 });
    expect(result.evidenceIds).toEqual([]);
    expect(result.gaps[0]).toMatchObject({ url: seed, reason: "max_duration" });
  });

  it("rejects encoded separators and decoded dot segments in scope and seed paths", async () => {
    for (const [index, path] of ["/research/%2foutside", "/research/%5coutside", "/research/%2e%2e/outside"].entries()) {
      await expect(create(`unsafe-path-${index}`, { seeds: [`https://example.com${path}`] }))
        .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    }
    await expect(create("unsafe-scope", {
      scope: {
        hosts: ["example.com"], pathPrefixes: ["/research/%2e%2e"], maxDepth: 2,
        maxPages: 10, maxDurationMs: 1_000, maxBytes: 100_000,
      },
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    expect(provider.hits).toEqual([]);
  });

  it("enforces cumulative byte and elapsed-time ceilings and records the stop reason", async () => {
    const byteSession = await create("byte-research");
    await service.setResearchPermission(permissionCommand(byteSession.id, 1, "allowed"));
    const byteLimited = await service.runResearch(runCommand(byteSession.id, 2, { maxBytes: 1 }));
    expect(byteLimited).toMatchObject({ state: "blocked", stopReason: "max_bytes" });
    expect(byteLimited.evidenceIds).toEqual([]);
    expect(byteLimited.gaps[0]).toMatchObject({ url: seed, reason: "max_bytes" });

    const timeSession = await create("time-research");
    await service.setResearchPermission(permissionCommand(timeSession.id, 1, "allowed"));
    provider.delayMs = 5;
    const timeLimited = await service.runResearch(runCommand(timeSession.id, 2, { maxDurationMs: 1 }));
    expect(timeLimited.stopReason).toBe("max_duration");
    expect(timeLimited.evidenceIds).toEqual([]);
    expect(timeLimited.gaps[0]).toMatchObject({ url: seed, reason: "max_duration" });
  });

  it("preserves successful evidence and an explicit gap when one seed fails", async () => {
    const failed = "https://example.com/research/failure";
    provider.failures.set(failed, new Error("fixture page failed"));
    const created = await create("partial-research", { seeds: [seed, failed], expansion: false });

    const result = await service.runResearch(runCommand(created.id, 1));
    expect(result).toMatchObject({ expansion: "not_requested", state: "partial" });
    expect(result.evidenceIds).toHaveLength(1);
    expect(result.gaps).toEqual([{
      url: failed,
      reason: "acquisition_failed",
      message: "fixture page failed",
    }]);
    expect(provider.hits).toEqual([seed, failed]);
  });
});

describe("DataResearchService confirmed competitor diffs", () => {
  let store: Store;
  let service: DataResearchService;
  let sequence: number;

  const context = (suffix: string): CommandContext => ({
    actor: "agent-1",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  });

  beforeEach(async () => {
    store = openStore(":memory:");
    sequence = 0;
    service = new DataResearchService(
      store,
      { now: () => now },
      { next: () => `competitor-generated-${++sequence}` },
    );
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(entity("workspace-1"));
      await repos.workspaces.insert(entity("workspace-2", "workspace-2"));
    });
  });

  afterEach(() => {
    store.close();
  });

  async function addCompetitor(
    id: string,
    evidenceIds: string[] = [],
    status: "confirmed" | "excluded" = "confirmed",
    workspaceId = "workspace-1",
  ): Promise<void> {
    await store.transaction((repos) => repos.competitors.insert({
      ...entity(id, workspaceId),
      status,
      evidenceIds,
    }));
  }

  async function addObservation(
    id: string,
    fields: Record<string, string>,
    options: {
      acquisition?: "research" | "content_ingestion" | null;
      classification?: "owned_operating" | "owned_conversion" | "external_observation";
      ownership?: "owned" | "authorized" | "external_public";
      type?: "file" | "link" | "api" | "manual" | "database";
      generatedAssets?: boolean;
    } = {},
  ): Promise<void> {
    await store.transaction(async (repos) => {
      await repos.sources.insert({
        ...entity(`source-${id}`),
        type: options.type ?? "link",
        ownership: options.ownership ?? "external_public",
        metadata: {
          ...(options.acquisition === null
            ? {}
            : { acquisition: options.acquisition ?? "research" }),
          fields,
        },
      });
      await repos.evidence.insert({
        ...entity(id),
        sourceId: `source-${id}`,
        sourceLocator: `https://example.com/${id}`,
        observedAt: now,
        summary: "Structured public observation",
        contentHash: id.padStart(64, "0").slice(0, 64),
        classification: options.classification ?? "external_observation",
        assets: options.generatedAssets === false ? [] : [
          { id: `text-${id}`, kind: "page_text", contentHash: "a".repeat(64), byteLength: 1 },
          { id: `screenshot-${id}`, kind: "screenshot", contentHash: "b".repeat(64), byteLength: 1 },
        ],
      });
    });
  }

  function diffCommand(id: string, extra: Record<string, unknown> = {}) {
    return {
      input: {
        id,
        workspaceId: "workspace-1",
        competitorIds: ["left", "right"],
        dimensions: ["price"],
        ...extra,
      },
      context: context(id),
    };
  }

  it("confirms or excludes a competitor through the audited command pipeline", async () => {
    const legacy = { ...competitor("legacy"), evidenceIds: [] } as Record<string, unknown>;
    delete legacy.status;
    await store.transaction((repos) => repos.competitors.insert(legacy as Competitor));
    const command = {
      input: {
        id: "legacy",
        workspaceId: "workspace-1",
        expectedVersion: 1,
        status: "confirmed" as const,
      },
      context: context("confirm"),
    };

    const confirmed = await service.confirmCompetitor(command);
    expect(confirmed).toMatchObject({ id: "legacy", status: "confirmed", version: 2 });
    await expect(service.confirmCompetitor(command)).resolves.toEqual(confirmed);
    const excluded = await service.confirmCompetitor({
      input: {
        id: "legacy",
        workspaceId: "workspace-1",
        expectedVersion: 2,
        status: "excluded",
      },
      context: context("exclude"),
    });
    expect(excluded).toMatchObject({ status: "excluded", version: 3 });
    await expect(store.transaction((repos) =>
      repos.audit.listForEntity("workspace-1", "competitor", "legacy")
    )).resolves.toMatchObject([
      { action: "competitor.confirm" },
      { action: "competitor.confirm" },
    ]);
  });

  it("persists deterministic entries without semantic findings", async () => {
    await addObservation("evidence-z", { price: "20", cta: "Buy" });
    await addObservation("evidence-duplicate", { price: "20" });
    await addObservation("evidence-a", { price: "20", cta: "Start" });
    await addCompetitor("left", ["evidence-z", "evidence-duplicate"]);
    await addCompetitor("right", ["evidence-a"]);

    const diff = await service.diffCompetitors(diffCommand("diff-complete", {
      dimensions: ["price", "cta", "shipping"],
    }));

    expect(diff).toMatchObject({
      id: "diff-complete",
      competitorIds: ["left", "right"],
      entries: [
        { dimension: "price", result: "same", evidenceIds: ["evidence-a", "evidence-duplicate", "evidence-z"] },
        { dimension: "cta", result: "different", evidenceIds: ["evidence-a", "evidence-z"] },
        { dimension: "shipping", result: "unknown", evidenceIds: [] },
      ],
      findingIds: [],
    });
    const persisted = await store.transaction(async (repos) => ({
      diff: await repos.competitorDiffs.get("diff-complete", "workspace-1"),
      audits: await repos.audit.listForEntity("workspace-1", "competitor_diff", "diff-complete"),
    }));
    expect(persisted.diff).toEqual(diff);
    expect(persisted.audits).toHaveLength(1);
  });

  it("rejects unconfirmed, excluded, and cross-workspace competitors without a diff", async () => {
    const legacy = { ...competitor("unconfirmed"), evidenceIds: [] } as Record<string, unknown>;
    delete legacy.status;
    await store.transaction((repos) => repos.competitors.insert(legacy as Competitor));
    await addCompetitor("confirmed");
    await addCompetitor("excluded", [], "excluded");
    await addCompetitor("other-workspace", [], "confirmed", "workspace-2");
    const cases = [
      ["diff-unconfirmed", ["unconfirmed", "confirmed"]],
      ["diff-excluded", ["excluded", "confirmed"]],
      ["diff-cross-workspace", ["confirmed", "other-workspace"]],
    ] as const;

    for (const [id, competitorIds] of cases) {
      await expect(service.diffCompetitors(diffCommand(id, { competitorIds: [...competitorIds] })))
        .rejects.toMatchObject<DomainError>({ code: id === "diff-cross-workspace" ? "NOT_FOUND" : "CONFLICT" });
      await expect(store.transaction((repos) =>
        repos.competitorDiffs.get(id, "workspace-1")
      )).resolves.toBeUndefined();
    }
  });

  it("ignores observations that did not come from research or content ingestion", async () => {
    await addObservation("research-valid", { price: "20" });
    await addObservation("content-valid", { price: "20" }, { acquisition: "content_ingestion" });
    await addObservation("manual-forged", { price: "999", ownedOnly: "100" }, {
      acquisition: null,
    });
    await addObservation("forged-provenance", { price: "999" }, { generatedAssets: false });
    await addObservation("owned-metrics", { price: "999", ownedOnly: "100" }, {
      classification: "owned_operating",
      ownership: "owned",
      type: "api",
    });
    await addCompetitor("left", ["research-valid", "manual-forged", "forged-provenance"]);
    await addCompetitor("right", ["content-valid", "owned-metrics"]);

    const diff = await service.diffCompetitors(diffCommand("diff-qualified", {
      dimensions: ["price", "ownedOnly"],
    }));
    expect(diff.entries).toEqual([
      { dimension: "price", result: "same", evidenceIds: ["content-valid", "research-valid"] },
      { dimension: "ownedOnly", result: "unknown", evidenceIds: [] },
    ]);
  });

  it.each([
    ["null", null],
    ["empty array", []],
    ["free text", [{
      dimension: "price",
      statement: "The public price lifts demand.",
      limitations: "Unstructured and unverifiable.",
    }]],
  ])("rejects %s conclusions without creating a diff", async (_label, conclusions) => {
    await addObservation("evidence-left", { price: "20" });
    await addObservation("evidence-right", { price: "21" });
    await addCompetitor("left", ["evidence-left"]);
    await addCompetitor("right", ["evidence-right"]);
    const command = diffCommand("diff-conclusions", { conclusions });

    await expect(service.diffCompetitors(command as never))
      .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expect(store.transaction((repos) =>
      repos.competitorDiffs.get("diff-conclusions", "workspace-1")
    )).resolves.toBeUndefined();
  });

  it("rejects malformed direct JavaScript input", async () => {
    const invalidCommands = [
      diffCommand("diff-malformed-status", { competitorIds: ["left", "left"] }),
      diffCommand("diff-malformed-dimensions", { dimensions: ["price", "price"] }),
    ];
    await addCompetitor("left");
    await addCompetitor("right");
    for (const command of invalidCommands) {
      await expect(service.diffCompetitors(command as never))
        .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
      await expect(store.transaction((repos) =>
        repos.competitorDiffs.get(command.input.id, "workspace-1")
      )).resolves.toBeUndefined();
    }
    await addCompetitor("bad-status");
    await expect(service.confirmCompetitor({
      input: {
        id: "bad-status",
        workspaceId: "workspace-1",
        expectedVersion: 1,
        status: "perhaps",
      },
      context: context("bad-status"),
    } as never)).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it("diffs structured fields from the real content-link acquisition evidence chain", async () => {
    const artifactRoot = await createTempDir();
    try {
      const acquisition: AcquisitionProvider = {
        acquire: async (request) => ({
          url: request.url,
          finalUrl: request.url,
          title: request.url.includes("left") ? "Left competitor" : "Right competitor",
          text: "Public competitor page",
          fields: request.url.includes("left")
            ? { price: "20", cta: "Buy" }
            : { price: "20", cta: "Start" },
          screenshot: Buffer.from(`screenshot:${request.url}`),
          provider: "playwright",
          toolVersion: "fixture-1",
        }),
      };
      const acquiredService = new DataResearchService(
        store,
        { now: () => now },
        { next: () => `competitor-generated-${++sequence}` },
        new ArtifactStore(artifactRoot),
        undefined,
        acquisition,
      );
      const batch = await acquiredService.ingestContentLinks({
        input: {
          id: "content-acquisition",
          workspaceId: "workspace-1",
          links: [
            { url: "https://example.com/left", fields: { price: ".price", cta: ".cta" } },
            { url: "https://example.com/right", fields: { price: ".price", cta: ".cta" } },
          ],
        },
        context: context("content-acquisition"),
      });
      expect(batch.evidenceIds).toEqual([
        "competitor-generated-2",
        "competitor-generated-6",
      ]);

      const evidence = await store.transaction(async (repos) => Promise.all(
        batch.evidenceIds.map((id) => repos.evidence.get(id, "workspace-1")),
      ));
      const sources = await store.transaction(async (repos) => Promise.all(
        evidence.map((item) => repos.sources.get(item!.sourceId, "workspace-1")),
      ));
      expect(sources.map((source) => source?.metadata)).toEqual([
        expect.objectContaining({
          acquisition: "content_ingestion",
          fields: { price: "20", cta: "Buy" },
        }),
        expect.objectContaining({
          acquisition: "content_ingestion",
          fields: { price: "20", cta: "Start" },
        }),
      ]);

      await store.transaction(async (repos) => {
        for (const [id, evidenceId] of [
          ["acquired-left", batch.evidenceIds[0]!],
          ["acquired-right", batch.evidenceIds[1]!],
        ] as const) {
          const legacy = { ...competitor(id), evidenceIds: [evidenceId] } as Record<string, unknown>;
          delete legacy.status;
          await repos.competitors.insert(legacy as Competitor);
        }
      });
      for (const id of ["acquired-left", "acquired-right"]) {
        await acquiredService.confirmCompetitor({
          input: { id, workspaceId: "workspace-1", expectedVersion: 1, status: "confirmed" },
          context: context(`${id}-confirm`),
        });
      }

      const diff = await acquiredService.diffCompetitors(diffCommand("acquired-diff", {
        competitorIds: ["acquired-left", "acquired-right"],
        dimensions: ["price", "cta"],
      }));
      expect(diff).toMatchObject({
        entries: [
          {
            dimension: "price",
            result: "same",
            evidenceIds: ["competitor-generated-2", "competitor-generated-6"],
          },
          {
            dimension: "cta",
            result: "different",
            evidenceIds: ["competitor-generated-2", "competitor-generated-6"],
          },
        ],
        findingIds: [],
      });
    } finally {
      await removeTempDir(artifactRoot);
    }
  });

  it("rolls back diff, audit, and idempotency records after a mid-write failure", async () => {
    await addObservation("evidence-left", { price: "20" });
    await addObservation("evidence-right", { price: "21" });
    await addCompetitor("left", ["evidence-left"]);
    await addCompetitor("right", ["evidence-right"]);
    const failingStore: Store = {
      close: () => store.close(),
      transaction: (work) => store.transaction(async (repos) => work({
        ...repos,
        audit: {
          ...repos.audit,
          append: async (record) => {
            await repos.audit.append(record);
            throw new Error("injected failure after diff and audit writes");
          },
        },
      })),
    };
    const failing = new DataResearchService(
      failingStore,
      { now: () => now },
      { next: () => `competitor-generated-${++sequence}` },
    );

    await expect(failing.diffCompetitors(diffCommand("diff-rollback", {
      dimensions: ["price"],
    }))).rejects.toThrow("injected failure after diff and audit writes");
    const residue = await store.transaction(async (repos) => ({
      diff: await repos.competitorDiffs.get("diff-rollback", "workspace-1"),
      audits: await repos.audit.listForEntity("workspace-1", "competitor_diff", "diff-rollback"),
      idempotency: await repos.idempotency.get("workspace-1", "command-diff-rollback"),
      left: await repos.competitors.get("left", "workspace-1"),
      right: await repos.competitors.get("right", "workspace-1"),
    }));
    expect(residue).toMatchObject({
      diff: undefined,
      audits: [],
      idempotency: undefined,
      left: { version: 1, status: "confirmed", evidenceIds: ["evidence-left"] },
      right: { version: 1, status: "confirmed", evidenceIds: ["evidence-right"] },
    });
  });
});

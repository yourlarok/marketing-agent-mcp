import { readFileSync } from "node:fs";
import { copyFile, readdir, readFile, unlink, writeFile } from "node:fs/promises";
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
import type { DomainError } from "../../src/domain/errors.js";
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
  return { ...entity(id), evidenceIds: ["evidence-2", "evidence-1"] };
}

function competitor(id = "competitor-1"): Competitor {
  return { ...entity(id), evidenceIds: ["evidence-2", "evidence-1"] };
}

function competitorDiff(id = "diff-1"): CompetitorDiff {
  return { ...entity(id), findingIds: ["finding-2", "finding-1"] };
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
});

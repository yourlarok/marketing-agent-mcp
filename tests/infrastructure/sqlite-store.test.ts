import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { canonicalJson } from "../../src/infrastructure/sqlite.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import {
  SystemClock,
  SystemIdGenerator,
} from "../../src/infrastructure/system.js";
import type { EntityRecord, Store } from "../../src/application/ports.js";
import {
  createAnalysisGraph,
  expandAnalysisGraph,
  type AnalysisGraph,
} from "../../src/domain/analysis-model.js";
import {
  createDashboard,
  createDashboardView,
  type Dashboard,
} from "../../src/domain/dashboard-model.js";
import {
  createAssetVersion,
  createBenchmarkAnalysis,
  createContentBrief,
  type AssetVersion,
  type BenchmarkAnalysis,
  type ContentBrief,
} from "../../src/domain/content-production-model.js";
import {
  createApproval,
  createPublication,
  createSchedule,
  type Approval,
  type Publication,
  type Schedule,
} from "../../src/domain/publishing-model.js";
import {
  createEffectReview,
  createMetricSnapshot,
  type EffectReview,
  type MetricSnapshot,
} from "../../src/domain/effect-model.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-26T12:30:00.000Z";
const later = "2026-10-26T12:31:00.000Z";

function entity(id: string, workspaceId = id): EntityRecord {
  return {
    id,
    workspaceId,
    version: 1,
    createdAt: now,
    updatedAt: now,
    name: `Entity ${id}`,
    metadata: { z: 1, a: { z: 2, a: 1 } },
  };
}

function analysisGraph(id = "graph-1", workspaceId = "ws-1"): AnalysisGraph {
  return createAnalysisGraph({
    id,
    workspaceId,
    createdAt: now,
    nodes: [
      { id: "question-node", kind: "question", payload: { text: "How?" } },
      { id: "dataset-node", kind: "dataset", payload: { datasetId: "dataset-1" } },
      {
        id: "research-node",
        kind: "research",
        payload: { evidenceIds: ["evidence-2", "evidence-1"] },
      },
      {
        id: "metric-node",
        kind: "metric",
        payload: { datasetId: "dataset-1", evidenceId: "evidence-1" },
      },
    ],
    edges: [
      { id: "edge-1", fromNodeId: "question-node", toNodeId: "dataset-node" },
      { id: "edge-2", fromNodeId: "dataset-node", toNodeId: "metric-node" },
    ],
    recommendedActions: [{ tool: "research", description: "Review evidence" }],
  });
}

function dashboardRecord(overrides: Record<string, unknown> = {}): Dashboard {
  return createDashboard({
    id: "dashboard-1",
    workspaceId: "ws-1",
    createdAt: now,
    generatedAt: later,
    renderer: {
      type: "controlled_renderer",
      id: "controlled_html_svg_v1",
      professionalTool: false,
    },
    views: [createDashboardView({
      id: "task-effect",
      kind: "task_effect",
      graphId: "graph-1",
      taskIds: ["task-1"],
      monitorNodeIds: ["monitor-1"],
      status: "ok",
      reasons: [],
      dataAsOf: now,
      sourceUpdatedAt: later,
      sources: [{ sourceId: "source-1", updatedAt: later }],
      metrics: [{ metricId: "ctr_v1", formula: "sum(clicks) / sum(impressions)" }],
    })],
    artifacts: [
      {
        id: "dashboard-html",
        kind: "html",
        contentHash: "a".repeat(64),
        byteLength: 100,
        mediaType: "text/html; charset=utf-8",
      },
      {
        id: "dashboard-manifest",
        kind: "manifest",
        contentHash: "b".repeat(64),
        byteLength: 200,
        mediaType: "application/json",
      },
    ],
    sourceIds: ["source-1"],
    datasetIds: ["dataset-1"],
    evidenceIds: ["evidence-2", "evidence-1"],
    graphIds: ["graph-1"],
    competitorDiffIds: ["diff-1"],
    taskIds: ["task-1"],
    sourceVersions: [
      { entityType: "source", id: "source-1", version: 1 },
      { entityType: "dataset", id: "dataset-1", version: 1 },
      { entityType: "evidence", id: "evidence-2", version: 1 },
      { entityType: "evidence", id: "evidence-1", version: 1 },
      { entityType: "analysis_graph", id: "graph-1", version: 1 },
      { entityType: "competitor_diff", id: "diff-1", version: 1 },
      { entityType: "task", id: "task-1", version: 1 },
    ],
    ...overrides,
  });
}

describe("transactional SQLite storage", () => {
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

  it("migrates an empty database and persists entities after close and reopen", async () => {
    const first = open();
    await first.transaction((repos) => repos.workspaces.insert(entity("ws-1")));
    first.close();

    const second = open();
    const restored = await second.transaction((repos) =>
      repos.workspaces.get("ws-1", "ws-1"),
    );

    expect(restored).toEqual(entity("ws-1"));
  });

  it("repeats migration without changing existing records", async () => {
    const first = open();
    await first.transaction((repos) => repos.workspaces.insert(entity("ws-1")));
    first.close();

    const second = open();
    expect(
      await second.transaction((repos) =>
        repos.workspaces.get("ws-1", "ws-1"),
      ),
    ).toEqual(entity("ws-1"));
  });

  it("enables foreign keys on every connection", async () => {
    const store = open();

    await expect(
      store.transaction((repos) =>
        repos.sources.insert(entity("source-1", "missing-workspace")),
      ),
    ).rejects.toThrow();

    const raw = new DatabaseSync(databasePath);
    try {
      expect(raw.prepare("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
    } finally {
      raw.close();
    }
  });

  it("rolls back entity, audit, and idempotency writes together", async () => {
    const store = open();

    await expect(
      store.transaction(async (repos) => {
        await repos.workspaces.insert(entity("ws-1"));
        await repos.audit.append({
          id: "audit-1",
          workspaceId: "ws-1",
          requestId: "request-1",
          actor: "actor-1",
          action: "workspace.create",
          entityType: "workspace",
          entityId: "ws-1",
          details: { changed: true },
          createdAt: now,
        });
        await repos.idempotency.put({
          workspaceId: "ws-1",
          key: "command-1",
          requestHash: "hash-1",
          response: { id: "ws-1" },
          createdAt: now,
        });
        throw new Error("abort command");
      }),
    ).rejects.toThrow("abort command");

    await expect(
      store.transaction((repos) => repos.workspaces.get("ws-1", "ws-1")),
    ).resolves.toBeUndefined();
    const raw = new DatabaseSync(databasePath);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS count FROM audit_records").get(),
      ).toEqual({ count: 0 });
      expect(
        raw.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get(),
      ).toEqual({ count: 0 });
    } finally {
      raw.close();
    }
  });

  it("rejects stale-version updates with a conflict", async () => {
    const store = open();
    await store.transaction((repos) => repos.workspaces.insert(entity("ws-1")));

    await store.transaction(async (repos) => {
      const current = await repos.workspaces.get("ws-1", "ws-1");
      expect(current).toBeDefined();
      await repos.workspaces.update(
        { ...current!, name: "current", updatedAt: now },
        1,
      );
    });

    await expect(
      store.transaction((repos) =>
        repos.workspaces.update(
          { ...entity("ws-1"), name: "stale" },
          1,
        ),
      ),
    ).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });

    expect(
      await store.transaction((repos) =>
        repos.workspaces.get("ws-1", "ws-1"),
      ),
    ).toMatchObject({ version: 2, name: "current" });
  });

  it("stores canonical JSON and UTC timestamp text", async () => {
    const store = open();
    await store.transaction((repos) => repos.workspaces.insert(entity("ws-1")));

    const raw = new DatabaseSync(databasePath);
    try {
      const row = raw
        .prepare("SELECT payload, created_at FROM workspaces WHERE id = ?")
        .get("ws-1") as { payload: string; created_at: string };
      expect(row.created_at).toBe(now);
      expect(row.payload).toBe(
        '{"createdAt":"2026-10-26T12:30:00.000Z","id":"ws-1","metadata":{"a":{"a":1,"z":2},"z":1},"name":"Entity ws-1","updatedAt":"2026-10-26T12:30:00.000Z","version":1,"workspaceId":"ws-1"}',
      );
    } finally {
      raw.close();
    }
  });

  it("rejects non-UTC timestamps and non-finite JSON numbers", async () => {
    const store = open();

    await expect(
      store.transaction((repos) =>
        repos.workspaces.insert({ ...entity("ws-1"), createdAt: "2026-10-26T20:30:00+08:00" }),
      ),
    ).rejects.toThrow("UTC");
    await expect(
      store.transaction((repos) =>
        repos.workspaces.insert({ ...entity("ws-1"), value: Number.NaN }),
      ),
    ).rejects.toThrow("JSON");
  });

  it("makes audit records append-only", async () => {
    const store = open();
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(entity("ws-1"));
      await repos.audit.append({
        id: "audit-1",
        workspaceId: "ws-1",
        requestId: "request-1",
        actor: "actor-1",
        action: "workspace.create",
        entityType: "workspace",
        entityId: "ws-1",
        details: {},
        createdAt: now,
      });
    });

    const raw = new DatabaseSync(databasePath);
    try {
      expect(() =>
        raw.prepare("UPDATE audit_records SET actor = ? WHERE id = ?").run("other", "audit-1"),
      ).toThrow();
      expect(() =>
        raw.prepare("DELETE FROM audit_records WHERE id = ?").run("audit-1"),
      ).toThrow();
    } finally {
      raw.close();
    }
  });

  it("lists lineage audit request IDs in append order within the workspace", async () => {
    const store = open();
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(entity("ws-1"));
      await repos.workspaces.insert(entity("ws-2"));
      for (const record of [
        { id: "audit-2", workspaceId: "ws-1", requestId: "request-2", entityId: "task-1" },
        { id: "audit-1", workspaceId: "ws-1", requestId: "request-1", entityId: "task-1" },
        { id: "audit-3", workspaceId: "ws-1", requestId: "request-other", entityId: "task-other" },
        { id: "audit-4", workspaceId: "ws-2", requestId: "request-private", entityId: "task-1" },
      ]) {
        await repos.audit.append({
          ...record,
          actor: "actor-1",
          action: "task.transition",
          entityType: "task",
          details: {},
          createdAt: now,
        });
      }
    });

    await expect(
      store.transaction((repos) => repos.audit.listForEntity("ws-1", "task", "task-1")),
    ).resolves.toEqual([
      expect.objectContaining({ requestId: "request-2" }),
      expect.objectContaining({ requestId: "request-1" }),
    ]);
  });

  it("enforces workspace-scoped idempotency keys", async () => {
    const store = open();
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(entity("ws-1"));
      await repos.workspaces.insert(entity("ws-2"));
      await repos.idempotency.put({
        workspaceId: "ws-1",
        key: "same-key",
        requestHash: "hash-1",
        response: { result: 1 },
        createdAt: now,
      });
      await repos.idempotency.put({
        workspaceId: "ws-2",
        key: "same-key",
        requestHash: "hash-2",
        response: { result: 2 },
        createdAt: now,
      });
    });

    await expect(
      store.transaction((repos) =>
        repos.idempotency.put({
          workspaceId: "ws-1",
          key: "same-key",
          requestHash: "hash-3",
          response: { result: 3 },
          createdAt: now,
        }),
      ),
    ).rejects.toMatchObject<DomainError>({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("enforces lineage references and preserves evidence order after reopen", async () => {
    const first = open();
    await first.transaction(async (repos) => {
      await repos.workspaces.insert(entity("ws-1"));
      await repos.sources.insert(entity("source-1", "ws-1"));
      await repos.evidence.insert(entity("evidence-1", "ws-1"));
      await repos.evidence.insert(entity("evidence-2", "ws-1"));
      await repos.findings.insert({
        ...entity("finding-1", "ws-1"),
        evidenceIds: ["evidence-2", "evidence-1"],
      });
    });

    await expect(
      first.transaction((repos) =>
        repos.findings.insert({
          ...entity("finding-2", "ws-1"),
          evidenceIds: ["missing-evidence"],
        }),
      ),
    ).rejects.toThrow();
    first.close();

    const second = open();
    expect(
      await second.transaction((repos) =>
        repos.findings.get("finding-1", "ws-1"),
      ),
    ).toMatchObject({ evidenceIds: ["evidence-2", "evidence-1"] });
    const raw = new DatabaseSync(databasePath);
    try {
      expect(
        raw
          .prepare(
            "SELECT evidence_id, position FROM finding_evidence WHERE finding_id = ? ORDER BY position",
          )
          .all("finding-1"),
      ).toEqual([
        { evidence_id: "evidence-2", position: 0 },
        { evidence_id: "evidence-1", position: 1 },
      ]);
    } finally {
      raw.close();
    }
  });

  it("persists task dependency IDs and positions after reopen", async () => {
    const first = open();
    await first.transaction(async (repos) => {
      await repos.workspaces.insert(entity("ws-1"));
      await repos.tasks.insert(entity("dependency-1", "ws-1"));
      await repos.tasks.insert(entity("dependency-2", "ws-1"));
      await repos.tasks.insert({
        ...entity("task-1", "ws-1"),
        dependencyIds: ["dependency-2", "dependency-1"],
      });
    });
    first.close();

    const second = open();
    expect(
      await second.transaction((repos) => repos.tasks.get("task-1", "ws-1")),
    ).toMatchObject({ dependencyIds: ["dependency-2", "dependency-1"] });
    const raw = new DatabaseSync(databasePath);
    try {
      expect(
        raw
          .prepare(
            "SELECT dependency_id, position FROM task_dependencies WHERE task_id = ? ORDER BY position",
          )
          .all("task-1"),
      ).toEqual([
        { dependency_id: "dependency-2", position: 0 },
        { dependency_id: "dependency-1", position: 1 },
      ]);
    } finally {
      raw.close();
    }
  });

  it("persists canonical analysis graphs with optimistic versions across restart", async () => {
    const first = open();
    await first.transaction(async (repos) => {
      await repos.workspaces.insert(entity("ws-1"));
      await repos.sources.insert(entity("source-1", "ws-1"));
      await repos.datasets.insert({ ...entity("dataset-1", "ws-1"), sourceId: "source-1" });
      await repos.evidence.insert({ ...entity("evidence-1", "ws-1"), sourceId: "source-1" });
      await repos.evidence.insert({ ...entity("evidence-2", "ws-1"), sourceId: "source-1" });
      await repos.analysisGraphs.insert(analysisGraph());
    });
    const expanded = expandAnalysisGraph(analysisGraph(), {
      expectedVersion: 1,
      updatedAt: later,
      nodes: [{ id: "decision-node", kind: "decision", payload: { decision: "continue" } }],
      edges: [{ id: "edge-3", fromNodeId: "metric-node", toNodeId: "decision-node" }],
    });
    await first.transaction((repos) => repos.analysisGraphs.update(expanded, 1));
    await expect(
      first.transaction((repos) => repos.analysisGraphs.update(analysisGraph(), 1)),
    ).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    first.close();

    const second = open();
    const restored = await second.transaction((repos) =>
      repos.analysisGraphs.get("graph-1", "ws-1"),
    );
    expect(restored).toEqual(expanded);
    expect(restored?.version).toBe(2);
    expect(
      await second.transaction((repos) => repos.analysisGraphs.get("graph-1", "ws-2")),
    ).toBeUndefined();

    const raw = new DatabaseSync(databasePath);
    try {
      const row = raw
        .prepare("SELECT payload, version FROM analysis_graphs WHERE id = ?")
        .get("graph-1") as { payload: string; version: number };
      expect(row).toEqual({ payload: canonicalJson(expanded), version: 2 });
      expect(
        raw.prepare(
          "SELECT dataset_id, position FROM analysis_graph_datasets WHERE graph_id = ? ORDER BY position",
        ).all("graph-1"),
      ).toEqual([{ dataset_id: "dataset-1", position: 0 }]);
      expect(
        raw.prepare(
          "SELECT evidence_id, position FROM analysis_graph_evidence WHERE graph_id = ? ORDER BY position",
        ).all("graph-1"),
      ).toEqual([
        { evidence_id: "evidence-2", position: 0 },
        { evidence_id: "evidence-1", position: 1 },
      ]);
    } finally {
      raw.close();
    }
  });

  it("enforces analysis graph workspace references and rolls back failed updates", async () => {
    const store = open();
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(entity("ws-1"));
      await repos.workspaces.insert(entity("ws-2"));
      await repos.sources.insert(entity("source-1", "ws-1"));
      await repos.datasets.insert({ ...entity("dataset-1", "ws-1"), sourceId: "source-1" });
      await repos.evidence.insert({ ...entity("evidence-1", "ws-1"), sourceId: "source-1" });
      await repos.evidence.insert({ ...entity("evidence-2", "ws-1"), sourceId: "source-1" });
      await repos.sources.insert(entity("source-other", "ws-2"));
      await repos.datasets.insert({ ...entity("dataset-other", "ws-2"), sourceId: "source-other" });
      await repos.evidence.insert({ ...entity("evidence-other", "ws-2"), sourceId: "source-other" });
      await repos.analysisGraphs.insert(analysisGraph());
      await repos.analysisGraphs.insert(createAnalysisGraph({
        id: "parent-other",
        workspaceId: "ws-2",
        createdAt: now,
      }));
    });

    await expect(
      store.transaction((repos) => repos.analysisGraphs.insert({
        ...analysisGraph("cross-dataset"),
        nodes: [{ id: "dataset-node", kind: "dataset", payload: { datasetId: "dataset-other" } }],
      })),
    ).rejects.toThrow();
    await expect(
      store.transaction((repos) => repos.analysisGraphs.insert({
        ...createAnalysisGraph({ id: "cross-parent", workspaceId: "ws-1", createdAt: now }),
        parentGraphId: "parent-other",
        parentVersion: 1,
      })),
    ).rejects.toThrow();

    const invalidUpdate = expandAnalysisGraph(analysisGraph(), {
      expectedVersion: 1,
      updatedAt: later,
      nodes: [{
        id: "other-research",
        kind: "research",
        payload: { evidenceId: "evidence-other" },
      }],
      edges: [],
    });
    await expect(
      store.transaction((repos) => repos.analysisGraphs.update(invalidUpdate, 1)),
    ).rejects.toThrow();

    expect(
      await store.transaction((repos) => repos.analysisGraphs.get("graph-1", "ws-1")),
    ).toEqual(analysisGraph());
    expect(
      await store.transaction((repos) => repos.analysisGraphs.get("cross-dataset", "ws-1")),
    ).toBeUndefined();
    const raw = new DatabaseSync(databasePath);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS count FROM analysis_graph_evidence WHERE evidence_id = ?")
          .get("evidence-other"),
      ).toEqual({ count: 0 });
    } finally {
      raw.close();
    }
  });

  it("serializes asynchronous transactions across stores for the same database", async () => {
    const first = open();
    const second = open(join(tempDir, "nested", "..", "store.db"));
    await first.transaction((repos) => repos.workspaces.insert(entity("ws-1")));

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstTransaction = first.transaction(async (repos) => {
      await repos.sources.insert(entity("source-1", "ws-1"));
      markStarted();
      await firstGate;
      await repos.audit.append({
        id: "audit-1",
        workspaceId: "ws-1",
        requestId: "request-1",
        actor: "actor-1",
        action: "source.register",
        entityType: "source",
        entityId: "source-1",
        details: {},
        createdAt: now,
      });
    });
    await started;
    const secondTransaction = second.transaction(async (repos) => {
      await repos.workspaces.insert(entity("ws-2"));
      await repos.idempotency.put({
        workspaceId: "ws-2",
        key: "command-2",
        requestHash: "hash-2",
        response: { id: "ws-2" },
        createdAt: now,
      });
    });
    const releaseTimer = setTimeout(releaseFirst, 50);

    try {
      await Promise.all([firstTransaction, secondTransaction]);
    } finally {
      clearTimeout(releaseTimer);
      releaseFirst();
    }

    expect(
      await second.transaction((repos) => repos.sources.get("source-1", "ws-1")),
    ).toBeDefined();
    expect(
      await first.transaction((repos) => repos.workspaces.get("ws-2", "ws-2")),
    ).toBeDefined();
  }, 10_000);

  it("rolls back a failed migration and opens successfully after repair", async () => {
    const broken = new DatabaseSync(databasePath);
    broken.exec("CREATE TABLE sources (broken TEXT)");
    broken.close();

    expect(() => open()).toThrow();
    const afterFailure = new DatabaseSync(databasePath);
    try {
      expect(
        afterFailure
          .prepare("SELECT name FROM sqlite_master WHERE name = ?")
          .get("workspaces"),
      ).toBeUndefined();
      expect(
        afterFailure
          .prepare("SELECT name FROM sqlite_master WHERE name = ?")
          .get("schema_migrations"),
      ).toBeUndefined();
      afterFailure.exec("DROP TABLE sources");
    } finally {
      afterFailure.close();
    }

    const repaired = open();
    await repaired.transaction((repos) => repos.workspaces.insert(entity("ws-1")));
    expect(
      await repaired.transaction((repos) => repos.workspaces.get("ws-1", "ws-1")),
    ).toEqual(entity("ws-1"));
  });

  it("provides UTC system time and unique IDs", () => {
    const clock = new SystemClock();
    const ids = new SystemIdGenerator();

    expect(clock.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(ids.next()).not.toBe(ids.next());
  });

  it("canonicalizes JSON object keys recursively without dropping __proto__", () => {
    expect(canonicalJson({ z: 1, a: [{ z: 2, a: 1 }] })).toBe(
      '{"a":[{"a":1,"z":2}],"z":1}',
    );
    const input = JSON.parse(
      '{"z":1,"__proto__":{"preserved":true},"a":2}',
    ) as Record<string, unknown>;
    expect(canonicalJson(input)).toBe(
      '{"__proto__":{"preserved":true},"a":2,"z":1}',
    );
  });

  it("persists __proto__ metadata without silent field loss", async () => {
    const first = open();
    const record = entity("ws-1");
    record.metadata = JSON.parse(
      '{"__proto__":{"preserved":true},"a":1}',
    ) as Record<string, unknown>;
    await first.transaction((repos) => repos.workspaces.insert(record));
    first.close();

    const second = open();
    expect(
      await second.transaction((repos) => repos.workspaces.get("ws-1", "ws-1")),
    ).toEqual(record);
    const raw = new DatabaseSync(databasePath);
    try {
      const row = raw
        .prepare("SELECT payload FROM workspaces WHERE id = ?")
        .get("ws-1") as { payload: string };
      const payload = JSON.parse(row.payload) as {
        metadata: Record<string, unknown>;
      };
      expect(Object.hasOwn(payload.metadata, "__proto__")).toBe(true);
      expect(payload.metadata["__proto__"]).toEqual({ preserved: true });
    } finally {
      raw.close();
    }
  });

  it("upgrades a populated v3 database without changing legacy Recommendation or Task records", async () => {
    const legacyRecommendation = {
      id: "legacy-recommendation",
      workspaceId: "ws-1",
      version: 1,
      createdAt: now,
      updatedAt: now,
      findingIds: [],
      hypothesis: "Legacy hypothesis",
      affectedStage: "legacy-stage",
      priority: "legacy-priority",
      expectedMetric: "legacy-metric",
    };
    const legacyTask = {
      id: "legacy-task",
      workspaceId: "ws-1",
      version: 1,
      createdAt: now,
      updatedAt: now,
      recommendationIds: [],
      assignee: "legacy-owner",
      dependencyIds: [],
      assetRequirements: [],
      acceptanceCriteria: ["Legacy acceptance"],
      state: "completed",
    };
    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
      for (const migration of ["001_initial.sql", "002_data_research.sql", "003_analysis_graphs.sql"]) {
        raw.exec(readFileSync(fileURLToPath(new URL(`../../migrations/${migration}`, import.meta.url)), "utf8"));
      }
      raw.prepare(
        "INSERT INTO workspaces (id, workspace_id, version, created_at, updated_at, payload) VALUES (?, ?, 1, ?, ?, ?)",
      ).run("ws-1", "ws-1", now, now, canonicalJson(entity("ws-1")));
      raw.prepare(
        "INSERT INTO recommendations (id, workspace_id, version, created_at, updated_at, payload) VALUES (?, ?, 1, ?, ?, ?)",
      ).run(legacyRecommendation.id, "ws-1", now, now, canonicalJson(legacyRecommendation));
      raw.prepare(
        "INSERT INTO tasks (id, workspace_id, version, created_at, updated_at, payload) VALUES (?, ?, 1, ?, ?, ?)",
      ).run(legacyTask.id, "ws-1", now, now, canonicalJson(legacyTask));
      raw.exec("COMMIT");
    } finally {
      raw.close();
    }

    const store = open();
    expect(await store.transaction((repos) => repos.recommendations.get("legacy-recommendation", "ws-1"))).toEqual(legacyRecommendation);
    expect(await store.transaction((repos) => repos.tasks.get("legacy-task", "ws-1"))).toEqual(legacyTask);

    const migrated = new DatabaseSync(databasePath);
    try {
      expect(migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 7 });
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dashboards'").get()).toEqual({ name: "dashboards" });
    } finally {
      migrated.close();
    }
  });

  it("persists Dashboard references in order, enforces workspace foreign keys, and rejects stale updates", async () => {
    const store = open();
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(entity("ws-1"));
      await repos.workspaces.insert(entity("ws-2"));
      await repos.sources.insert(entity("source-1", "ws-1"));
      await repos.sources.insert(entity("source-other", "ws-2"));
      await repos.datasets.insert({ ...entity("dataset-1", "ws-1"), sourceId: "source-1" });
      await repos.datasets.insert({ ...entity("dataset-other", "ws-2"), sourceId: "source-other" });
      await repos.evidence.insert({ ...entity("evidence-1", "ws-1"), sourceId: "source-1" });
      await repos.evidence.insert({ ...entity("evidence-2", "ws-1"), sourceId: "source-1" });
      await repos.evidence.insert({ ...entity("evidence-other", "ws-2"), sourceId: "source-other" });
      await repos.analysisGraphs.insert(analysisGraph());
      await repos.analysisGraphs.insert(createAnalysisGraph({ id: "graph-other", workspaceId: "ws-2", createdAt: now }));
      await repos.competitorDiffs.insert(entity("diff-1", "ws-1"));
      await repos.competitorDiffs.insert(entity("diff-other", "ws-2"));
      await repos.tasks.insert(entity("task-1", "ws-1"));
      await repos.tasks.insert(entity("task-other", "ws-2"));
      await repos.dashboards.insert(dashboardRecord());
    });

    const crossWorkspaceReferences = [
      ["sourceIds", "source", "source-other"],
      ["datasetIds", "dataset", "dataset-other"],
      ["evidenceIds", "evidence", "evidence-other"],
      ["graphIds", "analysis_graph", "graph-other"],
      ["competitorDiffIds", "competitor_diff", "diff-other"],
      ["taskIds", "task", "task-other"],
    ] as const;
    for (const [field, entityType, otherId] of crossWorkspaceReferences) {
      const candidate = dashboardRecord();
      await expect(store.transaction((repos) => repos.dashboards.insert(dashboardRecord({
        id: `cross-${field}`,
        [field]: [otherId],
        sourceVersions: candidate.sourceVersions.map((reference) =>
          reference.entityType === entityType ? { ...reference, id: otherId } : reference
        ),
      })))).rejects.toThrow();
    }

    const unnormalized = dashboardRecord({
      id: "unnormalized-task-effect",
      taskIds: [],
      sourceVersions: dashboardRecord().sourceVersions.filter((reference) => reference.entityType !== "task"),
    });
    const normalizedView = createDashboardView({
      id: "empty-task-effect",
      kind: "task_effect",
      graphId: "graph-1",
      taskIds: [],
      monitorNodeIds: ["monitor-1"],
      sourceUpdatedAt: later,
      sources: [{ sourceId: "source-1", updatedAt: later }],
      metrics: [{ metricId: "ctr_v1", formula: "sum(clicks) / sum(impressions)" }],
    });
    unnormalized.views = [{ ...normalizedView, status: "ok", reasons: [] }];
    await expect(
      store.transaction((repos) => repos.dashboards.insert(unnormalized)),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    expect(
      await store.transaction((repos) => repos.dashboards.get("unnormalized-task-effect", "ws-1")),
    ).toBeUndefined();

    await store.transaction((repos) => repos.dashboards.update(dashboardRecord(), 1));
    await expect(
      store.transaction((repos) => repos.dashboards.update(dashboardRecord(), 1)),
    ).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    store.close();

    const reopened = open();
    expect(await reopened.transaction((repos) => repos.dashboards.get("dashboard-1", "ws-1"))).toMatchObject({
      ...dashboardRecord(),
      version: 2,
    });
    expect(await reopened.transaction((repos) => repos.dashboards.get("dashboard-1", "ws-2"))).toBeUndefined();
    const raw = new DatabaseSync(databasePath);
    try {
      expect(raw.prepare(
        "SELECT evidence_id, position FROM dashboard_evidence WHERE dashboard_id = ? ORDER BY position",
      ).all("dashboard-1")).toEqual([
        { evidence_id: "evidence-2", position: 0 },
        { evidence_id: "evidence-1", position: 1 },
      ]);
      expect(raw.prepare("SELECT COUNT(*) AS count FROM dashboards WHERE id LIKE 'cross-%'").get()).toEqual({ count: 0 });
    } finally {
      raw.close();
    }
  });
});

describe("content production SQLite persistence", () => {
  let tempDir: string;
  let databasePath: string;
  let stores: Store[];

  beforeEach(async () => {
    tempDir = await createTempDir();
    databasePath = join(tempDir, "store.db");
    stores = [];
  });

  afterEach(async () => {
    for (const store of stores) store.close();
    await removeTempDir(tempDir);
  });

  function open(path = databasePath): Store {
    const store = openStore(path);
    stores.push(store);
    return store;
  }

  function benchmarkRecord(overrides: Record<string, unknown> = {}): BenchmarkAnalysis {
    return createBenchmarkAnalysis({
      id: "benchmark-1",
      workspaceId: "ws-1",
      createdAt: now,
      modality: "image",
      status: "completed",
      methods: [{
        id: "method-1",
        dimension: "layout",
        pattern: "Observed visual sequence",
        transferableRule: "Use a clear visual sequence",
        basis: "image",
        confidence: "unknown",
        evidenceAssetRefs: [{
          sourceId: "source-1",
          evidenceId: "evidence-1",
          assetId: "asset-1",
          kind: "screenshot",
          observedAt: now,
          contentHash: "a".repeat(64),
          byteLength: 100,
        }],
      }],
      gaps: [],
      evidenceIds: ["evidence-1"],
      competitorDiffId: "diff-1",
      sourceVersions: [
        { entityType: "source", id: "source-1", version: 1 },
        { entityType: "evidence", id: "evidence-1", version: 1 },
        { entityType: "competitor_diff", id: "diff-1", version: 1 },
      ],
      provider: {
        type: "mcp",
        tool: "reverse_engineer",
        toolVersion: "fixture-1",
        inputHash: "b".repeat(64),
        analysisMethod: "fixture-v1",
        humanReview: "not_performed",
      },
      ...overrides,
    });
  }

  function briefRecord(overrides: Record<string, unknown> = {}): ContentBrief {
    return createContentBrief({
      id: "brief-1",
      workspaceId: "ws-1",
      createdAt: now,
      channel: "xhs",
      taskId: "task-1",
      recommendationId: "recommendation-1",
      benchmarkAnalysisId: "benchmark-1",
      methodIds: ["method-1"],
      objective: "Objective",
      audience: "Audience",
      copy: {
        hook: { id: "hook", kind: "creative", text: "Original hook" },
        body: [{ id: "fact", kind: "fact", text: "Traceable fact", findingId: "finding-1" }],
        cta: { id: "cta", kind: "creative", text: "Original CTA" },
      },
      frames: [],
      assetRequirements: [],
      findingIds: ["finding-1"],
      evidenceIds: ["evidence-1"],
      sourceVersions: [
        { entityType: "task", id: "task-1", version: 1 },
        { entityType: "recommendation", id: "recommendation-1", version: 1 },
        { entityType: "benchmark_analysis", id: "benchmark-1", version: 1 },
        { entityType: "finding", id: "finding-1", version: 1 },
        { entityType: "evidence", id: "evidence-1", version: 1 },
        { entityType: "source", id: "source-1", version: 1 },
      ],
      ...overrides,
    });
  }

  function assetRecord(overrides: Record<string, unknown> = {}): AssetVersion {
    return createAssetVersion({
      id: "asset-1",
      workspaceId: "ws-1",
      createdAt: now,
      contentId: "content-1",
      channel: "xhs",
      briefId: "brief-1",
      briefVersion: 1,
      taskId: "task-1",
      recommendationId: "recommendation-1",
      parentVersionId: null,
      parentVersion: null,
      artifact: {
        id: "primary-1",
        kind: "primary",
        mediaType: "image/png",
        contentHash: "c".repeat(64),
        byteLength: 100,
      },
      sourceMaterials: [],
      modification: {
        summary: "Initial",
        revisionInstructions: "Generate",
        actor: "agent-1",
        requestId: "request-1",
        createdAt: now,
      },
      provider: { type: "mcp", tool: "render", toolVersion: "fixture-1", inputHash: "d".repeat(64) },
      validation: {
        status: "passed",
        profileId: "xhs_png_1080x1440_v1",
        guarantee: "internal_acceptance_only",
        decoder: "playwright_chromium",
        width: 1080,
        height: 1440,
        durationMs: null,
        videoCodec: null,
        audioCodec: null,
      },
      evidenceIds: ["evidence-1"],
      sourceVersions: [
        { entityType: "content_brief", id: "brief-1", version: 1 },
        { entityType: "task", id: "task-1", version: 1 },
        { entityType: "recommendation", id: "recommendation-1", version: 1 },
        { entityType: "evidence", id: "evidence-1", version: 1 },
        { entityType: "source", id: "source-1", version: 1 },
      ],
      ...overrides,
    });
  }

  async function seedParents(store: Store): Promise<void> {
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(entity("ws-1"));
      await repos.sources.insert(entity("source-1", "ws-1"));
      await repos.evidence.insert({ ...entity("evidence-1", "ws-1"), sourceId: "source-1" });
      await repos.findings.insert({ ...entity("finding-1", "ws-1"), evidenceIds: ["evidence-1"] });
      await repos.competitorDiffs.insert({ ...entity("diff-1", "ws-1"), findingIds: [] });
      await repos.recommendations.insert({ ...entity("recommendation-1", "ws-1"), findingIds: ["finding-1"] });
      await repos.tasks.insert({ ...entity("task-1", "ws-1"), recommendationIds: ["recommendation-1"], dependencyIds: [] });
      await repos.benchmarkAnalyses.insert(benchmarkRecord());
      await repos.contentBriefs.insert(briefRecord());
    });
  }

  it("persists immutable records, ordered refs, and root/derivative versions across reopen", async () => {
    const first = open();
    await seedParents(first);
    const root = assetRecord();
    const derivative = assetRecord({
      id: "asset-2",
      version: 2,
      createdAt: later,
      parentVersionId: "asset-1",
      parentVersion: 1,
      sourceMaterials: [{
        role: "parent",
        assetVersionId: "asset-1",
        artifactId: "primary-1",
        mediaType: "image/png",
        contentHash: "c".repeat(64),
        byteLength: 100,
      }],
      sourceVersions: [...root.sourceVersions, { entityType: "asset_version", id: "asset-1", version: 1 }],
    });
    await first.transaction(async (repos) => {
      await repos.assetVersions.insert(root);
      await repos.assetVersions.insert(derivative);
    });
    expect(await first.transaction((repos) => repos.assetVersions.latest("content-1", "ws-1"))).toEqual(derivative);
    await first.transaction(async (repos) => {
      expect(repos.assetVersions).not.toHaveProperty("update");
    });
    await expect(first.transaction((repos) => repos.assetVersions.insert(assetRecord({ id: "asset-duplicate-root" })))).rejects.toThrow();
    await expect(first.transaction((repos) => repos.assetVersions.insert(assetRecord({
      id: "asset-second-child",
      version: 2,
      parentVersionId: "asset-1",
      parentVersion: 1,
    })))).rejects.toThrow();
    await expect(first.transaction((repos) => repos.assetVersions.insert(assetRecord({
      id: "asset-stale-parent",
      version: 2,
      parentVersionId: "asset-2",
      parentVersion: 1,
    })))).rejects.toThrow(/version|parent/i);
    await expect(first.transaction((repos) => repos.sources.update({ ...entity("source-1", "ws-1"), version: 2 }, 1))).resolves.toBeDefined();
    await expect(first.transaction((repos) => repos.sources.insert({ ...entity("source-version-2", "ws-1"), version: 2 }))).rejects.toThrow(/version 1/i);
    await expect(first.transaction((repos) => repos.benchmarkAnalyses.update(benchmarkRecord(), 1))).rejects.toThrow(/immutable/i);
    await expect(first.transaction((repos) => repos.contentBriefs.update(briefRecord(), 1))).rejects.toThrow(/immutable/i);
    first.close();

    const second = open();
    expect(await second.transaction((repos) => repos.benchmarkAnalyses.get("benchmark-1", "ws-1"))).toEqual(benchmarkRecord());
    expect(await second.transaction((repos) => repos.contentBriefs.get("brief-1", "ws-1"))).toEqual(briefRecord());
    expect(await second.transaction((repos) => repos.assetVersions.get("asset-1", "ws-1"))).toEqual(root);
    expect(await second.transaction((repos) => repos.assetVersions.get("asset-2", "ws-1"))).toEqual(derivative);
    const raw = new DatabaseSync(databasePath);
    try {
      expect(raw.prepare("SELECT evidence_id, position FROM content_brief_evidence WHERE brief_id = ? ORDER BY position").all("brief-1")).toEqual([{ evidence_id: "evidence-1", position: 0 }]);
      expect(raw.prepare("SELECT source_id, position FROM benchmark_analysis_sources WHERE analysis_id = ? ORDER BY position").all("benchmark-1")).toEqual([{ source_id: "source-1", position: 0 }]);
      expect(raw.prepare("SELECT content_id, version, parent_version_id FROM asset_versions ORDER BY version").all()).toEqual([
        { content_id: "content-1", version: 1, parent_version_id: null },
        { content_id: "content-1", version: 2, parent_version_id: "asset-1" },
      ]);
    } finally {
      raw.close();
    }
  });

  it("enforces workspace-scoped references and self-parent lineage", async () => {
    const store = open();
    await seedParents(store);
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(entity("ws-2"));
      await repos.sources.insert(entity("source-other", "ws-2"));
      await repos.evidence.insert({ ...entity("evidence-other", "ws-2"), sourceId: "source-other" });
      await repos.competitorDiffs.insert({ ...entity("diff-other", "ws-2"), findingIds: [] });
      await repos.tasks.insert({ ...entity("task-other", "ws-2"), recommendationIds: [], dependencyIds: [] });
      await repos.assetVersions.insert(assetRecord());
    });

    await expect(store.transaction((repos) => repos.benchmarkAnalyses.insert(benchmarkRecord({ id: "cross-evidence", evidenceIds: ["evidence-other"] })))).rejects.toThrow();
    await expect(store.transaction((repos) => repos.benchmarkAnalyses.insert(benchmarkRecord({ id: "cross-diff", competitorDiffId: "diff-other" })))).rejects.toThrow();
    await expect(store.transaction((repos) => repos.contentBriefs.insert(briefRecord({ id: "cross-task", taskId: "task-other" })))).rejects.toThrow();
    await expect(store.transaction((repos) => repos.assetVersions.insert(assetRecord({ id: "cross-parent", version: 2, parentVersionId: "asset-1", parentVersion: 1, workspaceId: "ws-2" })))).rejects.toThrow();
    await expect(store.transaction((repos) => repos.assetVersions.insert(assetRecord({ id: "self-parent", version: 2, parentVersionId: "self-parent", parentVersion: 1 })))).rejects.toThrow(/parent|version/i);
    await expect(store.transaction((repos) => repos.assetVersions.insert(assetRecord({ id: "wrong-parent-version", version: 2, parentVersionId: "asset-1", parentVersion: 2 })))).rejects.toThrow(/parent|version/i);
    expect(await store.transaction((repos) => repos.assetVersions.get("asset-1", "ws-2"))).toBeUndefined();
  });

  it("rejects nested Evidence refs omitted from top-level persistence and lineage", async () => {
    const store = open();
    await seedParents(store);
    await store.transaction((repos) =>
      repos.evidence.insert({ ...entity("evidence-2", "ws-1"), sourceId: "source-1" })
    );
    const benchmark = benchmarkRecord();
    const method = benchmark.methods[0]!;
    const nestedBenchmark: BenchmarkAnalysis = {
      ...benchmark,
      id: "benchmark-nested-evidence",
      methods: [{
        ...method,
        evidenceAssetRefs: [{ ...method.evidenceAssetRefs[0]!, evidenceId: "evidence-2" }],
      }],
    };
    const nestedAsset: AssetVersion = {
      ...assetRecord(),
      id: "asset-nested-evidence",
      sourceMaterials: [{
        role: "source",
        source: {
          sourceId: "source-1",
          evidenceId: "evidence-2",
          assetId: "asset-2",
          kind: "original",
          observedAt: now,
          contentHash: "e".repeat(64),
          byteLength: 100,
        },
        ownership: "owned",
      }],
    };

    await expect(store.transaction((repos) => repos.benchmarkAnalyses.insert(nestedBenchmark))).rejects.toThrow(/evidenceIds/i);
    await expect(store.transaction((repos) => repos.assetVersions.insert(nestedAsset))).rejects.toThrow(/evidenceIds/i);
    expect(await store.transaction((repos) => repos.benchmarkAnalyses.get(nestedBenchmark.id, "ws-1"))).toBeUndefined();
    expect(await store.transaction((repos) => repos.assetVersions.get(nestedAsset.id, "ws-1"))).toBeUndefined();
  });

  it("upgrades every populated v4 payload without rewriting history", async () => {
    const raw = new DatabaseSync(databasePath);
    const payloadTables = [
      "workspaces", "sources", "datasets", "evidence", "findings", "recommendations", "tasks",
      "capabilities", "data_request_plans", "ingestion_batches", "research_sessions", "competitors",
      "competitor_diffs", "analysis_graphs", "dashboards",
    ];
    try {
      raw.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
      for (const migration of ["001_initial.sql", "002_data_research.sql", "003_analysis_graphs.sql", "004_dashboard_strategy.sql"]) {
        raw.exec(readFileSync(fileURLToPath(new URL(`../../migrations/${migration}`, import.meta.url)), "utf8"));
      }
      const insert = (table: string, id: string, referenceColumn?: string, referenceId?: string) => {
        const columns = ["id", "workspace_id", ...(referenceColumn ? [referenceColumn] : []), "version", "created_at", "updated_at", "payload"];
        const values = [id, "ws-1", ...(referenceId ? [referenceId] : []), "1", now, now, canonicalJson(entity(id, "ws-1"))];
        raw.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
      };
      insert("workspaces", "ws-1");
      insert("sources", "source-1");
      insert("datasets", "dataset-1", "source_id", "source-1");
      insert("evidence", "evidence-1", "source_id", "source-1");
      for (const table of payloadTables.slice(4)) insert(table, `${table}-legacy`);
      raw.exec("COMMIT");
    } finally {
      raw.close();
    }
    const before = new DatabaseSync(databasePath);
    let oldPayloads: Record<string, unknown[]>;
    try {
      oldPayloads = Object.fromEntries(payloadTables.map((table) => [table, before.prepare(`SELECT id, payload FROM ${table} ORDER BY id`).all()]));
    } finally {
      before.close();
    }

    const store = open();
    expect(await store.transaction((repos) => repos.workspaces.get("ws-1", "ws-1"))).toEqual(entity("ws-1"));
    store.close();
    const migrated = new DatabaseSync(databasePath);
    try {
      for (const table of payloadTables) {
        expect(migrated.prepare(`SELECT id, payload FROM ${table} ORDER BY id`).all()).toEqual(oldPayloads[table]);
      }
      expect(migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 7 });
    } finally {
      migrated.close();
    }
  });
});

describe("publishing and effect SQLite persistence", () => {
  let tempDir: string;
  let databasePath: string;
  let stores: Store[];

  beforeEach(async () => {
    tempDir = await createTempDir();
    databasePath = join(tempDir, "store.db");
    stores = [];
  });

  afterEach(async () => {
    for (const store of stores) store.close();
    await removeTempDir(tempDir);
  });

  function open(path = databasePath): Store {
    const store = openStore(path);
    stores.push(store);
    return store;
  }

  function benchmarkRecord(overrides: Record<string, unknown> = {}): BenchmarkAnalysis {
    return createBenchmarkAnalysis({
      id: "benchmark-1", workspaceId: "ws-1", createdAt: now, modality: "image", status: "partial",
      methods: [], gaps: [], evidenceIds: ["evidence-1"], competitorDiffId: "diff-1",
      sourceVersions: [
        { entityType: "source", id: "source-1", version: 1 },
        { entityType: "evidence", id: "evidence-1", version: 1 },
        { entityType: "competitor_diff", id: "diff-1", version: 1 },
      ],
      provider: {
        type: "mcp", tool: "reverse_engineer", toolVersion: "fixture-1", inputHash: "b".repeat(64),
        analysisMethod: "fixture-v1", humanReview: "not_performed",
      },
      ...overrides,
    });
  }

  function briefRecord(overrides: Record<string, unknown> = {}): ContentBrief {
    return createContentBrief({
      id: "brief-1", workspaceId: "ws-1", createdAt: now, channel: "xhs",
      taskId: "task-1", recommendationId: "recommendation-1", benchmarkAnalysisId: "benchmark-1",
      methodIds: ["method-1"], objective: "Objective", audience: "Audience",
      copy: {
        hook: { id: "hook", kind: "creative", text: "Hook" },
        body: [{ id: "body", kind: "creative", text: "Body" }],
        cta: { id: "cta", kind: "creative", text: "CTA" },
      },
      frames: [], assetRequirements: [], findingIds: ["finding-1"], evidenceIds: ["evidence-1"],
      sourceVersions: [
        { entityType: "task", id: "task-1", version: 1 },
        { entityType: "recommendation", id: "recommendation-1", version: 1 },
        { entityType: "benchmark_analysis", id: "benchmark-1", version: 1 },
        { entityType: "finding", id: "finding-1", version: 1 },
        { entityType: "evidence", id: "evidence-1", version: 1 },
        { entityType: "source", id: "source-1", version: 1 },
      ],
      ...overrides,
    });
  }

  function assetRecord(overrides: Record<string, unknown> = {}): AssetVersion {
    return createAssetVersion({
      id: "asset-1", workspaceId: "ws-1", createdAt: now, contentId: "content-1", channel: "xhs",
      briefId: "brief-1", briefVersion: 1, taskId: "task-1", recommendationId: "recommendation-1",
      parentVersionId: null, parentVersion: null,
      artifact: { id: "primary-1", kind: "primary", mediaType: "image/png", contentHash: "c".repeat(64), byteLength: 100 },
      sourceMaterials: [],
      modification: { summary: "Initial", revisionInstructions: "Generate", actor: "agent-1", requestId: "request-1", createdAt: now },
      provider: { type: "mcp", tool: "render", toolVersion: "fixture-1", inputHash: "d".repeat(64) },
      validation: {
        status: "passed", profileId: "xhs_png_1080x1440_v1", guarantee: "internal_acceptance_only",
        decoder: "playwright_chromium", width: 1080, height: 1440, durationMs: null, videoCodec: null, audioCodec: null,
      },
      evidenceIds: ["evidence-1"],
      sourceVersions: [
        { entityType: "content_brief", id: "brief-1", version: 1 },
        { entityType: "task", id: "task-1", version: 1 },
        { entityType: "recommendation", id: "recommendation-1", version: 1 },
        { entityType: "evidence", id: "evidence-1", version: 1 },
        { entityType: "source", id: "source-1", version: 1 },
      ],
      ...overrides,
    });
  }

  function approvalRecord(overrides: Record<string, unknown> = {}): Approval {
    return createApproval({
      id: "approval-1", workspaceId: "ws-1", createdAt: now, assetVersionId: "asset-1", assetVersion: 1,
      artifactHash: "c".repeat(64), decision: "approved",
      reviewer: { actor: "human-1", attestation: "human_attested" }, comment: "Approved", decidedAt: now,
      ...overrides,
    });
  }

  function scheduleRecord(overrides: Record<string, unknown> = {}): Schedule {
    return createSchedule({
      id: "schedule-1", workspaceId: "ws-1", createdAt: now, assetVersionId: "asset-1", assetVersion: 1,
      approvalId: "approval-1", channel: "xhs", accountId: "account-1", scheduledFor: later,
      timeZone: "UTC", deliveryMode: "automatic", status: "scheduled",
      ...overrides,
    });
  }

  function publicationRecord(overrides: Record<string, unknown> = {}): Publication {
    return createPublication({
      id: "publication-1", workspaceId: "ws-1", createdAt: now, scheduleId: "schedule-1", scheduleVersion: 1,
      assetVersionId: "asset-1", assetVersion: 1, approvalId: "approval-1", artifactHash: "c".repeat(64),
      operationKey: `publish:v1:${"e".repeat(64)}`, channel: "xhs", accountId: "account-1", deliveryMode: "automatic",
      status: "pending", attempts: [], receipts: [], failure: null, delivery: null, verification: null,
      ...overrides,
    });
  }

  function snapshotRecord(overrides: Record<string, unknown> = {}): MetricSnapshot {
    return createMetricSnapshot({
      id: "snapshot-1", workspaceId: "ws-1", createdAt: later, publicationId: "publication-1", publicationVersion: 1,
      windowStart: now, windowEnd: later, observedAt: later,
      observations: [{ metric: "impressions", evidenceIds: ["evidence-1"], value: 10 }],
      ...overrides,
    });
  }

  function reviewRecord(overrides: Record<string, unknown> = {}): EffectReview {
    const section = {
      metrics: [{ name: "observed", value: 1, status: "ok" as const, reason: null, numerator: 1, denominator: 1 }],
      notes: [], limitations: [], causality: "not_established" as const,
    };
    return createEffectReview({
      id: "review-1", workspaceId: "ws-1", createdAt: later,
      publicationRefs: [{ id: "publication-1", version: 1 }], metricSnapshotIds: ["snapshot-1"],
      baselineMetricSnapshotIds: [], benchmarkEvidenceIds: ["evidence-1"],
      sourceVersions: [
        { entityType: "publication", id: "publication-1", version: 1 },
        { entityType: "metric_snapshot", id: "snapshot-1", version: 1 },
        { entityType: "evidence", id: "evidence-1", version: 1 },
      ],
      efficiency: section, content: section, conversion: section, automation: section,
      ...overrides,
    });
  }

  async function seedContent(store: Store): Promise<void> {
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(entity("ws-1"));
      await repos.sources.insert(entity("source-1", "ws-1"));
      await repos.evidence.insert({ ...entity("evidence-1", "ws-1"), sourceId: "source-1" });
      await repos.findings.insert({ ...entity("finding-1", "ws-1"), evidenceIds: ["evidence-1"] });
      await repos.competitorDiffs.insert({ ...entity("diff-1", "ws-1"), findingIds: ["finding-1"] });
      await repos.recommendations.insert({ ...entity("recommendation-1", "ws-1"), findingIds: ["finding-1"] });
      await repos.tasks.insert({ ...entity("task-1", "ws-1"), recommendationIds: ["recommendation-1"], dependencyIds: [] });
      await repos.benchmarkAnalyses.insert(benchmarkRecord());
      await repos.contentBriefs.insert(briefRecord());
      await repos.assetVersions.insert(assetRecord());
    });
  }

  async function seedPublishing(store: Store): Promise<void> {
    await seedContent(store);
    await store.transaction(async (repos) => {
      await repos.approvals.insert(approvalRecord());
      await repos.schedules.insert(scheduleRecord());
      await repos.publications.insert(publicationRecord());
    });
  }

  it("persists every repository across restart and enforces optimistic versions and uniqueness", async () => {
    const first = open();
    await seedPublishing(first);
    await first.transaction(async (repos) => {
      await repos.metricSnapshots.insert(snapshotRecord());
      await repos.effectReviews.insert(reviewRecord());
    });
    await expect(first.transaction((repos) => repos.approvals.insert(approvalRecord({ id: "approval-2" })))).rejects.toThrow();
    await expect(first.transaction((repos) => repos.publications.insert(publicationRecord({ id: "publication-2", operationKey: `publish:v1:${"f".repeat(64)}` })))).rejects.toThrow();
    await first.transaction((repos) => repos.schedules.update({ ...scheduleRecord(), scheduledFor: "2026-10-29T12:02:00.000Z", updatedAt: later }, 1));
    await expect(first.transaction((repos) => repos.schedules.update(scheduleRecord(), 1))).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await first.transaction((repos) => repos.publications.update({ ...publicationRecord(), status: "submitted", updatedAt: later }, 1));
    await expect(first.transaction((repos) => repos.publications.update(publicationRecord(), 1))).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    first.close();

    const second = open();
    expect(await second.transaction((repos) => repos.approvals.get("approval-1", "ws-1"))).toEqual(approvalRecord());
    expect(await second.transaction((repos) => repos.schedules.get("schedule-1", "ws-1"))).toMatchObject({ version: 2 });
    expect(await second.transaction((repos) => repos.publications.getByScheduleId("schedule-1", "ws-1"))).toMatchObject({ id: "publication-1", version: 2, status: "submitted" });
    expect(await second.transaction((repos) => repos.metricSnapshots.get("snapshot-1", "ws-1"))).toEqual(snapshotRecord());
    expect(await second.transaction((repos) => repos.effectReviews.get("review-1", "ws-1"))).toEqual(reviewRecord());
  });

  it.each([
    ["operationKey", `publish:v1:${"f".repeat(64)}`],
    ["scheduleId", "schedule-other"],
    ["scheduleVersion", 2],
    ["assetVersionId", "asset-other"],
    ["assetVersion", 2],
    ["approvalId", "approval-other"],
    ["artifactHash", "f".repeat(64)],
    ["channel", "channels"],
    ["accountId", "account-other"],
  ] as const)("keeps Publication identity field %s immutable across optimistic updates", async (field, value) => {
    const store = open();
    await seedPublishing(store);
    const changed = publicationRecord({ [field]: value });

    await expect(store.transaction((repos) => repos.publications.update(
      { ...changed, updatedAt: later },
      1,
    ))).rejects.toThrow(/identity|immutable/i);
    expect(await store.transaction((repos) => repos.publications.get("publication-1", "ws-1"))).toEqual(publicationRecord());
  });

  it.each([
    {
      table: "metric_snapshot_evidence",
      ownerColumn: "snapshot_id",
      ownerId: "snapshot-1",
      targetColumn: "evidence_id",
      insertedTarget: "evidence-2",
    },
    {
      table: "effect_review_publications",
      ownerColumn: "review_id",
      ownerId: "review-1",
      targetColumn: "publication_id",
      insertedTarget: "publication-2",
    },
    {
      table: "effect_review_metric_snapshots",
      ownerColumn: "review_id",
      ownerId: "review-1",
      targetColumn: "snapshot_id",
      insertedTarget: "snapshot-2",
    },
    {
      table: "effect_review_evidence",
      ownerColumn: "review_id",
      ownerId: "review-1",
      targetColumn: "evidence_id",
      insertedTarget: "evidence-2",
    },
  ] as const)("protects $table for the immutable parent lifetime", async ({ table, ownerColumn, ownerId, targetColumn, insertedTarget }) => {
    const first = open();
    await seedPublishing(first);
    await first.transaction(async (repos) => {
      await repos.evidence.insert({ ...entity("evidence-2", "ws-1"), sourceId: "source-1" });
      await repos.schedules.insert(scheduleRecord({ id: "schedule-2" }));
      await repos.publications.insert(publicationRecord({ id: "publication-2", scheduleId: "schedule-2", operationKey: `publish:v1:${"f".repeat(64)}` }));
      await repos.metricSnapshots.insert(snapshotRecord());
      await repos.metricSnapshots.insert(snapshotRecord({ id: "snapshot-2", publicationId: "publication-2" }));
      await repos.effectReviews.insert(reviewRecord());
    });
    first.close();

    const raw = new DatabaseSync(databasePath);
    try {
      expect(() => raw.prepare(
        `INSERT INTO ${table} (workspace_id, ${ownerColumn}, ${targetColumn}, position) VALUES ('ws-1', ?, ?, 1)`,
      ).run(ownerId, insertedTarget)).toThrow(/immutable/i);
      expect(() => raw.prepare(`UPDATE ${table} SET position = 99 WHERE ${ownerColumn} = ?`).run(ownerId)).toThrow(/immutable/i);
      expect(() => raw.prepare(`DELETE FROM ${table} WHERE ${ownerColumn} = ?`).run(ownerId)).toThrow(/immutable/i);
      expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${ownerColumn} = ?`).get(ownerId)).toEqual({ count: 1 });
    } finally {
      raw.close();
    }

    const reopened = open();
    if (table === "metric_snapshot_evidence") {
      expect(await reopened.transaction((repos) => repos.metricSnapshots.get("snapshot-1", "ws-1"))).toEqual(snapshotRecord());
    } else {
      expect(await reopened.transaction((repos) => repos.effectReviews.get("review-1", "ws-1"))).toEqual(reviewRecord());
    }
  });

  it("lists due schedules in timestamp/ID order and recovery candidates by update order", async () => {
    const store = open();
    await seedPublishing(store);
    await store.transaction(async (repos) => {
      await repos.assetVersions.insert(assetRecord({ id: "asset-2", contentId: "content-2" }));
      await repos.approvals.insert(approvalRecord({ id: "approval-2", assetVersionId: "asset-2" }));
      await repos.schedules.insert(scheduleRecord({ id: "schedule-2", assetVersionId: "asset-2", approvalId: "approval-2", scheduledFor: now }));
      await repos.schedules.insert(scheduleRecord({ id: "schedule-3", assetVersionId: "asset-2", approvalId: "approval-2", scheduledFor: now, status: "cancelled" }));
      await repos.publications.insert(publicationRecord({ id: "publication-unknown", scheduleId: "schedule-3", status: "unknown", createdAt: later, operationKey: `publish:v1:${"a".repeat(64)}` }));
      await repos.publications.insert(publicationRecord({ id: "publication-submitting", scheduleId: "schedule-2", status: "submitting", createdAt: now, operationKey: `publish:v1:${"f".repeat(64)}` }));
    });
    expect(await store.transaction((repos) => repos.schedules.listDue("ws-1", later))).toEqual([
      expect.objectContaining({ id: "schedule-2" }),
      expect.objectContaining({ id: "schedule-1" }),
    ]);
    expect(await store.transaction((repos) => repos.schedules.listDue("ws-1", later, 1))).toEqual([
      expect.objectContaining({ id: "schedule-2" }),
    ]);
    expect(await store.transaction((repos) => repos.publications.listRecoveryCandidates("ws-1"))).toEqual([
      expect.objectContaining({ id: "publication-submitting" }),
      expect.objectContaining({ id: "publication-unknown" }),
    ]);
  });

  it("enforces immutable triggers and workspace-scoped references including nested Evidence", async () => {
    const store = open();
    await seedPublishing(store);
    await store.transaction(async (repos) => {
      await repos.metricSnapshots.insert(snapshotRecord());
      await repos.effectReviews.insert(reviewRecord());
      await repos.workspaces.insert(entity("ws-2"));
      await repos.sources.insert(entity("source-other", "ws-2"));
      await repos.evidence.insert({ ...entity("evidence-other", "ws-2"), sourceId: "source-other" });
    });
    await expect(store.transaction((repos) => repos.approvals.insert(approvalRecord({ id: "cross-approval", workspaceId: "ws-2" })))).rejects.toThrow();
    await expect(store.transaction((repos) => repos.schedules.insert(scheduleRecord({ id: "cross-schedule", workspaceId: "ws-2" })))).rejects.toThrow();
    await expect(store.transaction((repos) => repos.publications.insert(publicationRecord({ id: "cross-publication", workspaceId: "ws-2" })))).rejects.toThrow();
    await expect(store.transaction((repos) => repos.metricSnapshots.insert(snapshotRecord({ id: "cross-snapshot", workspaceId: "ws-2" })))).rejects.toThrow();
    await expect(store.transaction((repos) => repos.effectReviews.insert(reviewRecord({ id: "cross-review", workspaceId: "ws-2" })))).rejects.toThrow();
    await expect(store.transaction((repos) => repos.metricSnapshots.insert(snapshotRecord({ id: "cross-evidence", observations: [{ metric: "leads", evidenceIds: ["evidence-other"], value: 1 }] })))).rejects.toThrow();
    await expect(store.transaction((repos) => repos.effectReviews.insert(reviewRecord({ id: "cross-benchmark", benchmarkEvidenceIds: ["evidence-other"], sourceVersions: reviewRecord().sourceVersions.map((ref) => ref.entityType === "evidence" ? { ...ref, id: "evidence-other" } : ref) })))).rejects.toThrow();

    const raw = new DatabaseSync(databasePath);
    try {
      for (const [table, id] of [["approvals", "approval-1"], ["metric_snapshots", "snapshot-1"], ["effect_reviews", "review-1"]] as const) {
        expect(() => raw.prepare(`UPDATE ${table} SET payload = payload WHERE id = ?`).run(id)).toThrow(/immutable/i);
        expect(() => raw.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)).toThrow(/immutable/i);
      }
    } finally {
      raw.close();
    }
  });

  it("rolls back a schedule/publication pair and preserves recovery queries after restart", async () => {
    const first = open();
    await seedContent(first);
    await expect(first.transaction(async (repos) => {
      await repos.approvals.insert(approvalRecord());
      await repos.schedules.insert(scheduleRecord());
      await repos.publications.insert(publicationRecord({ operationKey: "not-a-key" }));
      throw new Error("abort pair");
    })).rejects.toThrow("abort pair");
    expect(await first.transaction((repos) => repos.schedules.get("schedule-1", "ws-1"))).toBeUndefined();
    await first.transaction(async (repos) => {
      await repos.approvals.insert(approvalRecord());
      await repos.schedules.insert(scheduleRecord());
      await repos.publications.insert(publicationRecord({ status: "unknown" }));
    });
    first.close();
    const second = open();
    expect(await second.transaction((repos) => repos.publications.listRecoveryCandidates("ws-1"))).toEqual([
      publicationRecord({ status: "unknown" }),
    ]);
  });

  it("upgrades populated v5 records byte-for-byte and repeats migrations 006 and 007 without changes", async () => {
    const raw = new DatabaseSync(databasePath);
    const records: [string, EntityRecord, Record<string, string | null>][] = [
      ["workspaces", entity("ws-1"), {}],
      ["sources", entity("source-1", "ws-1"), {}],
      ["evidence", { ...entity("evidence-1", "ws-1"), sourceId: "source-1" }, { source_id: "source-1" }],
      ["findings", { ...entity("finding-1", "ws-1"), evidenceIds: [] }, {}],
      ["competitor_diffs", { ...entity("diff-1", "ws-1"), findingIds: [] }, {}],
      ["recommendations", { ...entity("recommendation-1", "ws-1"), findingIds: [] }, {}],
      ["tasks", { ...entity("task-1", "ws-1"), recommendationIds: [], dependencyIds: [] }, {}],
      ["benchmark_analyses", benchmarkRecord(), { competitor_diff_id: "diff-1" }],
      ["content_briefs", briefRecord(), { task_id: "task-1", recommendation_id: "recommendation-1", benchmark_analysis_id: "benchmark-1" }],
      ["asset_versions", assetRecord(), { content_id: "content-1", brief_id: "brief-1", task_id: "task-1", recommendation_id: "recommendation-1", parent_version_id: null }],
    ];
    try {
      raw.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
      for (const migration of ["001_initial.sql", "002_data_research.sql", "003_analysis_graphs.sql", "004_dashboard_strategy.sql", "005_content_production.sql"]) {
        raw.exec(readFileSync(fileURLToPath(new URL(`../../migrations/${migration}`, import.meta.url)), "utf8"));
      }
      for (const [table, record, references] of records) {
        const columns = ["id", "workspace_id", ...Object.keys(references), "version", "created_at", "updated_at", "payload"];
        const values = [record.id, record.workspaceId, ...Object.values(references), "1", record.createdAt, record.updatedAt, canonicalJson(record)];
        raw.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
      }
      raw.exec("COMMIT");
    } finally {
      raw.close();
    }
    const tables = [
      "workspaces", "sources", "datasets", "evidence", "findings", "recommendations", "tasks", "capabilities",
      "data_request_plans", "ingestion_batches", "research_sessions", "competitors", "competitor_diffs", "analysis_graphs",
      "dashboards", "benchmark_analyses", "content_briefs", "asset_versions",
    ];
    const before = new DatabaseSync(databasePath);
    let payloads: Record<string, unknown[]>;
    try {
      payloads = Object.fromEntries(tables.map((table) => [table, before.prepare(`SELECT id, payload FROM ${table} ORDER BY id`).all()]));
    } finally {
      before.close();
    }
    const first = open();
    first.close();
    const second = open();
    expect(await second.transaction((repos) => repos.assetVersions.get("asset-1", "ws-1"))).toEqual(assetRecord());
    const migrated = new DatabaseSync(databasePath);
    try {
      for (const table of tables) expect(migrated.prepare(`SELECT id, payload FROM ${table} ORDER BY id`).all()).toEqual(payloads[table]);
      expect(migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 7 });
      expect(migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'schedules_due_idx'").get()).toEqual({
        sql: "CREATE INDEX schedules_due_idx ON schedules(status, scheduled_for)",
      });
    } finally {
      migrated.close();
    }
  });
});

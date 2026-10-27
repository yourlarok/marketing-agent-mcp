import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
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
});

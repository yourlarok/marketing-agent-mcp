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
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-26T12:30:00.000Z";

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

  it("enforces lineage references and preserves evidence order", async () => {
    const store = open();
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(entity("ws-1"));
      await repos.sources.insert(entity("source-1", "ws-1"));
      await repos.evidence.insert(entity("evidence-1", "ws-1"));
      await repos.findings.insert({
        ...entity("finding-1", "ws-1"),
        evidenceIds: ["evidence-1"],
      });
    });

    await expect(
      store.transaction((repos) =>
        repos.findings.insert({
          ...entity("finding-2", "ws-1"),
          evidenceIds: ["missing-evidence"],
        }),
      ),
    ).rejects.toThrow();
  });

  it("provides UTC system time and unique IDs", () => {
    const clock = new SystemClock();
    const ids = new SystemIdGenerator();

    expect(clock.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(ids.next()).not.toBe(ids.next());
  });

  it("canonicalizes JSON object keys recursively", () => {
    expect(canonicalJson({ z: 1, a: [{ z: 2, a: 1 }] })).toBe(
      '{"a":[{"a":1,"z":2}],"z":1}',
    );
  });
});

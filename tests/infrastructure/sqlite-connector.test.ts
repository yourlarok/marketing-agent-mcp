import { createHash } from "node:crypto";
import { existsSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sqliteControl = vi.hoisted(() => ({ beforeOpen: undefined as (() => void) | undefined }));
vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  return {
    ...actual,
    DatabaseSync: class extends actual.DatabaseSync {
      constructor(path: string, options?: { readOnly?: boolean }) {
        sqliteControl.beforeOpen?.();
        super(path, options ?? {});
      }
    },
  };
});
import { loadConfig } from "../../src/config.js";
import type { StructuredTableQuery } from "../../src/domain/connector-model.js";
import { DomainError } from "../../src/domain/errors.js";
import { SqliteConnector } from "../../src/infrastructure/sqlite-connector.js";
import { canonicalJson } from "../../src/infrastructure/sqlite.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-27T01:02:03.000Z";

function query(patch: Partial<StructuredTableQuery> = {}): StructuredTableQuery {
  return {
    databaseId: "warehouse/marketing",
    table: "daily_metrics",
    columns: ["id", "day", "channel", "active", "clicks", "note"],
    filters: {},
    order: [{ column: "day", direction: "asc" }],
    limit: 100,
    ...patch,
  };
}

describe("SqliteConnector", () => {
  let tempDir: string;
  let root: string;
  let outside: string;
  let databasePath: string;
  let connector: SqliteConnector;

  beforeEach(async () => {
    tempDir = await createTempDir();
    root = join(tempDir, "authorized");
    outside = join(tempDir, "outside");
    await mkdir(join(root, "warehouse"), { recursive: true });
    await mkdir(outside);
    databasePath = join(root, "warehouse", "marketing.sqlite");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE daily_metrics (
          id INTEGER,
          day TEXT,
          channel TEXT,
          active BOOLEAN,
          clicks INTEGER,
          note TEXT
        );
        INSERT INTO daily_metrics VALUES
          (1, '2026-10-26', 'owned', 1, 10, 'first'),
          (2, '2026-10-26', 'owned', 1, 20, NULL),
          (3, '2026-10-25', 'partner', 0, 30, 'other'),
          (4, '2026-10-27', 'owned', 0, 40, 'inactive');
        CREATE TABLE campaign_types (value);
        INSERT INTO campaign_types VALUES ('text'), (12), (NULL);
      `);
    } finally {
      database.close();
    }
    const other = new DatabaseSync(join(root, "other.db"));
    try {
      other.exec("CREATE TABLE private_data (secret TEXT)");
    } finally {
      other.close();
    }
    await writeFile(join(root, "notes.txt"), "not a database");
    connector = new SqliteConnector(root, { now: () => now });
  });

  afterEach(async () => {
    sqliteControl.beforeOpen = undefined;
    await removeTempDir(tempDir);
  });

  it("discovers only the requested authorized database schema", () => {
    expect(connector.discover("warehouse/marketing")).toEqual({
      databaseId: "warehouse/marketing",
      tables: [
        {
          name: "campaign_types",
          columns: [{ name: "value", type: "unknown" }],
        },
        {
          name: "daily_metrics",
          columns: [
            { name: "id", type: "number" },
            { name: "day", type: "string" },
            { name: "channel", type: "string" },
            { name: "active", type: "number" },
            { name: "clicks", type: "number" },
            { name: "note", type: "string" },
          ],
        },
      ],
    });
    expect(connector.discover("warehouse/marketing.sqlite")).toEqual({
      ...connector.discover("warehouse/marketing"),
      databaseId: "warehouse/marketing.sqlite",
    });
    expect(connector.discover("other.db")).toEqual({
      databaseId: "other.db",
      tables: [{ name: "private_data", columns: [{ name: "secret", type: "string" }] }],
    });
  });

  it("uses actual schema whitelists, equality filters, stable ordering, and a bounded limit", () => {
    const snapshot = connector.snapshot(query({
      filters: { channel: "owned", active: true },
      order: [{ column: "day", direction: "asc" }],
      limit: 1,
    }));
    expect(snapshot).toMatchObject({
      rows: [{ id: 1, day: "2026-10-26", channel: "owned", active: 1, clicks: 10, note: "first" }],
      observedAt: now,
      sourceDescriptor: {
        connectorId: "sqlite-readonly",
        databaseId: "warehouse/marketing",
        table: "daily_metrics",
      },
    });
    expect(snapshot.queryHash).toBe(
      createHash("sha256").update(canonicalJson(query({
        filters: { channel: "owned", active: true },
        order: [{ column: "day", direction: "asc" }],
        limit: 1,
      }))).digest("hex"),
    );

    expect(connector.snapshot(query({
      filters: { channel: "owned", active: true },
    })).rows.map((row) => row.id)).toEqual([1, 2]);
    expect(connector.snapshot(query({ filters: { note: null }, order: [] })).rows.map((row) => row.id)).toEqual([2]);
    expect(connector.snapshot(query({
      order: [{ column: "day", direction: "desc" }],
      limit: 3,
    })).rows.map((row) => row.id)).toEqual([4, 1, 2]);
    expect(connector.snapshot(query({ filters: { channel: "partner" } })).queryHash).not.toBe(snapshot.queryHash);

    for (const invalid of [
      query({ table: "missing" }),
      query({ columns: ["missing"] }),
      query({ filters: { missing: 1 } }),
      query({ order: [{ column: "missing", direction: "asc" }] }),
    ]) {
      expect(() => connector.snapshot(invalid)).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
      );
    }
  });

  it.each([
    { table: "shadowed_rowid", declarations: "rowid INTEGER, value TEXT" },
    { table: "shadowed_aliases", declarations: "rowid INTEGER, _rowid_ INTEGER, value TEXT" },
  ])("uses an unshadowed hidden rowid alias for duplicate declared keys in $table", ({ table, declarations }) => {
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE ${table} (${declarations});
        CREATE INDEX ${table}_index ON ${table}(rowid);
        INSERT INTO ${table} (rowid, value) VALUES
          (1, 'first'),
          (1, 'second'),
          (1, 'third');
      `);
    } finally {
      database.close();
    }

    const snapshot = connector.snapshot(query({
      table,
      columns: ["rowid", "value"],
      order: [{ column: "rowid", direction: "desc" }],
    }));
    expect(snapshot.rows.map((row) => row.value)).toEqual(["first", "second", "third"]);
  });

  it("rejects ordering when every hidden rowid alias is shadowed and no unique key exists", () => {
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE no_hidden_rowid (
          rowid INTEGER,
          _rowid_ INTEGER,
          oid INTEGER,
          value TEXT
        );
        INSERT INTO no_hidden_rowid VALUES (1, 2, 3, 'value');
      `);
    } finally {
      database.close();
    }

    expect(() => connector.snapshot(query({
      table: "no_hidden_rowid",
      columns: ["value"],
      order: [{ column: "value", direction: "asc" }],
    }))).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }));
  });

  it("rejects nullable primary keys with duplicate NULL when hidden rowid aliases are shadowed", () => {
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE nullable_primary_key (
          rowid INTEGER,
          _rowid_ INTEGER,
          oid INTEGER,
          value TEXT,
          PRIMARY KEY(value)
        );
        INSERT INTO nullable_primary_key VALUES
          (1, 2, 3, NULL),
          (1, 2, 3, NULL);
      `);
    } finally {
      database.close();
    }

    expect(() => connector.snapshot(query({
      table: "nullable_primary_key",
      columns: ["rowid", "value"],
      order: [{ column: "rowid", direction: "asc" }],
    }))).toThrowError(expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }));
  });

  it("represents mixed SQLite value types as unknown instead of forging a scalar type", () => {
    const snapshot = connector.snapshot(query({
      table: "campaign_types",
      columns: ["value"],
      order: [],
    }));
    expect(snapshot.schema).toEqual([{ name: "value", type: "unknown" }]);
    expect(snapshot.rows).toEqual([{ value: "text" }, { value: 12 }, { value: null }]);
  });

  it("fails closed with a controlled error for a real uncheckpointed WAL database", () => {
    const walPath = join(root, "warehouse", "wal.sqlite");
    const writer = new DatabaseSync(walPath);
    try {
      writer.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE daily_metrics (
          id INTEGER,
          day TEXT,
          channel TEXT,
          active BOOLEAN,
          clicks INTEGER,
          note TEXT
        );
        INSERT INTO daily_metrics VALUES
          (1, '2026-10-28', 'owned', 1, 100, 'wal-only');
      `);
      expect(writer.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(existsSync(`${walPath}-wal`)).toBe(true);

      for (const read of [
        () => connector.discover("warehouse/wal"),
        () => connector.snapshot(query({ databaseId: "warehouse/wal" })),
      ]) {
        expect(read).toThrowError(expect.objectContaining<Partial<DomainError>>({
          code: "CAPABILITY_UNAVAILABLE",
          details: expect.objectContaining({
            capability: "sqlite",
            reason: "wal_not_supported",
          }),
        }));
      }
    } finally {
      writer.close();
    }
  });

  it.each([
    "/etc/passwd",
    "../outside.sqlite",
    "warehouse/../outside.sqlite",
    "warehouse\\marketing",
    "warehouse/marketing.txt",
  ])("rejects unsafe or unauthorized database path %s", (databaseId) => {
    expect(() => connector.discover(databaseId)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
    );
  });

  it("rejects final and intermediate symbolic links that escape the authorized root", async () => {
    const externalPath = join(outside, "external.sqlite");
    const external = new DatabaseSync(externalPath);
    external.close();
    await symlink(externalPath, join(root, "link.sqlite"));
    await symlink(outside, join(root, "escape"));

    for (const databaseId of ["link", "escape/external"]) {
      expect(() => connector.discover(databaseId)).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
      );
    }
  });

  it.each(["file", "directory"] as const)(
    "keeps reads on the verified database when a %s is replaced before SQLite open",
    (replacement) => {
      const externalPath = join(
        outside,
        replacement === "file" ? "external.sqlite" : "marketing.sqlite",
      );
      const external = new DatabaseSync(externalPath);
      try {
        external.exec(`
          CREATE TABLE daily_metrics (
            id INTEGER,
            day TEXT,
            channel TEXT,
            active BOOLEAN,
            clicks INTEGER,
            note TEXT
          );
          INSERT INTO daily_metrics VALUES
            (999, '2030-01-01', 'external', 1, 999, 'unauthorized');
        `);
      } finally {
        external.close();
      }
      sqliteControl.beforeOpen = () => {
        sqliteControl.beforeOpen = undefined;
        if (replacement === "file") {
          unlinkSync(databasePath);
          symlinkSync(externalPath, databasePath);
        } else {
          renameSync(join(root, "warehouse"), join(root, "warehouse-held"));
          symlinkSync(outside, join(root, "warehouse"));
        }
      };

      expect(connector.snapshot(query()).rows.map((row) => row.id)).toEqual([3, 1, 2, 4]);
    },
  );

  it("rejects write-shaped and arbitrary SQL forms without changing source data", () => {
    const before = new DatabaseSync(databasePath, { readOnly: true });
    const countBefore = before.prepare("SELECT COUNT(*) AS count FROM daily_metrics").get();
    before.close();

    const attacks: unknown[] = [
      { ...query(), table: "daily_metrics; DROP TABLE daily_metrics" },
      { ...query(), table: "daily_metrics WHERE 1=1" },
      { ...query(), filters: { channel: { eq: "owned" } } },
      { ...query(), order: [{ column: "day; DELETE FROM daily_metrics", direction: "asc" }] },
      { ...query(), sql: "DELETE FROM daily_metrics" },
      { ...query(), limit: "1; DROP TABLE daily_metrics" },
    ];
    for (const attack of attacks) {
      expect(() => connector.snapshot(attack as StructuredTableQuery)).toThrowError(
        expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
      );
    }

    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(after.prepare("SELECT COUNT(*) AS count FROM daily_metrics").get()).toEqual(countBefore);
    } finally {
      after.close();
    }
  });

  it("enforces the connector row ceiling before reading the database", () => {
    expect(() => connector.snapshot(query({ limit: 100_001 }))).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
    );
  });

  it("reports a missing root as unavailable and validates a configured root at startup", () => {
    const unavailable = new SqliteConnector(undefined, { now: () => now });
    expect(() => unavailable.discover("warehouse/marketing")).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "CAPABILITY_UNAVAILABLE",
        details: { capability: "sqlite", configuration: "MARKETING_DATABASE_ROOT" },
      }),
    );
    expect(loadConfig({ MARKETING_DATA_DIR: root, MARKETING_DATABASE_ROOT: root })).toEqual({
      dataDir: root,
      databaseRoot: root,
      logLevel: "info",
    });
    expect(() => loadConfig({
      MARKETING_DATA_DIR: root,
      MARKETING_DATABASE_ROOT: join(root, "missing"),
    })).toThrow("MARKETING_DATABASE_ROOT must be an existing directory");
  });
});

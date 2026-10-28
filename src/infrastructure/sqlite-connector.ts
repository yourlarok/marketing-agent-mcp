import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { extname, relative, resolve, sep } from "node:path";
import type { Clock } from "../application/ports.js";
import {
  CONNECTOR_LIMITS,
  validateConnectorSnapshot,
  validateStructuredTableQuery,
  type ConnectorColumnSchema,
  type ConnectorManifest,
  type ConnectorScalar,
  type ConnectorSnapshot,
  type StructuredTableQuery,
} from "../domain/connector-model.js";
import { assertDatabaseId, assertIdentifier } from "../domain/contract-validation.js";
import { DomainError } from "../domain/errors.js";
import { canonicalJson } from "./sqlite.js";

export const SQLITE_CONNECTOR_MANIFEST: ConnectorManifest = {
  id: "sqlite-readonly",
  version: 1,
  kind: "sqlite",
  operations: ["discover", "snapshot"],
  inputSchema: {
    type: "object",
    required: ["databaseId", "table", "columns", "filters", "order", "limit"],
    additionalProperties: false,
    properties: {
      databaseId: { type: "string" },
      table: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" },
      columns: {
        type: "array",
        items: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" },
        minItems: 1,
        maxItems: CONNECTOR_LIMITS.maxColumns,
        uniqueItems: true,
      },
      filters: {
        type: "object",
        maxProperties: CONNECTOR_LIMITS.maxFilters,
        propertyNames: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" },
        additionalProperties: { type: ["string", "number", "boolean", "null"] },
      },
      order: {
        type: "array",
        maxItems: CONNECTOR_LIMITS.maxColumns,
        items: {
          type: "object",
          required: ["column", "direction"],
          additionalProperties: false,
          properties: {
            column: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
        },
      },
      limit: { type: "integer", minimum: 1, maximum: CONNECTOR_LIMITS.maxRows },
    },
  },
  limits: { ...CONNECTOR_LIMITS },
  ownership: ["owned", "authorized"],
  securityBoundaries: [
    "authorized_database_root",
    "read_only",
    "query_only",
    "schema_allowlist",
    "equality_filters_only",
    "stable_order",
    "no_arbitrary_sql",
    "wal_fail_closed",
  ],
};

export interface SqliteDiscoveredTable {
  name: string;
  columns: ConnectorColumnSchema[];
}

export interface SqliteDiscovery {
  databaseId: string;
  tables: SqliteDiscoveredTable[];
}

interface TableInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface AuthorizedTable {
  name: string;
  columns: ConnectorColumnSchema[];
  primaryKey: string[];
  reliablePrimaryKey: boolean;
  withoutRowid: boolean;
}

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

function walUnsupported(): never {
  throw new DomainError(
    "CAPABILITY_UNAVAILABLE",
    "SQLite WAL databases are not supported by this connector",
    false,
    { capability: "sqlite", reason: "wal_not_supported" },
  );
}

function quoteIdentifier(identifier: string): string {
  assertIdentifier(identifier, "SQLite identifier");
  return `"${identifier}"`;
}

function insideRoot(root: string, path: string): boolean {
  const child = relative(root, path);
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && resolve(root, child) === path;
}

function declaredType(declaration: string): ConnectorColumnSchema["type"] {
  const normalized = declaration.toUpperCase();
  if (/INT|REAL|FLOA|DOUB|NUM|DEC|BOOL/.test(normalized)) return "number";
  if (/CHAR|CLOB|TEXT|DATE|TIME/.test(normalized)) return "string";
  return "unknown";
}

export class SqliteConnector {
  private readonly root?: string;

  constructor(
    configuredRoot: string | undefined,
    private readonly clock: Clock,
  ) {
    if (configuredRoot) {
      let root: string;
      try {
        root = realpathSync(resolve(configuredRoot));
      } catch (error) {
        throw new Error("MARKETING_DATABASE_ROOT must be an existing directory", { cause: error });
      }
      if (!statSync(root).isDirectory()) {
        throw new Error("MARKETING_DATABASE_ROOT must be a directory");
      }
      this.root = root;
    }
  }

  isConfigured(): boolean {
    return this.root !== undefined;
  }

  discover(databaseId: string): SqliteDiscovery {
    assertDatabaseId(databaseId);
    const path = this.databaseHandle(databaseId);
    return this.withDatabase(path, (database) => ({
      databaseId,
      tables: this.tables(database).map((table) => ({
        name: table.name,
        columns: table.columns.map((column) => ({ ...column })),
      })),
    }));
  }

  snapshot(query: StructuredTableQuery): ConnectorSnapshot {
    validateStructuredTableQuery(query);
    const path = this.databaseHandle(query.databaseId);
    return this.withDatabase(path, (database) => {
      const table = this.tables(database, query.table)[0];
      if (!table) invalid("Query table is not present in the authorized database schema");
      const columns = new Map(table.columns.map((column) => [column.name, column]));
      for (const column of [
        ...query.columns,
        ...Object.keys(query.filters),
        ...query.order.map((order) => order.column),
      ]) {
        if (!columns.has(column)) invalid(`Query column is not present in the authorized table schema: ${column}`);
      }

      const selected = query.columns.map(quoteIdentifier).join(", ");
      const predicates: string[] = [];
      const parameters: (string | number | null)[] = [];
      for (const [column, value] of Object.entries(query.filters)) {
        if (value === null) {
          predicates.push(`${quoteIdentifier(column)} IS NULL`);
        } else {
          predicates.push(`${quoteIdentifier(column)} = ?`);
          parameters.push(typeof value === "boolean" ? Number(value) : value);
        }
      }
      const order = query.order.map((entry) =>
        `${quoteIdentifier(entry.column)} ${entry.direction.toUpperCase()}`
      );
      const hiddenRowid = table.withoutRowid
        ? undefined
        : ["rowid", "_rowid_", "oid"].find((alias) => !columns.has(alias));
      if (hiddenRowid) {
        order.push(`${quoteIdentifier(hiddenRowid)} ASC`);
      } else {
        if (!table.reliablePrimaryKey) invalid("Query table has no reliable stable ordering key");
        for (const column of table.primaryKey) {
          if (!query.order.some((entry) => entry.column === column)) order.push(`${quoteIdentifier(column)} ASC`);
        }
      }
      const sql = [
        `SELECT ${selected} FROM ${quoteIdentifier(query.table)}`,
        predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "",
        `ORDER BY ${order.join(", ")}`,
        `LIMIT ${query.limit}`,
      ].filter(Boolean).join(" ");
      const records = database.prepare(sql).all(...parameters) as Record<string, unknown>[];
      const rows = records.map((record) => this.snapshotRow(record, query.columns));
      const schema = query.columns.map((name): ConnectorColumnSchema => {
        const observed = new Set(rows.flatMap((row) => row[name] === null ? [] : [typeof row[name]]));
        return {
          name,
          type: observed.size > 1 ? "unknown" : observed.size === 0
            ? columns.get(name)!.type
            : observed.values().next().value as ConnectorColumnSchema["type"],
        };
      });
      const snapshot: ConnectorSnapshot = {
        rows,
        schema,
        observedAt: this.clock.now(),
        sourceDescriptor: {
          connectorId: SQLITE_CONNECTOR_MANIFEST.id,
          connectorVersion: SQLITE_CONNECTOR_MANIFEST.version,
          databaseId: query.databaseId,
          table: query.table,
          query: {
            databaseId: query.databaseId,
            table: query.table,
            columns: [...query.columns],
            filters: { ...query.filters },
            order: query.order.map((entry) => ({ ...entry })),
            limit: query.limit,
          },
        },
        queryHash: createHash("sha256").update(canonicalJson(query)).digest("hex"),
      };
      validateConnectorSnapshot(snapshot);
      return snapshot;
    });
  }

  private databaseHandle(databaseId: string): number {
    if (!this.root) {
      throw new DomainError(
        "CAPABILITY_UNAVAILABLE",
        "SQLite connector is unavailable until MARKETING_DATABASE_ROOT is configured",
        false,
        { capability: "sqlite", configuration: "MARKETING_DATABASE_ROOT" },
      );
    }
    assertDatabaseId(databaseId);
    const extension = extname(databaseId).toLowerCase();
    if (extension && extension !== ".sqlite" && extension !== ".db") {
      invalid("databaseId must resolve to a .sqlite or .db file");
    }
    const relativePath = extension ? databaseId : `${databaseId}.sqlite`;
    const candidate = resolve(this.root, relativePath);
    if (!insideRoot(this.root, candidate)) invalid("databaseId resolves outside MARKETING_DATABASE_ROOT");
    try {
      if (lstatSync(candidate).isSymbolicLink()) invalid("SQLite database must not be a symbolic link");
      const canonical = realpathSync(candidate);
      if (!insideRoot(this.root, canonical)) invalid("SQLite database resolves outside MARKETING_DATABASE_ROOT");
      if (!statSync(canonical).isFile()) invalid("SQLite database must be a regular file");
      try {
        lstatSync(`${canonical}-wal`);
        walUnsupported();
      } catch (error) {
        if (error instanceof DomainError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const descriptor = openSync(
        canonical,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const metadata = fstatSync(descriptor);
        const openedPath = realpathSync(canonical);
        const openedMetadata = statSync(canonical);
        if (
          openedPath !== canonical ||
          metadata.dev !== openedMetadata.dev ||
          metadata.ino !== openedMetadata.ino
        ) {
          invalid("SQLite database changed while opening");
        }
        if (!metadata.isFile()) invalid("SQLite database must be a regular file");
        return descriptor;
      } catch (error) {
        closeSync(descriptor);
        throw error;
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DomainError("NOT_FOUND", "Authorized SQLite database not found", false, { databaseId });
      }
      throw error;
    }
  }

  private withDatabase<T>(descriptor: number, read: (database: DatabaseSync) => T): T {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(`/dev/fd/${descriptor}`, { readOnly: true });
      database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
      const journal = database.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown };
      if (String(journal.journal_mode).toLowerCase() === "wal") walUnsupported();
      database.exec("BEGIN;");
      try {
        const result = read(database);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      try {
        database?.close();
      } finally {
        closeSync(descriptor);
      }
    }
  }

  private tables(database: DatabaseSync, selectedTable?: string): AuthorizedTable[] {
    const records = database.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ${selectedTable === undefined ? "" : "AND name = ?"} ORDER BY name`,
    ).all(...(selectedTable === undefined ? [] : [selectedTable])) as { name: string; sql: string | null }[];
    return records.map((record) => {
      assertIdentifier(record.name, "Discovered table");
      const info = database.prepare(`PRAGMA table_info(${quoteIdentifier(record.name)})`).all() as unknown as TableInfo[];
      if (info.length === 0 || info.length > CONNECTOR_LIMITS.maxColumns) {
        invalid("Discovered table must have a bounded non-empty schema");
      }
      const names = new Set<string>();
      const columns = info.map((column) => {
        assertIdentifier(column.name, "Discovered column");
        if (names.has(column.name)) invalid("Discovered table contains duplicate columns");
        names.add(column.name);
        return { name: column.name, type: declaredType(column.type) };
      });
      const primaryKey = info.filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk);
      const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(record.sql ?? "");
      return {
        name: record.name,
        columns,
        primaryKey: primaryKey.map((column) => column.name),
        reliablePrimaryKey: primaryKey.length > 0 &&
          (withoutRowid || primaryKey.every((column) => column.notnull === 1)),
        withoutRowid,
      };
    });
  }

  private snapshotRow(
    record: Record<string, unknown>,
    columns: string[],
  ): Record<string, ConnectorScalar> {
    const row = Object.create(null) as Record<string, ConnectorScalar>;
    for (const column of columns) {
      const value = record[column];
      if (typeof value === "bigint") {
        if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new DomainError("CONFLICT", "SQLite integer exceeds the safe snapshot number range");
        }
        row[column] = Number(value);
      } else if (value === null || typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") {
        row[column] = value;
      } else {
        throw new DomainError("CONFLICT", "SQLite snapshot contains an unsupported or non-finite value");
      }
    }
    return row;
  }
}

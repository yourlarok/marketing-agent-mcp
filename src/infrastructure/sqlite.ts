import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { AnalysisGraph } from "../domain/analysis-model.js";

const migrations = [
  {
    version: 1,
    path: fileURLToPath(new URL("../../migrations/001_initial.sql", import.meta.url)),
  },
  {
    version: 2,
    path: fileURLToPath(new URL("../../migrations/002_data_research.sql", import.meta.url)),
  },
  {
    version: 3,
    path: fileURLToPath(new URL("../../migrations/003_analysis_graphs.sql", import.meta.url)),
  },
  {
    version: 4,
    path: fileURLToPath(new URL("../../migrations/004_dashboard_strategy.sql", import.meta.url)),
  },
] as const;

export interface AnalysisGraphReferenceIds {
  datasetIds: string[];
  evidenceIds: string[];
}

export function analysisGraphReferenceIds(graph: AnalysisGraph): AnalysisGraphReferenceIds {
  const references: AnalysisGraphReferenceIds = { datasetIds: [], evidenceIds: [] };
  const seen = { datasetIds: new Set<string>(), evidenceIds: new Set<string>() };
  for (const node of graph.nodes) {
    for (const [singular, plural, key] of [
      ["datasetId", "datasetIds", "datasetIds"],
      ["evidenceId", "evidenceIds", "evidenceIds"],
    ] as const) {
      for (const field of [singular, plural]) {
        const value = node.payload[field];
        if (value === undefined || value === null) continue;
        const ids = field === singular ? [value] : value;
        if (!Array.isArray(ids)) {
          throw new TypeError(`Analysis graph ${field} references must be non-empty string IDs`);
        }
        for (const id of ids) {
          if (typeof id !== "string" || id.trim().length === 0) {
            throw new TypeError(`Analysis graph ${field} references must be non-empty string IDs`);
          }
          if (!seen[key].has(id)) {
            seen[key].add(id);
            references[key].push(id);
          }
        }
      }
    }
  }
  return references;
}

function normalizeJson(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JSON numbers must be finite");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("Value must contain JSON values only");
  }
  if (seen.has(value)) {
    throw new TypeError("JSON values must not contain cycles");
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeJson(entry, seen));
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON objects must be plain objects");
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      output[key] = normalizeJson((value as Record<string, unknown>)[key], seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, new Set()));
}

export function assertUtcInstant(value: string): void {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) {
    throw new TypeError("Timestamps must be UTC ISO-8601 instants");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !date.toISOString().startsWith(match[1]!)) {
    throw new TypeError("Timestamps must be valid UTC ISO-8601 instants");
  }
}

export function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    database.exec("BEGIN IMMEDIATE");
    const migrationTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    const currentVersion = migrationTable
      ? (database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version
      : 0;
    const programVersion = migrations[migrations.length - 1].version;
    if (currentVersion > programVersion) {
      throw new Error(
        `Database schema version ${currentVersion} is newer than supported version ${programVersion}`,
      );
    }
    for (const migration of migrations) {
      if (migration.version > currentVersion) {
        database.exec(readFileSync(migration.path, "utf8"));
      }
    }
    database.exec("COMMIT");
    return database;
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {}
    }
    try {
      database.close();
    } catch {}
    throw error;
  }
}

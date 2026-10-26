import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const migrationPath = fileURLToPath(
  new URL("../../migrations/001_initial.sql", import.meta.url),
);

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
    const output: Record<string, unknown> = {};
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
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  database.exec(readFileSync(migrationPath, "utf8"));
  return database;
}

import type { JsonValue } from "../application/ports.js";
import {
  assertDatabaseId,
  assertIdentifier,
  assertJsonValue,
  assertNonEmptyStringArray,
  assertRecord,
  assertStableId,
  invalid,
} from "./contract-validation.js";
import { SOURCE_OWNERSHIPS, type SourceOwnership } from "./model.js";

export const CONNECTOR_LIMITS = {
  maxRows: 100_000,
  maxColumns: 500,
  maxFilters: 100,
} as const;

export interface ConnectorLimits {
  maxRows: number;
  maxColumns: number;
  maxFilters: number;
}

export interface ConnectorManifest {
  id: string;
  version: number;
  kind: string;
  operations: string[];
  inputSchema: Readonly<Record<string, JsonValue>>;
  limits: ConnectorLimits;
  ownership: SourceOwnership[];
  securityBoundaries: string[];
}

export type ConnectorScalar = string | number | boolean | null;

export interface StructuredTableOrder {
  column: string;
  direction: "asc" | "desc";
}

export interface StructuredTableQuery {
  databaseId: string;
  table: string;
  columns: string[];
  filters: Readonly<Record<string, ConnectorScalar>>;
  order: StructuredTableOrder[];
  limit: number;
}

export interface ConnectorColumnSchema {
  name: string;
  type: "string" | "number" | "boolean" | "null" | "unknown";
}

export interface ConnectorSnapshot {
  rows: Readonly<Record<string, ConnectorScalar>>[];
  schema: ConnectorColumnSchema[];
  observedAt: string;
  sourceDescriptor: Readonly<Record<string, JsonValue>>;
  queryHash: string;
}

function assertIntegerInRange(value: unknown, label: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
}

function assertLimits(value: unknown): void {
  assertRecord(value, "Connector limits", ["maxRows", "maxColumns", "maxFilters"]);
  assertIntegerInRange(value.maxRows, "Connector maxRows", 1, CONNECTOR_LIMITS.maxRows);
  assertIntegerInRange(value.maxColumns, "Connector maxColumns", 1, CONNECTOR_LIMITS.maxColumns);
  assertIntegerInRange(value.maxFilters, "Connector maxFilters", 0, CONNECTOR_LIMITS.maxFilters);
}

export function validateConnectorManifest(value: unknown): asserts value is ConnectorManifest {
  assertRecord(value, "Connector manifest", [
    "id",
    "version",
    "kind",
    "operations",
    "inputSchema",
    "limits",
    "ownership",
    "securityBoundaries",
  ]);
  assertStableId(value.id, "Connector ID");
  assertStableId(value.kind, "Connector kind");
  assertIntegerInRange(value.version, "Connector version", 1, Number.MAX_SAFE_INTEGER);
  assertNonEmptyStringArray(value.operations, "Connector operations", 100);
  assertRecord(value.inputSchema, "Connector inputSchema");
  assertJsonValue(value.inputSchema, "Connector inputSchema");
  assertLimits(value.limits);
  assertNonEmptyStringArray(value.ownership, "Connector ownership", SOURCE_OWNERSHIPS.length);
  if (value.ownership.some((item) => !(SOURCE_OWNERSHIPS as readonly string[]).includes(item))) {
    invalid("Connector ownership contains an unsupported source ownership");
  }
  assertNonEmptyStringArray(value.securityBoundaries, "Connector securityBoundaries", 100);
}

export function validateStructuredTableQuery(value: unknown): asserts value is StructuredTableQuery {
  assertRecord(value, "Structured table query", [
    "databaseId",
    "table",
    "columns",
    "filters",
    "order",
    "limit",
  ]);
  assertDatabaseId(value.databaseId);
  assertIdentifier(value.table, "Query table");
  if (!Array.isArray(value.columns) || value.columns.length === 0 ||
      value.columns.length > CONNECTOR_LIMITS.maxColumns) {
    invalid("Query columns must be non-empty and within the column limit");
  }
  for (const column of value.columns) assertIdentifier(column, "Query column");
  if (new Set(value.columns).size !== value.columns.length) invalid("Query columns must be unique");

  assertRecord(value.filters, "Query filters");
  const filterEntries = Object.entries(value.filters);
  if (filterEntries.length > CONNECTOR_LIMITS.maxFilters) invalid("Query exceeds the filter limit");
  for (const [column, filter] of filterEntries) {
    assertIdentifier(column, "Query filter column");
    if (filter !== null && typeof filter !== "string" && typeof filter !== "boolean" &&
        (typeof filter !== "number" || !Number.isFinite(filter))) {
      invalid("Query filters must be finite scalar equality values");
    }
  }

  if (!Array.isArray(value.order) || value.order.length > CONNECTOR_LIMITS.maxColumns) {
    invalid("Query order must be a bounded array");
  }
  const orderColumns = new Set<string>();
  for (const order of value.order) {
    assertRecord(order, "Query order entry", ["column", "direction"]);
    assertIdentifier(order.column, "Query order column");
    if (order.direction !== "asc" && order.direction !== "desc") {
      invalid("Query order direction must be asc or desc");
    }
    if (orderColumns.has(order.column)) invalid("Query order columns must be unique");
    orderColumns.add(order.column);
  }
  assertIntegerInRange(value.limit, "Query limit", 1, CONNECTOR_LIMITS.maxRows);
}

function assertObservedAt(value: unknown): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    invalid("Snapshot observedAt must be a valid timestamp");
  }
}

export function validateConnectorSnapshot(value: unknown): asserts value is ConnectorSnapshot {
  assertRecord(value, "Connector snapshot", [
    "rows",
    "schema",
    "observedAt",
    "sourceDescriptor",
    "queryHash",
  ]);
  if (!Array.isArray(value.schema) || value.schema.length === 0 ||
      value.schema.length > CONNECTOR_LIMITS.maxColumns) {
    invalid("Snapshot schema must be non-empty and within the column limit");
  }
  const schema = new Map<string, string>();
  for (const column of value.schema) {
    assertRecord(column, "Snapshot schema column", ["name", "type"]);
    assertIdentifier(column.name, "Snapshot schema column name");
    if (!["string", "number", "boolean", "null", "unknown"].includes(column.type as string)) {
      invalid("Snapshot schema column type is not controlled");
    }
    if (schema.has(column.name)) invalid("Snapshot schema columns must be unique");
    schema.set(column.name, column.type as string);
  }
  if (!Array.isArray(value.rows) || value.rows.length > CONNECTOR_LIMITS.maxRows) {
    invalid("Snapshot rows must be within the row limit");
  }
  for (const row of value.rows) {
    assertRecord(row, "Snapshot row");
    const names = Object.keys(row);
    if (names.length !== schema.size || names.some((name) => !schema.has(name))) {
      invalid("Snapshot row keys must exactly match the schema");
    }
    for (const [name, item] of Object.entries(row)) {
      if (item !== null && typeof item !== "string" && typeof item !== "boolean" &&
          (typeof item !== "number" || !Number.isFinite(item))) {
        invalid("Snapshot values must be finite scalars or null");
      }
      const declaredType = schema.get(name);
      if (item !== null && declaredType !== "unknown" && declaredType !== "null" &&
          typeof item !== declaredType) {
        invalid(`Snapshot value does not match schema column: ${name}`);
      }
      if (item !== null && declaredType === "null") invalid(`Snapshot column must be null: ${name}`);
    }
  }
  assertObservedAt(value.observedAt);
  assertRecord(value.sourceDescriptor, "Snapshot sourceDescriptor");
  assertJsonValue(value.sourceDescriptor, "Snapshot sourceDescriptor");
  if (typeof value.queryHash !== "string" || !/^[a-f0-9]{64}$/.test(value.queryHash)) {
    invalid("Snapshot queryHash must be a lowercase SHA-256 hash");
  }
}

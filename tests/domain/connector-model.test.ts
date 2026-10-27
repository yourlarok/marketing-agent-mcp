import { describe, expect, it } from "vitest";
import {
  CONNECTOR_LIMITS,
  validateConnectorManifest,
  validateConnectorSnapshot,
  validateStructuredTableQuery,
} from "../../src/domain/connector-model.js";
import { DomainError } from "../../src/domain/errors.js";

function manifest() {
  return {
    id: "sqlite-readonly",
    version: 1,
    kind: "sqlite",
    operations: ["discover", "snapshot"],
    inputSchema: { type: "object", properties: { databaseId: { type: "string" } } },
    limits: { maxRows: 100_000, maxColumns: 500, maxFilters: 100 },
    ownership: ["owned", "authorized"],
    securityBoundaries: ["read_only", "no_arbitrary_sql"],
  };
}

function query() {
  return {
    databaseId: "warehouse/sales",
    table: "daily_metrics",
    columns: ["day", "clicks", "conversions"],
    filters: { channel: "owned", active: true, spend: 12.5, deletedAt: null },
    order: [{ column: "day", direction: "asc" }],
    limit: 500,
  };
}

function snapshot() {
  return {
    rows: [
      { day: "2026-10-26", clicks: 20, conversions: 2 },
      { day: "2026-10-27", clicks: 30, conversions: null },
    ],
    schema: [
      { name: "day", type: "string" },
      { name: "clicks", type: "number" },
      { name: "conversions", type: "number" },
    ],
    observedAt: "2026-10-27T01:02:03.000Z",
    sourceDescriptor: {
      connectorId: "sqlite-readonly",
      databaseId: "warehouse/sales",
      table: "daily_metrics",
    },
    queryHash: "a".repeat(64),
  };
}

function expectInvalid(operation: () => void): void {
  expect(operation).toThrowError(
    expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
  );
}

describe("connector manifest runtime contract", () => {
  it("accepts a bounded manifest with explicit ownership and security boundaries", () => {
    expect(() => validateConnectorManifest(manifest())).not.toThrow();
    expect(CONNECTOR_LIMITS).toEqual({ maxRows: 100_000, maxColumns: 500, maxFilters: 100 });
  });

  it.each([
    ["prototype id", { id: "__proto__" }],
    ["empty operations", { operations: [] }],
    ["duplicate operations", { operations: ["snapshot", "snapshot"] }],
    ["invalid version", { version: 1.5 }],
    ["row ceiling", { limits: { maxRows: 100_001, maxColumns: 500, maxFilters: 100 } }],
    ["invalid ownership", { ownership: ["untrusted"] }],
    ["missing security boundary", { securityBoundaries: [] }],
    ["non-JSON schema", { inputSchema: { callback: () => true } }],
    ["prototype schema key", { inputSchema: JSON.parse('{"__proto__":{"polluted":true}}') }],
  ])("rejects %s", (_name, patch) => {
    expectInvalid(() => validateConnectorManifest({ ...manifest(), ...patch }));
  });
});

describe("structured table query runtime contract", () => {
  it("accepts scalar equality filters, stable ordering, and a bounded limit", () => {
    expect(() => validateStructuredTableQuery(query())).not.toThrow();
  });

  it.each(["sales;DROP", "sales.main", '"sales"', "", "__proto__", "constructor", "prototype"])(
    "rejects unsafe table or column identifier %s",
    (identifier) => {
      expectInvalid(() => validateStructuredTableQuery({ ...query(), table: identifier }));
      expectInvalid(() => validateStructuredTableQuery({ ...query(), columns: [identifier] }));
    },
  );

  it.each(["../secrets", "/absolute/path", "warehouse\\sales", "warehouse/./sales", "warehouse//sales"])(
    "rejects unsafe databaseId %s",
    (databaseId) => {
      expectInvalid(() => validateStructuredTableQuery({ ...query(), databaseId }));
    },
  );

  it.each([
    ["object filter", { filters: { channel: { eq: "owned" } } }],
    ["array filter", { filters: { channel: ["owned"] } }],
    ["undefined filter", { filters: { channel: undefined } }],
    ["NaN filter", { filters: { spend: Number.NaN } }],
    ["infinite filter", { filters: { spend: Number.POSITIVE_INFINITY } }],
    ["unsafe filter column", { filters: { "channel;DROP": "owned" } }],
    ["too many filters", {
      filters: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`field_${index}`, index])),
    }],
  ])("rejects %s", (_name, patch) => {
    expectInvalid(() => validateStructuredTableQuery({ ...query(), ...patch }));
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 100_001])(
    "rejects invalid row limit %s",
    (limit) => {
      expectInvalid(() => validateStructuredTableQuery({ ...query(), limit }));
    },
  );

  it("rejects empty, duplicate, or excessive selected columns", () => {
    expectInvalid(() => validateStructuredTableQuery({ ...query(), columns: [] }));
    expectInvalid(() => validateStructuredTableQuery({ ...query(), columns: ["day", "day"] }));
    expectInvalid(() => validateStructuredTableQuery({
      ...query(),
      columns: Array.from({ length: 501 }, (_, index) => `field_${index}`),
    }));
  });

  it("rejects unsafe ordering and prototype filter keys", () => {
    expectInvalid(() => validateStructuredTableQuery({
      ...query(),
      order: [{ column: "day", direction: "sideways" }],
    }));
    expectInvalid(() => validateStructuredTableQuery({
      ...query(),
      order: [{ column: "day", direction: "asc" }, { column: "day", direction: "desc" }],
    }));
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expectInvalid(() => validateStructuredTableQuery({
        ...query(),
        filters: JSON.parse(`{"${key}":"value"}`),
      }));
    }
  });
});

describe("connector snapshot runtime contract", () => {
  it("accepts schema-aligned scalar rows and a SHA-256 query hash", () => {
    expect(() => validateConnectorSnapshot(snapshot())).not.toThrow();
  });

  it.each([
    ["row missing from schema", { rows: [{ day: "2026-10-27", clicks: 1 }] }],
    ["row outside schema", { rows: [{ day: "2026-10-27", clicks: 1, conversions: 2, extra: 3 }] }],
    ["wrong scalar type", { rows: [{ day: "2026-10-27", clicks: "1", conversions: 2 }] }],
    ["non-finite value", { rows: [{ day: "2026-10-27", clicks: Number.NaN, conversions: 2 }] }],
    ["invalid timestamp", { observedAt: "not-a-date" }],
    ["invalid query hash", { queryHash: "not-a-sha256" }],
    ["duplicate schema columns", {
      schema: [
        { name: "day", type: "string" },
        { name: "day", type: "number" },
        { name: "conversions", type: "number" },
      ],
    }],
    ["non-JSON source descriptor", { sourceDescriptor: { path: /tmp\/db/ } }],
  ])("rejects %s", (_name, patch) => {
    expectInvalid(() => validateConnectorSnapshot({ ...snapshot(), ...patch }));
  });

  it("rejects prototype keys in rows and source descriptors", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const rows = [{ day: "2026-10-27", clicks: 1, conversions: 2 }];
      Object.defineProperty(rows[0], key, { value: "polluted", enumerable: true });
      expectInvalid(() => validateConnectorSnapshot({ ...snapshot(), rows }));
      expectInvalid(() => validateConnectorSnapshot({
        ...snapshot(),
        sourceDescriptor: JSON.parse(`{"connectorId":"sqlite","${key}":true}`),
      }));
    }
  });
});

describe("connector review regressions", () => {
  it.each([
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00.1Z",
    "2026-01-01T00:00:00.123Z",
    "2026-01-01T00:00:00.123456Z",
  ])("accepts a real snapshot UTC instant with optional fractional seconds %s", (observedAt) => {
    expect(() => validateConnectorSnapshot({ ...snapshot(), observedAt })).not.toThrow();
  });

  it.each([
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00.000Z",
    "2026-13-01T00:00:00.000Z",
    "2026-01-01T24:00:00.000Z",
    "2026-01-01T00:00:00.000+00:00",
  ])("rejects a nonexistent or non-UTC snapshot instant %s", (observedAt) => {
    expectInvalid(() => validateConnectorSnapshot({ ...snapshot(), observedAt }));
  });

  it("rejects literal __proto__ filters and rows while allowing null-prototype filters", () => {
    expectInvalid(() => validateStructuredTableQuery({
      ...query(),
      filters: { __proto__: { polluted: true } },
    }));
    const filters = Object.assign(Object.create(null) as Record<string, unknown>, { channel: "owned" });
    expect(() => validateStructuredTableQuery({ ...query(), filters })).not.toThrow();
    expectInvalid(() => validateConnectorSnapshot({
      ...snapshot(),
      rows: [{ day: "2026-10-27", clicks: 1, conversions: 2, __proto__: { polluted: true } }],
    }));
  });
});

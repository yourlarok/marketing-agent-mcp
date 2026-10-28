import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeAnomalyReference,
  computeFunnelReference,
  computeTrendReference,
  type AnalyticsOperation,
  type AnalyticsRow,
} from "../../src/domain/analytics-model.js";
import type { DomainError } from "../../src/domain/errors.js";
import { McpAnalyticsProvider } from "../../src/infrastructure/analytics-provider.js";

const fixture = fileURLToPath(new URL("../fixtures/professional-analytics-mcp.mjs", import.meta.url));
const rows: AnalyticsRow[] = [
  { observedAt: "2026-01-01T00:00:00.000Z", revenue: 10, impressions: 100, clicks: 20, conversions: 2 },
  { observedAt: "2026-01-01T01:00:00.000Z", revenue: 11, impressions: 100, clicks: 20, conversions: 2 },
  { observedAt: "2026-01-03T00:00:00.000Z", revenue: 9, impressions: 100, clicks: 20, conversions: 2 },
  { observedAt: "2026-01-03T01:00:00.000Z", revenue: 10, impressions: 100, clicks: 20, conversions: 2 },
  { observedAt: "2026-01-04T00:00:00.000Z", revenue: 12, impressions: 100, clicks: 20, conversions: 2 },
  { observedAt: "2026-01-04T01:00:00.000Z", revenue: 100, impressions: 100, clicks: 20, conversions: 2 },
];
const trend: AnalyticsOperation = {
  operation: "trend_v1",
  datasetId: "dataset-1",
  parameters: { timeField: "observedAt", valueField: "revenue", grain: "day" },
};
const funnel: AnalyticsOperation = {
  operation: "funnel_v1",
  datasetId: "dataset-1",
  parameters: { stageFields: ["impressions", "clicks", "conversions"] },
};
const anomaly: AnalyticsOperation = {
  operation: "anomaly_v1",
  datasetId: "dataset-1",
  parameters: { valueField: "revenue" },
};

function provider(mode?: string, patch: { timeoutMs?: number; maxResponseBytes?: number } = {}) {
  return new McpAnalyticsProvider({
    command: process.execPath,
    args: [fixture],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MARKETING_TEST_BUSINESS_SECRET: "must-not-reach-child",
      ...(mode === undefined ? {} : { ANALYTICS_FIXTURE_MODE: mode }),
    },
    envAllowlist: ["ANALYTICS_FIXTURE_MODE"],
    ...patch,
  });
}

async function expectGap(
  promise: Promise<unknown>,
  reason: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject<DomainError>({
    code: "CAPABILITY_UNAVAILABLE",
    details: {
      capability: "professional_analytics",
      reason,
      configurationAction: "Configure MARKETING_ANALYTICS_MCP_COMMAND and MARKETING_ANALYTICS_MCP_ARGS in the trusted deployment environment",
    },
  });
}

describe("real professional analytics stdio MCP provider", () => {
  it("calls analyze for trend_v1 and verifies ordered UTC points, missing windows, and coverage", async () => {
    const response = await provider().analyze({ operation: trend, rows });
    expect(response.result).toEqual(computeTrendReference(trend, rows));
    expect(response.result).toMatchObject({
      operation: "trend_v1",
      points: [
        { window: "2026-01-01", value: 21, rowCount: 2 },
        { window: "2026-01-02", value: null, rowCount: 0 },
        { window: "2026-01-03", value: 19, rowCount: 2 },
        { window: "2026-01-04", value: 112, rowCount: 2 },
      ],
      missingWindows: ["2026-01-02"],
      coverage: 0.75,
    });
    expect(response.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(response.toolVersion).toBe("1.0.0");
  });

  it("calls analyze for funnel_v1 and verifies adjacent and overall conversion on one dataset", async () => {
    const response = await provider().analyze({ operation: funnel, rows });
    expect(response.result).toEqual(computeFunnelReference(funnel, rows));
    expect(response.result).toMatchObject({
      stages: [
        { field: "impressions", total: 600, conversionFromPrevious: null },
        { field: "clicks", total: 120, conversionFromPrevious: 0.2 },
        { field: "conversions", total: 12, conversionFromPrevious: 0.1 },
      ],
      overallConversion: 0.02,
    });
  });

  it("calls analyze for anomaly_v1 and verifies median/MAD scores without a business-cause claim", async () => {
    const response = await provider().analyze({ operation: anomaly, rows });
    expect(response.result).toEqual(computeAnomalyReference(anomaly, [10, 11, 9, 10, 12, 100]));
    expect(response.result).toMatchObject({
      median: 10.5,
      mad: 1,
      modifiedZScoreThreshold: 3.5,
      anomalies: [{ index: 5, value: 100 }],
    });
    expect(JSON.stringify(response.result)).not.toMatch(/cause|causal|reasonForAnomaly/i);
  });

  it("returns explicit anomaly unknown results for insufficient samples and zero MAD", async () => {
    const insufficient = await provider().analyze({ operation: anomaly, rows: rows.slice(0, 2) });
    expect(insufficient.result).toMatchObject({ status: "unknown", unknownReason: "INSUFFICIENT_SAMPLES" });
    const constantRows = rows.slice(0, 3).map((row) => ({ ...row, revenue: 1 }));
    const zeroMad = await provider().analyze({ operation: anomaly, rows: constantRows });
    expect(zeroMad.result).toMatchObject({ status: "unknown", unknownReason: "ZERO_MAD", median: 1, mad: 0 });
  });

  it("returns a structured configuration gap instead of a local substitute when unconfigured", async () => {
    await expectGap(new McpAnalyticsProvider({}).analyze({ operation: trend, rows }), "mcp_not_configured");
  });

  it("returns a structured availability gap when the configured process cannot start", async () => {
    const unavailable = new McpAnalyticsProvider({ command: "/definitely/missing/analytics-provider" });
    await expectGap(unavailable.analyze({ operation: trend, rows }), "mcp_unavailable");
  });

  it.each([
    ["malformed", "mcp_invalid_response"],
    ["wrong-hash", "mcp_input_hash_mismatch"],
    ["mismatch", "mcp_result_mismatch"],
  ])("rejects a real fixture %s response with reason %s", async (mode, reason) => {
    await expectGap(provider(mode).analyze({ operation: trend, rows }), reason);
  });

  it("enforces response bytes before accepting an oversized fixture payload", async () => {
    await expectGap(
      provider("oversized", { maxResponseBytes: 1_024 }).analyze({ operation: trend, rows }),
      "mcp_response_too_large",
    );
  });

  it("times out and closes a real unresponsive fixture", async () => {
    const started = Date.now();
    await expectGap(
      provider("timeout", { timeoutMs: 100 }).analyze({ operation: trend, rows }),
      "mcp_timeout",
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 5_000);

  it("accepts the bounded maximum trend window span with explicit missing windows", async () => {
    const first = Date.parse("2026-01-01T00:00:00.000Z");
    const sparseRows: AnalyticsRow[] = [
      { observedAt: new Date(first).toISOString(), revenue: 1 },
      { observedAt: new Date(first + 100_000 * 86_400_000).toISOString(), revenue: 2 },
    ];
    const response = await provider(undefined, { maxResponseBytes: 64 * 1024 * 1024 }).analyze({
      operation: trend,
      rows: sparseRows,
    });
    expect(response.result).toMatchObject({ status: "ok", coverage: 2 / 100_001 });
    if (response.result.operation !== "trend_v1") throw new Error("Expected trend result");
    expect(response.result.points).toHaveLength(100_001);
    expect(response.result.missingWindows).toHaveLength(99_999);
  }, 15_000);

  it("rejects excessive rows and invalid numeric input before treating provider output as authoritative", async () => {
    const excessive = Array.from({ length: 100_001 }, () => rows[0]!);
    await expect(provider().analyze({ operation: trend, rows: excessive })).rejects.toMatchObject<DomainError>({
      code: "INVALID_INPUT",
    });
    await expect(provider().analyze({
      operation: trend,
      rows: [{ observedAt: "2026-01-01T00:00:00.000Z", revenue: Number.NaN }],
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });
});

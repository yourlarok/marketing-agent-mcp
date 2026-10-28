import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : sorted[middle - 1] + (sorted[middle] - sorted[middle - 1]) / 2;
}

function analyze(operation, rows) {
  const base = { operation: operation.operation, datasetId: operation.datasetId };
  if (operation.operation === "trend_v1") {
    if (rows.length === 0) {
      return { ...base, status: "unknown", unknownReason: "NO_VALID_ROWS", points: [], missingWindows: [], coverage: 0 };
    }
    const groups = new Map();
    for (const row of rows) {
      const date = new Date(row[operation.parameters.timeField]);
      date.setUTCHours(0, 0, 0, 0);
      if (operation.parameters.grain === "week") {
        date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
      }
      const window = date.toISOString().slice(0, 10);
      const group = groups.get(window) ?? { values: [], rowCount: 0 };
      group.values.push(Number(row[operation.parameters.valueField]));
      group.rowCount += 1;
      groups.set(window, group);
    }
    const windows = [...groups.keys()].sort();
    const step = operation.parameters.grain === "day" ? 86_400_000 : 7 * 86_400_000;
    const points = [];
    const missingWindows = [];
    for (let time = Date.parse(`${windows[0]}T00:00:00.000Z`); time <= Date.parse(`${windows.at(-1)}T00:00:00.000Z`); time += step) {
      const window = new Date(time).toISOString().slice(0, 10);
      const group = groups.get(window);
      if (!group) {
        points.push({ window, value: null, rowCount: 0 });
        missingWindows.push(window);
      } else {
        points.push({ window, value: group.values.reduce((sum, value) => sum + value, 0), rowCount: group.rowCount });
      }
    }
    return { ...base, status: "ok", unknownReason: null, points, missingWindows, coverage: groups.size / points.length };
  }
  if (operation.operation === "funnel_v1") {
    const totals = operation.parameters.stageFields.map((field) =>
      rows.reduce((sum, row) => sum + Number(row[field]), 0));
    const stages = operation.parameters.stageFields.map((field, index) => ({
      field,
      total: totals[index],
      conversionFromPrevious: index === 0 || totals[index - 1] === 0 ? null : totals[index] / totals[index - 1],
      conversionUnknownReason: index > 0 && totals[index - 1] === 0 ? "ZERO_DENOMINATOR" : null,
    }));
    return {
      ...base,
      status: "ok",
      stages,
      overallConversion: totals[0] === 0 ? null : totals.at(-1) / totals[0],
      overallUnknownReason: totals[0] === 0 ? "ZERO_DENOMINATOR" : null,
    };
  }
  const values = rows.map((row) => Number(row[operation.parameters.valueField]));
  const anomalyBase = { ...base, modifiedZScoreThreshold: 3.5, anomalies: [] };
  if (values.length < 3) {
    return { ...anomalyBase, status: "unknown", unknownReason: "INSUFFICIENT_SAMPLES", median: null, mad: null, threshold: null };
  }
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  if (mad === 0) {
    return { ...anomalyBase, status: "unknown", unknownReason: "ZERO_MAD", median: center, mad, threshold: null };
  }
  const threshold = 3.5 * mad / 0.6745;
  const anomalies = values.flatMap((value, index) => {
    const modifiedZScore = 0.6745 * (value - center) / mad;
    return Math.abs(modifiedZScore) > 3.5 ? [{ index, value, modifiedZScore }] : [];
  });
  return { ...anomalyBase, status: "ok", unknownReason: null, median: center, mad, threshold, anomalies };
}

const server = new McpServer({ name: "professional-analytics-fixture", version: "1.0.0" });
server.registerTool("analyze", {
  description: "Independent deterministic analytics fixture",
  inputSchema: {
    operation: z.object({
      operation: z.enum(["trend_v1", "funnel_v1", "anomaly_v1"]),
      datasetId: z.string(),
      parameters: z.record(z.string(), z.unknown()),
    }),
    rows: z.array(z.record(z.string(), z.unknown())),
  },
}, async ({ operation, rows }) => {
  if (process.env.MARKETING_TEST_BUSINESS_SECRET) throw new Error("Business environment leaked into fixture");
  const mode = process.env.ANALYTICS_FIXTURE_MODE ?? "success";
  if (mode === "timeout") await delay(5_000);
  const inputHash = createHash("sha256").update(JSON.stringify(canonical({ operation, rows }))).digest("hex");
  const result = analyze(operation, rows);
  let structuredContent = { inputHash, result };
  if (mode === "malformed") structuredContent = { inputHash, result: { operation: operation.operation } };
  if (mode === "wrong-hash") structuredContent = { inputHash: "0".repeat(64), result };
  if (mode === "mismatch") structuredContent = { inputHash, result: { ...result, datasetId: "dataset-other" } };
  if (mode === "oversized") structuredContent = { inputHash, result, padding: "x".repeat(100_000) };
  return {
    content: [{ type: "text", text: "professional analytics fixture" }],
    structuredContent,
  };
});
await server.connect(new StdioServerTransport());

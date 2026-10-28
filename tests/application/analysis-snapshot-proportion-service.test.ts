import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalysisCapabilityService, AnalysisService } from "../../src/application/analysis-service.js";
import type { ComputeMetric } from "../../src/application/analysis-commands.js";
import type { Command, CommandContext } from "../../src/application/commands.js";
import { DataResearchService } from "../../src/application/data-research-service.js";
import type { Store } from "../../src/application/ports.js";
import type { AnalysisPayload } from "../../src/domain/analysis-model.js";
import type { IngestionBatch } from "../../src/domain/data-research-model.js";
import type { DomainError } from "../../src/domain/errors.js";
import type { MetricId } from "../../src/domain/metric-catalog.js";
import type { Evidence } from "../../src/domain/model.js";
import { wilsonScore95 } from "../../src/domain/proportion.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import { SafeHttpClient } from "../../src/infrastructure/safe-http.js";
import { SqliteConnector } from "../../src/infrastructure/sqlite-connector.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-27T12:00:00.000Z";
const standardRows = [
  { likes: 10, saves: 2, comments: 3, impressions: 500, conversions: 5, clicks: 50 },
  { likes: 5, saves: 1, comments: 2, impressions: 500, conversions: 5, clicks: 50 },
];

function context(suffix: string): CommandContext {
  return {
    actor: "agent-1",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  };
}

describe("AnalysisService new metrics and proportion assessments from real snapshots", () => {
  let tempDir: string;
  let importRoot: string;
  let artifactRoot: string;
  let databaseRoot: string;
  let store: Store;
  let ingest: DataResearchService;
  let analysis: AnalysisService;
  let sequence: number;
  let originalImportRoot: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir();
    importRoot = await createTempDir();
    artifactRoot = await createTempDir();
    databaseRoot = join(tempDir, "databases");
    await mkdir(databaseRoot);
    originalImportRoot = process.env.MARKETING_IMPORT_ROOT;
    process.env.MARKETING_IMPORT_ROOT = importRoot;
    store = openStore(join(tempDir, "analysis.db"));
    sequence = 0;
    const artifacts = new ArtifactStore(artifactRoot);
    ingest = new DataResearchService(
      store,
      { now: () => now },
      { next: () => `ingest-${++sequence}` },
      artifacts,
      new SafeHttpClient({ allowlist: ["127.0.0.1"], now: () => now }),
      undefined,
      new SqliteConnector(databaseRoot, { now: () => now }),
    );
    analysis = new AnalysisService(
      store,
      { now: () => now },
      { next: () => `analysis-${++sequence}` },
      artifacts,
    );
    await store.transaction(async (repos) => {
      await repos.workspaces.insert({
        id: "workspace-1",
        workspaceId: "workspace-1",
        version: 1,
        createdAt: now,
        updatedAt: now,
        name: "workspace-1",
      });
    });
  });

  afterEach(async () => {
    store.close();
    if (originalImportRoot === undefined) delete process.env.MARKETING_IMPORT_ROOT;
    else process.env.MARKETING_IMPORT_ROOT = originalImportRoot;
    await Promise.all([
      removeTempDir(tempDir),
      removeTempDir(importRoot),
      removeTempDir(artifactRoot),
    ]);
  });

  async function csvBatch(id: string, content: string, ownership: "owned" | "authorized" | "external_public" = "owned") {
    await writeFile(join(importRoot, `${id}.csv`), content);
    return ingest.importFiles({
      input: { id, workspaceId: "workspace-1", paths: [`${id}.csv`], ownership },
      context: context(id),
    });
  }

  async function standardBatch(kind: "csv" | "xlsx" | "api" | "sqlite"): Promise<IngestionBatch> {
    const id = `standard-${kind}`;
    if (kind === "csv") {
      return csvBatch(id, [
        "likes,saves,comments,impressions,conversions,clicks",
        ...standardRows.map((row) => [
          row.likes, row.saves, row.comments, row.impressions, row.conversions, row.clicks,
        ].join(",")),
        "",
      ].join("\n"));
    }
    if (kind === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Metrics");
      sheet.addRow(["likes", "saves", "comments", "impressions", "conversions", "clicks"]);
      for (const row of standardRows) {
        sheet.addRow([row.likes, row.saves, row.comments, row.impressions, row.conversions, row.clicks]);
      }
      await workbook.xlsx.writeFile(join(importRoot, `${id}.xlsx`));
      return ingest.importFiles({
        input: { id, workspaceId: "workspace-1", paths: [`${id}.xlsx`] },
        context: context(id),
      });
    }
    if (kind === "api") {
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(standardRows));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      try {
        return await ingest.ingestTemporaryApi({
          input: {
            id,
            workspaceId: "workspace-1",
            url: `http://127.0.0.1:${port}/metrics`,
            ownership: "owned",
            expiresAt: "2026-10-28T12:00:00.000Z",
          },
          context: context(id),
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }

    const database = new DatabaseSync(join(databaseRoot, `${id}.sqlite`));
    try {
      database.exec(`
        CREATE TABLE metrics (
          likes REAL,
          saves REAL,
          comments REAL,
          impressions REAL,
          conversions REAL,
          clicks REAL
        );
        INSERT INTO metrics VALUES
          (10, 2, 3, 500, 5, 50),
          (5, 1, 2, 500, 5, 50);
      `);
    } finally {
      database.close();
    }
    return ingest.ingestSqlite({
      input: {
        id,
        workspaceId: "workspace-1",
        query: {
          databaseId: id,
          table: "metrics",
          columns: ["likes", "saves", "comments", "impressions", "conversions", "clicks"],
          filters: {},
          order: [{ column: "impressions", direction: "asc" }],
          limit: 100,
        },
        ownership: "authorized",
      },
      context: context(id),
    });
  }

  async function computePayload(
    metricId: MetricId,
    batch: IngestionBatch,
    suffix: string,
  ): Promise<AnalysisPayload> {
    const graph = await analysis.start({
      input: {
        id: `${batch.id}-${suffix}`,
        workspaceId: "workspace-1",
        objective: "Measure a real imported snapshot",
        inputMode: "dataset",
        referenceId: batch.datasetIds[0]!,
      },
      context: context(`${batch.id}-${suffix}-start`),
    });
    const evidence = await store.transaction((repos) =>
      repos.evidence.get(batch.evidenceIds[0]!, "workspace-1")
    ) as Evidence;
    const command: Command<ComputeMetric> = {
      input: {
        id: graph.id,
        workspaceId: graph.workspaceId,
        expectedVersion: graph.version,
        batchId: batch.id,
        datasetId: batch.datasetIds[0]!,
        evidenceId: batch.evidenceIds[0]!,
        assetId: evidence.assets!.find((asset) => asset.kind === "normalized_jsonl")!.id,
        metricId,
        comparability: "comparable",
      },
      context: context(`${batch.id}-${suffix}-compute`),
    };
    const result = await analysis.computeMetric(command);
    return result.nodes.filter((node) => node.kind === "metric").at(-1)!.payload;
  }

  it.each(["csv", "xlsx", "api", "sqlite"] as const)(
    "computes engagement, conversion, and eligible Wilson intervals from a real %s snapshot",
    async (kind) => {
      const batch = await standardBatch(kind);
      const engagement = await computePayload("engagement_rate_v1", batch, "engagement");
      expect(engagement).toMatchObject({
        metricId: "engagement_rate_v1",
        status: "ok",
        numerator: 23,
        denominator: 1000,
        value: 0.023,
        includedRowCount: 2,
        excludedRowCount: 0,
        referenceAssessment: {
          level: "high",
          dimensions: { sample: { status: "sufficient", minimumDenominator: 1000 } },
        },
        proportionAssessment: {
          status: "not_applicable",
          reason: "METRIC_NOT_BINOMIAL_ELIGIBLE",
          interval: null,
          assumptions: [],
        },
      });

      const conversion = await computePayload("conversion_rate_v1", batch, "conversion");
      expect(conversion).toMatchObject({
        metricId: "conversion_rate_v1",
        status: "ok",
        numerator: 10,
        denominator: 100,
        value: 0.1,
        referenceAssessment: {
          level: "high",
          dimensions: { sample: { status: "sufficient", minimumDenominator: 100 } },
        },
        proportionAssessment: {
          status: "applicable",
          reason: null,
          interval: wilsonScore95(10, 100),
        },
      });
      const assumptions = (conversion.proportionAssessment as { assumptions: string[] }).assumptions.join(" ");
      expect(assumptions).toMatch(/independent and identically distributed Bernoulli trials/);
      expect(assumptions).toMatch(/not a probability of marketing lift or a causal interval/);

      const ctr = await computePayload("ctr_v1", batch, "ctr");
      expect(ctr).toMatchObject({
        numerator: 100,
        denominator: 1000,
        value: 0.1,
        proportionAssessment: {
          status: "applicable",
          reason: null,
          interval: wilsonScore95(100, 1000),
        },
      });
    },
  );

  it.each([
    ["non-integer", "1.5,100", "ok", "NON_INTEGER_COUNTS", "high"],
    ["negative", "-1,100", "unknown", "NO_VALID_ROWS", "unknown"],
    ["numerator above denominator", "101,100", "ok", "NUMERATOR_EXCEEDS_DENOMINATOR", "high"],
    ["below minimum", "1,99", "ok", "SAMPLE_BELOW_MINIMUM", "medium"],
    ["missing", ",100", "unknown", "NO_VALID_ROWS", "unknown"],
    ["zero denominator", "1,0", "unknown", "ZERO_DENOMINATOR", "unknown"],
  ] as const)(
    "returns an honest proportion assessment for %s conversion counts",
    async (name, values, status, reason, referenceLevel) => {
      const batch = await csvBatch(`boundary-${name.replaceAll(" ", "-")}`, `conversions,clicks\n${values}\n`);
      const payload = await computePayload("conversion_rate_v1", batch, "conversion");
      expect(payload).toMatchObject({
        status,
        referenceAssessment: { level: referenceLevel },
        proportionAssessment: {
          status: "not_applicable",
          reason,
          interval: null,
          assumptions: [],
        },
      });
    },
  );

  it("keeps complete-case exclusions visible while retaining reference and interval consistency", async () => {
    const batch = await csvBatch("complete-case", [
      "conversions,clicks",
      "5e0,5.0e1",
      "5,50",
      ",50",
      "-1,50",
      "",
    ].join("\n"));
    const payload = await computePayload("conversion_rate_v1", batch, "conversion");
    expect(payload).toMatchObject({
      numerator: 10,
      denominator: 100,
      value: 0.1,
      totalRowCount: 4,
      includedRowCount: 2,
      excludedRowCount: 2,
      numericInputNormalization: "strict_decimal_scientific_to_ieee754",
      precision: "ieee754_compensated_sum",
      referenceAssessment: {
        level: "medium",
        reasons: [{ code: "EXCLUDED_ROWS" }],
        dimensions: {
          sample: { status: "sufficient", denominator: 100, minimumDenominator: 100 },
          missingness: { status: "excluded_rows", includedRowCount: 2, excludedRowCount: 2 },
        },
      },
      proportionAssessment: {
        status: "applicable",
        reason: null,
        interval: wilsonScore95(10, 100),
      },
    });
  });

  it("rejects external_public conversion through the service without inferring it from engagement", async () => {
    const batch = await csvBatch("public-conversion", [
      "likes,saves,comments,impressions,conversions,clicks",
      "10,2,3,1000,10,100",
      "",
    ].join("\n"), "external_public");
    const engagement = await computePayload("engagement_rate_v1", batch, "engagement");
    expect(engagement).toMatchObject({ value: 0.015, referenceAssessment: { level: "medium" } });
    await expect(computePayload("conversion_rate_v1", batch, "conversion")).rejects.toMatchObject<DomainError>({
      code: "INVALID_INPUT",
      message: expect.stringMatching(/external_public conversion is not permitted/),
    });
  });

  it("advertises every controlled metric implemented by the real snapshot path", () => {
    expect(new AnalysisCapabilityService().list().find((entry) => entry.id === "metric.compute"))
      .toMatchObject({
        configuration: expect.arrayContaining([
          "ctr_v1",
          "save_like_ratio_v1",
          "engagement_rate_v1",
          "conversion_rate_v1",
        ]),
      });
  });
});

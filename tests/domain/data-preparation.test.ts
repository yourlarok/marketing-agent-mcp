import { describe, expect, it } from "vitest";
import {
  DATA_QUESTION_CATALOG,
  createDataQualityReports,
  planDataRequestRound,
  type QualityBatch,
} from "../../src/domain/data-preparation.js";

function qualityBatch(): QualityBatch {
  return {
    datasets: [{
      source: {
        path: "/imports/content.csv",
        fileName: "content.csv",
        format: "csv",
        sizeBytes: 120,
      },
      fields: [
        { name: "content_id", index: 0, inferredType: "mixed" },
        { name: "clicks", index: 1, inferredType: "number" },
      ],
      rowsJsonl: '{"content_id":"a","clicks":1}\n{"content_id":"a","clicks":1}\n',
      quality: {
        rowCount: 3,
        columnCount: 2,
        duplicateRowCount: 1,
        emptyRowCount: 1,
        typeInconsistencyCount: 1,
      },
      issues: [
        { code: "DUPLICATE_ROW", message: "Duplicate row", rowNumber: 3 },
        { code: "TYPE_INCONSISTENCY", message: "Mixed types", rowNumber: 2 },
        { code: "INCONSISTENT_COLUMNS", message: "Wrong column count", rowNumber: 2 },
      ],
    }],
  };
}

describe("deterministic data preparation", () => {
  it("keeps content questions free of orders and conversion questions free of engagement fields", () => {
    expect(DATA_QUESTION_CATALOG.content_performance.acceptedFields).not.toContain("orders");
    expect(DATA_QUESTION_CATALOG.content_performance.prompt).not.toMatch(/order/i);
    for (const field of ["likes", "shares", "comments", "clicks", "impressions"]) {
      expect(DATA_QUESTION_CATALOG.conversion.acceptedFields).not.toContain(field);
    }
  });

  it("requests only one question and one source layer in a stable first round", () => {
    const round = planDataRequestRound(
      ["content_performance", "conversion"],
      ["content_id", "published_at", "conversion_id"],
    );

    expect(round.questions).toEqual([{
      questionType: "content_performance",
      sourceLayer: "content_metrics",
      prompt: DATA_QUESTION_CATALOG.content_performance.prompt,
      acceptedFields: ["impressions", "clicks"],
      missingFields: ["impressions", "clicks"],
    }]);
    expect(round.state).toBe("partial");
    expect(round.answerableQuestionTypes).toEqual([]);
  });

  it("advances through source layers and then to the next question as fields arrive", () => {
    const identity = planDataRequestRound(["content_performance", "conversion"], []);
    expect(identity.questions).toHaveLength(1);
    expect(identity.questions[0]).toMatchObject({
      questionType: "content_performance",
      sourceLayer: "content_identity",
      missingFields: ["content_id", "published_at"],
    });

    const metrics = planDataRequestRound(
      ["content_performance", "conversion"],
      ["content_id", "published_at"],
    );
    expect(metrics.questions[0]).toMatchObject({
      questionType: "content_performance",
      sourceLayer: "content_metrics",
    });

    const fields = ["content_id", "published_at", "impressions", "clicks"];
    const conversion = planDataRequestRound(
      ["content_performance", "conversion"],
      fields,
      [],
      [{
        source: qualityBatch().datasets[0]!.source,
        fields,
        rowCount: 1,
        missingCellsByField: {},
        stale: false,
        coverageStart: null,
        coverageEnd: null,
      }],
    );
    expect(conversion.questions).toHaveLength(1);
    expect(conversion.questions[0]).toMatchObject({
      questionType: "conversion",
      sourceLayer: "conversion_events",
      missingFields: ["conversion_id", "converted_at"],
    });
    expect(conversion.answerableQuestionTypes).toEqual(["content_performance"]);
  });

  it("reports missing, duplicate, type, format, and freshness issues", () => {
    const reports = createDataQualityReports(qualityBatch(), {
      observedAt: "2026-01-01T00:00:00.000Z",
      evaluatedAt: "2026-10-26T12:30:00.000Z",
      maxAgeHours: 24,
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]!.statistics).toMatchObject(qualityBatch().datasets[0]!.quality);
    expect(reports[0]!.issues.map((issue) => issue.category)).toEqual(
      expect.arrayContaining(["missing", "duplicate", "type", "format", "freshness"]),
    );
    expect(reports[0]!.issues.find((issue) => issue.category === "freshness")).toMatchObject({
      code: "STALE_DATA",
    });
  });

  it("retains quality statistics as issues when detailed parser issues are absent", () => {
    const batch = qualityBatch();
    batch.datasets[0]!.issues = [];

    const reports = createDataQualityReports(batch);

    expect(reports[0]!.issues.map((issue) => issue.category)).toEqual(
      expect.arrayContaining(["missing", "duplicate", "type"]),
    );
  });

  it("rejects unknown parser issue codes instead of relabeling them as format issues", () => {
    const batch = qualityBatch();
    batch.datasets[0]!.issues = [{ code: "UNTRUSTED_CODE", message: "Unknown" }];

    expect(() => createDataQualityReports(batch)).toThrow(/issue code/i);
  });

  it("does not mark declared fields answerable without a usable dataset", () => {
    const round = planDataRequestRound(
      ["competitor_content"],
      ["competitor", "content_url", "published_at", "engagement"],
    );

    expect(round.state).not.toBe("ready");
    expect(round.answerableQuestionTypes).toEqual([]);
  });

  it.each([
    ["zero rows", { rowCount: 0, missingCellsByField: {}, stale: false }],
    ["all required cells empty", {
      rowCount: 2,
      missingCellsByField: { content_id: 2, published_at: 2, impressions: 2, clicks: 2 },
      stale: false,
    }],
    ["stale data", { rowCount: 1, missingCellsByField: {}, stale: true }],
  ])("rejects answerability for %s", (_name, quality) => {
    const fields = ["content_id", "published_at", "impressions", "clicks"];
    const round = planDataRequestRound(
      ["content_performance"],
      fields,
      [],
      [{
        source: qualityBatch().datasets[0]!.source,
        fields,
        coverageStart: null,
        coverageEnd: null,
        ...quality,
      }] as never,
    );

    expect(round.state).not.toBe("ready");
    expect(round.answerableQuestionTypes).toEqual([]);
  });

  it("rejects fields assembled across datasets and advances when one valid dataset arrives", () => {
    const source = qualityBatch().datasets[0]!.source;
    const datasets = [
      { source, fields: ["content_id", "published_at"], rowCount: 1, missingCellsByField: {}, stale: false, coverageStart: null, coverageEnd: null },
      { source, fields: ["impressions", "clicks"], rowCount: 1, missingCellsByField: {}, stale: false, coverageStart: null, coverageEnd: null },
    ];
    const fields = ["content_id", "published_at", "impressions", "clicks"];
    const split = planDataRequestRound(["content_performance"], fields, [], datasets as never);
    expect(split.answerableQuestionTypes).toEqual([]);
    expect(split.state).not.toBe("ready");

    const valid = planDataRequestRound(["content_performance"], fields, [], [...datasets, {
      source, fields, rowCount: 2, missingCellsByField: {}, stale: false,
      coverageStart: "2026-01-01T00:00:00.000Z", coverageEnd: "2026-01-02T00:00:00.000Z",
    }] as never);
    expect(valid).toMatchObject({ state: "ready", answerableQuestionTypes: ["content_performance"], questions: [] });
  });

  it("counts missing cells and extracts actual coverage or null when it is unknown", () => {
    const batch = qualityBatch();
    batch.datasets[0]!.fields = [
      { name: "content_id", index: 0, inferredType: "string" },
      { name: "published_at", index: 1, inferredType: "string" },
    ];
    batch.datasets[0]!.rowsJsonl = [
      JSON.stringify({ content_id: "a", published_at: "2026-01-02T00:00:00.000Z" }),
      JSON.stringify({ content_id: "", published_at: "2026-01-01T00:00:00.000Z" }),
    ].join("\n") + "\n";
    batch.datasets[0]!.quality.rowCount = 2;
    const covered = createDataQualityReports(batch)[0]!;
    expect(covered.statistics).toMatchObject({ missingCellCount: 1, missingCellsByField: { content_id: 1, published_at: 0 } });
    expect(covered).toMatchObject({
      coverageStart: "2026-01-01T00:00:00.000Z",
      coverageEnd: "2026-01-02T00:00:00.000Z",
    });

    batch.datasets[0]!.rowsJsonl = '{"content_id":"a","published_at":""}\n';
    const unknown = createDataQualityReports(batch)[0]!;
    expect(unknown).toMatchObject({ coverageStart: null, coverageEnd: null });
  });
});

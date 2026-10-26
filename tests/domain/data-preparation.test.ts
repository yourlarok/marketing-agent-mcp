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

  it("requests only currently missing fields in a stable first round", () => {
    const round = planDataRequestRound(
      ["content_performance", "conversion"],
      ["content_id", "published_at", "conversion_id"],
    );

    expect(round.questions).toEqual([
      {
        questionType: "content_performance",
        prompt: DATA_QUESTION_CATALOG.content_performance.prompt,
        acceptedFields: DATA_QUESTION_CATALOG.content_performance.acceptedFields,
        missingFields: ["impressions", "clicks"],
      },
      {
        questionType: "conversion",
        prompt: DATA_QUESTION_CATALOG.conversion.prompt,
        acceptedFields: DATA_QUESTION_CATALOG.conversion.acceptedFields,
        missingFields: ["converted_at", "conversion_value"],
      },
    ]);
    expect(round.state).toBe("partial");
    expect(round.answerableQuestionTypes).toEqual([]);
  });

  it("reports missing, duplicate, type, format, and freshness issues", () => {
    const reports = createDataQualityReports(qualityBatch(), {
      observedAt: "2026-01-01T00:00:00.000Z",
      evaluatedAt: "2026-10-26T12:30:00.000Z",
      maxAgeHours: 24,
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]!.statistics).toEqual(qualityBatch().datasets[0]!.quality);
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

  it("marks a fully supplied question ready without inventing another request", () => {
    const round = planDataRequestRound(
      ["competitor_content"],
      ["competitor", "content_url", "published_at", "engagement"],
    );

    expect(round).toMatchObject({
      state: "ready",
      answerableQuestionTypes: ["competitor_content"],
      questions: [],
    });
  });
});

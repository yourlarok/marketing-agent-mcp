import { describe, expect, it } from "vitest";
import {
  compareCompetitorObservations,
  type CompetitorObservation,
} from "../../src/domain/competitor-diff.js";

const competitors = ["competitor-b", "competitor-a"];

describe("deterministic competitor comparison", () => {
  it("reports same, different, and unknown without inventing missing values", () => {
    const observations: CompetitorObservation[] = [
      { competitorId: "competitor-b", evidenceId: "evidence-z", fields: { price: "20", cta: "Buy" } },
      { competitorId: "competitor-a", evidenceId: "evidence-a", fields: { price: "20", cta: "Start" } },
      { competitorId: "competitor-a", evidenceId: "evidence-duplicate", fields: { price: "20" } },
      { competitorId: "competitor-b", evidenceId: "evidence-shipping", fields: { shipping: "Free" } },
    ];

    expect(compareCompetitorObservations(
      competitors,
      ["price", "cta", "shipping", "missing"],
      observations,
    )).toEqual([
      {
        dimension: "price",
        result: "same",
        evidenceIds: ["evidence-a", "evidence-duplicate", "evidence-z"],
      },
      {
        dimension: "cta",
        result: "different",
        evidenceIds: ["evidence-a", "evidence-z"],
      },
      {
        dimension: "shipping",
        result: "unknown",
        evidenceIds: ["evidence-shipping"],
      },
      { dimension: "missing", result: "unknown", evidenceIds: [] },
    ]);
  });

  it("deduplicates evidence and remains stable when observation order changes", () => {
    const observations: CompetitorObservation[] = [
      { competitorId: "competitor-a", evidenceId: "evidence-b", fields: { price: "20" } },
      { competitorId: "competitor-b", evidenceId: "evidence-a", fields: { price: "20" } },
      { competitorId: "competitor-a", evidenceId: "evidence-b", fields: { price: "20" } },
    ];
    const expected = [{
      dimension: "price",
      result: "same",
      evidenceIds: ["evidence-a", "evidence-b"],
    }];

    expect(compareCompetitorObservations(competitors, ["price"], observations)).toEqual(expected);
    expect(compareCompetitorObservations(competitors, ["price"], [...observations].reverse())).toEqual(expected);
  });

  it("detects conflicting evidence independently of observation order", () => {
    const observations: CompetitorObservation[] = [
      { competitorId: "competitor-a", evidenceId: "evidence-a", fields: { price: "20" } },
      { competitorId: "competitor-a", evidenceId: "evidence-b", fields: { price: "21" } },
      { competitorId: "competitor-b", evidenceId: "evidence-c", fields: { price: "20" } },
    ];
    const expected = [{
      dimension: "price",
      result: "different",
      evidenceIds: ["evidence-a", "evidence-b", "evidence-c"],
    }];

    expect(compareCompetitorObservations(competitors, ["price"], observations)).toEqual(expected);
    expect(compareCompetitorObservations(competitors, ["price"], [...observations].reverse())).toEqual(expected);
  });
});

import type { CompetitorDiffEntry } from "./data-research-model.js";

export interface CompetitorObservation {
  competitorId: string;
  evidenceId: string;
  fields: Record<string, string>;
}

export function compareCompetitorObservations(
  competitorIds: string[],
  dimensions: string[],
  observations: CompetitorObservation[],
): CompetitorDiffEntry[] {
  return dimensions.map((dimension) => {
    const present = new Map<string, Set<string>>();
    const evidenceIds = new Set<string>();
    for (const competitorId of competitorIds) {
      const candidates = observations.filter((observation) =>
        observation.competitorId === competitorId &&
        Object.hasOwn(observation.fields, dimension)
      );
      if (candidates.length > 0) {
        present.set(
          competitorId,
          new Set(candidates.map((candidate) => candidate.fields[dimension]!)),
        );
        for (const candidate of candidates) {
          evidenceIds.add(candidate.evidenceId);
        }
      }
    }
    const values = competitorIds.map((competitorId) => present.get(competitorId));
    const distinctValues = new Set(values.flatMap((value) => [...(value ?? [])]));
    const result = values.some((value) => value === undefined)
      ? "unknown"
      : distinctValues.size === 1
        ? "same"
        : "different";
    return { dimension, result, evidenceIds: [...evidenceIds].sort() };
  });
}

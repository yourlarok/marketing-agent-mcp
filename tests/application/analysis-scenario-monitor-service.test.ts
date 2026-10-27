import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnalysisCapabilityService,
  AnalysisService,
} from "../../src/application/analysis-service.js";
import type {
  CompareMetricMonitor,
  ComputeMetric,
  CreateMetricScenario,
} from "../../src/application/analysis-commands.js";
import type { Command, CommandContext } from "../../src/application/commands.js";
import type { Store } from "../../src/application/ports.js";
import { DataResearchService } from "../../src/application/data-research-service.js";
import { MarketingService } from "../../src/application/marketing-service.js";
import type { AnalysisGraph, AnalysisGraphNode } from "../../src/domain/analysis-model.js";
import type { IngestionBatch } from "../../src/domain/data-research-model.js";
import type { DomainError } from "../../src/domain/errors.js";
import type { Evidence } from "../../src/domain/model.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-27T12:00:00.000Z";

function context(suffix: string): CommandContext {
  return {
    actor: "agent-1",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  };
}

describe("AnalysisService conditional scenarios and real-data monitoring", () => {
  let tempDir: string;
  let importRoot: string;
  let artifactRoot: string;
  let store: Store;
  let artifacts: ArtifactStore;
  let ingest: DataResearchService;
  let service: AnalysisService;
  let sequence: number;
  let originalImportRoot: string | undefined;
  let originalArtifactRoot: string | undefined;
  let baselineBatch: IngestionBatch;
  let graph: AnalysisGraph;
  let metricGraph: AnalysisGraph;
  let baselineMetric: AnalysisGraphNode;

  beforeEach(async () => {
    tempDir = await createTempDir();
    importRoot = await createTempDir();
    artifactRoot = await createTempDir();
    originalImportRoot = process.env.MARKETING_IMPORT_ROOT;
    originalArtifactRoot = process.env.MARKETING_ARTIFACT_DIR;
    process.env.MARKETING_IMPORT_ROOT = importRoot;
    process.env.MARKETING_ARTIFACT_DIR = artifactRoot;
    store = openStore(join(tempDir, "analysis.db"));
    artifacts = new ArtifactStore(artifactRoot);
    sequence = 0;
    ingest = new DataResearchService(
      store,
      { now: () => now },
      { next: () => `ingest-${++sequence}` },
    );
    service = new AnalysisService(
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
    baselineBatch = await importCsv("baseline", "baseline.csv", [
      "clicks,impressions",
      "40,400",
      "60,600",
      "",
    ]);
    graph = await startGraph(baselineBatch);
    metricGraph = await computeCtr(graph, baselineBatch, { comparability: "comparable" });
    baselineMetric = metricNode(metricGraph);
  });

  afterEach(async () => {
    store.close();
    vi.restoreAllMocks();
    if (originalImportRoot === undefined) delete process.env.MARKETING_IMPORT_ROOT;
    else process.env.MARKETING_IMPORT_ROOT = originalImportRoot;
    if (originalArtifactRoot === undefined) delete process.env.MARKETING_ARTIFACT_DIR;
    else process.env.MARKETING_ARTIFACT_DIR = originalArtifactRoot;
    await Promise.all([
      removeTempDir(tempDir),
      removeTempDir(importRoot),
      removeTempDir(artifactRoot),
    ]);
  });

  async function importCsv(id: string, fileName: string, lines: string[]): Promise<IngestionBatch> {
    await writeFile(join(importRoot, fileName), lines.join("\n"));
    return ingest.importFiles({
      input: { id, workspaceId: "workspace-1", paths: [fileName] },
      context: context(id),
    });
  }

  async function startGraph(batch: IngestionBatch, suffix = "graph"): Promise<AnalysisGraph> {
    return service.start({
      input: {
        id: `${batch.id}-${suffix}`,
        workspaceId: "workspace-1",
        objective: "Compare imported CTR snapshots",
        inputMode: "dataset",
        referenceId: batch.datasetIds[0]!,
      },
      context: context(`${batch.id}-${suffix}`),
    });
  }

  async function descriptors(batch: IngestionBatch) {
    const evidence = (await store.transaction((repos) =>
      repos.evidence.get(batch.evidenceIds[0]!, "workspace-1")
    )) as Evidence;
    return {
      batchId: batch.id,
      datasetId: batch.datasetIds[0]!,
      evidenceId: batch.evidenceIds[0]!,
      assetId: evidence.assets!.find((asset) => asset.kind === "normalized_jsonl")!.id,
    };
  }

  async function computeCtr(
    currentGraph: AnalysisGraph,
    batch: IngestionBatch,
    extra: Partial<ComputeMetric> = {},
  ): Promise<AnalysisGraph> {
    return service.computeMetric({
      input: {
        id: currentGraph.id,
        workspaceId: currentGraph.workspaceId,
        expectedVersion: currentGraph.version,
        ...await descriptors(batch),
        metricId: "ctr_v1",
        ...extra,
      },
      context: context(`${currentGraph.id}-compute-${currentGraph.version}`),
    });
  }

  function metricNode(currentGraph: AnalysisGraph): AnalysisGraphNode {
    return currentGraph.nodes.filter((node) => node.kind === "metric").at(-1)!;
  }

  function scenarioCommand(
    currentGraph: AnalysisGraph,
    metricNodeId: string,
    extra: Partial<CreateMetricScenario> = {},
  ): Command<CreateMetricScenario> {
    return {
      input: {
        id: currentGraph.id,
        workspaceId: currentGraph.workspaceId,
        expectedVersion: currentGraph.version,
        metricNodeId,
        label: "base",
        targetValue: 0.15,
        projectedDenominator: 1200,
        ...extra,
      },
      context: context(`${currentGraph.id}-scenario-${currentGraph.version}`),
    };
  }

  function monitorCommand(
    currentGraph: AnalysisGraph,
    batch: IngestionBatch,
    currentDescriptors: Awaited<ReturnType<typeof descriptors>>,
    extra: Partial<CompareMetricMonitor> = {},
  ): Command<CompareMetricMonitor> {
    return {
      input: {
        id: currentGraph.id,
        workspaceId: currentGraph.workspaceId,
        expectedVersion: currentGraph.version,
        baselineMetricNodeId: baselineMetric.id,
        ...currentDescriptors,
        comparability: "comparable",
        ...extra,
      },
      context: context(`${currentGraph.id}-monitor-${batch.id}-${currentGraph.version}`),
    };
  }

  it("creates a conditional scenario and compares two real imported CTR snapshots with an optional scenario link", async () => {
    const scenarioAction = metricGraph.recommendedActions.find((action) =>
      action.tool === "metric_scenario_create" && action.arguments?.metricNodeId === baselineMetric.id);
    const monitorAction = metricGraph.recommendedActions.find((action) =>
      action.tool === "metric_monitor_compare" && action.arguments?.baselineMetricNodeId === baselineMetric.id);
    expect(scenarioAction).toMatchObject({
      status: "requires_input",
      missingInputs: ["label", "targetValue", "projectedDenominator"],
      arguments: { id: metricGraph.id, expectedVersion: 2, metricNodeId: baselineMetric.id },
    });
    expect(monitorAction).toMatchObject({
      status: "requires_input",
      missingInputs: ["batchId", "datasetId", "evidenceId", "assetId"],
      arguments: { id: metricGraph.id, expectedVersion: 2, baselineMetricNodeId: baselineMetric.id },
    });

    const withScenario = await service.createMetricScenario({
      input: {
        ...scenarioAction!.arguments,
        label: "base",
        targetValue: 0.15,
        projectedDenominator: 1200,
      } as CreateMetricScenario,
      context: context("execute-scenario-action"),
    });
    const scenario = withScenario.nodes.find((node) => node.kind === "scenario")!;
    expect(withScenario.version).toBe(3);
    expect(withScenario.edges.at(-1)).toMatchObject({
      fromNodeId: baselineMetric.id,
      toNodeId: scenario.id,
    });
    expect(scenario.payload).toMatchObject({
      metricNodeId: baselineMetric.id,
      metricId: "ctr_v1",
      definitionVersion: 1,
      status: "ok",
      label: "base",
      baselineValue: 0.1,
      baselineNumerator: 100,
      baselineDenominator: 1000,
      targetValue: 0.15,
      projectedDenominator: 1200,
      absoluteDelta: expect.closeTo(0.05, 12),
      relativeDelta: expect.closeTo(0.5, 12),
      projectedNumerator: 180,
      projectedNumeratorDelta: 80,
      relativeDeltaUnknownReason: null,
      assumptions: ["projected_denominator_fixed_for_projection", "other_conditions_unchanged"],
    });
    expect(scenario.payload.sensitivity).toEqual(expect.stringMatching(/supplied projected denominator.*fixed.*projection/i));
    expect(scenario.payload.sensitivity).toEqual(expect.stringMatching(/difference between baseline and projected denominators/i));
    expect(JSON.stringify(scenario.payload)).not.toContain("denominator_unchanged");
    expect(JSON.stringify(scenario.payload)).not.toMatch(/revenue|caus|guarantee(?:d)? uplift/i);

    const currentBatch = await importCsv("current", "current.csv", [
      "clicks,impressions",
      "180,1200",
      "not-a-number,100",
      "",
    ]);
    const currentMonitorAction = withScenario.recommendedActions.find((action) =>
      action.tool === "metric_monitor_compare" &&
      action.arguments?.baselineMetricNodeId === baselineMetric.id)!;
    const command: Command<CompareMetricMonitor> = {
      input: {
        ...currentMonitorAction.arguments,
        ...await descriptors(currentBatch),
        scenarioNodeId: scenario.id,
        comparability: "comparable",
      } as CompareMetricMonitor,
      context: context("execute-monitor-action"),
    };
    const compared = await service.compareMetricMonitor(command);
    const monitor = compared.nodes.find((node) => node.kind === "monitor")!;
    expect(compared.version).toBe(4);
    expect(compared.edges.slice(-2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: baselineMetric.id, toNodeId: monitor.id }),
      expect.objectContaining({ fromNodeId: scenario.id, toNodeId: monitor.id }),
    ]));
    expect(monitor.payload).toMatchObject({
      metricId: "ctr_v1",
      definitionVersion: 1,
      status: "ok",
      baselineMetricNodeId: baselineMetric.id,
      scenarioNodeId: scenario.id,
      batchId: currentBatch.id,
      datasetId: currentBatch.datasetIds[0],
      evidenceId: currentBatch.evidenceIds[0],
      baseline: {
        value: 0.1,
        numerator: 100,
        denominator: 1000,
        referenceAssessment: { level: "high" },
      },
      current: {
        value: 0.15,
        numerator: 180,
        denominator: 1200,
        totalRowCount: 2,
        includedRowCount: 1,
        excludedRowCount: 1,
        referenceAssessment: { level: "medium" },
      },
      absoluteDelta: expect.closeTo(0.05, 12),
      relativeDelta: expect.closeTo(0.5, 12),
      relativeDeltaUnknownReason: null,
      comparisonUnknownReason: null,
      referenceChange: {
        baselineLevel: "high",
        currentLevel: "medium",
        levelChanged: true,
        reasonCodesAdded: ["EXCLUDED_ROWS"],
        reasonCodesRemoved: [],
      },
      sampleChange: {
        numeratorDelta: 80,
        denominatorDelta: 200,
        totalRowCountDelta: 0,
        includedRowCountDelta: -1,
        excludedRowCountDelta: 1,
      },
      monitoring: {
        requiredFields: ["clicks", "impressions"],
        minimumDenominator: 1000,
        guardrails: expect.arrayContaining([
          "Compare the same definition and comparable placements or audiences.",
        ]),
        reviewConditions: expect.arrayContaining([
          "Review when the denominator crosses the minimum threshold.",
        ]),
        scheduling: "not_provided",
      },
    });
    expect(JSON.stringify(monitor.payload)).not.toMatch(/revenue|caused by|guarantee(?:d)? uplift/i);

    const raw = new DatabaseSync(join(tempDir, "analysis.db"));
    try {
      expect(raw.prepare(
        "SELECT dataset_id FROM analysis_graph_datasets WHERE graph_id = ? ORDER BY position",
      ).all(compared.id)).toEqual([
        { dataset_id: baselineBatch.datasetIds[0]! },
        { dataset_id: currentBatch.datasetIds[0]! },
      ]);
      expect(raw.prepare(
        "SELECT evidence_id FROM analysis_graph_evidence WHERE graph_id = ? ORDER BY position",
      ).all(compared.id)).toEqual([
        { evidence_id: baselineBatch.evidenceIds[0]! },
        { evidence_id: currentBatch.evidenceIds[0]! },
      ]);
    } finally {
      raw.close();
    }
    const lineage = await new MarketingService(
      store,
      { now: () => now },
      { next: () => "unused" },
    ).getLineage({
      entityType: "analysis_graph",
      id: compared.id,
      workspaceId: compared.workspaceId,
    });
    expect(lineage.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "dataset", id: baselineBatch.datasetIds[0]! }),
      expect.objectContaining({ entityType: "dataset", id: currentBatch.datasetIds[0]! }),
      expect.objectContaining({ entityType: "evidence", id: baselineBatch.evidenceIds[0]! }),
      expect.objectContaining({ entityType: "evidence", id: currentBatch.evidenceIds[0]! }),
    ]));
    const graphLineageKeys = lineage.edges
      .filter((edge) => edge.to.entityType === "analysis_graph" && edge.to.id === compared.id)
      .map((edge) => `${edge.from.entityType}:${edge.from.id}`);
    expect(new Set(graphLineageKeys).size).toBe(graphLineageKeys.length);
    expect(graphLineageKeys).toEqual(expect.arrayContaining([
      `dataset:${baselineBatch.datasetIds[0]!}`,
      `dataset:${currentBatch.datasetIds[0]!}`,
      `evidence:${baselineBatch.evidenceIds[0]!}`,
      `evidence:${currentBatch.evidenceIds[0]!}`,
    ]));

    const read = vi.spyOn(artifacts, "read");
    await expect(service.compareMetricMonitor(command)).resolves.toEqual(compared);
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps zero-baseline and unknown scenario arithmetic explicit and finite", async () => {
    const zeroBatch = await importCsv("zero-baseline", "zero-baseline.csv", [
      "clicks,impressions",
      "0,1000",
      "",
    ]);
    const zeroGraph = await computeCtr(await startGraph(zeroBatch), zeroBatch);
    const zero = await service.createMetricScenario(scenarioCommand(
      zeroGraph,
      metricNode(zeroGraph).id,
      { label: "optimistic", targetValue: 0.1, projectedDenominator: 1000 },
    ));
    expect(zero.nodes.find((node) => node.kind === "scenario")!.payload).toMatchObject({
      status: "ok",
      absoluteDelta: 0.1,
      relativeDelta: null,
      relativeDeltaUnknownReason: "ZERO_BASELINE",
      projectedNumerator: 100,
      projectedNumeratorDelta: 100,
    });

    const unknownBatch = await importCsv("unknown-baseline", "unknown-baseline.csv", [
      "clicks,impressions",
      "10,0",
      "",
    ]);
    const unknownGraph = await computeCtr(await startGraph(unknownBatch), unknownBatch);
    const unknown = await service.createMetricScenario(scenarioCommand(
      unknownGraph,
      metricNode(unknownGraph).id,
      { label: "conservative" },
    ));
    const payload = unknown.nodes.find((node) => node.kind === "scenario")!.payload;
    expect(payload).toMatchObject({
      status: "unknown",
      baselineValue: null,
      absoluteDelta: null,
      relativeDelta: null,
      relativeDeltaUnknownReason: "UNKNOWN_BASELINE",
      projectedNumerator: null,
      projectedNumeratorDelta: null,
    });
    for (const value of Object.values(payload)) {
      if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
    }
    await expect(service.createMetricScenario(scenarioCommand(unknownGraph, metricNode(unknownGraph).id, {
      targetValue: Number.POSITIVE_INFINITY,
    }))).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it("keeps monitor deltas unknown for an unknown baseline or current value and reports a zero baseline separately", async () => {
    const unknownCurrent = await importCsv("unknown-current", "unknown-current.csv", [
      "clicks,impressions",
      "20,0",
      "",
    ]);
    const currentUnknown = await service.compareMetricMonitor(monitorCommand(
      metricGraph,
      unknownCurrent,
      await descriptors(unknownCurrent),
    ));
    expect(currentUnknown.nodes.find((node) => node.kind === "monitor")!.payload).toMatchObject({
      status: "unknown",
      current: { status: "unknown", value: null, unknownReason: "ZERO_DENOMINATOR" },
      absoluteDelta: null,
      relativeDelta: null,
      comparisonUnknownReason: "UNKNOWN_CURRENT",
      relativeDeltaUnknownReason: "UNKNOWN_CURRENT",
    });

    const unknownBaselineBatch = await importCsv("unknown-monitor-baseline", "unknown-monitor-baseline.csv", [
      "clicks,impressions",
      "10,0",
      "",
    ]);
    const unknownBaselineGraph = await computeCtr(
      await startGraph(unknownBaselineBatch),
      unknownBaselineBatch,
    );
    const baselineUnknown = await service.compareMetricMonitor(monitorCommand(
      unknownBaselineGraph,
      baselineBatch,
      await descriptors(baselineBatch),
      { baselineMetricNodeId: metricNode(unknownBaselineGraph).id },
    ));
    expect(baselineUnknown.nodes.find((node) => node.kind === "monitor")!.payload).toMatchObject({
      status: "unknown",
      baseline: { value: null },
      current: { status: "ok", value: 0.1 },
      absoluteDelta: null,
      relativeDelta: null,
      comparisonUnknownReason: "UNKNOWN_BASELINE",
      relativeDeltaUnknownReason: "UNKNOWN_BASELINE",
    });

    const zeroBatch = await importCsv("zero-monitor", "zero-monitor.csv", [
      "clicks,impressions",
      "0,1000",
      "",
    ]);
    const zeroGraph = await computeCtr(await startGraph(zeroBatch), zeroBatch);
    const zeroMetric = metricNode(zeroGraph);
    const compared = await service.compareMetricMonitor({
      input: {
        id: zeroGraph.id,
        workspaceId: zeroGraph.workspaceId,
        expectedVersion: zeroGraph.version,
        baselineMetricNodeId: zeroMetric.id,
        ...await descriptors(baselineBatch),
      },
      context: context("zero-monitor-compare"),
    });
    expect(compared.nodes.find((node) => node.kind === "monitor")!.payload).toMatchObject({
      status: "ok",
      absoluteDelta: 0.1,
      relativeDelta: null,
      comparisonUnknownReason: null,
      relativeDeltaUnknownReason: "ZERO_BASELINE",
    });
  });

  it("rejects wrong-node, cross-graph, and mismatched scenario references without advancing a graph", async () => {
    const datasetNode = metricGraph.nodes.find((node) => node.kind === "dataset")!;
    await expect(service.createMetricScenario(scenarioCommand(metricGraph, datasetNode.id)))
      .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    const otherGraph = await computeCtr(await startGraph(baselineBatch, "other"), baselineBatch);
    await expect(service.createMetricScenario(scenarioCommand(metricGraph, metricNode(otherGraph).id)))
      .rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });

    const withScenario = await service.createMetricScenario(scenarioCommand(metricGraph, baselineMetric.id));
    const otherWithScenario = await service.createMetricScenario(scenarioCommand(
      otherGraph,
      metricNode(otherGraph).id,
    ));
    const otherScenario = otherWithScenario.nodes.find((node) => node.kind === "scenario")!;
    await expect(service.compareMetricMonitor(monitorCommand(
      withScenario,
      baselineBatch,
      await descriptors(baselineBatch),
      { scenarioNodeId: otherScenario.id },
    ))).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    await expect(service.compareMetricMonitor(monitorCommand(
      withScenario,
      baselineBatch,
      await descriptors(baselineBatch),
      { baselineMetricNodeId: metricNode(otherGraph).id },
    ))).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    const unrelatedBatch = await importCsv("unrelated-monitor", "unrelated-monitor.csv", [
      "clicks,impressions",
      "1,1000",
      "",
    ]);
    await expect(service.compareMetricMonitor(monitorCommand(
      withScenario,
      baselineBatch,
      {
        ...await descriptors(baselineBatch),
        evidenceId: unrelatedBatch.evidenceIds[0]!,
      },
    ))).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expect(service.get({ id: metricGraph.id, workspaceId: metricGraph.workspaceId }))
      .resolves.toEqual(withScenario);
  });

  it("enforces graph versions, rebinds derived actions after expansion, and advertises implemented capabilities", async () => {
    const expanded = await service.expand({
      input: {
        id: metricGraph.id,
        workspaceId: metricGraph.workspaceId,
        expectedVersion: metricGraph.version,
        nodes: [],
        edges: [],
      },
      context: context("expand-derived-actions"),
    });
    for (const tool of ["metric_scenario_create", "metric_monitor_compare"]) {
      const action = expanded.recommendedActions.find((candidate) => candidate.tool === tool)!;
      expect(action.arguments).toMatchObject({ id: expanded.id, expectedVersion: 3 });
    }
    await expect(service.createMetricScenario(scenarioCommand(metricGraph, baselineMetric.id, {
      expectedVersion: 1,
    }))).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });

    const catalog = new AnalysisCapabilityService().list();
    expect(catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "metric.scenario",
        operation: "metric_scenario_create",
        availability: { state: "available", detail: expect.any(String) },
      }),
      expect.objectContaining({
        id: "metric.monitor",
        operation: "metric_monitor_compare",
        availability: { state: "available", detail: expect.any(String) },
      }),
    ]));
    expect(JSON.stringify(catalog)).toMatch(/No automatic scheduling|not scheduled|scheduling is not provided/i);
  });
});

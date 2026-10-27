import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnalysisCapabilityService,
  AnalysisService,
} from "../../src/application/analysis-service.js";
import type { ComputeMetric } from "../../src/application/analysis-commands.js";
import type { Command, CommandContext } from "../../src/application/commands.js";
import type { Store } from "../../src/application/ports.js";
import type { AnalysisGraph } from "../../src/domain/analysis-model.js";
import type { IngestionBatch } from "../../src/domain/data-research-model.js";
import type { DomainError } from "../../src/domain/errors.js";
import type { MetricId, ReferenceComparability } from "../../src/domain/metric-catalog.js";
import type { Evidence } from "../../src/domain/model.js";
import { DataResearchService } from "../../src/application/data-research-service.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import { MAX_DATASET_JSONL_BYTES } from "../../src/infrastructure/file-ingestor.js";
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

function workspace(id: string) {
  return {
    id,
    workspaceId: id,
    version: 1,
    createdAt: now,
    updatedAt: now,
    name: id,
  };
}

describe("AnalysisService real metric computation", () => {
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
  let batch: IngestionBatch;
  let graph: AnalysisGraph;
  let evidence: Evidence;
  let normalizedAssetId: string;

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
      await repos.workspaces.insert(workspace("workspace-1"));
      await repos.workspaces.insert(workspace("workspace-2"));
    });
    batch = await importWorkbook("batch-default", "metrics.xlsx", [
      ["clicks", "impressions", "saves", "likes", "published_at"],
      [100, 1000, 1, 10, "2026-01-01T00:00:00.000Z"],
      [200, 2000, 4, 20, "2026-01-03T00:00:00.000Z"],
      [null, null, null, null, "2026-01-01T00:00:00.000Z"],
      [null, null, null, null, "2026-01-01T00:00:00.000Z"],
      [0, 0, 0, 0, "2026-01-02T00:00:00.000Z"],
    ]);
    graph = await startGraph(batch);
    await loadDescriptors();
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

  async function importWorkbook(id: string, fileName: string, rows: unknown[][]): Promise<IngestionBatch> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Metrics");
    for (const row of rows) sheet.addRow(row);
    await workbook.xlsx.writeFile(join(importRoot, fileName));
    return ingest.importFiles({
      input: { id, workspaceId: "workspace-1", paths: [fileName] },
      context: context(id),
    });
  }

  async function startGraph(currentBatch: IngestionBatch, suffix = "graph"): Promise<AnalysisGraph> {
    return service.start({
      input: {
        id: `${currentBatch.id}-${suffix}`,
        workspaceId: "workspace-1",
        objective: "Measure imported performance",
        inputMode: "dataset",
        referenceId: currentBatch.datasetIds[0]!,
      },
      context: context(`${currentBatch.id}-${suffix}`),
    });
  }

  async function loadDescriptors(currentBatch = batch): Promise<void> {
    evidence = (await store.transaction((repos) =>
      repos.evidence.get(currentBatch.evidenceIds[0]!, "workspace-1")
    )) as Evidence;
    normalizedAssetId = evidence.assets!.find((asset) => asset.kind === "normalized_jsonl")!.id;
  }

  function computeCommand(
    metricId: MetricId,
    currentGraph = graph,
    currentBatch = batch,
    extra: Partial<ComputeMetric> = {},
  ): Command<ComputeMetric> {
    return {
      input: {
        id: currentGraph.id,
        workspaceId: currentGraph.workspaceId,
        expectedVersion: currentGraph.version,
        batchId: currentBatch.id,
        datasetId: currentBatch.datasetIds[0]!,
        evidenceId: currentBatch.evidenceIds[0]!,
        assetId: normalizedAssetId,
        metricId,
        ...extra,
      },
      context: context(`${currentGraph.id}-${metricId}-${currentGraph.version}`),
    };
  }

  function executeMetricAction(
    action: AnalysisGraph["recommendedActions"][number],
    suffix: string,
  ): Promise<AnalysisGraph> {
    const input = action.arguments as ComputeMetric & {
      requestId?: string;
      idempotencyKey?: string;
    };
    return service.computeMetric({
      input,
      context: {
        actor: "agent-1",
        requestId: input.requestId ?? `request-${suffix}`,
        idempotencyKey: input.idempotencyKey ?? `command-${suffix}`,
      },
    });
  }

  function metricNode(currentGraph: AnalysisGraph) {
    const nodes = currentGraph.nodes.filter((node) => node.kind === "metric");
    expect(nodes.length).toBeGreaterThan(0);
    return nodes.at(-1)!;
  }

  it("computes both controlled metrics from real normalized_jsonl with sums, precision, coverage, exclusions, and quality details", async () => {
    const ctrGraph = await service.computeMetric(computeCommand("ctr_v1"));
    const ctr = metricNode(ctrGraph);
    expect(ctrGraph.version).toBe(2);
    expect(ctrGraph.edges.at(-1)).toMatchObject({
      fromNodeId: `${graph.id}-dataset`,
      toNodeId: ctr.id,
    });
    expect(ctr.payload).toMatchObject({
      metricId: "ctr_v1",
      definitionVersion: 1,
      formula: "sum(clicks) / sum(impressions)",
      precision: "ieee754_compensated_sum",
      status: "ok",
      numerator: 300,
      denominator: 3000,
      value: 0.1,
      unknownReason: null,
      batchId: batch.id,
      datasetId: batch.datasetIds[0],
      evidenceId: batch.evidenceIds[0],
      assetId: normalizedAssetId,
      sourceId: batch.sourceIds[0],
      evidenceHash: evidence.contentHash,
      assetKind: "normalized_jsonl",
      assetContentHash: evidence.contentHash,
      assetByteLength: evidence.assets!.find((asset) => asset.id === normalizedAssetId)!.byteLength,
      coverage: {
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-03T00:00:00.000Z",
      },
      totalRowCount: 5,
      includedRowCount: 3,
      excludedRowCount: 2,
      referenceAssessment: {
        dimensions: {
          provenance: "owned",
          freshness: "fresh",
          sample: { status: "sufficient", denominator: 3000, minimumDenominator: 1000 },
          missingness: { status: "excluded_rows", includedRowCount: 3, excludedRowCount: 2 },
          comparability: "not_assessed",
        },
      },
    });
    expect(ctr.payload.excludedRows).toEqual([
      { rowIndex: 2, reasons: ["MISSING_NUMERATOR", "MISSING_DENOMINATOR"] },
      { rowIndex: 3, reasons: ["MISSING_NUMERATOR", "MISSING_DENOMINATOR"] },
    ]);
    expect(ctr.payload.qualityLimitations).toEqual(expect.arrayContaining([
      expect.stringContaining("Duplicate row"),
    ]));
    expect(JSON.stringify(ctr.payload)).not.toContain("base64");
    const remainingActions = ctrGraph.recommendedActions.filter((action) => action.tool === "metric_compute");
    expect(remainingActions).toHaveLength(1);
    expect(remainingActions[0]?.arguments).toMatchObject({
      metricId: "save_like_ratio_v1",
      expectedVersion: 2,
    });

    const saveGraph = await service.computeMetric(computeCommand("save_like_ratio_v1", ctrGraph));
    expect(metricNode(saveGraph).payload).toMatchObject({
      metricId: "save_like_ratio_v1",
      formula: "sum(saves) / sum(likes)",
      numerator: 5,
      denominator: 30,
      value: 1 / 6,
      includedRowCount: 3,
      excludedRowCount: 2,
      referenceAssessment: {
        level: "medium",
        dimensions: { sample: { status: "sufficient" } },
      },
    });
    expect(metricNode(saveGraph).payload.definitionLimitations).toEqual(expect.arrayContaining([
      "This is not a save rate or a conversion rate.",
    ]));
  });

  it("recommends executable dataset metric actions and advertises only the implemented metric operation", async () => {
    const actions = graph.recommendedActions.filter((action) => action.tool === "metric_compute");
    expect(actions.map((action) => action.arguments?.metricId)).toEqual([
      "ctr_v1",
      "save_like_ratio_v1",
    ]);
    for (const action of actions) {
      expect(action).toMatchObject({ status: "ready", missingInputs: [] });
      expect(action.arguments).toMatchObject({
        id: graph.id,
        workspaceId: "workspace-1",
        expectedVersion: 1,
        batchId: batch.id,
        datasetId: batch.datasetIds[0],
        evidenceId: batch.evidenceIds[0],
        assetId: normalizedAssetId,
      });
    }

    const capability = new AnalysisCapabilityService().list()
      .find((entry) => entry.id === "metric.compute");
    expect(capability).toMatchObject({
      operation: "metric_compute",
      availability: { state: "available" },
      configuration: expect.arrayContaining(["ctr_v1", "save_like_ratio_v1"]),
    });
    expect(JSON.stringify(new AnalysisCapabilityService().list())).not.toMatch(
      /metric_(?:scenario_create|monitor_compare).*available/i,
    );
  });

  it("executes ready actions after real CSV ingest with the same numeric results as XLSX", async () => {
    await writeFile(join(importRoot, "metrics.csv"), [
      "clicks,impressions,saves,likes",
      "100,1000,1,10",
      "2e2,2.0E3,4e0,2e1",
      "",
    ].join("\n"));
    const csvBatch = await ingest.importFiles({
      input: { id: "batch-csv", workspaceId: "workspace-1", paths: ["metrics.csv"] },
      context: context("batch-csv"),
    });
    const csvGraph = await startGraph(csvBatch);
    const actions = csvGraph.recommendedActions.filter((action) => action.tool === "metric_compute");
    expect(actions).toHaveLength(2);
    expect(actions.every((action) => action.status === "ready")).toBe(true);

    const ctrGraph = await executeMetricAction(actions[0]!, "csv-ctr");
    expect(metricNode(ctrGraph).payload).toMatchObject({
      metricId: "ctr_v1",
      status: "ok",
      numerator: 300,
      denominator: 3000,
      value: 0.1,
      includedRowCount: 2,
      excludedRowCount: 0,
      numericInputNormalization: "strict_decimal_scientific_to_ieee754",
      precision: "ieee754_compensated_sum",
    });
    const saveAction = ctrGraph.recommendedActions.find((action) =>
      action.tool === "metric_compute" && action.arguments?.metricId === "save_like_ratio_v1")!;
    const saveGraph = await executeMetricAction(saveAction, "csv-save");
    expect(metricNode(saveGraph).payload).toMatchObject({
      metricId: "save_like_ratio_v1",
      status: "ok",
      numerator: 5,
      denominator: 30,
      value: 1 / 6,
      includedRowCount: 2,
      excludedRowCount: 0,
    });
  });

  it("keeps ready actions executable after expand advances the graph version", async () => {
    const expanded = await service.expand({
      input: {
        id: graph.id,
        workspaceId: graph.workspaceId,
        expectedVersion: graph.version,
        nodes: [],
        edges: [],
      },
      context: context("expand-before-action"),
    });
    const action = expanded.recommendedActions.find((candidate) =>
      candidate.tool === "metric_compute" && candidate.arguments?.metricId === "ctr_v1")!;
    expect(action.arguments).toMatchObject({ id: graph.id, expectedVersion: 2 });

    const computed = await executeMetricAction(action, "expanded-action");
    expect(computed).toMatchObject({ id: graph.id, version: 3 });
    expect(metricNode(computed).payload).toMatchObject({ metricId: "ctr_v1", value: 0.1 });
  });

  it("rebinds forked graph actions and executes parent and child without shared replay", async () => {
    const parent = await service.expand({
      input: {
        id: graph.id,
        workspaceId: graph.workspaceId,
        expectedVersion: graph.version,
        nodes: [],
        edges: [],
        recommendedActions: graph.recommendedActions.map((action) => ({
          ...action,
          arguments: {
            ...action.arguments,
            expectedVersion: 2,
            requestId: `parent-request-${String(action.arguments?.metricId)}`,
            idempotencyKey: `parent-command-${String(action.arguments?.metricId)}`,
          },
        })),
      },
      context: context("parent-action-bind"),
    });
    const child = await service.fork({
      input: {
        id: "forked-metric-graph",
        workspaceId: parent.workspaceId,
        parentGraphId: parent.id,
        expectedVersion: parent.version,
        forkNodeId: `${parent.id}-dataset`,
      },
      context: context("fork-action-bind"),
    });
    const parentAction = parent.recommendedActions.find((action) =>
      action.tool === "metric_compute" && action.arguments?.metricId === "ctr_v1")!;
    const childAction = child.recommendedActions.find((action) =>
      action.tool === "metric_compute" && action.arguments?.metricId === "ctr_v1")!;
    expect(childAction.arguments).toMatchObject({ id: child.id, expectedVersion: 1 });
    expect(childAction.arguments?.idempotencyKey).not.toBe(parentAction.arguments?.idempotencyKey);
    expect(childAction.arguments?.requestId).not.toBe(parentAction.arguments?.requestId);

    const parentResult = await executeMetricAction(parentAction, "parent-action");
    const childResult = await executeMetricAction(childAction, "child-action");
    expect(parentResult).toMatchObject({ id: parent.id, version: 3 });
    expect(childResult).toMatchObject({ id: child.id, version: 2 });
    expect(metricNode(childResult).payload).toMatchObject({ metricId: "ctr_v1", value: 0.1 });
    await expect(service.get({ id: parent.id, workspaceId: parent.workspaceId }))
      .resolves.toEqual(parentResult);
    await expect(service.get({ id: child.id, workspaceId: child.workspaceId }))
      .resolves.toEqual(childResult);
  });

  it("returns unknown rather than zero for a zero denominator", async () => {
    const zero = await importWorkbook("batch-zero", "zero.xlsx", [
      ["clicks", "impressions"],
      [10, 0],
      [20, 0],
    ]);
    const zeroGraph = await startGraph(zero);
    await loadDescriptors(zero);
    const result = await service.computeMetric(computeCommand("ctr_v1", zeroGraph, zero));

    expect(metricNode(result).payload).toMatchObject({
      status: "unknown",
      numerator: 30,
      denominator: 0,
      value: null,
      unknownReason: "ZERO_DENOMINATOR",
      referenceAssessment: {
        level: "unknown",
        reasons: [{ code: "ZERO_DENOMINATOR" }],
      },
    });
  });

  it("derives reference from real ownership, quality-report staleness, sample size, and comparability", async () => {
    const sufficient = await importWorkbook("batch-reference", "reference.xlsx", [
      ["clicks", "impressions"],
      [60, 600],
      [50, 500],
    ]);
    const referenceGraph = await startGraph(sufficient);
    await loadDescriptors(sufficient);
    const initial = await service.computeMetric(computeCommand("ctr_v1", referenceGraph, sufficient));
    expect(metricNode(initial).payload.referenceAssessment).toMatchObject({ level: "medium" });

    const high = await service.computeMetric(computeCommand(
      "ctr_v1",
      await startGraph(sufficient, "comparable"),
      sufficient,
      { comparability: "comparable" satisfies ReferenceComparability },
    ));
    expect(metricNode(high).payload.referenceAssessment).toMatchObject({ level: "high" });

    await store.transaction(async (repos) => {
      const source = (await repos.sources.get(sufficient.sourceIds[0]!, "workspace-1"))!;
      await repos.sources.update({ ...source, ownership: "external_public" }, source.version);
    });
    const external = await service.computeMetric(computeCommand(
      "ctr_v1",
      await startGraph(sufficient, "external"),
      sufficient,
      { comparability: "comparable" },
    ));
    expect(metricNode(external).payload.referenceAssessment).toMatchObject({
      level: "medium",
      reasons: expect.arrayContaining([expect.objectContaining({ code: "EXTERNAL_PUBLIC" })]),
      dimensions: { provenance: "external_public" },
    });

    const stale = await ingest.importFiles({
      input: {
        id: "batch-stale",
        workspaceId: "workspace-1",
        paths: ["reference.xlsx"],
        freshness: {
          observedAt: "2026-01-01T00:00:00.000Z",
          evaluatedAt: "2026-02-01T00:00:00.000Z",
          maxAgeHours: 24,
        },
      },
      context: context("batch-stale"),
    });
    await loadDescriptors(stale);
    const staleResult = await service.computeMetric(computeCommand(
      "ctr_v1",
      await startGraph(stale),
      stale,
    ));
    expect(metricNode(staleResult).payload.referenceAssessment).toMatchObject({
      level: "medium",
      reasons: expect.arrayContaining([expect.objectContaining({ code: "STALE_DATA" })]),
      dimensions: { freshness: "stale" },
    });

    const small = await importWorkbook("batch-small", "small.xlsx", [
      ["clicks", "impressions"],
      [1, 10],
    ]);
    await loadDescriptors(small);
    const smallResult = await service.computeMetric(computeCommand(
      "ctr_v1",
      await startGraph(small),
      small,
      { comparability: "comparable" },
    ));
    expect(metricNode(smallResult).payload.referenceAssessment).toMatchObject({
      level: "medium",
      reasons: expect.arrayContaining([expect.objectContaining({ code: "SAMPLE_BELOW_MINIMUM" })]),
      dimensions: { sample: { status: "below_minimum", denominator: 10 } },
    });
  });

  it("rejects malformed JSONL, wrong asset kind, inconsistent batch pairings, hash and byte length, and oversized artifacts", async () => {
    const originalAssetId = evidence.assets!.find((asset) => asset.kind === "original")!.id;
    await expect(service.computeMetric(computeCommand("ctr_v1", graph, batch, {
      assetId: originalAssetId,
    }))).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });

    const other = await importWorkbook("batch-other", "other.xlsx", [
      ["clicks", "impressions"],
      [1, 1000],
    ]);
    await expect(service.computeMetric(computeCommand("ctr_v1", graph, batch, {
      evidenceId: other.evidenceIds[0],
    }))).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expect(service.computeMetric(computeCommand("ctr_v1", graph, batch, {
      datasetId: other.datasetIds[0],
    }))).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    await expect(service.computeMetric(computeCommand("ctr_v1", graph, batch, {
      batchId: "missing-batch",
    }))).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });

    await replaceNormalized(Buffer.from('{"clicks":1,"impressions":1000}\nnot-json\n'));
    await expect(service.computeMetric(computeCommand("ctr_v1", graph, batch, {
      comparability: "not_assessed",
    }))).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });

    const current = (await store.transaction((repos) =>
      repos.evidence.get(batch.evidenceIds[0]!, "workspace-1")
    )) as Evidence;
    await store.transaction(async (repos) => {
      const assets = current.assets!.map((asset) => asset.id === normalizedAssetId
        ? { ...asset, byteLength: asset.byteLength + 1 }
        : asset);
      await repos.evidence.update({ ...current, assets }, current.version);
    });
    await expect(service.computeMetric(computeCommand("ctr_v1", graph, batch)))
      .rejects.toMatchObject<DomainError>({ code: "CONFLICT" });

    await replaceNormalized(Buffer.alloc(MAX_DATASET_JSONL_BYTES + 1, 32));
    await expect(service.computeMetric(computeCommand("ctr_v1", graph, batch)))
      .rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await expect(service.get({ id: graph.id, workspaceId: graph.workspaceId })).resolves.toEqual(graph);
  });

  async function replaceNormalized(content: Buffer): Promise<void> {
    const stored = await artifacts.put(content);
    const current = (await store.transaction((repos) =>
      repos.evidence.get(batch.evidenceIds[0]!, "workspace-1")
    )) as Evidence;
    await store.transaction(async (repos) => {
      const assets = current.assets!.map((asset) => asset.id === normalizedAssetId
        ? { ...asset, ...stored }
        : asset);
      await repos.evidence.update({
        ...current,
        contentHash: stored.contentHash,
        assets,
      }, current.version);
    });
    evidence = { ...current, contentHash: stored.contentHash };
  }

  it("reads artifacts outside transactions, rechecks current entity versions before writing, and replays without I/O", async () => {
    let transactionDepth = 0;
    let artifactRead = false;
    let rechecked = false;
    const transaction = store.transaction.bind(store);
    const observingStore: Store = {
      close: () => store.close(),
      transaction: (work) => {
        transactionDepth += 1;
        return transaction(async (repos) => {
          const getDataset = repos.datasets.get.bind(repos.datasets);
          repos.datasets.get = async (id, workspaceId) => {
            const current = await getDataset(id, workspaceId);
            if (artifactRead && current?.id === batch.datasetIds[0]) {
              rechecked = true;
              return { ...current, version: current.version + 1 };
            }
            return current;
          };
          try {
            return await work(repos);
          } finally {
            transactionDepth -= 1;
          }
        });
      },
    };
    const originalRead = artifacts.read.bind(artifacts);
    const readDepths: number[] = [];
    const read = vi.spyOn(artifacts, "read").mockImplementation(async (...args) => {
      readDepths.push(transactionDepth);
      artifactRead = true;
      return originalRead(...args);
    });
    const observed = new AnalysisService(
      observingStore,
      { now: () => now },
      { next: () => `observed-${++sequence}` },
      artifacts,
    );
    const command = computeCommand("ctr_v1");
    await expect(observed.computeMetric(command)).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    expect(rechecked).toBe(true);
    expect(read).toHaveBeenCalled();
    expect(readDepths).toEqual([0, 0]);
    await expect(service.get({ id: graph.id, workspaceId: graph.workspaceId })).resolves.toEqual(graph);

    vi.restoreAllMocks();
    const created = await service.computeMetric(command);
    const replayRead = vi.spyOn(artifacts, "read");
    await expect(service.computeMetric(command)).resolves.toEqual(created);
    expect(replayRead).not.toHaveBeenCalled();
    await expect(store.transaction((repos) =>
      repos.audit.listForEntity(graph.workspaceId, "analysis_graph", graph.id)
    )).resolves.toMatchObject([
      { action: "analysis_graph.start" },
      { action: "analysis_graph.compute_metric" },
    ]);
  });

  it("rejects cross-workspace graph and evidence access without creating a result", async () => {
    await expect(service.computeMetric(computeCommand("ctr_v1", graph, batch, {
      workspaceId: "workspace-2",
    }))).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    await expect(service.get({ id: graph.id, workspaceId: "workspace-1" })).resolves.toEqual(graph);
    const audits = await store.transaction((repos) =>
      repos.audit.listForEntity("workspace-1", "analysis_graph", graph.id)
    );
    expect(audits).toHaveLength(1);
  });
});

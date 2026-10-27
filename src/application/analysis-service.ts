import { createHash } from "node:crypto";
import {
  createAnalysisGraph,
  createMetricScenario as calculateMetricScenario,
  expandAnalysisGraph,
  forkAnalysisGraph,
  type AnalysisGraph,
  type AnalysisGraphNode,
  type AnalysisPayload,
  type AnalysisRecommendedAction,
} from "../domain/analysis-model.js";
import type { IngestionBatch } from "../domain/data-research-model.js";
import { DomainError } from "../domain/errors.js";
import {
  METRIC_CATALOG,
  assessMetricReference,
  computeMetric as calculateMetric,
  getMetricDefinition,
  type MetricComputation,
  type ReferenceAssessment,
} from "../domain/metric-catalog.js";
import type { Dataset, Evidence, EvidenceAsset, Source } from "../domain/model.js";
import { canonicalAcquisitionUrl } from "../infrastructure/acquisition-policy.js";
import type { ArtifactStore } from "../infrastructure/artifact-store.js";
import { MAX_DATASET_JSONL_BYTES } from "../infrastructure/file-ingestor.js";
import { credentialEnvironmentVariable } from "../infrastructure/safe-http.js";
import { assertUtcInstant } from "../infrastructure/sqlite.js";
import {
  AuditableCommandPipeline,
  type Command,
  type CommandContext,
  type CommandPipeline,
} from "./commands.js";
import {
  ANALYSIS_INPUT_MODES,
  type AnalysisCapability,
  type CompareMetricMonitor,
  type ComputeMetric,
  type CreateMetricScenario,
  type ExpandAnalysisGraph,
  type ForkAnalysisGraph,
  type GetAnalysisGraph,
  type StartAnalysis,
} from "./analysis-commands.js";
import type {
  Clock,
  IdGenerator,
  Repositories,
  Store,
} from "./ports.js";

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${field} must not be empty`);
  }
}

function assertExpectedVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid("expectedVersion must be a positive integer");
  }
}

async function requireWorkspace(repos: Repositories, workspaceId: string): Promise<void> {
  if (!(await repos.workspaces.get(workspaceId, workspaceId))) {
    throw new DomainError("NOT_FOUND", "Workspace not found", false, { workspaceId });
  }
}

async function requireGraph(
  repos: Repositories,
  id: string,
  workspaceId: string,
): Promise<AnalysisGraph> {
  const graph = await repos.analysisGraphs.get(id, workspaceId);
  if (!graph) {
    throw new DomainError("NOT_FOUND", "Analysis graph not found in workspace", false, {
      id,
      workspaceId,
    });
  }
  return graph;
}

interface MetricDescriptors {
  graph: AnalysisGraph;
  batch: IngestionBatch;
  dataset: Dataset;
  evidence: Evidence;
  source: Source;
  asset: EvidenceAsset;
  qualityAsset: EvidenceAsset;
}

interface PreparedMetric {
  descriptors: MetricDescriptors;
  computation: MetricComputation;
  referenceAssessment: ReferenceAssessment;
  qualityLimitations: string[];
}

function conflict(message: string): never {
  throw new DomainError("CONFLICT", message);
}

async function loadMetricDescriptors(
  repos: Repositories,
  input: ComputeMetric,
): Promise<MetricDescriptors> {
  await requireWorkspace(repos, input.workspaceId);
  const graph = await requireGraph(repos, input.id, input.workspaceId);
  if (graph.version !== input.expectedVersion) {
    throw new DomainError("CONFLICT", "Analysis graph version does not match expectedVersion");
  }
  const batch = await repos.ingestionBatches.get(input.batchId, input.workspaceId) as
    IngestionBatch | undefined;
  if (!batch) {
    throw new DomainError("NOT_FOUND", "Ingestion batch not found in workspace", false, {
      batchId: input.batchId,
      workspaceId: input.workspaceId,
    });
  }
  const dataset = await repos.datasets.get(input.datasetId, input.workspaceId) as Dataset | undefined;
  if (!dataset) {
    throw new DomainError("NOT_FOUND", "Metric dataset not found in workspace", false, {
      datasetId: input.datasetId,
      workspaceId: input.workspaceId,
    });
  }
  const evidence = await repos.evidence.get(input.evidenceId, input.workspaceId) as Evidence | undefined;
  if (!evidence) {
    throw new DomainError("NOT_FOUND", "Metric evidence not found in workspace", false, {
      evidenceId: input.evidenceId,
      workspaceId: input.workspaceId,
    });
  }
  const datasetIndexes = batch.datasetIds.flatMap((id, index) => id === dataset.id ? [index] : []);
  if (datasetIndexes.length !== 1 || batch.evidenceIds[datasetIndexes[0]!] !== evidence.id) {
    invalid("Dataset and evidence must be paired in the specified ingestion batch");
  }
  if (dataset.sourceId !== evidence.sourceId || !batch.sourceIds.includes(dataset.sourceId)) {
    invalid("Batch, dataset, and evidence must reference the same Source");
  }
  const source = await repos.sources.get(dataset.sourceId, input.workspaceId) as Source | undefined;
  if (!source) {
    throw new DomainError("NOT_FOUND", "Metric Source not found in workspace", false, {
      sourceId: dataset.sourceId,
      workspaceId: input.workspaceId,
    });
  }
  const assets = evidence.assets ?? [];
  const asset = assets.find((candidate) => candidate.id === input.assetId);
  if (!asset || asset.kind !== "normalized_jsonl") {
    invalid("assetId must identify a normalized_jsonl asset on the specified evidence");
  }
  const qualityAssets = assets.filter((candidate) => candidate.kind === "quality_report");
  if (qualityAssets.length !== 1) {
    conflict("Metric evidence must contain exactly one quality report asset");
  }
  for (const candidate of [asset, qualityAssets[0]!]) {
    if (!/^[0-9a-f]{64}$/.test(candidate.contentHash) ||
        !Number.isSafeInteger(candidate.byteLength) || candidate.byteLength < 0 ||
        candidate.byteLength > MAX_DATASET_JSONL_BYTES) {
      conflict("Evidence asset descriptor has an invalid hash or byte length");
    }
  }
  if (evidence.contentHash !== asset.contentHash) {
    conflict("Evidence hash must match its normalized_jsonl asset");
  }
  return { graph, batch, dataset, evidence, source, asset, qualityAsset: qualityAssets[0]! };
}

function assertCurrentMetricDescriptors(
  current: MetricDescriptors,
  prepared: MetricDescriptors,
): void {
  for (const key of ["graph", "batch", "dataset", "evidence", "source"] as const) {
    if (current[key].version !== prepared[key].version) {
      conflict(`Metric ${key} changed while its artifact was being read`);
    }
  }
  for (const key of ["asset", "qualityAsset"] as const) {
    if (current[key].id !== prepared[key].id ||
        current[key].kind !== prepared[key].kind ||
        current[key].contentHash !== prepared[key].contentHash ||
        current[key].byteLength !== prepared[key].byteLength) {
      conflict("Metric evidence assets changed while they were being read");
    }
  }
}

function decodeArtifact(content: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return conflict(`${label} must be valid UTF-8`);
  }
}

function parseNormalizedRows(content: Buffer): Record<string, unknown>[] {
  const text = decodeArtifact(content, "normalized_jsonl");
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return conflict(`normalized_jsonl contains malformed JSON at row ${index}`);
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return conflict(`normalized_jsonl row ${index} must be a JSON object`);
    }
    return row as Record<string, unknown>;
  });
}

function parseQualityReport(content: Buffer): { stale: boolean; limitations: string[] } {
  let report: unknown;
  try {
    report = JSON.parse(decodeArtifact(content, "quality_report"));
  } catch {
    return conflict("quality_report must contain valid JSON");
  }
  if (report === null || typeof report !== "object" || Array.isArray(report) ||
      !Array.isArray((report as { issues?: unknown }).issues)) {
    conflict("quality_report must contain an issues array");
  }
  const issues = (report as { issues: unknown[] }).issues;
  if (issues.some((issue) => issue === null || typeof issue !== "object" || Array.isArray(issue))) {
    conflict("quality_report issues must be objects");
  }
  return {
    stale: issues.some((issue) => (issue as { code?: unknown }).code === "STALE_DATA"),
    limitations: issues.flatMap((issue) => {
      const message = (issue as { message?: unknown }).message;
      return typeof message === "string" ? [message] : [];
    }),
  };
}

async function readMetric(
  store: Store,
  artifacts: ArtifactStore,
  input: ComputeMetric,
): Promise<PreparedMetric> {
  const descriptors = await store.transaction((repos) => loadMetricDescriptors(repos, input));
  const [normalized, quality] = await Promise.all([
    artifacts.read(descriptors.asset.contentHash, MAX_DATASET_JSONL_BYTES),
    artifacts.read(descriptors.qualityAsset.contentHash, MAX_DATASET_JSONL_BYTES),
  ]);
  if (normalized.length !== descriptors.asset.byteLength ||
      quality.length !== descriptors.qualityAsset.byteLength) {
    conflict("Evidence artifact byte length does not match its descriptor");
  }
  const qualityReport = parseQualityReport(quality);
  const computation = calculateMetric(input.metricId, parseNormalizedRows(normalized));
  const referenceAssessment = assessMetricReference(input.metricId, computation, {
    ownership: descriptors.source.ownership,
    stale: qualityReport.stale,
    ...(input.comparability === undefined ? {} : { comparability: input.comparability }),
  });
  const datasetLimitations = Array.isArray(descriptors.dataset.limitations)
    ? descriptors.dataset.limitations.filter((item): item is string => typeof item === "string")
    : [];
  return {
    descriptors,
    computation,
    referenceAssessment,
    qualityLimitations: [...new Set([...datasetLimitations, ...qualityReport.limitations])],
  };
}

function metricNodeId(input: ComputeMetric): string {
  const identity = JSON.stringify([
    input.id,
    input.batchId,
    input.datasetId,
    input.evidenceId,
    input.assetId,
    input.metricId,
  ]);
  return `metric-${createHash("sha256").update(identity).digest("hex")}`;
}

const GRAPH_SCOPED_ACTION_TOOLS = new Set([
  "metric_compute",
  "metric_scenario_create",
  "metric_monitor_compare",
]);
const FORK_COMMAND_ACTION_TOOLS = new Set([
  "ingest_content_links",
  "ingest_temporary_api",
  "research_session_create",
]);

function rebindGraphActions(
  actions: AnalysisRecommendedAction[],
  graphId: string,
  graphVersion: number,
  fork = false,
): AnalysisRecommendedAction[] {
  return actions.map((action) => {
    const graphScoped = GRAPH_SCOPED_ACTION_TOOLS.has(action.tool);
    const forkCommand = fork && FORK_COMMAND_ACTION_TOOLS.has(action.tool);
    if (!graphScoped && !forkCommand) return action;
    const args = action.arguments ?? {};
    const rebound: AnalysisPayload = { ...args };
    if (graphScoped) {
      rebound.id = graphId;
      rebound.expectedVersion = graphVersion;
    }
    if (forkCommand && typeof args.id === "string") {
      const identity = JSON.stringify([graphId, action.tool, args.id]);
      rebound.id = `analysis-command-${createHash("sha256").update(identity).digest("hex")}`;
    }
    for (const field of ["graphId", "parentGraphId"] as const) {
      if (Object.hasOwn(args, field)) rebound[field] = graphId;
    }
    if (Object.hasOwn(args, "expectedGraphVersion")) {
      rebound.expectedGraphVersion = graphVersion;
    }
    for (const field of ["requestId", "idempotencyKey"] as const) {
      const previous = args[field];
      if (typeof previous === "string") {
        const identity = JSON.stringify([graphId, graphVersion, field, previous]);
        rebound[field] = `analysis-${field}-${createHash("sha256").update(identity).digest("hex")}`;
      }
    }
    return { ...action, arguments: rebound };
  });
}

function metricPayload(prepared: PreparedMetric, input: ComputeMetric): AnalysisPayload {
  const { descriptors, computation } = prepared;
  const definition = getMetricDefinition(input.metricId);
  return {
    ...computation,
    batchId: input.batchId,
    datasetId: input.datasetId,
    evidenceId: input.evidenceId,
    assetId: input.assetId,
    sourceId: descriptors.source.id,
    evidenceHash: descriptors.evidence.contentHash,
    assetKind: descriptors.asset.kind,
    assetContentHash: descriptors.asset.contentHash,
    assetByteLength: descriptors.asset.byteLength,
    coverage: {
      start: descriptors.dataset.coverageStart,
      end: descriptors.dataset.coverageEnd,
    },
    qualityLimitations: prepared.qualityLimitations,
    definitionLimitations: [...definition.limitations],
    referenceAssessment: prepared.referenceAssessment,
  } as unknown as AnalysisPayload;
}

function requireMetricNode(graph: AnalysisGraph, nodeId: string): AnalysisGraphNode {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new DomainError("NOT_FOUND", "Metric node not found in analysis graph", false, {
      id: graph.id,
      nodeId,
    });
  }
  if (node.kind !== "metric") invalid("Referenced analysis node must be a Metric node");
  return node;
}

function metricComputationFromNode(node: AnalysisGraphNode): MetricComputation {
  const payload = node.payload;
  const definition = getMetricDefinition(payload.metricId as ComputeMetric["metricId"]);
  if (payload.definitionVersion !== definition.version ||
      payload.formula !== definition.formula || payload.unit !== definition.unit ||
      (payload.status !== "ok" && payload.status !== "unknown")) {
    conflict("Metric node has an invalid definition or status");
  }
  for (const field of ["numerator", "denominator", "value"] as const) {
    const value = payload[field];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      conflict(`Metric node ${field} must be a finite non-negative number or null`);
    }
  }
  if (payload.status === "ok" &&
      [payload.numerator, payload.denominator, payload.value].some((value) => value === null)) {
    conflict("An ok Metric node must contain numerator, denominator, and value");
  }
  if (payload.status === "unknown" && payload.value !== null) {
    conflict("An unknown Metric node must have a null value");
  }
  for (const field of ["totalRowCount", "includedRowCount", "excludedRowCount"] as const) {
    const value = payload[field];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      conflict(`Metric node ${field} must be a non-negative integer`);
    }
  }
  return { ...payload } as unknown as MetricComputation;
}

function metricReferenceFromNode(node: AnalysisGraphNode): ReferenceAssessment {
  const reference = node.payload.referenceAssessment;
  if (reference === null || typeof reference !== "object" || Array.isArray(reference) ||
      !["high", "medium", "low", "unknown"].includes(String(reference.level)) ||
      !Array.isArray(reference.reasons) || reference.reasons.some((reason) =>
        reason === null || typeof reason !== "object" || Array.isArray(reason) ||
        typeof reason.code !== "string" || typeof reason.message !== "string")) {
    conflict("Metric node must contain a valid reference assessment");
  }
  return reference as unknown as ReferenceAssessment;
}

function derivedNodeId(kind: "scenario" | "monitor", identity: unknown): string {
  return `${kind}-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function metricFollowupActions(
  graphId: string,
  workspaceId: string,
  graphVersion: number,
  metricNodeId: string,
): AnalysisRecommendedAction[] {
  return [
    {
      tool: "metric_scenario_create",
      description: "Create a conditional arithmetic scenario for this metric; this is not a performance guarantee.",
      arguments: { id: graphId, workspaceId, expectedVersion: graphVersion, metricNodeId },
      status: "requires_input",
      missingInputs: ["label", "targetValue", "projectedDenominator"],
    },
    {
      tool: "metric_monitor_compare",
      description: "Recompute the same definition from a new verified snapshot and compare it with this baseline.",
      arguments: { id: graphId, workspaceId, expectedVersion: graphVersion, baselineMetricNodeId: metricNodeId },
      status: "requires_input",
      missingInputs: ["batchId", "datasetId", "evidenceId", "assetId"],
    },
  ];
}

function nullableDelta(current: number | null, baseline: number | null): number | null {
  if (current === null || baseline === null) return null;
  const delta = current - baseline;
  if (!Number.isFinite(delta)) invalid("Monitor arithmetic must remain finite");
  return delta;
}

function monitorPayload(
  baselineNode: AnalysisGraphNode,
  prepared: PreparedMetric,
  input: CompareMetricMonitor,
): AnalysisPayload {
  const baseline = metricComputationFromNode(baselineNode);
  const baselineReference = metricReferenceFromNode(baselineNode);
  const current = prepared.computation;
  const currentPayload = metricPayload(prepared, {
    ...input,
    metricId: baseline.metricId,
  });
  const baselineUnknown = baseline.status === "unknown" || baseline.value === null;
  const currentUnknown = current.status === "unknown" || current.value === null;
  const comparisonUnknownReason = baselineUnknown && currentUnknown
    ? "UNKNOWN_BASELINE_AND_CURRENT"
    : baselineUnknown ? "UNKNOWN_BASELINE" : currentUnknown ? "UNKNOWN_CURRENT" : null;
  const absoluteDelta = comparisonUnknownReason === null
    ? nullableDelta(current.value, baseline.value)
    : null;
  const zeroBaseline = comparisonUnknownReason === null && baseline.value === 0;
  const relativeDelta = comparisonUnknownReason !== null || zeroBaseline
    ? null
    : absoluteDelta! / baseline.value!;
  if (relativeDelta !== null && !Number.isFinite(relativeDelta)) {
    invalid("Monitor arithmetic must remain finite");
  }
  const baselineReasons = new Set(baselineReference.reasons.map((reason) => reason.code));
  const currentReasons = new Set(prepared.referenceAssessment.reasons.map((reason) => reason.code));
  const definition = getMetricDefinition(baseline.metricId);
  return {
    metricId: baseline.metricId,
    definitionVersion: baseline.definitionVersion,
    formula: baseline.formula,
    unit: baseline.unit,
    status: comparisonUnknownReason === null ? "ok" : "unknown",
    baselineMetricNodeId: baselineNode.id,
    scenarioNodeId: input.scenarioNodeId ?? null,
    batchId: input.batchId,
    datasetId: input.datasetId,
    evidenceId: input.evidenceId,
    baseline: {
      value: baseline.value,
      numerator: baseline.numerator,
      denominator: baseline.denominator,
      referenceAssessment: baselineReference,
      sample: {
        totalRowCount: baseline.totalRowCount,
        includedRowCount: baseline.includedRowCount,
        excludedRowCount: baseline.excludedRowCount,
      },
    },
    current: currentPayload,
    absoluteDelta,
    relativeDelta,
    comparisonUnknownReason,
    relativeDeltaUnknownReason: comparisonUnknownReason ?? (zeroBaseline ? "ZERO_BASELINE" : null),
    referenceChange: {
      baselineLevel: baselineReference.level,
      currentLevel: prepared.referenceAssessment.level,
      levelChanged: baselineReference.level !== prepared.referenceAssessment.level,
      reasonCodesAdded: [...currentReasons].filter((code) => !baselineReasons.has(code)),
      reasonCodesRemoved: [...baselineReasons].filter((code) => !currentReasons.has(code)),
    },
    sampleChange: {
      numeratorDelta: nullableDelta(current.numerator, baseline.numerator),
      denominatorDelta: nullableDelta(current.denominator, baseline.denominator),
      totalRowCountDelta: current.totalRowCount - baseline.totalRowCount,
      includedRowCountDelta: current.includedRowCount - baseline.includedRowCount,
      excludedRowCountDelta: current.excludedRowCount - baseline.excludedRowCount,
      baselineMinimumDenominatorMet: baseline.denominator !== null &&
        baseline.denominator >= definition.monitoring.minimumDenominator,
      currentMinimumDenominatorMet: current.denominator !== null &&
        current.denominator >= definition.monitoring.minimumDenominator,
    },
    monitoring: {
      requiredFields: [...definition.monitoring.requiredFields],
      minimumDenominator: definition.monitoring.minimumDenominator,
      guardrails: [...definition.monitoring.guardrails],
      reviewConditions: [...definition.monitoring.reviewConditions],
      scheduling: "not_provided",
    },
    limitations: [
      "Observed before-and-after arithmetic only; it does not explain the change or predict commercial outcomes.",
    ],
  } as unknown as AnalysisPayload;
}

function referencedIds(payload: AnalysisPayload, singular: string, plural: string): string[] {
  const ids: string[] = [];
  for (const field of [singular, plural]) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    const candidates = field === singular ? [value] : value;
    if (!Array.isArray(candidates)) {
      invalid(`Analysis graph ${field} references must be non-empty string IDs`);
    }
    for (const id of candidates) {
      assertNonEmptyString(id, `Analysis graph ${field} reference`);
      ids.push(id);
    }
  }
  return ids;
}

async function requireReferences(
  repos: Repositories,
  workspaceId: string,
  nodes: AnalysisGraphNode[],
): Promise<void> {
  for (const node of nodes) {
    for (const id of referencedIds(node.payload, "datasetId", "datasetIds")) {
      if (!(await repos.datasets.get(id, workspaceId))) {
        throw new DomainError("NOT_FOUND", "Analysis dataset not found in workspace", false, {
          datasetId: id,
          workspaceId,
        });
      }
    }
    for (const id of referencedIds(node.payload, "evidenceId", "evidenceIds")) {
      if (!(await repos.evidence.get(id, workspaceId))) {
        throw new DomainError("NOT_FOUND", "Analysis evidence not found in workspace", false, {
          evidenceId: id,
          workspaceId,
        });
      }
    }
  }
}

function derivedActionId(graphId: string, purpose: "research" | "content" | "api"): string {
  return `analysis-${purpose}-${createHash("sha256").update(graphId).digest("hex")}`;
}

function bindStartActionContext(
  action: AnalysisRecommendedAction,
  graphId: string,
  context: CommandContext,
): AnalysisRecommendedAction {
  if (action.tool === "host.web_search") return action;
  const derived: AnalysisPayload = { actor: context.actor };
  for (const field of ["requestId", "idempotencyKey"] as const) {
    const identity = JSON.stringify([graphId, action.tool, action.arguments ?? null, field, context[field]]);
    derived[field] = `analysis-${field}-${createHash("sha256").update(identity).digest("hex")}`;
  }
  return { ...action, arguments: { ...action.arguments, ...derived } };
}

function startActions(
  input: StartAnalysis & { inputMode: NonNullable<StartAnalysis["inputMode"]> },
): AnalysisRecommendedAction[] {
  if (input.inputMode === "none") {
    return [
      {
        tool: "host.web_search",
        description: "Use the host agent's search capability, when available, to gather current public sources; this server does not perform general web search.",
        arguments: { query: `${input.objective}${input.channel ? ` ${input.channel}` : ""}` },
        status: "ready",
        missingInputs: [],
      },
      {
        tool: "research_session_create",
        description: "After host search or user input supplies seed URLs and a bounded scope, create a public research session; no research has run yet.",
        arguments: {
          id: derivedActionId(input.id, "research"),
          workspaceId: input.workspaceId,
          goal: input.objective,
          expansion: false,
        },
        status: "requires_input",
        missingInputs: ["seeds", "scope"],
      },
    ];
  }
  if (input.inputMode === "links") {
    return [{
      tool: "ingest_content_links",
      description: "Acquire the supplied public content links through the configured browser acquisition fallback chain.",
      arguments: {
        id: derivedActionId(input.id, "content"),
        workspaceId: input.workspaceId,
        links: input.links!.map((link) => ({
          url: link.url,
          ...(link.fields === undefined ? {} : { fields: { ...link.fields } }),
        })),
      },
      status: "ready",
      missingInputs: [],
    }];
  }
  if (input.inputMode === "api") {
    return [{
      tool: "ingest_temporary_api",
      description: "Import an owned or authorized, expiring JSON or CSV API response using a credential reference rather than plaintext credentials.",
      arguments: {
        id: derivedActionId(input.id, "api"),
        workspaceId: input.workspaceId,
        url: input.url!,
        ownership: input.ownership!,
        expiresAt: input.expiresAt!,
        ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
      },
      status: "ready",
      missingInputs: [],
    }];
  }
  return [];
}

async function datasetMetricActions(
  repos: Repositories,
  input: StartAnalysis & { inputMode: "dataset" },
): Promise<AnalysisRecommendedAction[]> {
  const dataset = await repos.datasets.get(input.referenceId!, input.workspaceId) as Dataset;
  const fields = Array.isArray(dataset.fieldDefinitions)
    ? dataset.fieldDefinitions.flatMap((field) =>
        field !== null && typeof field === "object" && !Array.isArray(field) &&
        typeof (field as { name?: unknown }).name === "string"
          ? [(field as { name: string }).name]
          : [])
    : [];
  const batch = dataset.ingestionBatchId === undefined
    ? undefined
    : await repos.ingestionBatches.get(dataset.ingestionBatchId, input.workspaceId) as
      IngestionBatch | undefined;
  const datasetIndex = batch?.datasetIds.indexOf(dataset.id) ?? -1;
  const evidence = batch && datasetIndex >= 0
    ? await repos.evidence.get(batch.evidenceIds[datasetIndex]!, input.workspaceId) as Evidence | undefined
    : undefined;
  const asset = evidence?.assets?.find((candidate) => candidate.kind === "normalized_jsonl");
  return Object.values(METRIC_CATALOG).flatMap((definition) => {
    if (!definition.monitoring.requiredFields.every((field) => fields.includes(field))) return [];
    const complete = batch && evidence && asset;
    return [{
      tool: "metric_compute",
      description: `Compute ${definition.id} from the imported normalized dataset; no custom formula is accepted.`,
      arguments: {
        id: input.id,
        workspaceId: input.workspaceId,
        expectedVersion: 1,
        datasetId: dataset.id,
        metricId: definition.id,
        ...(batch ? { batchId: batch.id } : {}),
        ...(evidence ? { evidenceId: evidence.id } : {}),
        ...(asset ? { assetId: asset.id } : {}),
      },
      status: complete ? "ready" as const : "requires_input" as const,
      missingInputs: complete ? [] : ["batchId", "evidenceId", "assetId"],
    }];
  });
}

function startGraph(
  input: StartAnalysis & { inputMode: NonNullable<StartAnalysis["inputMode"]> },
  timestamp: string,
  context: CommandContext,
  metricActions: AnalysisRecommendedAction[] = [],
): AnalysisGraph {
  const question: AnalysisGraphNode = {
    id: `${input.id}-question`,
    kind: "question",
    payload: {
      objective: input.objective,
      channel: input.channel ?? null,
      inputMode: input.inputMode,
      clarification: input.channel === undefined ? {
        question: "Which marketing channel should be prioritized?",
        required: false,
        default: "Continue with public cross-channel research",
      } : null,
    },
  };
  const branch: AnalysisGraphNode = input.inputMode === "dataset" ? {
    id: `${input.id}-dataset`,
    kind: "dataset",
    payload: { datasetId: input.referenceId!, status: "available" },
  } : input.inputMode === "api" ? {
    id: `${input.id}-dataset`,
    kind: "dataset",
    payload: { inputMode: "api", status: "ready_to_ingest" },
  } : {
    id: `${input.id}-research`,
    kind: "research",
    payload: {
      mode: input.inputMode === "links" ? "content_links" : "public_research",
      status: input.inputMode === "links" ? "ready_to_ingest" : "planned",
      researchCompleted: false,
    },
  };
  return createAnalysisGraph({
    id: input.id,
    workspaceId: input.workspaceId,
    createdAt: timestamp,
    nodes: [question, branch],
    edges: [{
      id: `${input.id}-edge-question-${branch.kind}`,
      fromNodeId: question.id,
      toNodeId: branch.id,
    }],
    recommendedActions: [...startActions(input), ...metricActions].map((action) =>
      bindStartActionContext(action, input.id, context)),
  });
}

export class AnalysisService {
  private readonly commands: CommandPipeline;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    ids: IdGenerator,
    private readonly artifacts?: ArtifactStore,
  ) {
    this.commands = new AuditableCommandPipeline(store, clock, ids);
  }

  start(command: Command<StartAnalysis>): Promise<AnalysisGraph> {
    const input = command.input;
    assertNonEmptyString(input.objective, "objective");
    if (input.channel !== undefined) assertNonEmptyString(input.channel, "channel");
    const inputMode = input.inputMode ?? "none";
    if (!(ANALYSIS_INPUT_MODES as readonly string[]).includes(inputMode)) {
      invalid("inputMode must be none, links, dataset, or api");
    }
    if (input.referenceId !== undefined) assertNonEmptyString(input.referenceId, "referenceId");
    if (inputMode === "dataset" && input.referenceId === undefined) {
      invalid("referenceId is required for dataset inputMode");
    }
    if (inputMode !== "dataset" && input.referenceId !== undefined) {
      invalid("referenceId is only supported for dataset inputMode");
    }

    let links: StartAnalysis["links"];
    if (inputMode === "links") {
      if (!Array.isArray(input.links) || input.links.length === 0 || input.links.length > 100) {
        invalid("links inputMode requires between 1 and 100 public links");
      }
      links = input.links.map((link) => {
        if (link === null || typeof link !== "object" || Array.isArray(link)) {
          invalid("links must contain objects with public URLs");
        }
        if (link.fields !== undefined &&
          (link.fields === null || typeof link.fields !== "object" || Array.isArray(link.fields) ||
            Object.values(link.fields).some((value) => typeof value !== "string" || value.length === 0))) {
          invalid("link fields must contain non-empty string selectors");
        }
        return {
          url: canonicalAcquisitionUrl(link.url),
          ...(link.fields === undefined ? {} : { fields: { ...link.fields } }),
        };
      });
    } else if (input.links !== undefined) {
      invalid("links are only supported for links inputMode");
    }

    let url: string | undefined;
    if (inputMode === "api") {
      if (input.url === undefined || input.ownership === undefined || input.expiresAt === undefined) {
        invalid("api inputMode requires url, ownership, and expiresAt");
      }
      if (input.ownership !== "owned" && input.ownership !== "authorized") {
        invalid("ownership must be owned or authorized");
      }
      assertNonEmptyString(input.expiresAt, "expiresAt");
      if (input.credentialRef !== undefined) assertNonEmptyString(input.credentialRef, "credentialRef");
      url = canonicalAcquisitionUrl(input.url);
      try {
        assertUtcInstant(input.expiresAt);
        if (input.credentialRef !== undefined) credentialEnvironmentVariable(input.credentialRef);
      } catch {
        invalid("expiresAt must be valid UTC and credentialRef must be an environment reference");
      }
      if (Date.parse(input.expiresAt) <= Date.parse(this.clock.now())) {
        invalid("expiresAt must be in the future");
      }
    } else if ([input.url, input.ownership, input.expiresAt, input.credentialRef]
      .some((value) => value !== undefined)) {
      invalid("url, ownership, expiresAt, and credentialRef are only supported for api inputMode");
    }

    const normalized = {
      ...input,
      objective: input.objective.trim(),
      ...(input.channel === undefined ? {} : { channel: input.channel.trim() }),
      ...(links === undefined ? {} : { links }),
      ...(url === undefined ? {} : { url }),
      inputMode,
    };

    return this.commands.execute({
      workspaceId: input.workspaceId,
      action: "analysis_graph.start",
      entityType: "analysis_graph",
      input: normalized,
      context: command.context,
      write: async (repos, current, timestamp) => {
        await requireWorkspace(repos, current.workspaceId);
        let metricActions: AnalysisRecommendedAction[] = [];
        if (current.inputMode === "dataset") {
          await requireReferences(repos, current.workspaceId, [{
            id: "dataset-reference",
            kind: "dataset",
            payload: { datasetId: current.referenceId! },
          }]);
          metricActions = await datasetMetricActions(repos, { ...current, inputMode: "dataset" });
        }
        return repos.analysisGraphs.insert(startGraph(current, timestamp, command.context, metricActions));
      },
    });
  }

  async get(query: GetAnalysisGraph): Promise<AnalysisGraph> {
    assertNonEmptyString(query.id, "id");
    assertNonEmptyString(query.workspaceId, "workspaceId");
    return this.store.transaction((repos) => requireGraph(repos, query.id, query.workspaceId));
  }

  computeMetric(command: Command<ComputeMetric>): Promise<AnalysisGraph> {
    const input = command.input;
    assertExpectedVersion(input.expectedVersion);
    for (const field of ["batchId", "datasetId", "evidenceId", "assetId"] as const) {
      assertNonEmptyString(input[field], field);
    }
    getMetricDefinition(input.metricId);
    if (!this.artifacts) {
      throw new Error("ArtifactStore is required for metric computation");
    }
    let prepared: PreparedMetric | undefined;
    return this.commands.executeBatch({
      workspaceId: input.workspaceId,
      action: "analysis_graph.compute_metric",
      entityType: "analysis_graph",
      input,
      context: command.context,
      write: async (repos, current, timestamp) => {
        if (!prepared) conflict("Metric artifact preparation did not complete");
        const descriptors = await loadMetricDescriptors(repos, current);
        assertCurrentMetricDescriptors(descriptors, prepared.descriptors);
        const datasetNode = descriptors.graph.nodes.find((node) =>
          node.kind === "dataset" && node.payload.datasetId === current.datasetId);
        if (!datasetNode) {
          invalid("The analysis graph must contain the metric dataset node");
        }
        const nodeId = metricNodeId(current);
        const remainingActions = descriptors.graph.recommendedActions.filter((action) => {
          const args = action.arguments;
          return action.tool !== "metric_compute" || args?.metricId !== current.metricId ||
            args.datasetId !== current.datasetId || args.evidenceId !== current.evidenceId ||
            args.assetId !== current.assetId || args.batchId !== current.batchId;
        });
        const recommendedActions = rebindGraphActions(
          [
            ...remainingActions,
            ...metricFollowupActions(
              current.id,
              current.workspaceId,
              current.expectedVersion + 1,
              nodeId,
            ),
          ],
          current.id,
          current.expectedVersion + 1,
        );
        const expanded = expandAnalysisGraph(descriptors.graph, {
          expectedVersion: current.expectedVersion,
          updatedAt: timestamp,
          nodes: [{
            id: nodeId,
            kind: "metric",
            payload: metricPayload(prepared, current),
          }],
          edges: [{
            id: `metric-edge-${nodeId.slice("metric-".length)}`,
            fromNodeId: datasetNode.id,
            toNodeId: nodeId,
          }],
          recommendedActions,
        });
        return repos.analysisGraphs.update(expanded, current.expectedVersion);
      },
    }, async () => {
      prepared = await readMetric(this.store, this.artifacts!, input);
    });
  }

  createMetricScenario(command: Command<CreateMetricScenario>): Promise<AnalysisGraph> {
    const input = command.input;
    assertExpectedVersion(input.expectedVersion);
    assertNonEmptyString(input.metricNodeId, "metricNodeId");
    return this.commands.execute({
      workspaceId: input.workspaceId,
      action: "analysis_graph.create_metric_scenario",
      entityType: "analysis_graph",
      input,
      context: command.context,
      write: async (repos, current, timestamp) => {
        const graph = await requireGraph(repos, current.id, current.workspaceId);
        if (graph.version !== current.expectedVersion) {
          throw new DomainError("CONFLICT", "Analysis graph version does not match expectedVersion");
        }
        const metricNode = requireMetricNode(graph, current.metricNodeId);
        const scenario = calculateMetricScenario(metricComputationFromNode(metricNode), current);
        const nodeId = derivedNodeId("scenario", [
          current.id,
          current.metricNodeId,
          current.targetValue,
          current.projectedDenominator,
          current.label,
        ]);
        const remainingActions = graph.recommendedActions.filter((action) =>
          action.tool !== "metric_scenario_create" ||
          action.arguments?.metricNodeId !== current.metricNodeId);
        const expanded = expandAnalysisGraph(graph, {
          expectedVersion: current.expectedVersion,
          updatedAt: timestamp,
          nodes: [{
            id: nodeId,
            kind: "scenario",
            payload: { ...scenario, metricNodeId: metricNode.id },
          }],
          edges: [{
            id: `scenario-edge-${nodeId.slice("scenario-".length)}`,
            fromNodeId: metricNode.id,
            toNodeId: nodeId,
          }],
          recommendedActions: rebindGraphActions(
            remainingActions,
            graph.id,
            graph.version + 1,
          ),
        });
        return repos.analysisGraphs.update(expanded, current.expectedVersion);
      },
    });
  }

  compareMetricMonitor(command: Command<CompareMetricMonitor>): Promise<AnalysisGraph> {
    const input = command.input;
    assertExpectedVersion(input.expectedVersion);
    assertNonEmptyString(input.baselineMetricNodeId, "baselineMetricNodeId");
    if (input.scenarioNodeId !== undefined) {
      assertNonEmptyString(input.scenarioNodeId, "scenarioNodeId");
    }
    for (const field of ["batchId", "datasetId", "evidenceId", "assetId"] as const) {
      assertNonEmptyString(input[field], field);
    }
    if (!this.artifacts) {
      throw new Error("ArtifactStore is required for metric monitoring");
    }
    let prepared: PreparedMetric | undefined;
    let baselineMetricId: ComputeMetric["metricId"] | undefined;
    return this.commands.executeBatch({
      workspaceId: input.workspaceId,
      action: "analysis_graph.compare_metric_monitor",
      entityType: "analysis_graph",
      input,
      context: command.context,
      write: async (repos, current, timestamp) => {
        if (!prepared || !baselineMetricId) {
          conflict("Metric monitor preparation did not complete");
        }
        const descriptors = await loadMetricDescriptors(repos, {
          ...current,
          metricId: baselineMetricId,
        });
        assertCurrentMetricDescriptors(descriptors, prepared.descriptors);
        const baselineNode = requireMetricNode(descriptors.graph, current.baselineMetricNodeId);
        const baseline = metricComputationFromNode(baselineNode);
        if (baseline.metricId !== baselineMetricId) {
          conflict("Baseline metric changed while current evidence was being read");
        }
        const nodeId = derivedNodeId("monitor", [
          current.id,
          current.baselineMetricNodeId,
          current.batchId,
          current.datasetId,
          current.evidenceId,
          current.assetId,
          current.scenarioNodeId ?? null,
          current.comparability ?? null,
        ]);
        const edges = [{
          id: `monitor-edge-baseline-${nodeId.slice("monitor-".length)}`,
          fromNodeId: baselineNode.id,
          toNodeId: nodeId,
        }];
        if (current.scenarioNodeId !== undefined) {
          const scenario = descriptors.graph.nodes.find((node) => node.id === current.scenarioNodeId);
          if (!scenario) {
            throw new DomainError("NOT_FOUND", "Scenario node not found in analysis graph", false, {
              id: current.id,
              nodeId: current.scenarioNodeId,
            });
          }
          if (scenario.kind !== "scenario") {
            invalid("scenarioNodeId must reference a Scenario node");
          }
          if (scenario.payload.metricNodeId !== baselineNode.id) {
            invalid("Scenario and monitor must reference the same baseline Metric node");
          }
        }
        if (current.scenarioNodeId !== undefined) {
          edges.push({
            id: `monitor-edge-scenario-${nodeId.slice("monitor-".length)}`,
            fromNodeId: current.scenarioNodeId,
            toNodeId: nodeId,
          });
        }
        const expanded = expandAnalysisGraph(descriptors.graph, {
          expectedVersion: current.expectedVersion,
          updatedAt: timestamp,
          nodes: [{
            id: nodeId,
            kind: "monitor",
            payload: monitorPayload(baselineNode, prepared, current),
          }],
          edges,
          recommendedActions: rebindGraphActions(
            descriptors.graph.recommendedActions,
            current.id,
            current.expectedVersion + 1,
          ),
        });
        return repos.analysisGraphs.update(expanded, current.expectedVersion);
      },
    }, async () => {
      const graph = await this.store.transaction((repos) =>
        requireGraph(repos, input.id, input.workspaceId));
      const baselineNode = requireMetricNode(graph, input.baselineMetricNodeId);
      baselineMetricId = metricComputationFromNode(baselineNode).metricId;
      prepared = await readMetric(this.store, this.artifacts!, {
        ...input,
        metricId: baselineMetricId,
      });
    });
  }

  expand(command: Command<ExpandAnalysisGraph>): Promise<AnalysisGraph> {
    const input = command.input;
    assertExpectedVersion(input.expectedVersion);
    if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
      invalid("nodes and edges must be arrays");
    }
    if (input.recommendedActions !== undefined && !Array.isArray(input.recommendedActions)) {
      invalid("recommendedActions must be an array");
    }
    return this.commands.execute({
      workspaceId: input.workspaceId,
      action: "analysis_graph.expand",
      entityType: "analysis_graph",
      input,
      context: command.context,
      write: async (repos, current, timestamp) => {
        const graph = await requireGraph(repos, current.id, current.workspaceId);
        const expanded = expandAnalysisGraph(graph, {
          expectedVersion: current.expectedVersion,
          updatedAt: timestamp,
          nodes: current.nodes,
          edges: current.edges,
          recommendedActions: rebindGraphActions(
            current.recommendedActions ?? graph.recommendedActions,
            graph.id,
            graph.version + 1,
          ),
        });
        await requireReferences(repos, current.workspaceId, current.nodes);
        return repos.analysisGraphs.update(expanded, current.expectedVersion);
      },
    });
  }

  fork(command: Command<ForkAnalysisGraph>): Promise<AnalysisGraph> {
    const input = command.input;
    assertNonEmptyString(input.parentGraphId, "parentGraphId");
    assertNonEmptyString(input.forkNodeId, "forkNodeId");
    assertExpectedVersion(input.expectedVersion);
    return this.commands.execute({
      workspaceId: input.workspaceId,
      action: "analysis_graph.fork",
      entityType: "analysis_graph",
      input,
      context: command.context,
      write: async (repos, current, timestamp) => {
        const parent = await requireGraph(repos, current.parentGraphId, current.workspaceId);
        if (parent.version !== current.expectedVersion) {
          throw new DomainError("CONFLICT", "Parent analysis graph version does not match expectedVersion", false, {
            id: parent.id,
          });
        }
        const fork = forkAnalysisGraph(parent, {
          id: current.id,
          forkNodeId: current.forkNodeId,
          createdAt: timestamp,
        });
        fork.recommendedActions = rebindGraphActions(fork.recommendedActions, fork.id, fork.version, true);
        return repos.analysisGraphs.insert(fork);
      },
    });
  }
}

function capability(
  value: Omit<AnalysisCapability, "configuration" | "fallback" | "limitations"> &
    Partial<Pick<AnalysisCapability, "configuration" | "fallback" | "limitations">>,
): AnalysisCapability {
  return {
    configuration: [],
    fallback: [],
    limitations: [],
    ...value,
  };
}

export class AnalysisCapabilityService {
  list(): AnalysisCapability[] {
    return [
      capability({
        id: "analysis.start",
        operation: "marketing_analysis_start",
        description: "Create a versioned analysis question and a guidance-only branch for an optional input mode.",
        requiredInputs: ["id", "workspaceId", "objective", "actor", "requestId", "idempotencyKey"],
        configuration: ["channel (optional)", "inputMode=none|links|dataset|api (default none)", "referenceId for dataset mode", "links for links mode", "url, ownership, expiresAt, and optional credentialRef for api mode"],
        availability: { state: "available", detail: "Creates graph state only; it does not run research or import data." },
        limitations: ["No business data is required for none mode.", "No metric, scenario, monitor, or research result is produced by start."],
      }),
      capability({
        id: "analysis.get",
        operation: "analysis_graph_get",
        description: "Read a persisted analysis graph by workspace and graph ID.",
        requiredInputs: ["id", "workspaceId"],
        availability: { state: "available", detail: "Reads SQLite graph state without reading evidence artifacts." },
        limitations: ["Workspace-scoped IDs are required."],
      }),
      capability({
        id: "analysis.expand",
        operation: "analysis_graph_expand",
        description: "Atomically append controlled nodes and directed edges after any existing graph node.",
        requiredInputs: ["id", "workspaceId", "expectedVersion", "nodes", "edges", "actor", "requestId", "idempotencyKey"],
        availability: { state: "available", detail: "Uses optimistic graph versions and validates node references." },
        limitations: ["Graphs must remain acyclic with unique IDs and no orphan edges.", "No branch merge is provided."],
      }),
      capability({
        id: "analysis.fork",
        operation: "analysis_graph_fork",
        description: "Deep-copy a graph while recording its parent graph, parent version, and fork node.",
        requiredInputs: ["id", "workspaceId", "parentGraphId", "expectedVersion", "forkNodeId", "actor", "requestId", "idempotencyKey"],
        availability: { state: "available", detail: "Creates an independent graph and leaves the parent unchanged." },
        limitations: ["No branch merge is provided."],
      }),
      capability({
        id: "metric.compute",
        operation: "metric_compute",
        description: "Compute a controlled metric from same-batch normalized evidence and atomically append its graph node.",
        requiredInputs: ["id", "workspaceId", "expectedVersion", "batchId", "datasetId", "evidenceId", "assetId", "metricId", "actor", "requestId", "idempotencyKey"],
        configuration: ["ctr_v1", "save_like_ratio_v1", "ArtifactStore with content-addressed normalized_jsonl and quality_report assets"],
        availability: { state: "available", detail: "Reads verified artifacts outside SQLite write transactions and rechecks entity versions before commit." },
        limitations: ["Only the controlled formulas are implemented.", "A zero denominator returns unknown.", "No MCP registration is provided by this service."],
      }),
      capability({
        id: "metric.scenario",
        operation: "metric_scenario_create",
        description: "Create a labeled conditional scenario from a Metric node in the same analysis graph.",
        requiredInputs: ["id", "workspaceId", "expectedVersion", "metricNodeId", "targetValue", "projectedDenominator", "label", "actor", "requestId", "idempotencyKey"],
        configuration: ["conservative, base, or optimistic label", "Finite non-negative target and projected denominator"],
        availability: { state: "available", detail: "Returns conditional absolute, relative, and projected numerator arithmetic." },
        limitations: ["A zero baseline has null relative change.", "Unknown baselines remain unknown.", "No causal or commercial-outcome promise is made."],
      }),
      capability({
        id: "metric.monitor",
        operation: "metric_monitor_compare",
        description: "Recompute the baseline definition from a new same-batch verified snapshot and compare value, reference, and sample changes.",
        requiredInputs: ["id", "workspaceId", "expectedVersion", "baselineMetricNodeId", "batchId", "datasetId", "evidenceId", "assetId", "actor", "requestId", "idempotencyKey"],
        configuration: ["Optional same-graph scenarioNodeId", "Catalog required fields, minimumDenominator, guardrails, and reviewConditions are returned"],
        availability: { state: "available", detail: "Runs one explicit comparison; automatic scheduling is not provided." },
        limitations: ["Unknown baseline or current values keep deltas unknown.", "Observed changes do not establish causality.", "No scheduler or recurring monitor is created."],
      }),
      capability({
        id: "host.search",
        operation: "host-provided WebSearch or equivalent",
        description: "Discover current public sources through tools supplied by the host agent.",
        requiredInputs: ["Search query"],
        configuration: ["A host search tool must actually be exposed by the host."],
        availability: { state: "host_provided", detail: "Optional host capability; this MCP server is not a general search engine." },
        fallback: ["research_session_create with known seed URLs"],
        limitations: ["Availability and result quality depend on the host.", "Search results are not yet persisted research evidence."],
      }),
      capability({
        id: "research.scoped",
        operation: "research_session_create / research_session_run",
        description: "Acquire public pages within explicit host, path, depth, page, duration, and byte boundaries.",
        requiredInputs: ["goal", "seed URLs", "scope", "expansion choice", "actor", "requestId", "idempotencyKey"],
        configuration: ["Expansion requires explicit permission.", "Browser acquisition uses its configured fallback chain."],
        availability: { state: "available", detail: "Runs only when the separate research commands are invoked." },
        fallback: ["ingest_content_links for individual known public URLs", "host-provided search for source discovery"],
        limitations: ["Not general web search.", "Public observations do not establish CTR, conversion, or causality."],
      }),
      capability({
        id: "ingest.links",
        operation: "ingest_content_links",
        description: "Acquire known public content links and persist provenance-linked page evidence.",
        requiredInputs: ["id", "workspaceId", "links", "actor", "requestId", "idempotencyKey"],
        configuration: ["Optional field selectors", "Configured browser acquisition providers"],
        availability: { state: "available", detail: "Uses the existing content-link acquisition service." },
        fallback: ["research.scoped for bounded multi-page acquisition"],
        limitations: ["Public pages may be inaccessible or lack structured fields.", "No social-platform login or private connector is implied."],
      }),
      capability({
        id: "ingest.files",
        operation: "ingest_files",
        description: "Import CSV or XLSX snapshots into datasets, evidence, and quality reports.",
        requiredInputs: ["id", "workspaceId", "paths", "actor", "requestId", "idempotencyKey"],
        configuration: ["MARKETING_IMPORT_ROOT", "Optional bounded ingestion limits"],
        availability: { state: "available", detail: "Uses local snapshots inside the configured import root." },
        fallback: ["ingest_temporary_api for an authorized JSON or CSV response"],
        limitations: ["Files are not required for no-data analysis.", "Existing row, column, file, and byte limits apply."],
      }),
      capability({
        id: "ingest.temporary_api",
        operation: "ingest_temporary_api",
        description: "Import a temporary owned or authorized JSON or CSV API response.",
        requiredInputs: ["id", "workspaceId", "url", "ownership", "expiresAt", "actor", "requestId", "idempotencyKey"],
        configuration: ["Optional credential reference to an allowlisted environment variable", "Network allowlist and ingestion limits"],
        availability: { state: "available", detail: "Supports temporary snapshots, not persistent platform integration." },
        fallback: ["ingest_files with an exported snapshot"],
        limitations: ["Plaintext credentials are rejected.", "Only JSON arrays of flat objects or CSV are supported.", "No OAuth or live connector is installed."],
      }),
      capability({
        id: "connectors.live",
        operation: "No live-connector operation is registered",
        description: "Placeholder describing the absence of persistent marketing-platform connectors.",
        requiredInputs: [],
        availability: { state: "not_installed", detail: "No OAuth, account sync, or live platform connector is installed or health-checked." },
        fallback: ["ingest.files", "ingest.temporary_api", "ingest.links"],
        limitations: ["Do not claim account access, live metrics, publishing, or scheduled synchronization."],
      }),
    ];
  }
}

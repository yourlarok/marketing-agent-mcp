import type {
  AnalysisGraph,
  AnalysisGraphNode,
  AnalysisPayload,
} from "../domain/analysis-model.js";
import {
  MAX_DASHBOARD_ARTIFACT_BYTES,
  MAX_DASHBOARD_DATA_PER_VIEW,
  createDashboardView,
  type ControlledDashboardRenderResult,
  type DashboardAnalysisGraphRef,
  type DashboardDatum,
  type DashboardDatumBase,
  type DashboardDatasetDescriptor,
  type DashboardEntityVersionRef,
  type DashboardEvidenceDescriptor,
  type DashboardManifest,
  type DashboardManifestView,
  type DashboardMetricDescriptor,
  type DashboardReason,
  type DashboardSnapshot,
  type DashboardSourceDescriptor,
  type DashboardView,
  type DashboardViewInput,
  type DashboardViewStatus,
} from "../domain/dashboard-model.js";
import { DomainError } from "../domain/errors.js";
import type { MetricId } from "../domain/metric-catalog.js";
import type { RecommendationExpectedMetric } from "../domain/strategy-model.js";
import { canonicalJson } from "./sqlite.js";

export {
  MAX_DASHBOARD_ARTIFACT_BYTES,
  MAX_DASHBOARD_DATA_PER_VIEW,
} from "../domain/dashboard-model.js";
export type {
  ControlledDashboardRenderResult,
  DashboardManifest,
  DashboardSnapshot,
} from "../domain/dashboard-model.js";

const RENDERER = {
  type: "controlled_renderer",
  id: "controlled_html_svg_v1",
  professionalTool: false,
} as const;

type ViewInput<Kind extends DashboardViewInput["kind"]> =
  DashboardViewInput extends infer Candidate
    ? Candidate extends { kind: Kind } ? Candidate : never
    : never;

interface BuildResult {
  data: DashboardDatum[];
  reasons: DashboardReason[];
  datasetIds: string[];
  evidenceIds: string[];
  analysisGraphRefs: DashboardAnalysisGraphRef[];
  metrics: DashboardMetricDescriptor[];
  forceUnverifiable?: boolean;
}

interface BuiltView {
  view: DashboardManifestView;
  datasetIds: string[];
  evidenceIds: string[];
}

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

function conflict(message: string): never {
  throw new DomainError("CONFLICT", message);
}

function notFound(message: string): never {
  throw new DomainError("NOT_FOUND", message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${label} must be a string`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${label} must be finite`);
  return value;
}

function nullableFinite(value: unknown, label: string): number | null {
  return value === null ? null : finite(value, label);
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalid(`${label} must be a string array`);
  }
  return value as string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueReasons(reasons: DashboardReason[]): DashboardReason[] {
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    const key = JSON.stringify([reason.code, reason.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reason(code: string, message = code): DashboardReason {
  return { code, message };
}

function graph(snapshot: DashboardSnapshot, id: string): AnalysisGraph {
  return snapshot.graphs.find((candidate) => candidate.id === id) ??
    notFound("Dashboard analysis graph not found in snapshot");
}

function node(graphRecord: AnalysisGraph, id: string): AnalysisGraphNode {
  return graphRecord.nodes.find((candidate) => candidate.id === id) ??
    notFound("Dashboard analysis node not found in snapshot");
}

function graphRef(graphRecord: AnalysisGraph, graphNode: AnalysisGraphNode): DashboardAnalysisGraphRef {
  return {
    graphId: graphRecord.id,
    graphVersion: graphRecord.version,
    nodeId: graphNode.id,
    kind: graphNode.kind,
  };
}

function mergeGraphRefs(refs: DashboardAnalysisGraphRef[]): DashboardAnalysisGraphRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = JSON.stringify([ref.graphId, ref.nodeId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nestedPayload(payload: AnalysisPayload, key: string): AnalysisPayload | undefined {
  const value = payload[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as AnalysisPayload
    : undefined;
}

function referenceIds(payload: AnalysisPayload): { datasetIds: string[]; evidenceIds: string[] } {
  const datasetIds: string[] = [];
  const evidenceIds: string[] = [];
  for (const candidate of [payload, nestedPayload(payload, "provenance"), nestedPayload(payload, "current")]) {
    if (!candidate) continue;
    if (typeof candidate.datasetId === "string") datasetIds.push(candidate.datasetId);
    if (typeof candidate.evidenceId === "string") evidenceIds.push(candidate.evidenceId);
  }
  return { datasetIds: unique(datasetIds), evidenceIds: unique(evidenceIds) };
}

function sourceDescriptor(snapshot: DashboardSnapshot, sourceId: string): DashboardSourceDescriptor {
  const source = snapshot.sources.find((candidate) => candidate.id === sourceId) ??
    notFound("Dashboard Source not found in snapshot");
  return {
    sourceId: source.id,
    updatedAt: source.updatedAt,
    name: source.name,
    type: source.type,
    ownership: source.ownership,
  };
}

function datasetDescriptor(snapshot: DashboardSnapshot, datasetId: string): DashboardDatasetDescriptor {
  const dataset = snapshot.datasets.find((candidate) => candidate.id === datasetId) ??
    notFound("Dashboard Dataset not found in snapshot");
  return {
    datasetId: dataset.id,
    version: dataset.version,
    sourceId: dataset.sourceId,
    name: dataset.name,
    coverageStart: dataset.coverageStart,
    coverageEnd: dataset.coverageEnd,
    updatedAt: dataset.updatedAt,
  };
}

function evidenceDescriptor(snapshot: DashboardSnapshot, evidenceId: string): DashboardEvidenceDescriptor {
  const evidence = snapshot.evidence.find((candidate) => candidate.id === evidenceId) ??
    notFound("Dashboard Evidence not found in snapshot");
  return {
    evidenceId: evidence.id,
    version: evidence.version,
    sourceId: evidence.sourceId,
    observedAt: evidence.observedAt,
    contentHash: evidence.contentHash,
    classification: evidence.classification,
    assets: (evidence.assets ?? []).map((asset) => ({ ...asset })),
    updatedAt: evidence.updatedAt,
  };
}

function datumBase(
  snapshot: DashboardSnapshot,
  datumId: string,
  status: "ok" | "unknown",
  reasons: DashboardReason[],
  refs: { datasetIds: string[]; evidenceIds: string[] },
  analysisGraphRefs: DashboardAnalysisGraphRef[],
): DashboardDatumBase {
  const datasetIds = unique(refs.datasetIds);
  const evidenceIds = unique(refs.evidenceIds);
  return {
    datumId,
    status,
    reasons,
    datasetIds,
    evidenceIds,
    analysisGraphRefs: mergeGraphRefs(analysisGraphRefs),
    datasets: datasetIds.map((id) => datasetDescriptor(snapshot, id)),
    evidence: evidenceIds.map((id) => evidenceDescriptor(snapshot, id)),
  };
}

type DatumBase = ReturnType<typeof datumBase>;

function analyticsProvenance(payload: AnalysisPayload) {
  const provenance = object(payload.provenance, "Analytics provenance");
  return {
    provider: text(provenance.provider, "Analytics provider"),
    tool: text(provenance.tool, "Analytics tool"),
    toolVersion: text(provenance.toolVersion, "Analytics toolVersion"),
    inputHash: text(provenance.inputHash, "Analytics inputHash"),
    rowCount: finite(provenance.rowCount, "Analytics rowCount"),
  };
}

function buildTrend(snapshot: DashboardSnapshot, input: ViewInput< "trend">): BuildResult {
  const graphRecord = graph(snapshot, input.graphId);
  const data: DashboardDatum[] = [];
  const reasons: DashboardReason[] = [];
  const datasetIds: string[] = [];
  const evidenceIds: string[] = [];
  const analysisGraphRefs: DashboardAnalysisGraphRef[] = [];
  for (const nodeId of input.nodeIds) {
    const graphNode = node(graphRecord, nodeId);
    if (graphNode.kind !== "analytics" || graphNode.payload.operation !== "trend_v1") {
      invalid("Trend views require analytics nodes with operation=trend_v1");
    }
    const payload = graphNode.payload;
    const refs = referenceIds(payload);
    datasetIds.push(...refs.datasetIds);
    evidenceIds.push(...refs.evidenceIds);
    analysisGraphRefs.push(graphRef(graphRecord, graphNode));
    if (payload.status === "unknown") {
      reasons.push(reason(text(payload.unknownReason, "Trend unknownReason")));
      continue;
    }
    if (payload.status !== "ok" || !Array.isArray(payload.points)) invalid("Trend result is invalid");
    if (payload.missingWindows !== undefined && stringArray(payload.missingWindows, "Trend missingWindows").length > 0) {
      reasons.push(reason("MISSING_WINDOWS", "One or more windows have no observed rows."));
    }
    const coverage = finite(payload.coverage, "Trend coverage");
    const formula = text(payload.formula, "Trend formula");
    const definitionVersion = finite(payload.definitionVersion, "Trend definitionVersion");
    const provenance = analyticsProvenance(payload);
    for (const [index, value] of payload.points.entries()) {
      const point = object(value, "Trend point");
      const pointValue = nullableFinite(point.value, "Trend point value");
      const pointReasons = pointValue === null ? [reason("MISSING_WINDOW", "This window has no observed rows.")] : [];
      data.push({
        ...datumBase(snapshot, `${graphNode.id}/point/${index}`, pointValue === null ? "unknown" : "ok", pointReasons, refs, [graphRef(graphRecord, graphNode)]),
        kind: "trend_point",
        window: text(point.window, "Trend window"),
        value: pointValue,
        rowCount: finite(point.rowCount, "Trend rowCount"),
        coverage,
        formula,
        definitionVersion,
        provenance,
      });
    }
  }
  return { data, reasons, datasetIds, evidenceIds, analysisGraphRefs, metrics: [] };
}

function buildStructure(snapshot: DashboardSnapshot, input: ViewInput< "structure">): BuildResult {
  const graphRecord = graph(snapshot, input.graphId);
  const data: DashboardDatum[] = [];
  const reasons: DashboardReason[] = [];
  const datasetIds: string[] = [];
  const evidenceIds: string[] = [];
  const analysisGraphRefs: DashboardAnalysisGraphRef[] = [];
  let expected: { metricId: MetricId; definitionVersion: number } | undefined;
  let forceUnverifiable = false;
  for (const nodeId of input.nodeIds) {
    const graphNode = node(graphRecord, nodeId);
    if (graphNode.kind !== "metric") invalid("Structure views require Metric nodes");
    const payload = graphNode.payload;
    const metricId = text(payload.metricId, "Metric ID") as MetricId;
    const definitionVersion = finite(payload.definitionVersion, "Metric definitionVersion");
    if (expected && (expected.metricId !== metricId || expected.definitionVersion !== definitionVersion)) {
      invalid("Structure views require the same metricId and definitionVersion");
    }
    expected = { metricId, definitionVersion };
    const refs = referenceIds(payload);
    datasetIds.push(...refs.datasetIds);
    evidenceIds.push(...refs.evidenceIds);
    analysisGraphRefs.push(graphRef(graphRecord, graphNode));
    const reference = payload.referenceAssessment === undefined ? undefined : object(payload.referenceAssessment, "Metric referenceAssessment");
    const referenceReasonValues = reference?.reasons;
    const referenceReasons = Array.isArray(referenceReasonValues) ? referenceReasonValues.map((value) => {
      const item = object(value, "Metric reference reason");
      return reason(text(item.code, "Metric reference reason code"), text(item.message, "Metric reference reason message"));
    }) : [];
    if (referenceReasons.some((item) => item.code === "COMPARABILITY_NOT_COMPARABLE")) {
      forceUnverifiable = true;
      reasons.push(...referenceReasons.filter((item) => item.code === "COMPARABILITY_NOT_COMPARABLE"));
    }
    const value = nullableFinite(payload.value, "Metric value");
    const unknownReason = nullableText(payload.unknownReason, "Metric unknownReason");
    if (payload.status === "unknown" || unknownReason !== null) reasons.push(reason(unknownReason ?? "METRIC_UNKNOWN"));
    data.push({
      ...datumBase(snapshot, graphNode.id, payload.status === "ok" && value !== null ? "ok" : "unknown", unknownReason === null ? [] : [reason(unknownReason)], refs, [graphRef(graphRecord, graphNode)]),
      kind: "metric_category",
      category: graphNode.id,
      metricId,
      definitionVersion,
      formula: text(payload.formula, "Metric formula"),
      value,
      unknownReason,
    });
  }
  const metrics = expected ? [{
    metricId: expected.metricId,
    definitionVersion: expected.definitionVersion,
    formula: text(node(graphRecord, input.nodeIds[0]!).payload.formula, "Metric formula"),
  }] : [];
  return { data, reasons, datasetIds, evidenceIds, analysisGraphRefs, metrics, forceUnverifiable };
}

function buildFunnel(snapshot: DashboardSnapshot, input: ViewInput< "funnel">): BuildResult {
  if (input.nodeIds.length !== 1) invalid("Funnel views require exactly one analytics node");
  const graphRecord = graph(snapshot, input.graphId);
  const graphNode = node(graphRecord, input.nodeIds[0]!);
  if (graphNode.kind !== "analytics" || graphNode.payload.operation !== "funnel_v1") {
    invalid("Funnel views require an analytics node with operation=funnel_v1");
  }
  const payload = graphNode.payload;
  if (!Array.isArray(payload.stages)) invalid("Funnel stages must be an array");
  const refs = referenceIds(payload);
  const reasons: DashboardReason[] = [];
  const overallConversion = nullableFinite(payload.overallConversion, "Funnel overallConversion");
  const overallUnknownReason = nullableText(payload.overallUnknownReason, "Funnel overallUnknownReason");
  if (overallUnknownReason) reasons.push(reason(overallUnknownReason));
  const formula = text(payload.formula, "Funnel formula");
  const definitionVersion = finite(payload.definitionVersion, "Funnel definitionVersion");
  const data = payload.stages.map((value, index): DashboardDatum => {
    const stage = object(value, "Funnel stage");
    const conversionUnknownReason = nullableText(stage.conversionUnknownReason, "Funnel conversionUnknownReason");
    const datumReasons = conversionUnknownReason ? [reason(conversionUnknownReason)] : [];
    reasons.push(...datumReasons);
    return {
      ...datumBase(snapshot, `${graphNode.id}/stage/${index}`, "ok", datumReasons, refs, [graphRef(graphRecord, graphNode)]),
      kind: "funnel_stage",
      stageIndex: index,
      field: text(stage.field, "Funnel field"),
      total: finite(stage.total, "Funnel total"),
      conversionFromPrevious: nullableFinite(stage.conversionFromPrevious, "Funnel conversionFromPrevious"),
      conversionUnknownReason,
      overallConversion,
      overallUnknownReason,
      formula,
      definitionVersion,
    };
  });
  return {
    data,
    reasons,
    datasetIds: refs.datasetIds,
    evidenceIds: refs.evidenceIds,
    analysisGraphRefs: [graphRef(graphRecord, graphNode)],
    metrics: [],
  };
}

function buildCompetitor(snapshot: DashboardSnapshot, input: ViewInput< "competitor_comparison">): BuildResult {
  const diff = snapshot.competitorDiffs.find((candidate) => candidate.id === input.competitorDiffId) ??
    notFound("CompetitorDiff not found in snapshot");
  const reasons: DashboardReason[] = [];
  if (diff.entries.length === 0) reasons.push(reason("COMPETITOR_DIFF_UNKNOWN"));
  const data = diff.entries.map((entry, index): DashboardDatum => {
    const datumReasons = entry.result === "unknown" ? [reason("COMPETITOR_DIFF_UNKNOWN")] : [];
    reasons.push(...datumReasons);
    return {
      ...datumBase(snapshot, `${diff.id}/entry/${index}`, entry.result === "unknown" ? "unknown" : "ok", datumReasons, { datasetIds: [], evidenceIds: entry.evidenceIds }, []),
      kind: "competitor_entry",
      competitorDiffId: diff.id,
      dimension: entry.dimension,
      result: entry.result,
    };
  });
  return {
    data,
    reasons,
    datasetIds: [],
    evidenceIds: diff.entries.flatMap((entry) => entry.evidenceIds),
    analysisGraphRefs: [],
    metrics: [],
  };
}

function expectedBaseline(graphRecord: AnalysisGraph, expected: RecommendationExpectedMetric): string | undefined {
  if (expected.acceptance === "establish_baseline") return expected.baselineMetricNodeId;
  const scenarioNodeId = expected.scenarioNodeId;
  if (!scenarioNodeId) return undefined;
  const scenario = graphRecord.nodes.find((candidate) => candidate.id === scenarioNodeId && candidate.kind === "scenario");
  return typeof scenario?.payload.metricNodeId === "string" ? scenario.payload.metricNodeId : undefined;
}

function monitorMatches(
  graphNode: AnalysisGraphNode,
  expected: RecommendationExpectedMetric,
  baselineNodeId: string,
): boolean {
  const payload = graphNode.payload;
  return graphNode.kind === "monitor" &&
    payload.metricId === expected.metricId &&
    payload.definitionVersion !== undefined &&
    payload.baselineMetricNodeId === baselineNodeId &&
    (expected.acceptance === "establish_baseline" || payload.scenarioNodeId === expected.scenarioNodeId);
}

function buildTask(snapshot: DashboardSnapshot, input: ViewInput< "task_effect">): BuildResult {
  const graphRecord = graph(snapshot, input.graphId);
  const data: DashboardDatum[] = [];
  const reasons: DashboardReason[] = [];
  const datasetIds: string[] = [];
  const evidenceIds: string[] = [];
  const analysisGraphRefs: DashboardAnalysisGraphRef[] = [];
  const metrics: DashboardMetricDescriptor[] = [];
  if (input.taskIds.length === 0) {
    return {
      data,
      reasons: [reason("TASK_NOT_LINKED", "No task is linked to this task-effect view.")],
      datasetIds,
      evidenceIds,
      analysisGraphRefs,
      metrics,
      forceUnverifiable: true,
    };
  }
  const selectedMonitors = input.monitorNodeIds.map((id) => {
    const graphNode = node(graphRecord, id);
    if (graphNode.kind !== "monitor") invalid("Task-effect monitorNodeIds must reference Monitor nodes");
    return graphNode;
  });
  for (const taskId of input.taskIds) {
    const task = snapshot.tasks.find((candidate) => candidate.id === taskId) ?? notFound("Task not found in snapshot");
    if (task.state !== "completed") {
      reasons.push(reason("TASK_NOT_COMPLETED"));
      continue;
    }
    const recommendations = task.recommendationIds.map((id) =>
      snapshot.recommendations.find((candidate) => candidate.id === id) ??
      notFound("Task Recommendation not found in snapshot"));
    if (recommendations.length === 0 || recommendations.every((recommendation) => !recommendation.expectedMetrics?.length)) {
      reasons.push(reason("TASK_STRATEGY_METADATA_MISSING"));
      continue;
    }
    for (const recommendation of recommendations) {
      if (!recommendation.expectedMetrics?.length) {
        reasons.push(reason("TASK_STRATEGY_METADATA_MISSING"));
        continue;
      }
      for (const [expectedMetricIndex, expected] of recommendation.expectedMetrics.entries()) {
        const baselineNodeId = expectedBaseline(graphRecord, expected);
        if (!baselineNodeId || !graphRecord.nodes.some((candidate) => candidate.id === baselineNodeId && candidate.kind === "metric")) {
          reasons.push(reason("RECOMMENDATION_METRIC_NOT_LINKED"));
          continue;
        }
        const monitor = selectedMonitors.find((candidate) => monitorMatches(candidate, expected, baselineNodeId));
        if (!monitor) {
          reasons.push(reason("MONITOR_NOT_LINKED"));
          continue;
        }
        const baselineNode = node(graphRecord, baselineNodeId);
        const payload = monitor.payload;
        const definitionVersion = finite(payload.definitionVersion, "Monitor definitionVersion");
        if (baselineNode.payload.metricId !== expected.metricId || baselineNode.payload.definitionVersion !== definitionVersion) {
          reasons.push(reason("RECOMMENDATION_METRIC_NOT_LINKED"));
          continue;
        }
        const current = object(payload.current, "Monitor current");
        const baseline = object(payload.baseline, "Monitor baseline");
        const refs = referenceIds(payload);
        const baselineRefs = referenceIds(baselineNode.payload);
        refs.datasetIds.push(...baselineRefs.datasetIds);
        refs.evidenceIds.push(...baselineRefs.evidenceIds);
        datasetIds.push(...refs.datasetIds);
        evidenceIds.push(...refs.evidenceIds);
        analysisGraphRefs.push(graphRef(graphRecord, monitor), graphRef(graphRecord, baselineNode));
        const baselineValue = nullableFinite(baseline.value, "Monitor baseline value");
        const currentValue = nullableFinite(current.value, "Monitor current value");
        const absoluteDelta = nullableFinite(payload.absoluteDelta, "Monitor absoluteDelta");
        const relativeDelta = nullableFinite(payload.relativeDelta, "Monitor relativeDelta");
        const comparisonUnknownReason = nullableText(payload.comparisonUnknownReason, "Monitor comparisonUnknownReason");
        const relativeDeltaUnknownReason = nullableText(payload.relativeDeltaUnknownReason, "Monitor relativeDeltaUnknownReason");
        const datumReasons = uniqueReasons([
          ...(comparisonUnknownReason ? [reason(comparisonUnknownReason)] : []),
          ...(relativeDeltaUnknownReason ? [reason(relativeDeltaUnknownReason)] : []),
        ]);
        reasons.push(...datumReasons);
        const usable = payload.status === "ok" && baselineValue !== null && currentValue !== null && absoluteDelta !== null;
        const formula = text(payload.formula, "Monitor formula");
        metrics.push({ metricId: expected.metricId, definitionVersion, formula });
        data.push({
          ...datumBase(snapshot, `${task.id}/${recommendation.id}/${expectedMetricIndex}/${monitor.id}`, usable ? "ok" : "unknown", datumReasons, refs, [graphRef(graphRecord, monitor), graphRef(graphRecord, baselineNode)]),
          kind: "task_observation",
          taskId: task.id,
          monitorNodeId: monitor.id,
          metricId: expected.metricId,
          definitionVersion,
          formula,
          baselineValue,
          currentValue,
          absoluteDelta,
          relativeDelta,
          comparisonUnknownReason,
          relativeDeltaUnknownReason,
          interpretation: "observed_change_not_causal",
        });
      }
    }
  }
  return { data, reasons, datasetIds, evidenceIds, analysisGraphRefs, metrics };
}

function viewStatus(build: BuildResult): DashboardViewStatus {
  if (build.forceUnverifiable) return "unverifiable";
  const usable = build.data.filter((datum) => datum.status === "ok").length;
  if (usable === 0) return "unverifiable";
  if (usable < build.data.length || build.reasons.length > 0) return "partial";
  return "ok";
}

function finalizeView(snapshot: DashboardSnapshot, input: DashboardViewInput, build: BuildResult): BuiltView {
  if (build.data.length > MAX_DASHBOARD_DATA_PER_VIEW) conflict("Dashboard view data exceeds the controlled limit");
  const datasetIds = unique(build.datasetIds);
  const evidenceIds = unique(build.evidenceIds);
  const datasets = datasetIds.map((id) => datasetDescriptor(snapshot, id));
  const evidence = evidenceIds.map((id) => evidenceDescriptor(snapshot, id));
  const sourceIds = unique([...datasets.map((item) => item.sourceId), ...evidence.map((item) => item.sourceId)]);
  const sources = sourceIds.map((id) => sourceDescriptor(snapshot, id));
  const sourceUpdatedAt = sources.length === 0 ? snapshot.generatedAt : sources.reduce(
    (latest, source) => source.updatedAt > latest ? source.updatedAt : latest,
    sources[0]!.updatedAt,
  );
  const dataAsOf = evidence.length === 0 ? null : evidence.reduce((latest, item) => item.observedAt > latest ? item.observedAt : latest, evidence[0]!.observedAt);
  const reasons = uniqueReasons(build.reasons).slice(0, 100);
  const metrics = build.metrics.filter((metric, index, all) => all.findIndex((candidate) => candidate.metricId === metric.metricId) === index);
  const view = createDashboardView({
    ...input,
    status: viewStatus(build),
    reasons,
    dataAsOf,
    sourceUpdatedAt,
    sources,
    metrics,
  } as Parameters<typeof createDashboardView>[0]) as DashboardManifestView;
  view.data = build.data;
  return { view, datasetIds, evidenceIds };
}

function escape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function display(value: unknown): string {
  return value === null ? "不可验证" : typeof value === "object" ? canonicalJson(value) : String(value);
}

function datumLabel(datum: DashboardDatum): string {
  switch (datum.kind) {
    case "trend_point": return `${datum.window}: ${display(datum.value)} (rows=${datum.rowCount}, coverage=${datum.coverage})`;
    case "metric_category": return `${datum.category} ${datum.metricId}: ${display(datum.value)}`;
    case "funnel_stage": return `${datum.field}: total=${datum.total}, previous=${display(datum.conversionFromPrevious)}, overall=${display(datum.overallConversion)}`;
    case "competitor_entry": return `${datum.dimension}: ${datum.result}`;
    case "task_observation": return `${datum.taskId} ${datum.metricId}: baseline=${display(datum.baselineValue)}, current=${display(datum.currentValue)}, absolute=${display(datum.absoluteDelta)}, relative=${display(datum.relativeDelta)}, observed_change_not_causal`;
  }
}

function datumWidth(datum: DashboardDatum): number {
  let value = 0;
  if (datum.kind === "trend_point") value = Math.abs(datum.value ?? 0);
  else if (datum.kind === "metric_category") value = Math.abs(datum.value ?? 0);
  else if (datum.kind === "funnel_stage") value = Math.abs(datum.total);
  else if (datum.kind === "task_observation") value = Math.abs(datum.currentValue ?? 0);
  else value = datum.result === "different" ? 1 : datum.result === "same" ? 0.6 : 0.2;
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0.02, value)) * 500 * 100) / 100;
}

function renderView(snapshot: DashboardSnapshot, view: DashboardManifestView): string {
  const reasons = view.reasons.map((item) => `${item.code}: ${item.message}`).join("; ");
  const sources = view.sources.map((source) => `${source.name} (${source.sourceId}, ${source.ownership}, ${source.updatedAt})`).join("; ") || "无";
  const metrics = view.metrics.map((metric) => `${metric.metricId} v${metric.definitionVersion}: ${metric.formula}`).join("; ") || "见各 datum 公式";
  const height = Math.max(180, 100 + view.data.length * 48);
  const parts = [
    `<section id="section-${escape(view.id)}"><h2>${escape(view.kind)}</h2>`,
    `<p>状态: ${escape(view.status)}${view.status === "ok" ? "" : `；不可验证/部分不可验证 ${escape(reasons)}`}</p>`,
    `<p>来源: ${escape(sources)}</p><p>生成时间: ${escape(snapshot.generatedAt)}；来源更新时间: ${escape(view.sourceUpdatedAt)}；证据观察时间: ${escape(view.dataAsOf ?? "无")}</p>`,
    `<p>指标口径: ${escape(metrics)}</p>`,
    `<svg data-view-id="${escape(view.id)}" data-view-kind="${escape(view.kind)}" viewBox="0 0 1000 ${height}" width="1000" height="${height}" role="img" aria-label="${escape(view.kind)} controlled dashboard">`,
    `<text x="20" y="28">${escape(view.kind)} · ${escape(view.status)}</text>`,
  ];
  if (view.data.length === 0) {
    parts.push(`<text x="20" y="70">不可验证 ${escape(reasons)}</text>`);
  }
  view.data.forEach((datum, index) => {
    const y = 52 + index * 48;
    const anchor = `drill-${view.id}-${datum.datumId}`;
    const formula = "formula" in datum ? `；公式 v${datum.definitionVersion}: ${datum.formula}` : "";
    const unknown = datum.status === "unknown" || datum.reasons.length > 0
      ? `；不可验证 ${datum.reasons.map((item) => `${item.code}: ${item.message}`).join("; ")}`
      : "";
    parts.push(
      `<g data-datum-id="${escape(datum.datumId)}"><a href="#${escape(anchor)}">`,
      `<rect x="430" y="${y - 15}" width="${datumWidth(datum)}" height="22" fill="#527a9e"></rect>`,
      `<text x="20" y="${y}">${escape(datumLabel(datum))}${escape(formula)}${escape(unknown)}</text></a></g>`,
    );
  });
  parts.push("</svg>");
  for (const datum of view.data) {
    const anchor = `drill-${view.id}-${datum.datumId}`;
    const datasetText = datum.datasets.map((item) => `${item.datasetId} (Source ${item.sourceId})`).join(", ") || "无";
    const evidenceText = datum.evidence.map((item) => `${item.evidenceId} observedAt=${item.observedAt} hash=${item.contentHash} assets=${item.assets.map((asset) => `${asset.id}:${asset.contentHash}`).join(",")}`).join("; ") || "无";
    const graphText = datum.analysisGraphRefs.map((item) => `${item.graphId} v${item.graphVersion} node=${item.nodeId} kind=${item.kind}`).join("; ") || "无";
    parts.push(`<details id="${escape(anchor)}"><summary>下钻 ${escape(view.id)} / ${escape(datum.datumId)}</summary><p>Dataset: ${escape(datasetText)}</p><p>Evidence: ${escape(evidenceText)}</p><p>AnalysisGraph: ${escape(graphText)}</p></details>`);
  }
  parts.push("</section>");
  return parts.join("");
}

function sourceVersions(snapshot: DashboardSnapshot): DashboardEntityVersionRef[] {
  if (snapshot.sourceVersions) return snapshot.sourceVersions.map((reference) => ({ ...reference }));
  return [
    ...snapshot.sources.map((item) => ({ entityType: "source" as const, id: item.id, version: item.version })),
    ...snapshot.datasets.map((item) => ({ entityType: "dataset" as const, id: item.id, version: item.version })),
    ...snapshot.evidence.map((item) => ({ entityType: "evidence" as const, id: item.id, version: item.version })),
    ...snapshot.graphs.map((item) => ({ entityType: "analysis_graph" as const, id: item.id, version: item.version })),
    ...snapshot.competitorDiffs.map((item) => ({ entityType: "competitor_diff" as const, id: item.id, version: item.version })),
    ...snapshot.tasks.filter((task) => snapshot.views.some((view) => view.kind === "task_effect" && view.taskIds.includes(task.id))).map((item) => ({ entityType: "task" as const, id: item.id, version: item.version })),
  ];
}

export class ControlledDashboardRenderer {
  render(snapshot: DashboardSnapshot): ControlledDashboardRenderResult {
    if (!Array.isArray(snapshot.views) || snapshot.views.length < 1 || snapshot.views.length > 5) {
      invalid("A dashboard render requires between one and five views");
    }
    const ids = new Set<string>();
    const kinds = new Set<string>();
    for (const view of snapshot.views) {
      if (ids.has(view.id) || kinds.has(view.kind)) invalid("Dashboard view IDs and kinds must be unique");
      ids.add(view.id);
      kinds.add(view.kind);
      if (["trend", "structure", "funnel"].includes(view.kind) &&
          (view as DashboardViewInput & { nodeIds: string[] }).nodeIds.length === 0) {
        invalid("Dashboard nodeIds must not be empty");
      }
    }
    const built = snapshot.views.map((input): BuiltView => {
      const result = input.kind === "trend" ? buildTrend(snapshot, input)
        : input.kind === "structure" ? buildStructure(snapshot, input)
        : input.kind === "funnel" ? buildFunnel(snapshot, input)
        : input.kind === "competitor_comparison" ? buildCompetitor(snapshot, input)
        : buildTask(snapshot, input);
      return finalizeView(snapshot, input, result);
    });
    const datasetIds = unique(built.flatMap((item) => item.datasetIds));
    const evidenceIds = unique(built.flatMap((item) => item.evidenceIds));
    const sourceIds = unique([
      ...datasetIds.map((id) => datasetDescriptor(snapshot, id).sourceId),
      ...evidenceIds.map((id) => evidenceDescriptor(snapshot, id).sourceId),
    ]);
    const manifestModel: DashboardManifest = {
      schemaVersion: 1,
      dashboardId: snapshot.id,
      workspaceId: snapshot.workspaceId,
      generatedAt: snapshot.generatedAt,
      renderer: RENDERER,
      sources: sourceIds.map((id) => sourceDescriptor(snapshot, id)),
      datasets: datasetIds.map((id) => datasetDescriptor(snapshot, id)),
      evidence: evidenceIds.map((id) => evidenceDescriptor(snapshot, id)),
      views: built.map((item) => item.view),
      graphIds: unique(snapshot.views.flatMap((view) => view.kind === "competitor_comparison" ? [] : [view.graphId])),
      competitorDiffIds: snapshot.views.flatMap((view) => view.kind === "competitor_comparison" ? [view.competitorDiffId] : []),
      taskIds: unique(snapshot.views.flatMap((view) => view.kind === "task_effect" ? view.taskIds : [])),
      sourceVersions: sourceVersions(snapshot),
    };
    const body = built.map((item) => renderView(snapshot, item.view)).join("");
    const htmlText = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(snapshot.id)} controlled dashboard</title><style>body{font-family:system-ui,sans-serif;color:#17232d;background:#fff;margin:2rem}section{margin-bottom:2rem;border-top:1px solid #ccd5dc;padding-top:1rem}svg{max-width:100%;height:auto;background:#f7f9fa}text{font-size:12px}a{cursor:pointer}a:focus,a:hover{outline:2px solid #345f82}details{margin:.5rem 0;padding:.5rem;background:#f2f5f7}p{overflow-wrap:anywhere}</style></head><body><h1>受控 HTML/SVG 看板</h1><p>renderer=controlled_html_svg_v1；professionalTool=false；非 Power BI；生成时间 ${escape(snapshot.generatedAt)}</p>${body}</body></html>`;
    const html = new TextEncoder().encode(htmlText);
    const manifest = new TextEncoder().encode(canonicalJson(manifestModel));
    if (html.byteLength > MAX_DASHBOARD_ARTIFACT_BYTES || manifest.byteLength > MAX_DASHBOARD_ARTIFACT_BYTES) {
      conflict("Dashboard artifact exceeds the 1 MiB controlled limit");
    }
    return {
      html,
      manifest,
      manifestModel,
      views: built.map((item) => {
        const { data: _data, ...view } = item.view;
        return view as DashboardView;
      }),
    };
  }
}

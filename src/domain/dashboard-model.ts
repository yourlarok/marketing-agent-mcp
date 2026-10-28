import type { EntityRecord } from "../application/ports.js";
import type { AnalysisGraph, AnalysisNodeKind } from "./analysis-model.js";
import {
  assertEntityReferenceId,
  assertRecord,
  assertStableId,
  assertUtcInstant,
  invalid,
} from "./contract-validation.js";
import type { CompetitorDiff, CompetitorDiffResult } from "./data-research-model.js";
import { getMetricDefinition, type MetricId } from "./metric-catalog.js";
import type {
  Dataset,
  Evidence,
  EvidenceAsset,
  Recommendation,
  Source,
  SourceOwnership,
  SourceType,
  Task,
} from "./model.js";

export const MAX_DASHBOARD_ARTIFACT_BYTES = 1024 * 1024;
export const MAX_DASHBOARD_DATA_PER_VIEW = 500;

export const DASHBOARD_VIEW_KINDS = [
  "trend",
  "structure",
  "funnel",
  "competitor_comparison",
  "task_effect",
] as const;
export type DashboardViewKind = (typeof DASHBOARD_VIEW_KINDS)[number];

interface DashboardViewBase {
  id: string;
}

export type DashboardViewInput =
  | (DashboardViewBase & {
      kind: "trend";
      graphId: string;
      nodeIds: string[];
    })
  | (DashboardViewBase & {
      kind: "structure";
      graphId: string;
      nodeIds: string[];
    })
  | (DashboardViewBase & {
      kind: "funnel";
      graphId: string;
      nodeIds: string[];
    })
  | (DashboardViewBase & {
      kind: "competitor_comparison";
      competitorDiffId: string;
    })
  | (DashboardViewBase & {
      kind: "task_effect";
      graphId: string;
      taskIds: string[];
      monitorNodeIds: string[];
    });

export type DashboardViewStatus = "ok" | "partial" | "unverifiable";

export interface DashboardReason {
  code: string;
  message: string;
}

export interface DashboardSourceDescriptor {
  sourceId: string;
  updatedAt: string;
  name?: string;
  type?: SourceType;
  ownership?: SourceOwnership;
}

export interface DashboardMetricDescriptor {
  metricId: MetricId;
  formula: string;
  definitionVersion?: number;
}

export type DashboardView = DashboardViewInput & {
  status: DashboardViewStatus;
  reasons: DashboardReason[];
  dataAsOf: string | null;
  sourceUpdatedAt: string;
  sources: DashboardSourceDescriptor[];
  metrics: DashboardMetricDescriptor[];
};

export interface DashboardRenderer {
  type: "controlled_renderer";
  id: "controlled_html_svg_v1";
  professionalTool: false;
}

export interface DashboardArtifact {
  id: string;
  kind: "html" | "manifest";
  contentHash: string;
  byteLength: number;
  mediaType: "text/html; charset=utf-8" | "application/json";
}

export interface DashboardEntityVersionRef {
  entityType: "source" | "dataset" | "evidence" | "analysis_graph" | "competitor_diff" | "task";
  id: string;
  version: number;
}

export interface Dashboard extends EntityRecord {
  generatedAt: string;
  renderer: DashboardRenderer;
  views: DashboardView[];
  artifacts: [DashboardArtifact, DashboardArtifact];
  sourceIds: string[];
  datasetIds: string[];
  evidenceIds: string[];
  graphIds: string[];
  competitorDiffIds: string[];
  taskIds: string[];
  sourceVersions: DashboardEntityVersionRef[];
}

export interface DashboardAnalysisGraphRef {
  graphId: string;
  graphVersion: number;
  nodeId: string;
  kind: AnalysisNodeKind;
}

export interface DashboardDatasetDescriptor {
  datasetId: string;
  version: number;
  sourceId: string;
  name: string;
  coverageStart: string | null;
  coverageEnd: string | null;
  updatedAt: string;
}

export interface DashboardEvidenceDescriptor {
  evidenceId: string;
  version: number;
  sourceId: string;
  observedAt: string;
  contentHash: string;
  classification: Evidence["classification"];
  assets: EvidenceAsset[];
  updatedAt: string;
}

export interface DashboardAnalyticsProvenance {
  provider: string;
  tool: string;
  toolVersion: string;
  inputHash: string;
  rowCount: number;
}

export interface DashboardDatumBase {
  datumId: string;
  status: "ok" | "unknown";
  reasons: DashboardReason[];
  datasetIds: string[];
  evidenceIds: string[];
  analysisGraphRefs: DashboardAnalysisGraphRef[];
  datasets: DashboardDatasetDescriptor[];
  evidence: DashboardEvidenceDescriptor[];
}

export type DashboardDatum = DashboardDatumBase & (
  | {
      kind: "trend_point";
      window: string;
      value: number | null;
      rowCount: number;
      coverage: number;
      formula: string;
      definitionVersion: number;
      provenance: DashboardAnalyticsProvenance;
    }
  | {
      kind: "metric_category";
      category: string;
      metricId: MetricId;
      definitionVersion: number;
      formula: string;
      value: number | null;
      unknownReason: string | null;
    }
  | {
      kind: "funnel_stage";
      stageIndex: number;
      field: string;
      total: number;
      conversionFromPrevious: number | null;
      conversionUnknownReason: string | null;
      overallConversion: number | null;
      overallUnknownReason: string | null;
      formula: string;
      definitionVersion: number;
    }
  | {
      kind: "competitor_entry";
      competitorDiffId: string;
      dimension: string;
      result: CompetitorDiffResult;
    }
  | {
      kind: "task_observation";
      taskId: string;
      monitorNodeId: string;
      metricId: MetricId;
      definitionVersion: number;
      formula: string;
      baselineValue: number | null;
      currentValue: number | null;
      absoluteDelta: number | null;
      relativeDelta: number | null;
      comparisonUnknownReason: string | null;
      relativeDeltaUnknownReason: string | null;
      interpretation: "observed_change_not_causal";
    }
);

export type DashboardManifestView = DashboardView & {
  data: DashboardDatum[];
};

export interface DashboardManifest {
  schemaVersion: 1;
  dashboardId: string;
  workspaceId: string;
  generatedAt: string;
  renderer: DashboardRenderer;
  sources: DashboardSourceDescriptor[];
  datasets: DashboardDatasetDescriptor[];
  evidence: DashboardEvidenceDescriptor[];
  views: DashboardManifestView[];
  graphIds: string[];
  competitorDiffIds: string[];
  taskIds: string[];
  sourceVersions: DashboardEntityVersionRef[];
}

export interface DashboardSnapshot {
  id: string;
  workspaceId: string;
  generatedAt: string;
  views: DashboardViewInput[];
  sources: Source[];
  datasets: Dataset[];
  evidence: Evidence[];
  graphs: AnalysisGraph[];
  competitorDiffs: CompetitorDiff[];
  tasks: Task[];
  recommendations: Recommendation[];
  sourceVersions?: DashboardEntityVersionRef[];
}

export interface ControlledDashboardRenderResult {
  html: Uint8Array;
  manifest: Uint8Array;
  manifestModel: DashboardManifest;
  views: DashboardView[];
}

export type CreateDashboardViewInput = DashboardViewInput & {
  status?: DashboardViewStatus;
  reasons?: DashboardReason[];
  dataAsOf?: string | null;
  sourceUpdatedAt: string;
  sources: DashboardSourceDescriptor[];
  metrics: DashboardMetricDescriptor[];
};

export type CreateDashboardInput = Omit<Dashboard, "version" | "updatedAt">;

const VIEW_METADATA_KEYS = [
  "id",
  "kind",
  "status",
  "reasons",
  "dataAsOf",
  "sourceUpdatedAt",
  "sources",
  "metrics",
] as const;
const REFERENCE_FIELDS = [
  ["sourceIds", "source"],
  ["datasetIds", "dataset"],
  ["evidenceIds", "evidence"],
  ["graphIds", "analysis_graph"],
  ["competitorDiffIds", "competitor_diff"],
  ["taskIds", "task"],
] as const;

function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${label} must be a non-empty string`);
  }
}

function assertReferenceId(value: unknown, label: string): void {
  assertEntityReferenceId(value, label);
}

function assertIdArray(value: unknown, label: string, nonEmpty = false): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 1000 || (nonEmpty && value.length === 0)) {
    invalid(`${label} must be a bounded ID array`);
  }
  for (const id of value) assertReferenceId(id, label);
  if (new Set(value).size !== value.length) invalid(`${label} must not contain duplicates`);
}

function validateView(view: DashboardView): void {
  assertRecord(view, "Dashboard view");
  assertStableId(view.id, "Dashboard view ID");
  if (!(DASHBOARD_VIEW_KINDS as readonly string[]).includes(view.kind)) {
    invalid("Dashboard view kind must be supported");
  }
  const referenceKeys = view.kind === "competitor_comparison"
    ? ["competitorDiffId"]
    : view.kind === "task_effect"
      ? ["graphId", "taskIds", "monitorNodeIds"]
      : ["graphId", "nodeIds"];
  assertRecord(view, "Dashboard view", [...VIEW_METADATA_KEYS, ...referenceKeys]);

  if (view.kind === "competitor_comparison") {
    assertReferenceId(view.competitorDiffId, "Dashboard competitorDiffId");
  } else {
    assertReferenceId(view.graphId, "Dashboard graphId");
    if (view.kind === "task_effect") {
      assertIdArray(view.taskIds, "Dashboard taskIds");
      assertIdArray(view.monitorNodeIds, "Dashboard monitorNodeIds", true);
    } else {
      assertIdArray(view.nodeIds, "Dashboard nodeIds", true);
    }
  }

  if (!(["ok", "partial", "unverifiable"] as const).includes(view.status)) {
    invalid("Dashboard view status must be supported");
  }
  if (!Array.isArray(view.reasons) || view.reasons.length > 100) {
    invalid("Dashboard reasons must be a bounded array");
  }
  for (const reason of view.reasons) {
    assertRecord(reason, "Dashboard reason", ["code", "message"]);
    assertNonEmptyString(reason.code, "Dashboard reason code");
    assertNonEmptyString(reason.message, "Dashboard reason message");
  }
  if (view.kind === "task_effect" && view.taskIds.length === 0 &&
      (view.status !== "unverifiable" || !view.reasons.some((reason) => reason.code === "TASK_NOT_LINKED"))) {
    invalid("An empty task-effect view must be unverifiable with TASK_NOT_LINKED");
  }
  if (view.dataAsOf !== null) assertUtcInstant(view.dataAsOf, "Dashboard dataAsOf");
  assertUtcInstant(view.sourceUpdatedAt, "Dashboard sourceUpdatedAt");

  if (!Array.isArray(view.sources) || view.sources.length > 100) {
    invalid("Dashboard sources must be a bounded array");
  }
  const sourceIds = new Set<string>();
  for (const source of view.sources) {
    assertRecord(source, "Dashboard source descriptor", [
      "sourceId",
      "updatedAt",
      "name",
      "type",
      "ownership",
    ]);
    assertReferenceId(source.sourceId, "Dashboard source ID");
    assertUtcInstant(source.updatedAt, "Dashboard source updatedAt");
    if (source.name !== undefined) assertNonEmptyString(source.name, "Dashboard source name");
    if (source.type !== undefined && !["file", "link", "api", "manual", "database"].includes(source.type)) {
      invalid("Dashboard source type must be supported");
    }
    if (source.ownership !== undefined && !["owned", "authorized", "external_public"].includes(source.ownership)) {
      invalid("Dashboard source ownership must be supported");
    }
    if (sourceIds.has(source.sourceId)) invalid("Dashboard source descriptors must not contain duplicates");
    sourceIds.add(source.sourceId);
  }

  if (!Array.isArray(view.metrics) || view.metrics.length > 100) {
    invalid("Dashboard metrics must be a bounded array");
  }
  const metricIds = new Set<string>();
  for (const metric of view.metrics) {
    assertRecord(metric, "Dashboard metric descriptor", ["metricId", "formula", "definitionVersion"]);
    const definition = getMetricDefinition(metric.metricId);
    if (metric.formula !== definition.formula) invalid("Dashboard metric formula must match the controlled catalog");
    if (metric.definitionVersion !== undefined && metric.definitionVersion !== definition.version) {
      invalid("Dashboard metric definitionVersion must match the controlled catalog");
    }
    if (metricIds.has(metric.metricId)) invalid("Dashboard metric descriptors must not contain duplicates");
    metricIds.add(metric.metricId);
  }
}

export function createDashboardView(input: CreateDashboardViewInput): DashboardView {
  const reasons = [...(input.reasons ?? [])].map((reason) => ({ ...reason }));
  let status = input.status ?? "ok";
  if (input.kind === "task_effect" && input.taskIds.length === 0) {
    status = "unverifiable";
    if (!reasons.some((reason) => reason.code === "TASK_NOT_LINKED")) {
      reasons.push({ code: "TASK_NOT_LINKED", message: "No task is linked to this task-effect view." });
    }
  }
  const view = {
    ...input,
    status,
    reasons,
    dataAsOf: input.dataAsOf ?? null,
    sources: input.sources.map((source) => ({ ...source })),
    metrics: input.metrics.map((metric) => ({ ...metric })),
  } as DashboardView;
  validateView(view);
  return view;
}

export function validateDashboard(dashboard: Dashboard): void {
  assertRecord(dashboard, "Dashboard");
  assertStableId(dashboard.id, "Dashboard ID");
  assertReferenceId(dashboard.workspaceId, "Dashboard workspace ID");
  if (!Number.isSafeInteger(dashboard.version) || dashboard.version < 1) {
    invalid("Dashboard version must be a positive safe integer");
  }
  assertUtcInstant(dashboard.createdAt, "Dashboard createdAt");
  assertUtcInstant(dashboard.updatedAt, "Dashboard updatedAt");
  assertUtcInstant(dashboard.generatedAt, "Dashboard generatedAt");

  assertRecord(dashboard.renderer, "Dashboard renderer", ["type", "id", "professionalTool"]);
  if (dashboard.renderer.type !== "controlled_renderer" ||
      dashboard.renderer.id !== "controlled_html_svg_v1" ||
      dashboard.renderer.professionalTool !== false) {
    invalid("Dashboard renderer must be controlled_html_svg_v1 without a professional tool");
  }

  if (!Array.isArray(dashboard.views) || dashboard.views.length === 0 ||
      dashboard.views.length > DASHBOARD_VIEW_KINDS.length) {
    invalid("Dashboard views must contain between one and five views");
  }
  const viewIds = new Set<string>();
  const viewKinds = new Set<string>();
  for (const view of dashboard.views) {
    validateView(view);
    if (viewIds.has(view.id)) invalid("Dashboard view IDs must not contain duplicates");
    if (viewKinds.has(view.kind)) invalid("Dashboard view kinds must not contain duplicates");
    viewIds.add(view.id);
    viewKinds.add(view.kind);
  }

  if (!Array.isArray(dashboard.artifacts) || dashboard.artifacts.length !== 2) {
    invalid("Dashboard must contain exactly HTML and manifest artifacts");
  }
  const artifactIds = new Set<string>();
  const artifactKinds = new Set<string>();
  for (const artifact of dashboard.artifacts) {
    assertRecord(artifact, "Dashboard artifact", ["id", "kind", "contentHash", "byteLength", "mediaType"]);
    assertStableId(artifact.id, "Dashboard artifact ID");
    if (artifactIds.has(artifact.id)) invalid("Dashboard artifact IDs must not contain duplicates");
    if (artifact.kind !== "html" && artifact.kind !== "manifest") invalid("Dashboard artifact kind must be supported");
    if (artifactKinds.has(artifact.kind)) invalid("Dashboard artifact kinds must not contain duplicates");
    if (!/^[0-9a-f]{64}$/i.test(artifact.contentHash)) invalid("Dashboard artifact contentHash must be SHA-256 hexadecimal");
    if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1 ||
        artifact.byteLength > MAX_DASHBOARD_ARTIFACT_BYTES) {
      invalid("Dashboard artifact byteLength must be between 1 and 1 MiB");
    }
    const expectedMediaType = artifact.kind === "html" ? "text/html; charset=utf-8" : "application/json";
    if (artifact.mediaType !== expectedMediaType) invalid("Dashboard artifact mediaType does not match its kind");
    artifactIds.add(artifact.id);
    artifactKinds.add(artifact.kind);
  }
  if (artifactKinds.size !== 2) invalid("Dashboard must contain exactly HTML and manifest artifacts");

  const expectedVersions = new Set<string>();
  for (const [field, entityType] of REFERENCE_FIELDS) {
    const ids = dashboard[field];
    assertIdArray(ids, `Dashboard ${field}`);
    for (const id of ids) expectedVersions.add(JSON.stringify([entityType, id]));
  }
  if (expectedVersions.size === 0) invalid("Dashboard must reference at least one source entity");

  if (!Array.isArray(dashboard.sourceVersions) || dashboard.sourceVersions.length !== expectedVersions.size) {
    invalid("Dashboard sourceVersions must cover every top-level reference exactly once");
  }
  const actualVersions = new Set<string>();
  for (const reference of dashboard.sourceVersions) {
    assertRecord(reference, "Dashboard source version", ["entityType", "id", "version"]);
    if (!(REFERENCE_FIELDS.map(([, entityType]) => entityType) as readonly string[]).includes(reference.entityType)) {
      invalid("Dashboard source version entityType must be supported");
    }
    assertReferenceId(reference.id, "Dashboard source version ID");
    if (!Number.isSafeInteger(reference.version) || reference.version < 1) {
      invalid("Dashboard source version must be a positive safe integer");
    }
    const key = JSON.stringify([reference.entityType, reference.id]);
    if (!expectedVersions.has(key)) invalid("Dashboard source version must match a top-level reference");
    if (actualVersions.has(key)) invalid("Dashboard sourceVersions must not contain duplicates");
    actualVersions.add(key);
  }
}

export function createDashboard(input: CreateDashboardInput): Dashboard {
  const dashboard = {
    ...input,
    version: 1,
    updatedAt: input.createdAt,
  } as Dashboard;
  validateDashboard(dashboard);
  return dashboard;
}

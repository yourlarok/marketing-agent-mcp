import { DomainError } from "../domain/errors.js";
import type { AnalysisGraph, AnalysisGraphNode, AnalysisPayload } from "../domain/analysis-model.js";
import type { CompetitorDiff } from "../domain/data-research-model.js";
import {
  MAX_DASHBOARD_ARTIFACT_BYTES,
  MAX_DASHBOARD_DATA_PER_VIEW,
  createDashboard,
  validateDashboard,
  type Dashboard,
  type DashboardArtifact,
  type DashboardEntityVersionRef,
  type DashboardManifest,
  type DashboardManifestView,
  type DashboardSnapshot,
  type DashboardViewInput,
} from "../domain/dashboard-model.js";
import type { Dataset, Evidence, Recommendation, Source, Task } from "../domain/model.js";
import { ArtifactStore, type StoredArtifact } from "../infrastructure/artifact-store.js";
import { ControlledDashboardRenderer } from "../infrastructure/controlled-dashboard-renderer.js";
import {
  AuditableCommandPipeline,
  type Command,
  type CommandPipeline,
} from "./commands.js";
import type {
  DashboardArtifactContent,
  DashboardDrilldown,
  GetDashboard,
  GetDashboardArtifact,
  GetDashboardDrilldown,
  RenderDashboard,
} from "./dashboard-commands.js";
import type {
  Clock,
  EntityRecord,
  EntityRepository,
  IdGenerator,
  Repositories,
  Store,
} from "./ports.js";

export const DASHBOARD_ARTIFACT_CHUNK_MAX_BYTES = 32 * 1024;

interface PreparedDashboard {
  snapshot: DashboardSnapshot;
  views: Dashboard["views"];
  html: StoredArtifact;
  manifest: StoredArtifact;
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

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${field} must not be empty`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function requireWorkspace(repos: Repositories, workspaceId: string): Promise<void> {
  if (!(await repos.workspaces.get(workspaceId, workspaceId))) notFound("Workspace not found");
}

async function requireDashboard(repos: Repositories, id: string, workspaceId: string): Promise<Dashboard> {
  return await repos.dashboards.get(id, workspaceId) ?? notFound("Dashboard not found in workspace");
}

function requireNode(graph: AnalysisGraph, nodeId: string): AnalysisGraphNode {
  return graph.nodes.find((node) => node.id === nodeId) ?? notFound("Dashboard analysis node not found in workspace");
}

function nestedPayload(payload: AnalysisPayload, key: string): AnalysisPayload | undefined {
  const value = payload[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as AnalysisPayload
    : undefined;
}

function collectPayloadRefs(payload: AnalysisPayload, datasetIds: string[], evidenceIds: string[]): void {
  for (const candidate of [payload, nestedPayload(payload, "provenance"), nestedPayload(payload, "current")]) {
    if (!candidate) continue;
    if (typeof candidate.datasetId === "string") datasetIds.push(candidate.datasetId);
    if (typeof candidate.evidenceId === "string") evidenceIds.push(candidate.evidenceId);
  }
}

function versionRepository(repos: Repositories, reference: DashboardEntityVersionRef): EntityRepository {
  const name = {
    source: "sources",
    dataset: "datasets",
    evidence: "evidence",
    analysis_graph: "analysisGraphs",
    competitor_diff: "competitorDiffs",
    task: "tasks",
  } as const;
  return repos[name[reference.entityType]] as EntityRepository;
}

async function resolveSnapshot(repos: Repositories, input: RenderDashboard): Promise<DashboardSnapshot> {
  await requireWorkspace(repos, input.workspaceId);
  const existing = await repos.dashboards.get(input.id, input.workspaceId);
  if (input.expectedVersion === undefined) {
    if (existing) conflict("Dashboard already exists");
  } else if (!existing || existing.version !== input.expectedVersion) {
    conflict("Dashboard version does not match expectedVersion");
  }

  const graphIds: string[] = [];
  const competitorDiffIds: string[] = [];
  const taskIds: string[] = [];
  for (const view of input.views) {
    if (view.kind === "competitor_comparison") competitorDiffIds.push(view.competitorDiffId);
    else {
      graphIds.push(view.graphId);
      if (view.kind === "task_effect") taskIds.push(...view.taskIds);
    }
  }
  const orderedGraphIds = unique(graphIds);
  const orderedDiffIds = unique(competitorDiffIds);
  const orderedTaskIds = unique(taskIds);
  const graphs: AnalysisGraph[] = [];
  for (const id of orderedGraphIds) {
    graphs.push(await repos.analysisGraphs.get(id, input.workspaceId) ?? notFound("Dashboard analysis graph not found in workspace"));
  }
  const competitorDiffs: CompetitorDiff[] = [];
  for (const id of orderedDiffIds) {
    competitorDiffs.push(await repos.competitorDiffs.get(id, input.workspaceId) as CompetitorDiff | undefined ?? notFound("CompetitorDiff not found in workspace"));
  }
  const tasks: Task[] = [];
  for (const id of orderedTaskIds) {
    tasks.push(await repos.tasks.get(id, input.workspaceId) as Task | undefined ?? notFound("Task not found in workspace"));
  }
  const recommendationIds = unique(tasks.flatMap((task) => task.recommendationIds));
  const recommendations: Recommendation[] = [];
  for (const id of recommendationIds) {
    recommendations.push(await repos.recommendations.get(id, input.workspaceId) as Recommendation | undefined ?? notFound("Task Recommendation not found in workspace"));
  }

  const datasetIds: string[] = [];
  const evidenceIds: string[] = [];
  for (const view of input.views) {
    if (view.kind === "competitor_comparison") {
      const diff = competitorDiffs.find((candidate) => candidate.id === view.competitorDiffId)!;
      for (const entry of diff.entries) evidenceIds.push(...entry.evidenceIds);
      continue;
    }
    const graph = graphs.find((candidate) => candidate.id === view.graphId)!;
    const selectedIds = view.kind === "task_effect" ? view.monitorNodeIds : view.nodeIds;
    for (const nodeId of selectedIds) {
      const selected = requireNode(graph, nodeId);
      collectPayloadRefs(selected.payload, datasetIds, evidenceIds);
      if (view.kind === "task_effect" && typeof selected.payload.baselineMetricNodeId === "string") {
        const baseline = requireNode(graph, selected.payload.baselineMetricNodeId);
        collectPayloadRefs(baseline.payload, datasetIds, evidenceIds);
      }
    }
  }

  const orderedDatasetIds = unique(datasetIds);
  const orderedEvidenceIds = unique(evidenceIds);
  const datasets: Dataset[] = [];
  for (const id of orderedDatasetIds) {
    datasets.push(await repos.datasets.get(id, input.workspaceId) as Dataset | undefined ?? notFound("Dashboard Dataset not found in workspace"));
  }
  const evidence: Evidence[] = [];
  for (const id of orderedEvidenceIds) {
    evidence.push(await repos.evidence.get(id, input.workspaceId) as Evidence | undefined ?? notFound("Dashboard Evidence not found in workspace"));
  }
  const sourceIds = unique([
    ...datasets.map((dataset) => dataset.sourceId),
    ...evidence.map((item) => item.sourceId),
  ]);
  const sources: Source[] = [];
  for (const id of sourceIds) {
    sources.push(await repos.sources.get(id, input.workspaceId) as Source | undefined ?? notFound("Dashboard Source not found in workspace"));
  }
  const sourceVersions: DashboardEntityVersionRef[] = [
    ...sources.map((item) => ({ entityType: "source" as const, id: item.id, version: item.version })),
    ...datasets.map((item) => ({ entityType: "dataset" as const, id: item.id, version: item.version })),
    ...evidence.map((item) => ({ entityType: "evidence" as const, id: item.id, version: item.version })),
    ...graphs.map((item) => ({ entityType: "analysis_graph" as const, id: item.id, version: item.version })),
    ...competitorDiffs.map((item) => ({ entityType: "competitor_diff" as const, id: item.id, version: item.version })),
    ...tasks.map((item) => ({ entityType: "task" as const, id: item.id, version: item.version })),
  ];
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    generatedAt: "",
    views: input.views.map((view) => ({ ...view })),
    sources,
    datasets,
    evidence,
    graphs,
    competitorDiffs,
    tasks,
    recommendations,
    sourceVersions,
  };
}

function assertRenderInput(input: RenderDashboard): void {
  assertNonEmptyString(input.id, "id");
  assertNonEmptyString(input.workspaceId, "workspaceId");
  if (input.expectedVersion !== undefined &&
      (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) {
    invalid("expectedVersion must be a positive integer");
  }
  if (!Array.isArray(input.views) || input.views.length < 1 || input.views.length > 5) {
    invalid("A render command requires between one and five views");
  }
  const ids = new Set<string>();
  const kinds = new Set<string>();
  for (const view of input.views) {
    assertNonEmptyString(view.id, "Dashboard view ID");
    if (ids.has(view.id) || kinds.has(view.kind)) invalid("Dashboard view IDs and kinds must be unique");
    ids.add(view.id);
    kinds.add(view.kind);
    if (view.kind === "competitor_comparison") {
      assertNonEmptyString(view.competitorDiffId, "competitorDiffId");
      continue;
    }
    assertNonEmptyString(view.graphId, "graphId");
    if (view.kind === "task_effect") {
      if (!Array.isArray(view.taskIds) || !Array.isArray(view.monitorNodeIds) || view.monitorNodeIds.length === 0) {
        invalid("Task-effect views require taskIds and nonempty monitorNodeIds arrays");
      }
      for (const id of [...view.taskIds, ...view.monitorNodeIds]) assertNonEmptyString(id, "Task-effect reference ID");
    } else {
      if (!Array.isArray(view.nodeIds) || view.nodeIds.length === 0) invalid("Dashboard nodeIds must not be empty");
      for (const id of view.nodeIds) assertNonEmptyString(id, "Dashboard node ID");
    }
  }
}

async function recheckSourceVersions(
  repos: Repositories,
  workspaceId: string,
  references: DashboardEntityVersionRef[],
): Promise<void> {
  for (const reference of references) {
    const current = await versionRepository(repos, reference).get(reference.id, workspaceId);
    if (!current || current.version !== reference.version) {
      conflict(`Dashboard ${reference.entityType} changed while artifacts were being prepared`);
    }
  }
}

async function recheckRecommendations(
  repos: Repositories,
  snapshot: DashboardSnapshot,
): Promise<void> {
  for (const recommendation of snapshot.recommendations) {
    const current = await repos.recommendations.get(recommendation.id, snapshot.workspaceId) as Recommendation | undefined;
    if (!current || current.version !== recommendation.version) {
      conflict("Dashboard Recommendation changed while artifacts were being prepared");
    }
  }
}

function decodeManifest(content: Buffer): DashboardManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    return conflict("Dashboard manifest must be canonical UTF-8 JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return conflict("Dashboard manifest must be an object");
  }
  return parsed as DashboardManifest;
}

export class DashboardService {
  private readonly commands: CommandPipeline;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    ids: IdGenerator,
    private readonly artifacts: ArtifactStore,
    private readonly renderer = new ControlledDashboardRenderer(),
  ) {
    this.commands = new AuditableCommandPipeline(store, clock, ids);
  }

  render(command: Command<RenderDashboard>): Promise<Dashboard> {
    const input = command.input;
    assertRenderInput(input);
    let prepared: PreparedDashboard | undefined;
    return this.commands.executeBatch({
      workspaceId: input.workspaceId,
      action: "dashboard.render",
      entityType: "dashboard",
      input,
      context: command.context,
      write: async (repos, current, timestamp) => {
        if (!prepared) conflict("Dashboard artifact preparation did not complete");
        const { snapshot, views, html, manifest } = prepared;
        await recheckSourceVersions(repos, current.workspaceId, snapshot.sourceVersions!);
        await recheckRecommendations(repos, snapshot);
        const existing = await repos.dashboards.get(current.id, current.workspaceId);
        const artifacts: [DashboardArtifact, DashboardArtifact] = [
          {
            id: `${current.id}-html`,
            kind: "html",
            contentHash: html.contentHash,
            byteLength: html.byteLength,
            mediaType: "text/html; charset=utf-8",
          },
          {
            id: `${current.id}-manifest`,
            kind: "manifest",
            contentHash: manifest.contentHash,
            byteLength: manifest.byteLength,
            mediaType: "application/json",
          },
        ];
        const references = {
          sourceIds: snapshot.sources.map((item) => item.id),
          datasetIds: snapshot.datasets.map((item) => item.id),
          evidenceIds: snapshot.evidence.map((item) => item.id),
          graphIds: snapshot.graphs.map((item) => item.id),
          competitorDiffIds: snapshot.competitorDiffs.map((item) => item.id),
          taskIds: snapshot.tasks.map((item) => item.id),
          sourceVersions: snapshot.sourceVersions!,
        };
        if (current.expectedVersion === undefined) {
          if (existing) conflict("Dashboard already exists");
          return repos.dashboards.insert(createDashboard({
            id: current.id,
            workspaceId: current.workspaceId,
            createdAt: timestamp,
            generatedAt: snapshot.generatedAt,
            renderer: { type: "controlled_renderer", id: "controlled_html_svg_v1", professionalTool: false },
            views,
            artifacts,
            ...references,
          }));
        }
        if (!existing || existing.version !== current.expectedVersion) {
          conflict("Dashboard version does not match expectedVersion");
        }
        const updated: Dashboard = {
          ...existing,
          version: existing.version + 1,
          updatedAt: timestamp,
          generatedAt: snapshot.generatedAt,
          views,
          artifacts,
          ...references,
        };
        validateDashboard(updated);
        return repos.dashboards.update(updated, current.expectedVersion);
      },
    }, async () => {
      const resolved = await this.store.transaction((repos) => resolveSnapshot(repos, input));
      const snapshot: DashboardSnapshot = { ...resolved, generatedAt: this.clock.now() };
      const rendered = this.renderer.render(snapshot);
      const [html, manifest] = await Promise.all([
        this.artifacts.put(rendered.html),
        this.artifacts.put(rendered.manifest),
      ]);
      prepared = { snapshot, views: rendered.views, html, manifest };
    });
  }

  get(query: GetDashboard): Promise<Dashboard> {
    assertNonEmptyString(query.id, "id");
    assertNonEmptyString(query.workspaceId, "workspaceId");
    return this.store.transaction((repos) => requireDashboard(repos, query.id, query.workspaceId));
  }

  async getArtifact(query: GetDashboardArtifact): Promise<DashboardArtifactContent> {
    assertNonEmptyString(query.id, "id");
    assertNonEmptyString(query.workspaceId, "workspaceId");
    assertNonEmptyString(query.artifactId, "artifactId");
    const offset = query.offset ?? 0;
    const length = query.length ?? DASHBOARD_ARTIFACT_CHUNK_MAX_BYTES;
    if (!Number.isSafeInteger(offset) || offset < 0) invalid("Dashboard artifact offset must be a non-negative integer");
    if (!Number.isSafeInteger(length) || length < 1 || length > DASHBOARD_ARTIFACT_CHUNK_MAX_BYTES) {
      invalid(`Dashboard artifact length must be between 1 and ${DASHBOARD_ARTIFACT_CHUNK_MAX_BYTES}`);
    }
    const dashboard = await this.get(query);
    const artifact = dashboard.artifacts.find((candidate) => candidate.id === query.artifactId) ??
      notFound("Dashboard artifact not found in workspace");
    if (offset > artifact.byteLength) invalid("Dashboard artifact offset exceeds totalBytes");
    const content = await this.artifacts.readRange(
      artifact.contentHash,
      offset,
      length,
      artifact.byteLength,
    );
    return {
      content,
      offset,
      length: content.byteLength,
      totalBytes: artifact.byteLength,
      contentHash: artifact.contentHash,
      mediaType: artifact.mediaType,
    };
  }

  async getDrilldown(query: GetDashboardDrilldown): Promise<DashboardDrilldown> {
    assertNonEmptyString(query.id, "id");
    assertNonEmptyString(query.workspaceId, "workspaceId");
    assertNonEmptyString(query.viewId, "viewId");
    assertNonEmptyString(query.datumId, "datumId");
    const dashboard = await this.get(query);
    const dashboardView = dashboard.views.find((view) => view.id === query.viewId) ??
      notFound("Dashboard view not found");
    const descriptor = dashboard.artifacts.find((artifact) => artifact.kind === "manifest")!;
    const manifest = decodeManifest(await this.artifacts.read(descriptor.contentHash, MAX_DASHBOARD_ARTIFACT_BYTES));
    if (manifest.schemaVersion !== 1 || manifest.dashboardId !== dashboard.id ||
        manifest.workspaceId !== dashboard.workspaceId || manifest.generatedAt !== dashboard.generatedAt ||
        !Array.isArray(manifest.views) || !Array.isArray(manifest.sources)) {
      conflict("Dashboard manifest identity does not match its descriptor");
    }
    const view = manifest.views.find((candidate) => candidate.id === query.viewId) as DashboardManifestView | undefined;
    if (!view || view.kind !== dashboardView.kind || !Array.isArray(view.data) ||
        view.data.length > MAX_DASHBOARD_DATA_PER_VIEW) {
      conflict("Dashboard manifest view does not match its descriptor");
    }
    const datum = view.data.find((candidate) => candidate.datumId === query.datumId) ??
      notFound("Dashboard datum not found");
    if (!Array.isArray(datum.analysisGraphRefs) || datum.analysisGraphRefs.length > 100 ||
        !Array.isArray(datum.datasets) || datum.datasets.length > 100 ||
        !Array.isArray(datum.evidence) || datum.evidence.length > 100) {
      conflict("Dashboard drilldown exceeds controlled descriptor limits");
    }
    const sourceIds = unique([
      ...datum.datasets.map((item) => item.sourceId),
      ...datum.evidence.map((item) => item.sourceId),
    ]);
    return {
      id: dashboard.id,
      workspaceId: dashboard.workspaceId,
      viewId: query.viewId,
      datumId: query.datumId,
      analysisGraphRefs: datum.analysisGraphRefs.map((reference) => ({ ...reference })),
      sources: manifest.sources.filter((source) => sourceIds.includes(source.sourceId)).map((source) => ({ ...source })),
      datasets: datum.datasets.map((dataset) => ({ ...dataset })),
      evidence: datum.evidence.map((evidence) => ({
        ...evidence,
        assets: evidence.assets.map((asset) => ({ ...asset })),
      })),
    };
  }
}

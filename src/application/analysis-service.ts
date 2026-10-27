import { createHash } from "node:crypto";
import {
  createAnalysisGraph,
  expandAnalysisGraph,
  forkAnalysisGraph,
  type AnalysisGraph,
  type AnalysisGraphNode,
  type AnalysisPayload,
  type AnalysisRecommendedAction,
} from "../domain/analysis-model.js";
import { DomainError } from "../domain/errors.js";
import { canonicalAcquisitionUrl } from "../infrastructure/acquisition-policy.js";
import { credentialEnvironmentVariable } from "../infrastructure/safe-http.js";
import { assertUtcInstant } from "../infrastructure/sqlite.js";
import {
  AuditableCommandPipeline,
  type Command,
  type CommandPipeline,
} from "./commands.js";
import {
  ANALYSIS_INPUT_MODES,
  type AnalysisCapability,
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

function startGraph(
  input: StartAnalysis & { inputMode: NonNullable<StartAnalysis["inputMode"]> },
  timestamp: string,
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
    recommendedActions: startActions(input),
  });
}

export class AnalysisService {
  private readonly commands: CommandPipeline;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    ids: IdGenerator,
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
        if (current.inputMode === "dataset") {
          await requireReferences(repos, current.workspaceId, [{
            id: "dataset-reference",
            kind: "dataset",
            payload: { datasetId: current.referenceId! },
          }]);
        }
        return repos.analysisGraphs.insert(startGraph(current, timestamp));
      },
    });
  }

  async get(query: GetAnalysisGraph): Promise<AnalysisGraph> {
    assertNonEmptyString(query.id, "id");
    assertNonEmptyString(query.workspaceId, "workspaceId");
    return this.store.transaction((repos) => requireGraph(repos, query.id, query.workspaceId));
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
          ...(current.recommendedActions === undefined
            ? {}
            : { recommendedActions: current.recommendedActions }),
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

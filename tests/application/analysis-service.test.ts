import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AnalysisCapabilityService,
  AnalysisService,
} from "../../src/application/analysis-service.js";
import type { CommandContext } from "../../src/application/commands.js";
import type { Store } from "../../src/application/ports.js";
import type { AnalysisGraphNode, AnalysisNodeKind } from "../../src/domain/analysis-model.js";
import type { DomainError } from "../../src/domain/errors.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import {
  ingestContentLinksInputSchema,
  ingestTemporaryApiInputSchema,
  researchSessionCreateInputSchema,
} from "../../src/mcp/schemas.js";
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

describe("AnalysisService with real SQLite", () => {
  let tempDir: string;
  let databasePath: string;
  let store: Store;
  let service: AnalysisService;
  let sequence: number;

  beforeEach(async () => {
    tempDir = await createTempDir();
    databasePath = join(tempDir, "analysis.db");
    store = openStore(databasePath);
    sequence = 0;
    service = new AnalysisService(
      store,
      { now: () => now },
      { next: () => `generated-${++sequence}` },
    );
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(workspace("workspace-1"));
      await repos.workspaces.insert(workspace("workspace-2"));
      await repos.sources.insert({
        ...workspace("source-1"),
        workspaceId: "workspace-1",
        type: "file",
        ownership: "owned",
      });
      await repos.datasets.insert({
        ...workspace("dataset-1"),
        workspaceId: "workspace-1",
        sourceId: "source-1",
      });
    });
  });

  afterEach(async () => {
    store.close();
    await removeTempDir(tempDir);
  });

  function startCommand(id: string, extra: Record<string, unknown> = {}) {
    return {
      input: {
        id,
        workspaceId: "workspace-1",
        objective: "Understand how to market AI education",
        ...extra,
      },
      context: context(id),
    };
  }

  async function start(id: string, extra: Record<string, unknown> = {}) {
    return service.start(startCommand(id, extra));
  }

  it("defaults to no-data public research with one optional question and executable next steps", async () => {
    const graph = await start("graph-none");

    expect(graph).toMatchObject({
      id: "graph-none",
      workspaceId: "workspace-1",
      version: 1,
      parentGraphId: null,
      parentVersion: null,
      forkNodeId: null,
    });
    expect(graph.nodes.map((node) => node.kind)).toEqual(["question", "research"]);
    expect(graph.edges).toEqual([{
      id: "graph-none-edge-question-research",
      fromNodeId: "graph-none-question",
      toNodeId: "graph-none-research",
    }]);
    expect(graph.nodes[0]!.payload).toMatchObject({
      objective: "Understand how to market AI education",
      channel: null,
      inputMode: "none",
      clarification: {
        required: false,
        default: "Continue with public cross-channel research",
      },
    });
    expect(graph.nodes[1]!.payload).toMatchObject({
      mode: "public_research",
      status: "planned",
      researchCompleted: false,
    });
    expect(graph.recommendedActions.map((action) => action.tool)).toEqual([
      "host.web_search",
      "research_session_create",
    ]);
    expect(graph.recommendedActions[0]).toMatchObject({
      status: "ready",
      arguments: { query: expect.stringContaining("AI education") },
    });
    expect(graph.recommendedActions[1]).toMatchObject({
      status: "requires_input",
      missingInputs: ["seeds", "scope"],
      arguments: {
        id: expect.stringMatching(/^analysis-research-[a-f0-9]{64}$/),
        workspaceId: "workspace-1",
        goal: "Understand how to market AI education",
        expansion: false,
      },
    });
    expect(researchSessionCreateInputSchema.safeParse({
      ...graph.recommendedActions[1]!.arguments,
      ...context("wrapped-research"),
    }).success).toBe(false);
    expect(JSON.stringify(graph)).not.toMatch(/CSV.*required|research.*completed.*true/i);

    const questionNodes = graph.nodes.filter((node) => node.kind === "question");
    expect(questionNodes).toHaveLength(1);
    expect(JSON.stringify(questionNodes[0]!.payload.clarification).match(/question/gi)).toHaveLength(1);
  });

  it.each([
    ["links", ["question", "research"], "ingest_content_links"],
    ["dataset", ["question", "dataset"], undefined],
    ["api", ["question", "dataset"], "ingest_temporary_api"],
  ] as const)("routes %s only to branches backed by real capabilities", async (
    inputMode,
    kinds: AnalysisNodeKind[],
    tool: string | undefined,
  ) => {
    const graph = await start(`graph-${inputMode}`, {
      channel: "short_video",
      inputMode,
      ...(inputMode === "dataset" ? { referenceId: "dataset-1" } : {}),
      ...(inputMode === "links" ? {
        links: [{ url: "https://example.com/research", fields: { price: ".price" } }],
      } : {}),
      ...(inputMode === "api" ? {
        url: "https://example.com/metrics.json",
        ownership: "authorized",
        expiresAt: "2026-10-27T13:00:00.000Z",
        credentialRef: "env:TEMPORARY_API_TOKEN",
      } : {}),
    });

    expect(graph.nodes.map((node) => node.kind)).toEqual(kinds);
    expect(graph.nodes[0]!.payload).toMatchObject({
      channel: "short_video",
      inputMode,
      clarification: null,
    });
    if (inputMode === "links") {
      expect(graph.nodes[1]!.payload).toMatchObject({
        mode: "content_links",
        status: "ready_to_ingest",
        researchCompleted: false,
      });
    }
    if (inputMode === "dataset") {
      expect(graph.nodes[1]!.payload).toMatchObject({
        datasetId: "dataset-1",
        status: "available",
      });
    }
    if (inputMode === "api") {
      expect(graph.nodes[1]!.payload).toMatchObject({ status: "ready_to_ingest" });
    }
    if (tool) {
      const action = graph.recommendedActions.find((candidate) => candidate.tool === tool)!;
      expect(action).toMatchObject({ status: "ready", missingInputs: [] });
      const argumentsWithContext = { ...action.arguments, ...context(`wrapped-${inputMode}`) };
      if (inputMode === "links") {
        expect(ingestContentLinksInputSchema.parse(argumentsWithContext)).toMatchObject({
          id: expect.stringMatching(/^analysis-content-[a-f0-9]{64}$/),
          workspaceId: "workspace-1",
          links: [{ url: "https://example.com/research", fields: { price: ".price" } }],
        });
      }
      if (inputMode === "api") {
        expect(ingestTemporaryApiInputSchema.parse(argumentsWithContext)).toMatchObject({
          id: expect.stringMatching(/^analysis-api-[a-f0-9]{64}$/),
          workspaceId: "workspace-1",
          url: "https://example.com/metrics.json",
          ownership: "authorized",
          expiresAt: "2026-10-27T13:00:00.000Z",
          credentialRef: "env:TEMPORARY_API_TOKEN",
        });
      }
    } else {
      expect(graph.recommendedActions).toEqual([]);
    }
    expect(graph.recommendedActions.map((action) => action.tool)).not.toContain("metric_compute");
  });

  it.each(["links", "api"] as const)("derives bounded, distinct %s action IDs from maximum-length graph IDs", async (inputMode) => {
    const input = {
      inputMode,
      ...(inputMode === "links" ? {
        links: [{ url: "https://example.com/research" }],
      } : {
        url: "https://example.com/metrics.json",
        ownership: "owned",
        expiresAt: "2026-10-27T13:00:00.000Z",
      }),
    };
    const first = await start("a".repeat(256), input);
    const second = await start("b".repeat(256), input);
    const firstArguments = first.recommendedActions[0]!.arguments!;
    const secondArguments = second.recommendedActions[0]!.arguments!;

    expect(firstArguments.id).toMatch(/^analysis-(?:content|api)-[a-f0-9]{64}$/);
    expect(String(firstArguments.id).length).toBeLessThanOrEqual(256);
    expect(secondArguments.id).not.toBe(firstArguments.id);
    const withContext = { ...firstArguments, ...context(`wrapped-long-${inputMode}`) };
    if (inputMode === "links") {
      expect(ingestContentLinksInputSchema.parse(withContext).id).toBe(firstArguments.id);
    } else {
      expect(ingestTemporaryApiInputSchema.parse(withContext).id).toBe(firstArguments.id);
    }
  });

  it("rejects missing or unsafe links/API inputs before creating a graph", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["links-missing", { inputMode: "links" }],
      ["links-empty", { inputMode: "links", links: [] }],
      ["links-not-public", { inputMode: "links", links: [{ url: "file:///etc/passwd" }] }],
      ["links-userinfo", { inputMode: "links", links: [{ url: "https://user:secret@example.com" }] }],
      ["api-missing", { inputMode: "api" }],
      ["api-ownership", {
        inputMode: "api", url: "https://example.com/data", ownership: "external_public",
        expiresAt: "2026-10-27T13:00:00.000Z",
      }],
      ["api-expired", {
        inputMode: "api", url: "https://example.com/data", ownership: "owned",
        expiresAt: "2026-10-27T12:00:00.000Z",
      }],
      ["api-time", {
        inputMode: "api", url: "https://example.com/data", ownership: "owned",
        expiresAt: "tomorrow",
      }],
      ["api-url", {
        inputMode: "api", url: "file:///etc/passwd", ownership: "owned",
        expiresAt: "2026-10-27T13:00:00.000Z",
      }],
      ["api-plaintext-credential", {
        inputMode: "api", url: "https://example.com/data", ownership: "owned",
        expiresAt: "2026-10-27T13:00:00.000Z",
        credentialRef: "database-secret-must-not-leak",
      }],
    ];
    for (const [id, input] of cases) {
      await expect(start(id, input)).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
      await expect(service.get({ id, workspaceId: "workspace-1" }))
        .rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    }
  });

  it("requires an existing same-workspace dataset reference for dataset mode", async () => {
    for (const [id, referenceId] of [
      ["dataset-missing-reference", undefined],
      ["dataset-unknown-reference", "missing"],
    ] as const) {
      await expect(start(id, { inputMode: "dataset", referenceId }))
        .rejects.toMatchObject<DomainError>({
          code: referenceId === undefined ? "INVALID_INPUT" : "NOT_FOUND",
        });
      await expect(service.get({ id, workspaceId: "workspace-1" }))
        .rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    }
  });

  it("persists get across restart and replays start without duplicate graph or audit", async () => {
    const command = startCommand("graph-restart", { channel: "search" });
    const created = await service.start(command);
    await expect(service.start(command)).resolves.toEqual(created);
    store.close();
    store = openStore(databasePath);
    service = new AnalysisService(
      store,
      { now: () => now },
      { next: () => `restarted-${++sequence}` },
    );

    await expect(service.get({ id: created.id, workspaceId: "workspace-1" }))
      .resolves.toEqual(created);
    await expect(service.start(command)).resolves.toEqual(created);
    const audits = await store.transaction((repos) =>
      repos.audit.listForEntity("workspace-1", "analysis_graph", created.id)
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "analysis_graph.start",
      requestId: "request-graph-restart",
    });
  });

  it("atomically expands from any existing node with several controlled nodes and edges", async () => {
    const created = await start("graph-expand", { channel: "community" });
    const command = {
      input: {
        id: created.id,
        workspaceId: "workspace-1",
        expectedVersion: 1,
        nodes: [
          { id: "decision-manual", kind: "decision", payload: { statement: "Compare audience needs" } },
          { id: "research-follow-up", kind: "research", payload: { status: "planned" } },
        ] satisfies AnalysisGraphNode[],
        edges: [
          { id: "edge-decision", fromNodeId: "graph-expand-research", toNodeId: "decision-manual" },
          { id: "edge-follow-up", fromNodeId: "decision-manual", toNodeId: "research-follow-up" },
        ],
        recommendedActions: [{ tool: "host.web_search", description: "Research the follow-up question" }],
      },
      context: context("expand"),
    };

    const expanded = await service.expand(command);
    expect(expanded).toMatchObject({ version: 2, updatedAt: now });
    expect(expanded.nodes.map((node) => node.id)).toEqual([
      "graph-expand-question",
      "graph-expand-research",
      "decision-manual",
      "research-follow-up",
    ]);
    expect(expanded.edges.slice(-2)).toEqual(command.input.edges);
    await expect(service.expand(command)).resolves.toEqual(expanded);
    await expect(service.get({ id: created.id, workspaceId: "workspace-1" }))
      .resolves.toEqual(expanded);
    await expect(store.transaction((repos) =>
      repos.audit.listForEntity("workspace-1", "analysis_graph", created.id)
    )).resolves.toMatchObject([
      { action: "analysis_graph.start" },
      { action: "analysis_graph.expand" },
    ]);
  });

  it("rolls back an invalid expansion and rejects stale versions without extra audit or idempotency", async () => {
    const created = await start("graph-atomic");
    const invalid = {
      input: {
        id: created.id,
        workspaceId: "workspace-1",
        expectedVersion: 1,
        nodes: [{ id: "orphan", kind: "research", payload: {} }],
        edges: [{ id: "bad-edge", fromNodeId: "orphan", toNodeId: "missing" }],
      },
      context: context("invalid-expand"),
    };
    await expect(service.expand(invalid)).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });

    const stale = {
      input: { ...invalid.input, nodes: [], edges: [], expectedVersion: 2 },
      context: context("stale-expand"),
    };
    await expect(service.expand(stale)).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    await expect(service.get({ id: created.id, workspaceId: "workspace-1" }))
      .resolves.toEqual(created);
    await expect(store.transaction(async (repos) => ({
      audits: await repos.audit.listForEntity("workspace-1", "analysis_graph", created.id),
      invalid: await repos.idempotency.get("workspace-1", "command-invalid-expand"),
      stale: await repos.idempotency.get("workspace-1", "command-stale-expand"),
    }))).resolves.toMatchObject({ audits: [{}], invalid: undefined, stale: undefined });
  });

  it("forks a deep copy with exact parent lineage and leaves the parent unchanged", async () => {
    const parent = await start("graph-parent", { channel: "search" });
    const command = {
      input: {
        id: "graph-fork",
        workspaceId: "workspace-1",
        parentGraphId: parent.id,
        expectedVersion: 1,
        forkNodeId: "graph-parent-research",
      },
      context: context("fork"),
    };

    const fork = await service.fork(command);
    expect(fork).toMatchObject({
      id: "graph-fork",
      version: 1,
      parentGraphId: parent.id,
      parentVersion: 1,
      forkNodeId: "graph-parent-research",
    });
    expect(fork.nodes).toEqual(parent.nodes);
    expect(fork.nodes).not.toBe(parent.nodes);
    expect(fork.nodes[0]).not.toBe(parent.nodes[0]);
    expect(fork.recommendedActions).not.toBe(parent.recommendedActions);
    await expect(service.fork(command)).resolves.toEqual(fork);
    await expect(service.get({ id: parent.id, workspaceId: "workspace-1" }))
      .resolves.toEqual(parent);
    await expect(store.transaction((repos) =>
      repos.audit.listForEntity("workspace-1", "analysis_graph", fork.id)
    )).resolves.toMatchObject([{ action: "analysis_graph.fork" }]);
  });

  it("enforces workspace isolation and expected parent version for reads, expansion, and fork", async () => {
    const graph = await start("graph-isolated");
    await expect(service.get({ id: graph.id, workspaceId: "workspace-2" }))
      .rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    await expect(service.expand({
      input: {
        id: graph.id,
        workspaceId: "workspace-2",
        expectedVersion: 1,
        nodes: [],
        edges: [],
      },
      context: context("cross-expand"),
    })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    await expect(service.fork({
      input: {
        id: "cross-fork",
        workspaceId: "workspace-2",
        parentGraphId: graph.id,
        expectedVersion: 1,
        forkNodeId: "graph-isolated-research",
      },
      context: context("cross-fork"),
    })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    await expect(service.fork({
      input: {
        id: "stale-fork",
        workspaceId: "workspace-1",
        parentGraphId: graph.id,
        expectedVersion: 2,
        forkNodeId: "graph-isolated-research",
      },
      context: context("stale-fork"),
    })).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
  });

  it("validates references and detects same-key different input", async () => {
    const graph = await start("graph-validation");
    await expect(service.expand({
      input: {
        id: graph.id,
        workspaceId: "workspace-1",
        expectedVersion: 1,
        nodes: [{ id: "bad-dataset", kind: "dataset", payload: { datasetId: "unknown-dataset" } }],
        edges: [],
      },
      context: context("bad-dataset"),
    })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });

    const command = startCommand("graph-idempotent");
    await service.start(command);
    await expect(service.start({
      ...command,
      input: { ...command.input, objective: "A different objective" },
    })).rejects.toMatchObject<DomainError>({ code: "IDEMPOTENCY_CONFLICT" });
  });
});

describe("AnalysisCapabilityService", () => {
  it("describes operations, inputs, configuration, availability, fallback, and limits without inventing connectors", () => {
    const catalog = new AnalysisCapabilityService().list();

    expect(catalog.length).toBeGreaterThanOrEqual(8);
    for (const capability of catalog) {
      expect(capability).toMatchObject({
        id: expect.any(String),
        operation: expect.any(String),
        description: expect.any(String),
        requiredInputs: expect.any(Array),
        configuration: expect.any(Array),
        availability: {
          state: expect.any(String),
          detail: expect.any(String),
        },
        fallback: expect.any(Array),
        limitations: expect.any(Array),
      });
    }
    expect(catalog.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "analysis.start",
      "analysis.get",
      "analysis.expand",
      "analysis.fork",
      "host.search",
      "research.scoped",
      "ingest.links",
      "ingest.files",
      "ingest.temporary_api",
    ]));
    expect(catalog.find((entry) => entry.id === "host.search")?.availability.state)
      .toBe("host_provided");
    const connectors = catalog.find((entry) => entry.id === "connectors.live");
    expect(connectors?.availability.state).toBe("not_installed");
    expect(connectors?.fallback.length).toBeGreaterThan(0);
    expect(catalog.filter((entry) => entry.id.includes("connector") && entry.availability.state === "available"))
      .toEqual([]);
    expect(JSON.stringify(catalog)).not.toMatch(/built-in general search/i);
  });
});

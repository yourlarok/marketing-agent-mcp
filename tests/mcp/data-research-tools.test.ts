import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataResearchService } from "../../src/application/data-research-service.js";
import { MarketingService } from "../../src/application/marketing-service.js";
import type { EntityRecord, Store } from "../../src/application/ports.js";
import type { Competitor } from "../../src/domain/data-research-model.js";
import { AcquisitionProvider } from "../../src/infrastructure/acquisition-router.js";
import { ArtifactStore } from "../../src/infrastructure/artifact-store.js";
import { SafeHttpClient } from "../../src/infrastructure/safe-http.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";
import { MAX_SERIALIZED_INPUT_BYTES } from "../../src/mcp/schemas.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const now = "2026-10-26T12:30:00.000Z";
const dataResearchToolNames = [
  "competitor_confirm",
  "competitor_diff_create",
  "data_request_decline",
  "data_request_plan",
  "data_research_get",
  "evidence_asset_get",
  "ingest_content_links",
  "ingest_files",
  "ingest_temporary_api",
  "research_permission_set",
  "research_session_create",
  "research_session_run",
];
const priorToolNames = [
  "capability_health_record",
  "capability_list",
  "capability_register",
  "dataset_register",
  "evidence_record",
  "finding_record",
  "lineage_get",
  "recommendation_create",
  "source_register",
  "task_create",
  "task_transition",
  "workspace_create",
];

function entity(id: string, workspaceId = "workspace-1"): EntityRecord {
  return {
    id,
    workspaceId,
    version: 1,
    createdAt: now,
    updatedAt: now,
    name: `Entity ${id}`,
  };
}

function context(suffix: string): { actor: string; requestId: string; idempotencyKey: string } {
  return {
    actor: "agent-1",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  };
}

describe("data research MCP tools", () => {
  let tempDir: string;
  let store: Store;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let dataResearch: DataResearchService;
  let sequence: number;
  let originalImportRoot: string | undefined;

  const acquisition: AcquisitionProvider = {
    acquire: async (request) => ({
      url: request.url,
      finalUrl: request.url,
      title: "Public research page",
      text: "Public observation",
      fields: request.fields ?? { price: "20" },
      links: [],
      screenshot: Buffer.from("screenshot"),
      provider: "playwright",
      toolVersion: "fixture-1",
    }),
  };

  beforeEach(async () => {
    tempDir = await createTempDir();
    originalImportRoot = process.env.MARKETING_IMPORT_ROOT;
    process.env.MARKETING_IMPORT_ROOT = tempDir;
    store = openStore(join(tempDir, "store.db"));
    sequence = 0;
    const clock = { now: () => now };
    const ids = { next: () => `generated-${++sequence}` };
    const marketing = new MarketingService(store, clock, ids);
    dataResearch = new DataResearchService(
      store,
      clock,
      ids,
      new ArtifactStore(join(tempDir, "artifacts")),
      {
        get: async (request) => ({
          body: Buffer.from("name,amount\nAcme,12\n"),
          contentType: "text/csv",
          finalUrl: request.url,
        }),
      },
      acquisition,
    );
    server = createMcpServer(marketing, dataResearch);
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    await store.transaction(async (repos) => {
      await repos.workspaces.insert(entity("workspace-1"));
      await repos.workspaces.insert(entity("workspace-2", "workspace-2"));
    });
  });

  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
    store.close();
    if (originalImportRoot === undefined) {
      delete process.env.MARKETING_IMPORT_ROOT;
    } else {
      process.env.MARKETING_IMPORT_ROOT = originalImportRoot;
    }
    await removeTempDir(tempDir);
  });

  async function call(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    const result = await client.callTool({ name, arguments: arguments_ });
    expect(result).not.toMatchObject({ isError: true });
    return JSON.parse((result.content[0] as { text: string }).text) as unknown;
  }

  it("registers the complete new and prior tool contracts with strict object schemas", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...priorToolNames, ...dataResearchToolNames].sort(),
    );
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });

  it("creates and declines a data request plan, then reads it only in its workspace", async () => {
    const created = await call("data_request_plan", {
      id: "plan-1",
      workspaceId: "workspace-1",
      objective: "Understand content performance",
      questionTypes: ["content_performance"],
      availableFields: [],
      ...context("plan-create"),
    });
    expect(created).toMatchObject({ id: "plan-1", version: 1, state: "awaiting_data" });

    const declined = await call("data_request_decline", {
      planId: "plan-1",
      workspaceId: "workspace-1",
      expectedPlanVersion: 1,
      questionType: "content_performance",
      reason: "No operating export is available",
      ...context("plan-decline"),
    });
    expect(declined).toMatchObject({
      id: "plan-1",
      version: 2,
      state: "blocked",
      declinedQuestionTypes: ["content_performance"],
    });

    const read = await call("data_research_get", {
      entityType: "data_request_plan",
      id: "plan-1",
      workspaceId: "workspace-1",
    });
    expect(read).toMatchObject({
      workspaceId: "workspace-1",
      nodes: [{ entityType: "data_request_plan", id: "plan-1", version: 2 }],
    });
    const crossWorkspace = await client.callTool({
      name: "data_research_get",
      arguments: {
        entityType: "data_request_plan",
        id: "plan-1",
        workspaceId: "workspace-2",
      },
    });
    expect(crossWorkspace).toMatchObject({ isError: true });
    expect(JSON.stringify(crossWorkspace)).toContain("Resource not found");
  });

  it("ingests files, temporary APIs, and content links through the real service", async () => {
    const csvPath = join(tempDir, "metrics.csv");
    await writeFile(csvPath, "name,amount\nAcme,12\n");

    const files = await call("ingest_files", {
      id: "batch-files",
      workspaceId: "workspace-1",
      paths: ["metrics.csv"],
      ...context("ingest-files"),
    });
    expect(files).toMatchObject({ id: "batch-files", state: "completed", failures: [] });

    const api = await call("ingest_temporary_api", {
      id: "batch-api",
      workspaceId: "workspace-1",
      url: "https://example.com/metrics.csv",
      ownership: "authorized",
      expiresAt: "2026-10-26T13:00:00.000Z",
      ...context("ingest-api"),
    }) as { evidenceIds: string[] };
    expect(api).toMatchObject({ id: "batch-api", state: "completed", failures: [] });

    const links = await call("ingest_content_links", {
      id: "batch-links",
      workspaceId: "workspace-1",
      links: [{ url: "https://example.com/public", fields: { price: ".price" } }],
      ...context("ingest-links"),
    });
    expect(links).toMatchObject({ id: "batch-links", state: "completed", failures: [] });

    const evidence = await store.transaction((repos) =>
      repos.evidence.get(api.evidenceIds[0]!, "workspace-1")
    );
    const original = (evidence?.assets as { id: string; kind: string }[])
      .find((asset) => asset.kind === "api_response")!;
    const asset = await call("evidence_asset_get", {
      workspaceId: "workspace-1",
      evidenceId: api.evidenceIds[0]!,
      assetId: original.id,
    });
    expect(asset).toMatchObject({
      id: original.id,
      kind: "api_response",
      content: Buffer.from("name,amount\nAcme,12\n").toString("base64"),
    });

    const pathAttempt = await client.callTool({
      name: "evidence_asset_get",
      arguments: {
        workspaceId: "workspace-1",
        evidenceId: api.evidenceIds[0]!,
        assetId: original.id,
        path: join(tempDir, "artifacts", "not-allowed"),
      },
    });
    expect(pathAttempt).toMatchObject({ isError: true });
    const crossWorkspace = await client.callTool({
      name: "evidence_asset_get",
      arguments: {
        workspaceId: "workspace-2",
        evidenceId: api.evidenceIds[0]!,
        assetId: original.id,
      },
    });
    expect(crossWorkspace).toMatchObject({ isError: true });
  });

  it("creates, authorizes, and runs a bounded research session", async () => {
    const created = await call("research_session_create", {
      id: "session-1",
      workspaceId: "workspace-1",
      goal: "Research a public competitor",
      seeds: ["https://example.com/research"],
      expansion: true,
      scope: {
        hosts: ["example.com"],
        pathPrefixes: ["/research"],
        maxDepth: 1,
        maxPages: 2,
        maxDurationMs: 10_000,
        maxBytes: 1024 * 1024,
      },
      ...context("research-create"),
    });
    expect(created).toMatchObject({ state: "awaiting_permission", version: 1 });

    const permitted = await call("research_permission_set", {
      id: "session-1",
      workspaceId: "workspace-1",
      expectedVersion: 1,
      expansion: "allowed",
      ...context("research-permission"),
    });
    expect(permitted).toMatchObject({ expansion: "allowed", state: "ready", version: 2 });

    const run = await call("research_session_run", {
      id: "session-1",
      workspaceId: "workspace-1",
      expectedVersion: 2,
      limits: { maxPages: 1 },
      ...context("research-run"),
    });
    expect(run).toMatchObject({ state: "completed", stopReason: "completed", version: 3 });
  });

  it("confirms competitors and creates a deterministic diff", async () => {
    await store.transaction(async (repos) => {
      for (const id of ["left", "right"]) {
        await repos.competitors.insert({
          ...entity(id),
          status: "excluded",
          evidenceIds: [],
        } as Competitor);
      }
    });
    for (const id of ["left", "right"]) {
      const confirmed = await call("competitor_confirm", {
        id,
        workspaceId: "workspace-1",
        expectedVersion: 1,
        status: "confirmed",
        ...context(`confirm-${id}`),
      });
      expect(confirmed).toMatchObject({ id, status: "confirmed", version: 2 });
    }

    const diff = await call("competitor_diff_create", {
      id: "diff-1",
      workspaceId: "workspace-1",
      competitorIds: ["left", "right"],
      dimensions: ["price"],
      ...context("diff-create"),
    });
    expect(diff).toMatchObject({
      id: "diff-1",
      entries: [{ dimension: "price", result: "unknown", evidenceIds: [] }],
      findingIds: [],
    });
  });

  it("rejects unknown fields on every new tool before invoking business behavior", async () => {
    const calls = [
      ["data_request_plan", { id: "p", workspaceId: "workspace-1", objective: "Goal", questionTypes: ["conversion"], availableFields: [], ...context("strict-plan") }],
      ["data_request_decline", { planId: "p", workspaceId: "workspace-1", expectedPlanVersion: 1, questionType: "conversion", reason: "Unavailable", ...context("strict-decline") }],
      ["ingest_files", { id: "b", workspaceId: "workspace-1", paths: ["input.csv"], ...context("strict-files") }],
      ["ingest_temporary_api", { id: "b", workspaceId: "workspace-1", url: "https://example.com/data", ownership: "owned", expiresAt: "2026-10-26T13:00:00.000Z", ...context("strict-api") }],
      ["ingest_content_links", { id: "b", workspaceId: "workspace-1", links: [{ url: "https://example.com" }], ...context("strict-links") }],
      ["research_session_create", { id: "s", workspaceId: "workspace-1", goal: "Goal", seeds: ["https://example.com"], expansion: false, scope: { hosts: ["example.com"], pathPrefixes: ["/"], maxDepth: 1, maxPages: 1, maxDurationMs: 1000, maxBytes: 1000 }, ...context("strict-session") }],
      ["research_permission_set", { id: "s", workspaceId: "workspace-1", expectedVersion: 1, expansion: "denied", ...context("strict-permission") }],
      ["research_session_run", { id: "s", workspaceId: "workspace-1", expectedVersion: 1, ...context("strict-run") }],
      ["competitor_confirm", { id: "c", workspaceId: "workspace-1", expectedVersion: 1, status: "confirmed", ...context("strict-confirm") }],
      ["competitor_diff_create", { id: "d", workspaceId: "workspace-1", competitorIds: ["left", "right"], dimensions: ["price"], ...context("strict-diff") }],
      ["data_research_get", { entityType: "research_session", id: "s", workspaceId: "workspace-1" }],
      ["evidence_asset_get", { workspaceId: "workspace-1", evidenceId: "e", assetId: "a" }],
    ] as const;

    for (const [name, arguments_] of calls) {
      const result = await client.callTool({
        name,
        arguments: { ...arguments_, unexpected: true },
      });
      expect(result, name).toMatchObject({ isError: true });
    }
  });

  it("enforces the complete 64 KiB argument limit and rejects nested secret-like fields", async () => {
    const oversized = await client.callTool({
      name: "data_request_plan",
      arguments: {
        id: "oversized-plan",
        workspaceId: "workspace-1",
        objective: "x".repeat(MAX_SERIALIZED_INPUT_BYTES),
        questionTypes: ["conversion"],
        availableFields: [],
        ...context("oversized-plan"),
      },
    });
    expect(oversized).toMatchObject({ isError: true });
    expect(JSON.stringify(oversized)).toContain("Invalid input");

    const secret = "synthetic-mcp-data-research-secret";
    const nestedSecret = await client.callTool({
      name: "ingest_content_links",
      arguments: {
        id: "secret-batch",
        workspaceId: "workspace-1",
        links: [{ url: "https://example.com", fields: { apiKey: secret } }],
        ...context("secret-batch"),
      },
    });
    expect(nestedSecret).toMatchObject({ isError: true });
    expect(JSON.stringify(nestedSecret)).not.toContain(secret);
  });

  it("rejects raw oversized whitespace on every new tool without persistence", async () => {
    const scope = {
      hosts: ["example.com"],
      pathPrefixes: ["/research"],
      maxDepth: 1,
      maxPages: 2,
      maxDurationMs: 10_000,
      maxBytes: 1024 * 1024,
    };
    const plan = await dataResearch.planDataRequests({
      input: {
        id: "overflow-plan",
        workspaceId: "workspace-1",
        objective: "Overflow plan",
        questionTypes: ["conversion"],
        availableFields: [],
      },
      context: context("seed-overflow-plan"),
    });
    await dataResearch.createResearchSession({
      input: {
        id: "overflow-permission",
        workspaceId: "workspace-1",
        goal: "Permission",
        seeds: ["https://example.com/research"],
        expansion: true,
        scope,
      },
      context: context("seed-overflow-permission"),
    });
    await dataResearch.createResearchSession({
      input: {
        id: "overflow-run",
        workspaceId: "workspace-1",
        goal: "Run",
        seeds: ["https://example.com/research"],
        expansion: false,
        scope,
      },
      context: context("seed-overflow-run"),
    });
    const assetBatch = await dataResearch.ingestContentLinks({
      input: {
        id: "overflow-asset-seed",
        workspaceId: "workspace-1",
        links: [{ url: "https://example.com/research" }],
      },
      context: context("seed-overflow-asset"),
    });
    const assetEvidence = await store.transaction((repos) =>
      repos.evidence.get(assetBatch.evidenceIds[0]!, "workspace-1")
    );
    const assetId = (assetEvidence?.assets as { id: string }[])[0]!.id;
    await store.transaction(async (repos) => {
      await repos.competitors.insert({
        ...entity("overflow-confirm"),
        status: "excluded",
        evidenceIds: [],
      } as Competitor);
      for (const id of ["overflow-left", "overflow-right"]) {
        await repos.competitors.insert({
          ...entity(id),
          status: "confirmed",
          evidenceIds: [],
        } as Competitor);
      }
    });
    await writeFile(join(tempDir, "overflow.csv"), "name,amount\nAcme,12\n");

    const padding = " ".repeat(MAX_SERIALIZED_INPUT_BYTES);
    const workspaceId = `${padding}workspace-1`;
    const calls = [
      ["data_request_plan", { id: "overflow-new-plan", workspaceId, objective: "Overflow", questionTypes: ["conversion"], availableFields: [], ...context("overflow-new-plan") }],
      ["data_request_decline", { planId: plan.id, workspaceId, expectedPlanVersion: 1, questionType: "conversion", reason: "Overflow", ...context("overflow-decline") }],
      ["ingest_files", { id: "overflow-files", workspaceId, paths: ["overflow.csv"], ...context("overflow-files") }],
      ["ingest_temporary_api", { id: "overflow-api", workspaceId, url: "https://example.com/metrics.csv", ownership: "authorized", expiresAt: "2026-10-26T13:00:00.000Z", ...context("overflow-api") }],
      ["ingest_content_links", { id: "overflow-links", workspaceId, links: [{ url: "https://example.com/research" }], ...context("overflow-links") }],
      ["research_session_create", { id: "overflow-session", workspaceId, goal: "Overflow", seeds: ["https://example.com/research"], expansion: false, scope, ...context("overflow-session") }],
      ["research_permission_set", { id: "overflow-permission", workspaceId, expectedVersion: 1, expansion: "denied", ...context("overflow-set-permission") }],
      ["research_session_run", { id: "overflow-run", workspaceId, expectedVersion: 1, ...context("overflow-run-research") }],
      ["competitor_confirm", { id: "overflow-confirm", workspaceId, expectedVersion: 1, status: "confirmed", ...context("overflow-confirm-competitor") }],
      ["competitor_diff_create", { id: "overflow-diff", workspaceId, competitorIds: ["overflow-left", "overflow-right"], dimensions: ["price"], ...context("overflow-diff-create") }],
      ["data_research_get", { entityType: "data_request_plan", id: plan.id, workspaceId }],
      ["evidence_asset_get", { workspaceId, evidenceId: assetBatch.evidenceIds[0]!, assetId }],
    ] as const;

    const raw = new DatabaseSync(join(tempDir, "store.db"));
    try {
      const residue = () => raw.prepare(
        `SELECT
          (SELECT COUNT(*) FROM data_request_plans) AS plans,
          (SELECT COUNT(*) FROM ingestion_batches) AS batches,
          (SELECT COUNT(*) FROM research_sessions) AS sessions,
          (SELECT COUNT(*) FROM competitors) AS competitors,
          (SELECT COUNT(*) FROM competitor_diffs) AS diffs,
          (SELECT COUNT(*) FROM audit_records) AS audits,
          (SELECT COUNT(*) FROM idempotency_records) AS idempotency`,
      ).get();
      const before = residue();
      for (const [name, arguments_] of calls) {
        expect(Buffer.byteLength(JSON.stringify(arguments_), "utf8"), name).toBeGreaterThan(MAX_SERIALIZED_INPUT_BYTES);
        const result = await client.callTool({ name, arguments: arguments_ });
        expect(result, name).toMatchObject({ isError: true });
      }
      expect(residue()).toEqual(before);
    } finally {
      raw.close();
    }
  });

  it("maps expired temporary API failures to safe MCP errors", async () => {
    const expiredService = new DataResearchService(
      store,
      { now: () => now },
      { next: () => `expired-${++sequence}` },
      new ArtifactStore(join(tempDir, "artifacts")),
      new SafeHttpClient({ now: () => now, allowlist: ["example.com"] }),
      acquisition,
    );
    const expiredServer = createMcpServer(undefined, expiredService);
    const expiredClient = new Client({ name: "expired-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        expiredClient.connect(clientTransport),
        expiredServer.connect(serverTransport),
      ]);
      const result = await expiredClient.callTool({
        name: "ingest_temporary_api",
        arguments: {
          id: "expired-api",
          workspaceId: "workspace-1",
          url: "https://example.com/metrics.csv?private=synthetic-secret",
          ownership: "owned",
          expiresAt: "2026-10-26T12:00:00.000Z",
          ...context("expired-api"),
        },
      });
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain("Internal server error");
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
      expect(JSON.stringify(result)).not.toContain("Temporary API URL");
    } finally {
      await Promise.all([expiredClient.close(), expiredServer.close()]);
    }
  });
});

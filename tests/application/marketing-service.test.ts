import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Clock,
  IdGenerator,
  Store,
} from "../../src/application/ports.js";
import { MarketingService } from "../../src/application/marketing-service.js";
import type {
  CommandContext,
  CreateWorkspace,
  RecordEvidence,
  RegisterDataset,
} from "../../src/application/commands.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  createAnalysisGraph,
  forkAnalysisGraph,
} from "../../src/domain/analysis-model.js";
import { createDashboard, createDashboardView } from "../../src/domain/dashboard-model.js";
import {
  createAssetVersion,
  createBenchmarkAnalysis,
  createContentBrief,
} from "../../src/domain/content-production-model.js";
import type { ToolHealthEvidence } from "../../src/domain/model.js";
import { openStore } from "../../src/infrastructure/sqlite-store.js";

const firstNow = "2026-10-26T12:30:00.000Z";
const secondNow = "2026-10-26T12:31:00.000Z";

class TestClock implements Clock {
  constructor(private current = firstNow) {}

  now(): string {
    return this.current;
  }

  set(value: string): void {
    this.current = value;
  }
}

class TestIds implements IdGenerator {
  calls = 0;

  constructor(private values: string[]) {}

  next(): string {
    const value = this.values[this.calls];
    if (!value) {
      throw new Error("No test ID available");
    }
    this.calls += 1;
    return value;
  }
}

const context: CommandContext = {
  actor: "agent-1",
  requestId: "request-1",
  idempotencyKey: "command-1",
};

function workspaceInput(): CreateWorkspace {
  return {
    id: "workspace-1",
    name: "Northwind",
  };
}

function datasetInput(): RegisterDataset {
  return {
    id: "dataset-1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    name: "Orders",
    coverageStart: "2026-01-01T00:00:00.000Z",
    coverageEnd: "2026-01-31T23:59:59.999Z",
    fieldDefinitions: [
      { name: "order_id", type: "string" },
      { name: "revenue", type: "number" },
    ],
    metricDefinitions: [{ name: "revenue", aggregation: "sum" }],
    limitations: ["Refunds are excluded"],
  };
}

function evidenceInput(): RecordEvidence {
  return {
    id: "evidence-1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    sourceLocator: "warehouse/orders/2026-01",
    observedAt: "2026-02-01T00:00:00.000Z",
    summary: "January revenue reconciled to the ledger",
    contentHash: "a".repeat(64),
    classification: "owned_operating",
  };
}

function findingInput() {
  return {
    id: "finding-1",
    workspaceId: "workspace-1",
    kind: "inference" as const,
    statement: "January revenue growth was driven by repeat customers",
    evidenceIds: ["evidence-2", "evidence-1"],
    limitations: "Attribution is limited to the observed customer cohort",
  };
}

describe("MarketingService command pipeline", () => {
  let store: Store;
  let clock: TestClock;
  let ids: TestIds;
  let service: MarketingService;

  beforeEach(() => {
    store = openStore(":memory:");
    clock = new TestClock();
    ids = new TestIds([
      "audit-1",
      "audit-2",
      "audit-3",
      "audit-4",
      "audit-5",
      "audit-6",
      "audit-7",
      "audit-8",
    ]);
    service = new MarketingService(store, clock, ids);
  });

  afterEach(() => {
    store.close();
  });

  async function recordEvidencePair(): Promise<void> {
    await service.createWorkspace({ input: workspaceInput(), context });
    await service.registerSource({
      input: {
        id: "source-1",
        workspaceId: "workspace-1",
        name: "Warehouse",
        type: "database",
        ownership: "owned",
      },
      context: { ...context, requestId: "request-2", idempotencyKey: "command-2" },
    });
    await service.recordEvidence({
      input: evidenceInput(),
      context: { ...context, requestId: "request-3", idempotencyKey: "command-3" },
    });
    await service.recordEvidence({
      input: {
        ...evidenceInput(),
        id: "evidence-2",
        sourceLocator: "warehouse/orders/repeat-customers",
        summary: "Repeat customers accounted for the revenue increase",
        contentHash: "b".repeat(64),
      },
      context: { ...context, requestId: "request-4", idempotencyKey: "command-4" },
    });
  }

  it("creates a workspace with its own ID as scope and an atomic audit trail", async () => {
    const workspace = await service.createWorkspace({
      input: workspaceInput(),
      context,
    });

    expect(workspace).toEqual({
      id: "workspace-1",
      workspaceId: "workspace-1",
      version: 1,
      createdAt: firstNow,
      updatedAt: firstNow,
      name: "Northwind",
    });
    const persisted = await store.transaction(async (repos) => ({
      workspace: await repos.workspaces.get("workspace-1", "workspace-1"),
      audit: await repos.audit.get("audit-1", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-1"),
    }));
    expect(persisted.workspace).toEqual(workspace);
    expect(persisted.audit).toMatchObject({
      requestId: "request-1",
      actor: "agent-1",
      action: "workspace.create",
      entityType: "workspace",
      entityId: "workspace-1",
      details: { input: workspaceInput() },
    });
    expect(persisted.idempotency?.response).toEqual(workspace);
  });

  it("registers a source with its kind and ownership through the same pipeline", async () => {
    await service.createWorkspace({ input: workspaceInput(), context });
    const source = await service.registerSource({
      input: {
        id: "source-1",
        workspaceId: "workspace-1",
        name: "Public research",
        type: "link",
        ownership: "external_public",
      },
      context: {
        ...context,
        requestId: "request-2",
        idempotencyKey: "command-2",
      },
    });

    expect(source).toEqual({
      id: "source-1",
      workspaceId: "workspace-1",
      version: 1,
      createdAt: firstNow,
      updatedAt: firstNow,
      name: "Public research",
      type: "link",
      ownership: "external_public",
    });
    expect(
      await store.transaction((repos) =>
        repos.audit.get("audit-2", "workspace-1"),
      ),
    ).toMatchObject({
      action: "source.register",
      entityType: "source",
      entityId: "source-1",
    });
  });

  it("replays the first result for canonical-equivalent input without new writes", async () => {
    const first = await service.createWorkspace({
      input: workspaceInput(),
      context,
    });
    clock.set(secondNow);
    const replay = await service.createWorkspace({
      input: { name: "Northwind", id: "workspace-1" },
      context: { ...context, requestId: "request-replay" },
    });

    expect(replay).toEqual(first);
    expect(replay.createdAt).toBe(firstNow);
    expect(ids.calls).toBe(1);
    expect(
      await store.transaction((repos) =>
        repos.audit.get("audit-2", "workspace-1"),
      ),
    ).toBeUndefined();
  });

  it("rejects the same idempotency key with different canonical input", async () => {
    await service.createWorkspace({ input: workspaceInput(), context });

    await expect(
      service.createWorkspace({
        input: { ...workspaceInput(), name: "Changed" },
        context,
      }),
    ).rejects.toMatchObject<DomainError>({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(
      await store.transaction((repos) =>
        repos.workspaces.get("workspace-1", "workspace-1"),
      ),
    ).toMatchObject({ name: "Northwind" });
  });

  it("rolls back the entity and idempotency result when audit append fails", async () => {
    await service.createWorkspace({ input: workspaceInput(), context });
    service = new MarketingService(store, clock, new TestIds(["audit-1"]));

    await expect(
      service.createWorkspace({
        input: { id: "workspace-2", name: "Contoso" },
        context: {
          ...context,
          requestId: "request-2",
          idempotencyKey: "command-2",
        },
      }),
    ).rejects.toThrow();

    const persisted = await store.transaction(async (repos) => ({
      workspace: await repos.workspaces.get("workspace-2", "workspace-2"),
      idempotency: await repos.idempotency.get("workspace-2", "command-2"),
    }));
    expect(persisted).toEqual({ workspace: undefined, idempotency: undefined });
  });

  it("rejects secret-like metadata before canonicalization or any persistence", async () => {
    await expect(
      service.createWorkspace({
        input: {
          ...workspaceInput(),
          metadata: { apiKey: "synthetic-api-secret" },
        },
        context,
      }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });

    const persisted = await store.transaction(async (repos) => ({
      workspace: await repos.workspaces.get("workspace-1", "workspace-1"),
      audit: await repos.audit.get("audit-1", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-1"),
    }));
    expect(persisted).toEqual({
      workspace: undefined,
      audit: undefined,
      idempotency: undefined,
    });
    expect(ids.calls).toBe(0);
  });

  it("rejects nested secrets in direct source commands before any source writes", async () => {
    await service.createWorkspace({ input: workspaceInput(), context });

    await expect(
      service.registerSource({
        input: {
          id: "source-1",
          workspaceId: "workspace-1",
          name: "Inline credentials",
          type: "api",
          ownership: "authorized",
          metadata: {
            nested: [{ credentials: { apiKey: "synthetic-api-secret" } }],
            access_token: "synthetic-token-secret",
          },
        },
        context: {
          ...context,
          requestId: "request-2",
          idempotencyKey: "command-2",
        },
      }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });

    const persisted = await store.transaction(async (repos) => ({
      source: await repos.sources.get("source-1", "workspace-1"),
      audit: await repos.audit.get("audit-2", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-2"),
    }));
    expect(persisted).toEqual({
      source: undefined,
      audit: undefined,
      idempotency: undefined,
    });
    expect(ids.calls).toBe(1);
  });

  it("returns NOT_FOUND before inserting a reference-free finding into a missing workspace", async () => {
    const attemptContext = { actor: "agent-1", requestId: "request-missing", idempotencyKey: "command-missing" };

    await expect(service.recordFinding({
      input: {
        id: "finding-missing-workspace",
        workspaceId: "workspace-missing",
        kind: "unknown",
        statement: "The workspace is unknown",
        evidenceIds: [],
        unknownReason: "No workspace exists",
      },
      context: attemptContext,
    })).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });

    const persisted = await store.transaction(async (repos) => ({
      finding: await repos.findings.get("finding-missing-workspace", "workspace-missing"),
      audit: await repos.audit.get("audit-1", "workspace-missing"),
      idempotency: await repos.idempotency.get("workspace-missing", attemptContext.idempotencyKey),
    }));
    expect(persisted).toEqual({ finding: undefined, audit: undefined, idempotency: undefined });
  });

  it("scopes identical idempotency keys independently by workspace", async () => {
    const first = await service.createWorkspace({
      input: workspaceInput(),
      context,
    });
    const second = await service.createWorkspace({
      input: { id: "workspace-2", name: "Contoso" },
      context: { ...context, requestId: "request-2" },
    });

    expect(second).toMatchObject({
      id: "workspace-2",
      workspaceId: "workspace-2",
      name: "Contoso",
    });
    expect(second).not.toEqual(first);
    const persisted = await store.transaction(async (repos) => ({
      first: await repos.idempotency.get("workspace-1", "command-1"),
      second: await repos.idempotency.get("workspace-2", "command-1"),
    }));
    expect(persisted.first?.response).toEqual(first);
    expect(persisted.second?.response).toEqual(second);
  });

  it("registers dataset definitions, limitations, and provenance through the pipeline", async () => {
    await service.createWorkspace({ input: workspaceInput(), context });
    await service.registerSource({
      input: {
        id: "source-1",
        workspaceId: "workspace-1",
        name: "Warehouse",
        type: "database",
        ownership: "owned",
      },
      context: { ...context, requestId: "request-2", idempotencyKey: "command-2" },
    });

    const dataset = await service.registerDataset({
      input: datasetInput(),
      context: { ...context, requestId: "request-3", idempotencyKey: "command-3" },
    });

    expect(dataset).toEqual({
      ...datasetInput(),
      version: 1,
      createdAt: firstNow,
      updatedAt: firstNow,
    });
    const persisted = await store.transaction(async (repos) => ({
      dataset: await repos.datasets.get("dataset-1", "workspace-1"),
      audit: await repos.audit.get("audit-3", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-3"),
    }));
    expect(persisted.dataset).toEqual(dataset);
    expect(persisted.audit).toMatchObject({
      action: "dataset.register",
      entityType: "dataset",
      entityId: "dataset-1",
    });
    expect(persisted.idempotency?.response).toEqual(dataset);
  });

  it("rejects a dataset whose source does not exist in the caller workspace", async () => {
    await service.createWorkspace({ input: workspaceInput(), context });

    await expect(
      service.registerDataset({
        input: datasetInput(),
        context: { ...context, requestId: "request-2", idempotencyKey: "command-2" },
      }),
    ).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });

    const persisted = await store.transaction(async (repos) => ({
      dataset: await repos.datasets.get("dataset-1", "workspace-1"),
      audit: await repos.audit.get("audit-2", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-2"),
    }));
    expect(persisted).toEqual({
      dataset: undefined,
      audit: undefined,
      idempotency: undefined,
    });
  });

  it("rejects evidence that resolves a source only in another workspace", async () => {
    await service.createWorkspace({ input: workspaceInput(), context });
    await service.createWorkspace({
      input: { id: "workspace-2", name: "Contoso" },
      context: { ...context, requestId: "request-2", idempotencyKey: "command-2" },
    });
    await service.registerSource({
      input: {
        id: "source-1",
        workspaceId: "workspace-2",
        name: "Other workspace source",
        type: "manual",
        ownership: "owned",
      },
      context: { ...context, requestId: "request-3", idempotencyKey: "command-3" },
    });

    await expect(
      service.recordEvidence({
        input: evidenceInput(),
        context: { ...context, requestId: "request-4", idempotencyKey: "command-4" },
      }),
    ).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });

    const persisted = await store.transaction(async (repos) => ({
      evidence: await repos.evidence.get("evidence-1", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-4"),
    }));
    expect(persisted).toEqual({ evidence: undefined, idempotency: undefined });
  });

  it("rejects a dataset with an inverted coverage range", async () => {
    await service.createWorkspace({ input: workspaceInput(), context });
    await service.registerSource({
      input: {
        id: "source-1",
        workspaceId: "workspace-1",
        name: "Warehouse",
        type: "database",
        ownership: "owned",
      },
      context: { ...context, requestId: "request-2", idempotencyKey: "command-2" },
    });

    await expect(
      service.registerDataset({
        input: {
          ...datasetInput(),
          coverageStart: "2026-02-01T00:00:00.000Z",
          coverageEnd: "2026-01-01T00:00:00.000Z",
        },
        context: { ...context, requestId: "request-3", idempotencyKey: "command-3" },
      }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    expect(
      await store.transaction((repos) =>
        repos.datasets.get("dataset-1", "workspace-1"),
      ),
    ).toBeUndefined();
  });

  it("rejects evidence without a SHA-256 hexadecimal content hash", async () => {
    await service.createWorkspace({ input: workspaceInput(), context });
    await service.registerSource({
      input: {
        id: "source-1",
        workspaceId: "workspace-1",
        name: "Warehouse",
        type: "database",
        ownership: "owned",
      },
      context: { ...context, requestId: "request-2", idempotencyKey: "command-2" },
    });

    await expect(
      service.recordEvidence({
        input: { ...evidenceInput(), contentHash: "not-a-sha256-hash" },
        context: { ...context, requestId: "request-3", idempotencyKey: "command-3" },
      }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    expect(
      await store.transaction((repos) =>
        repos.evidence.get("evidence-1", "workspace-1"),
      ),
    ).toBeUndefined();
  });

  it("rejects evidence observed at a non-UTC timestamp", async () => {
    await service.createWorkspace({ input: workspaceInput(), context });
    await service.registerSource({
      input: {
        id: "source-1",
        workspaceId: "workspace-1",
        name: "Warehouse",
        type: "database",
        ownership: "owned",
      },
      context: { ...context, requestId: "request-2", idempotencyKey: "command-2" },
    });

    await expect(
      service.recordEvidence({
        input: { ...evidenceInput(), observedAt: "2026-02-01T08:00:00+08:00" },
        context: { ...context, requestId: "request-3", idempotencyKey: "command-3" },
      }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it("rejects owned conversion facts backed only by an external public source", async () => {
    await service.createWorkspace({ input: workspaceInput(), context });
    await service.registerSource({
      input: {
        id: "source-1",
        workspaceId: "workspace-1",
        name: "Public research",
        type: "link",
        ownership: "external_public",
      },
      context: { ...context, requestId: "request-2", idempotencyKey: "command-2" },
    });

    await expect(
      service.recordEvidence({
        input: { ...evidenceInput(), classification: "owned_conversion" },
        context: { ...context, requestId: "request-3", idempotencyKey: "command-3" },
      }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    expect(
      await store.transaction((repos) =>
        repos.evidence.get("evidence-1", "workspace-1"),
      ),
    ).toBeUndefined();
  });

  it("records valid internal and external evidence with their classifications", async () => {
    await service.createWorkspace({ input: workspaceInput(), context });
    await service.registerSource({
      input: {
        id: "source-1",
        workspaceId: "workspace-1",
        name: "Warehouse",
        type: "database",
        ownership: "owned",
      },
      context: { ...context, requestId: "request-2", idempotencyKey: "command-2" },
    });
    await service.registerSource({
      input: {
        id: "source-2",
        workspaceId: "workspace-1",
        name: "Public research",
        type: "link",
        ownership: "external_public",
      },
      context: { ...context, requestId: "request-3", idempotencyKey: "command-3" },
    });

    const internal = await service.recordEvidence({
      input: evidenceInput(),
      context: { ...context, requestId: "request-4", idempotencyKey: "command-4" },
    });
    const external = await service.recordEvidence({
      input: {
        ...evidenceInput(),
        id: "evidence-2",
        sourceId: "source-2",
        sourceLocator: "https://example.test/research?view=summary&keynote=public",
        summary: "Published market size observation",
        contentHash: "b".repeat(64),
        classification: "external_observation",
      },
      context: { ...context, requestId: "request-5", idempotencyKey: "command-5" },
    });

    expect(internal).toEqual({
      ...evidenceInput(),
      version: 1,
      createdAt: firstNow,
      updatedAt: firstNow,
    });
    expect(external).toMatchObject({
      id: "evidence-2",
      sourceId: "source-2",
      sourceLocator: "https://example.test/research?view=summary&keynote=public",
      classification: "external_observation",
    });
    const persisted = await store.transaction(async (repos) => ({
      internal: await repos.evidence.get("evidence-1", "workspace-1"),
      external: await repos.evidence.get("evidence-2", "workspace-1"),
      audit: await repos.audit.get("audit-5", "workspace-1"),
    }));
    expect(persisted.internal).toEqual(internal);
    expect(persisted.external).toEqual(external);
    expect(persisted.audit).toMatchObject({
      action: "evidence.record",
      entityType: "evidence",
      entityId: "evidence-2",
    });
  });

  it.each([
    {
      label: "URL userinfo",
      sourceLocator: "https://user:synthetic-password@example.test/report",
      secret: "synthetic-password",
    },
    {
      label: "URL access token query",
      sourceLocator: "https://example.test/report?access_token=synthetic-token",
      secret: "synthetic-token",
    },
    {
      label: "mixed-case URL API key query",
      sourceLocator: "https://example.test/report?ApiKey=synthetic-api-key",
      secret: "synthetic-api-key",
    },
    {
      label: "mixed-case URL client secret query",
      sourceLocator: "https://example.test/report?CLIENT_SECRET=synthetic-secret",
      secret: "synthetic-secret",
    },
    {
      label: "plain key query",
      sourceLocator: "https://example.test/report?Key=synthetic-key",
      secret: "synthetic-key",
    },
    {
      label: "non-URL secret parameter",
      sourceLocator: "warehouse/report?Token=synthetic-non-url-token",
      secret: "synthetic-non-url-token",
    },
    {
      label: "non-URL semicolon secret parameter",
      sourceLocator: "warehouse/report;Password=synthetic-non-url-password",
      secret: "synthetic-non-url-password",
    },
  ])("rejects $label before evidence persistence", async ({ sourceLocator, secret }) => {
    await service.createWorkspace({ input: workspaceInput(), context });
    await service.registerSource({
      input: {
        id: "source-1",
        workspaceId: "workspace-1",
        name: "Warehouse",
        type: "database",
        ownership: "owned",
      },
      context: { ...context, requestId: "request-2", idempotencyKey: "command-2" },
    });

    const error = await service.recordEvidence({
      input: { ...evidenceInput(), sourceLocator },
      context: { ...context, requestId: "request-3", idempotencyKey: "command-3" },
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    const persisted = await store.transaction(async (repos) => ({
      evidence: await repos.evidence.get("evidence-1", "workspace-1"),
      audit: await repos.audit.get("audit-3", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-3"),
    }));
    expect(persisted).toEqual({
      evidence: undefined,
      audit: undefined,
      idempotency: undefined,
    });
    expect(ids.calls).toBe(2);
  });

  it.each([
    {
      label: "unsupported classification",
      input: { ...evidenceInput(), classification: "unsupported" as never },
    },
    {
      label: "blank source locator",
      input: { ...evidenceInput(), sourceLocator: "   " },
    },
    {
      label: "blank summary",
      input: { ...evidenceInput(), summary: "\t\n" },
    },
  ])("rejects $label from a direct untrusted service call", async ({ input }) => {
    await service.createWorkspace({ input: workspaceInput(), context });
    await service.registerSource({
      input: {
        id: "source-1",
        workspaceId: "workspace-1",
        name: "Warehouse",
        type: "database",
        ownership: "owned",
      },
      context: { ...context, requestId: "request-2", idempotencyKey: "command-2" },
    });

    await expect(
      service.recordEvidence({
        input,
        context: { ...context, requestId: "request-3", idempotencyKey: "command-3" },
      }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });

    const persisted = await store.transaction(async (repos) => ({
      evidence: await repos.evidence.get("evidence-1", "workspace-1"),
      audit: await repos.audit.get("audit-3", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-3"),
    }));
    expect(persisted).toEqual({
      evidence: undefined,
      audit: undefined,
      idempotency: undefined,
    });
    expect(ids.calls).toBe(2);
  });

  it.each([
    {
      label: "fact without evidence",
      input: { ...findingInput(), kind: "fact" as const, evidenceIds: [] },
    },
    {
      label: "inference without evidence",
      input: { ...findingInput(), evidenceIds: [] },
    },
    {
      label: "with an unsupported kind",
      input: { ...findingInput(), kind: "unsupported" as never },
    },
  ])("rejects a finding $label from a direct service call", async ({ input }) => {
    await expect(
      service.recordFinding({ input, context }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });

    const persisted = await store.transaction(async (repos) => ({
      finding: await repos.findings.get("finding-1", "workspace-1"),
      audit: await repos.audit.get("audit-1", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-1"),
    }));
    expect(persisted).toEqual({
      finding: undefined,
      audit: undefined,
      idempotency: undefined,
    });
    expect(ids.calls).toBe(0);
  });

  it("rejects a finding inference without limitations", async () => {
    const { limitations: _limitations, ...input } = findingInput();

    await expect(
      service.recordFinding({ input, context }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    const persisted = await store.transaction(async (repos) => ({
      finding: await repos.findings.get("finding-1", "workspace-1"),
      audit: await repos.audit.get("audit-1", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-1"),
    }));
    expect(persisted).toEqual({
      finding: undefined,
      audit: undefined,
      idempotency: undefined,
    });
  });

  it("rejects a finding unknown without a reason", async () => {
    await expect(
      service.recordFinding({
        input: {
          id: "finding-1",
          workspaceId: "workspace-1",
          kind: "unknown",
          statement: "The cause of the revenue increase is unknown",
          evidenceIds: [],
        },
        context,
      }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    const persisted = await store.transaction(async (repos) => ({
      finding: await repos.findings.get("finding-1", "workspace-1"),
      audit: await repos.audit.get("audit-1", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-1"),
    }));
    expect(persisted).toEqual({
      finding: undefined,
      audit: undefined,
      idempotency: undefined,
    });
  });

  it("rejects a finding that references evidence in another workspace", async () => {
    await recordEvidencePair();
    await service.createWorkspace({
      input: { id: "workspace-2", name: "Contoso" },
      context: { ...context, requestId: "request-5", idempotencyKey: "command-5" },
    });
    await service.registerSource({
      input: {
        id: "source-other",
        workspaceId: "workspace-2",
        name: "Other warehouse",
        type: "database",
        ownership: "owned",
      },
      context: { ...context, requestId: "request-6", idempotencyKey: "command-6" },
    });
    await service.recordEvidence({
      input: {
        ...evidenceInput(),
        id: "evidence-other",
        workspaceId: "workspace-2",
        sourceId: "source-other",
      },
      context: { ...context, requestId: "request-7", idempotencyKey: "command-7" },
    });

    await expect(
      service.recordFinding({
        input: {
          ...findingInput(),
          evidenceIds: ["evidence-1", "evidence-other"],
        },
        context: { ...context, requestId: "request-8", idempotencyKey: "command-8" },
      }),
    ).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });

    const persisted = await store.transaction(async (repos) => ({
      finding: await repos.findings.get("finding-1", "workspace-1"),
      audit: await repos.audit.get("audit-8", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-8"),
    }));
    expect(persisted).toEqual({
      finding: undefined,
      audit: undefined,
      idempotency: undefined,
    });
  });

  it("rejects a finding whose evidence ID resolves to another entity type", async () => {
    await recordEvidencePair();

    await expect(
      service.recordFinding({
        input: { ...findingInput(), evidenceIds: ["source-1"] },
        context: { ...context, requestId: "request-5", idempotencyKey: "command-5" },
      }),
    ).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    const persisted = await store.transaction(async (repos) => ({
      finding: await repos.findings.get("finding-1", "workspace-1"),
      audit: await repos.audit.get("audit-5", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-5"),
    }));
    expect(persisted).toEqual({
      finding: undefined,
      audit: undefined,
      idempotency: undefined,
    });
  });

  it.each([
    {
      label: "a blank statement",
      input: { ...findingInput(), statement: " \t\n" },
    },
    {
      label: "null evidence IDs",
      input: { ...findingInput(), evidenceIds: null as never },
    },
    {
      label: "object evidence IDs",
      input: { ...findingInput(), evidenceIds: { 0: "evidence-1" } as never },
    },
    {
      label: "a non-string evidence ID",
      input: { ...findingInput(), evidenceIds: [42] as never },
    },
    {
      label: "sparse evidence IDs",
      input: { ...findingInput(), evidenceIds: new Array(1) as never },
    },
    {
      label: "a blank evidence ID",
      input: { ...findingInput(), evidenceIds: [" \t"] },
    },
    {
      label: "duplicate evidence IDs",
      input: {
        ...findingInput(),
        evidenceIds: ["evidence-1", "evidence-1"],
      },
    },
  ])("rejects a finding with $label without command residue", async ({ input }) => {
    await recordEvidencePair();

    await expect(
      service.recordFinding({
        input,
        context: { ...context, requestId: "request-5", idempotencyKey: "command-5" },
      }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });

    const persisted = await store.transaction(async (repos) => ({
      finding: await repos.findings.get("finding-1", "workspace-1"),
      audit: await repos.audit.get("audit-5", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-5"),
    }));
    expect(persisted).toEqual({
      finding: undefined,
      audit: undefined,
      idempotency: undefined,
    });
  });

  it("replays a finding without duplicate writes", async () => {
    await recordEvidencePair();
    const first = await service.recordFinding({
      input: findingInput(),
      context: { ...context, requestId: "request-5", idempotencyKey: "command-5" },
    });
    clock.set(secondNow);

    const replay = await service.recordFinding({
      input: {
        statement: "January revenue growth was driven by repeat customers",
        evidenceIds: ["evidence-2", "evidence-1"],
        limitations: "Attribution is limited to the observed customer cohort",
        kind: "inference",
        workspaceId: "workspace-1",
        id: "finding-1",
      },
      context: {
        ...context,
        requestId: "request-replay",
        idempotencyKey: "command-5",
      },
    });

    expect(replay).toEqual(first);
    expect(replay.createdAt).toBe(firstNow);
    expect(ids.calls).toBe(5);
    expect(
      await store.transaction((repos) =>
        repos.audit.get("audit-6", "workspace-1"),
      ),
    ).toBeUndefined();
  });

  it("records a supported finding inference with ordered evidence lineage", async () => {
    await recordEvidencePair();

    const finding = await service.recordFinding({
      input: findingInput(),
      context: { ...context, requestId: "request-5", idempotencyKey: "command-5" },
    });

    expect(finding).toEqual({
      ...findingInput(),
      version: 1,
      createdAt: firstNow,
      updatedAt: firstNow,
    });
    expect(finding.evidenceIds).toEqual(["evidence-2", "evidence-1"]);
    const persisted = await store.transaction(async (repos) => ({
      finding: await repos.findings.get("finding-1", "workspace-1"),
      audit: await repos.audit.get("audit-5", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", "command-5"),
    }));
    expect(persisted.finding).toEqual(finding);
    expect(persisted.audit).toMatchObject({
      action: "finding.record",
      entityType: "finding",
      entityId: "finding-1",
    });
    expect(persisted.idempotency?.response).toEqual(finding);
  });
  it.each([
    { label: "blank ID", input: { ...workspaceInput(), id: " \t" }, context },
    { label: "blank name", input: { ...workspaceInput(), name: " \n" }, context },
    { label: "non-string name", input: { ...workspaceInput(), name: 42 as never }, context },
    { label: "sparse metadata", input: { ...workspaceInput(), metadata: new Array(1) as never }, context },
    { label: "blank actor", input: workspaceInput(), context: { ...context, actor: " " } },
    { label: "blank request ID", input: workspaceInput(), context: { ...context, requestId: "\t" } },
    { label: "missing idempotency key", input: workspaceInput(), context: { ...context, idempotencyKey: undefined as never } },
    { label: "missing context", input: workspaceInput(), context: null as never },
  ])("rejects workspace $label from a direct service call without residue", async ({ input, context: attemptContext }) => {
    await expect(service.createWorkspace({ input, context: attemptContext }))
      .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });

    const scope = typeof input.id === "string" ? input.id : "workspace-1";
    const key = typeof attemptContext?.idempotencyKey === "string"
      ? attemptContext.idempotencyKey
      : "command-1";
    const persisted = await store.transaction(async (repos) => ({
      workspace: await repos.workspaces.get(scope, scope),
      audit: await repos.audit.get("audit-1", scope),
      idempotency: await repos.idempotency.get(scope, key),
    }));
    expect(persisted).toEqual({ workspace: undefined, audit: undefined, idempotency: undefined });
  });

  it.each([
    { field: "id", value: " " },
    { field: "workspaceId", value: "\t" },
    { field: "name", value: " \n" },
    { field: "type", value: "unsupported" },
    { field: "ownership", value: "public" },
    { field: "metadata", value: new Array(1) as never },
  ])("rejects source $field from a direct service call without residue", async ({ field, value }) => {
    await service.createWorkspace({ input: workspaceInput(), context });
    const input = {
      id: "source-1",
      workspaceId: "workspace-1",
      name: "Warehouse",
      type: "database",
      ownership: "owned",
      [field]: value,
    };
    const attemptContext = { actor: "agent-1", requestId: "request-2", idempotencyKey: "command-2" };

    await expect(service.registerSource({ input: input as never, context: attemptContext }))
      .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });

    const persisted = await store.transaction(async (repos) => ({
      source: await repos.sources.get(input.id, input.workspaceId),
      audit: await repos.audit.get("audit-2", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", attemptContext.idempotencyKey),
    }));
    expect(persisted).toEqual({ source: undefined, audit: undefined, idempotency: undefined });
  });

  it.each([
    { field: "id", value: " " },
    { field: "sourceId", value: "\t" },
    { field: "name", value: null },
    { field: "fieldDefinitions", value: new Array(1) as never },
    { field: "metricDefinitions", value: new Array(1) as never },
    { field: "limitations", value: new Array(1) as never },
  ])("rejects dataset $field from a direct service call without residue", async ({ field, value }) => {
    await service.createWorkspace({ input: workspaceInput(), context });
    await service.registerSource({
      input: {
        id: "source-1",
        workspaceId: "workspace-1",
        name: "Warehouse",
        type: "database",
        ownership: "owned",
      },
      context: { actor: "agent-1", requestId: "request-2", idempotencyKey: "command-2" },
    });
    const input = { ...datasetInput(), [field]: value };
    const attemptContext = { actor: "agent-1", requestId: "request-3", idempotencyKey: "command-3" };

    await expect(service.registerDataset({ input, context: attemptContext }))
      .rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });

    const persisted = await store.transaction(async (repos) => ({
      dataset: await repos.datasets.get(input.id, input.workspaceId),
      audit: await repos.audit.get("audit-3", "workspace-1"),
      idempotency: await repos.idempotency.get("workspace-1", attemptContext.idempotencyKey),
    }));
    expect(persisted).toEqual({ dataset: undefined, audit: undefined, idempotency: undefined });
  });
});

describe("MarketingService recommendations and tasks", () => {
  let store: Store;
  let clock: TestClock;
  let ids: TestIds;
  let service: MarketingService;
  let commandSequence: number;

  beforeEach(async () => {
    store = openStore(":memory:");
    clock = new TestClock();
    ids = new TestIds(Array.from({ length: 100 }, (_, index) => `audit-${index + 1}`));
    service = new MarketingService(store, clock, ids);
    commandSequence = 0;
    await service.createWorkspace({
      input: workspaceInput(),
      context: nextContext(),
    });
    await service.registerSource({
      input: {
        id: "source-1",
        workspaceId: "workspace-1",
        name: "Warehouse",
        type: "database",
        ownership: "owned",
      },
      context: nextContext(),
    });
    await service.recordEvidence({
      input: evidenceInput(),
      context: nextContext(),
    });
    await service.recordFinding({
      input: {
        id: "finding-1",
        workspaceId: "workspace-1",
        kind: "fact",
        statement: "January revenue reconciled to the ledger",
        evidenceIds: ["evidence-1"],
      },
      context: nextContext(),
    });
  });

  afterEach(() => {
    store.close();
  });

  function nextContext(): CommandContext {
    commandSequence += 1;
    return {
      actor: "agent-1",
      requestId: `task-request-${commandSequence}`,
      idempotencyKey: `task-command-${commandSequence}`,
    };
  }

  function recommendationInput() {
    return {
      id: "recommendation-1",
      workspaceId: "workspace-1",
      findingIds: ["finding-1"],
      hypothesis: "A repeat-customer campaign will increase retained revenue",
      affectedStage: "retention",
      priority: "high",
      expectedMetric: "repeat_customer_revenue",
    };
  }

  function taskInput() {
    return {
      id: "task-1",
      workspaceId: "workspace-1",
      recommendationIds: ["recommendation-1"],
      assignee: "lifecycle-marketer",
      dependencyIds: [] as string[],
      assetRequirements: ["approved email template"],
      acceptanceCriteria: ["Campaign is approved and scheduled"],
    };
  }

  async function createRecommendation(id = "recommendation-1") {
    return service.createRecommendation({
      input: { ...recommendationInput(), id },
      context: nextContext(),
    });
  }

  async function createTask(
    id: string,
    dependencyIds: string[] = [],
    recommendationIds = ["recommendation-1"],
  ) {
    return service.createTask({
      input: {
        ...taskInput(),
        id,
        dependencyIds,
        recommendationIds,
      },
      context: nextContext(),
    });
  }

  it("creates a recommendation and an auditable draft task", async () => {
    const recommendation = await createRecommendation();
    expect(recommendation).toEqual({
      ...recommendationInput(),
      version: 1,
      createdAt: firstNow,
      updatedAt: firstNow,
    });

    const task = await createTask("task-1");
    expect(task).toEqual({
      ...taskInput(),
      state: "draft",
      version: 1,
      createdAt: firstNow,
      updatedAt: firstNow,
    });
    expect(
      await store.transaction((repos) =>
        repos.audit.get("audit-6", "workspace-1"),
      ),
    ).toMatchObject({
      action: "task.create",
      entityType: "task",
      entityId: "task-1",
    });
  });

  it.each([{ acceptanceCriteria: [] }, { acceptanceCriteria: [" \t\n"] }])(
    "rejects empty acceptance criteria $acceptanceCriteria without task residue",
    async ({ acceptanceCriteria }) => {
      await createRecommendation();

      await expect(
        service.createTask({
          input: { ...taskInput(), acceptanceCriteria },
          context: nextContext(),
        }),
      ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
      expect(
        await store.transaction((repos) => repos.tasks.get("task-1", "workspace-1")),
      ).toBeUndefined();
    },
  );

  it("rejects a recommendation with a nonexistent finding", async () => {
    await expect(
      service.createRecommendation({
        input: { ...recommendationInput(), findingIds: ["finding-missing"] },
        context: nextContext(),
      }),
    ).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
  });

  it("rejects a recommendation that resolves a finding only in another workspace", async () => {
    await service.createWorkspace({
      input: { id: "workspace-2", name: "Contoso" },
      context: nextContext(),
    });
    await service.registerSource({
      input: {
        id: "source-other",
        workspaceId: "workspace-2",
        name: "Other warehouse",
        type: "database",
        ownership: "owned",
      },
      context: nextContext(),
    });
    await service.recordEvidence({
      input: {
        ...evidenceInput(),
        id: "evidence-other",
        workspaceId: "workspace-2",
        sourceId: "source-other",
      },
      context: nextContext(),
    });
    await service.recordFinding({
      input: {
        id: "finding-other",
        workspaceId: "workspace-2",
        kind: "fact",
        statement: "An observation private to another workspace",
        evidenceIds: ["evidence-other"],
      },
      context: nextContext(),
    });

    await expect(
      service.createRecommendation({
        input: { ...recommendationInput(), findingIds: ["finding-other"] },
        context: nextContext(),
      }),
    ).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    expect(
      await store.transaction((repos) =>
        repos.recommendations.get("recommendation-1", "workspace-1"),
      ),
    ).toBeUndefined();
  });

  it("rejects a self-dependency before persistence", async () => {
    await createRecommendation();

    await expect(
      createTask("task-1", ["task-1"]),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    expect(
      await store.transaction((repos) => repos.tasks.get("task-1", "workspace-1")),
    ).toBeUndefined();
  });

  it("rejects dependencies and recommendations outside the workspace", async () => {
    await createRecommendation();
    await store.transaction(async (repos) => {
      await repos.workspaces.insert({
        id: "workspace-2",
        workspaceId: "workspace-2",
        version: 1,
        createdAt: firstNow,
        updatedAt: firstNow,
        name: "Contoso",
      });
      await repos.tasks.insert({
        id: "task-other-workspace",
        workspaceId: "workspace-2",
        version: 1,
        createdAt: firstNow,
        updatedAt: firstNow,
        recommendationIds: [],
        assignee: "other-marketer",
        dependencyIds: [],
        assetRequirements: [],
        acceptanceCriteria: ["Other workspace criterion"],
        state: "draft",
      });
      await repos.recommendations.insert({
        ...(await repos.recommendations.get("recommendation-1", "workspace-1"))!,
        id: "recommendation-other",
        workspaceId: "workspace-2",
        findingIds: [],
      });
    });

    await expect(
      createTask("task-2", ["task-other-workspace"]),
    ).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    await expect(
      createTask("task-3", [], ["recommendation-other"]),
    ).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
  });

  it("blocks readiness until every dependency is completed", async () => {
    await createRecommendation();
    await createTask("dependency-1");
    const task = await createTask("task-1", ["dependency-1"]);

    await expect(
      service.transitionTask({
        input: { id: task.id, workspaceId: task.workspaceId, next: "ready", expectedVersion: 1 },
        context: nextContext(),
      }),
    ).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });

    for (const [index, next] of (["ready", "in_progress", "completed"] as const).entries()) {
      await service.transitionTask({
        input: { id: "dependency-1", workspaceId: "workspace-1", next, expectedVersion: index + 1 },
        context: nextContext(),
      });
    }
    await service.transitionTask({
      input: { id: task.id, workspaceId: task.workspaceId, next: "ready", expectedVersion: 1 },
      context: nextContext(),
    });
    const started = await service.transitionTask({
      input: { id: task.id, workspaceId: task.workspaceId, next: "in_progress", expectedVersion: 2 },
      context: nextContext(),
    });
    expect(started).toMatchObject({ state: "in_progress", version: 3 });
  });

  it("updates task state with the caller expected version through the command pipeline", async () => {
    await createRecommendation();
    await createTask("task-1");
    clock.set(secondNow);

    const ready = await service.transitionTask({
      input: { id: "task-1", workspaceId: "workspace-1", next: "ready", expectedVersion: 1 },
      context: nextContext(),
    });

    expect(ready).toMatchObject({
      state: "ready",
      version: 2,
      createdAt: firstNow,
      updatedAt: secondNow,
    });
    expect(
      await store.transaction((repos) =>
        repos.audit.get("audit-7", "workspace-1"),
      ),
    ).toMatchObject({ action: "task.transition", entityId: "task-1" });
  });

  it("does not allow the legacy transition command to reject a task without a rejection reason", async () => {
    await createRecommendation();
    await createTask("task-1");

    await expect(
      service.transitionTask({
        input: { id: "task-1", workspaceId: "workspace-1", next: "rejected", expectedVersion: 1 },
        context: nextContext(),
      }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    expect(
      await store.transaction((repos) => repos.tasks.get("task-1", "workspace-1")),
    ).toMatchObject({ state: "draft", version: 1 });

    await expect(service.transitionTask({
      input: { id: "task-1", workspaceId: "workspace-1", next: "ready", expectedVersion: 1 },
      context: nextContext(),
    })).resolves.toMatchObject({ state: "ready", version: 2 });
  });

  it("rejects a task transition with a stale expected version", async () => {
    await createRecommendation();
    await createTask("task-1");
    await service.transitionTask({
      input: { id: "task-1", workspaceId: "workspace-1", next: "ready", expectedVersion: 1 },
      context: nextContext(),
    });

    await expect(
      service.transitionTask({
        input: { id: "task-1", workspaceId: "workspace-1", next: "in_progress", expectedVersion: 1 },
        context: nextContext(),
      }),
    ).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
    expect(
      await store.transaction((repos) => repos.tasks.get("task-1", "workspace-1")),
    ).toMatchObject({ state: "ready", version: 2 });
  });

  it("returns ordered lineage nodes, directed edges, and audit request IDs", async () => {
    await createRecommendation();
    await createTask("task-1");
    await service.transitionTask({
      input: { id: "task-1", workspaceId: "workspace-1", next: "ready", expectedVersion: 1 },
      context: nextContext(),
    });
    await service.registerDataset({
      input: datasetInput(),
      context: nextContext(),
    });

    const lineage = await service.getLineage({
      entityType: "task",
      id: "task-1",
      workspaceId: "workspace-1",
    });

    expect(lineage).toEqual({
      workspaceId: "workspace-1",
      nodes: [
        { entityType: "source", id: "source-1", version: 1, auditRequestIds: ["task-request-2"] },
        { entityType: "evidence", id: "evidence-1", version: 1, auditRequestIds: ["task-request-3"] },
        { entityType: "finding", id: "finding-1", version: 1, auditRequestIds: ["task-request-4"] },
        { entityType: "recommendation", id: "recommendation-1", version: 1, auditRequestIds: ["task-request-5"] },
        { entityType: "task", id: "task-1", version: 2, auditRequestIds: ["task-request-6", "task-request-7"] },
      ],
      edges: [
        { from: { entityType: "source", id: "source-1" }, to: { entityType: "evidence", id: "evidence-1" } },
        { from: { entityType: "evidence", id: "evidence-1" }, to: { entityType: "finding", id: "finding-1" } },
        { from: { entityType: "finding", id: "finding-1" }, to: { entityType: "recommendation", id: "recommendation-1" } },
        { from: { entityType: "recommendation", id: "recommendation-1" }, to: { entityType: "task", id: "task-1" } },
      ],
    });
    await expect(
      service.getLineage({ entityType: "dataset", id: "dataset-1", workspaceId: "workspace-1" }),
    ).resolves.toMatchObject({
      nodes: [
        { entityType: "source", id: "source-1" },
        { entityType: "dataset", id: "dataset-1", auditRequestIds: ["task-request-8"] },
      ],
      edges: [
        { from: { entityType: "source", id: "source-1" }, to: { entityType: "dataset", id: "dataset-1" } },
      ],
    });
  });

  it("includes task dependencies and their complete upstream lineage with shared ancestors deduplicated", async () => {
    await createRecommendation();
    await createTask("task-shared");
    await createTask("task-dependency-a", ["task-shared"]);
    await createTask("task-dependency-b", ["task-shared"]);
    await createTask("task-final", ["task-dependency-a", "task-dependency-b"]);

    const lineage = await service.getLineage({
      entityType: "task",
      id: "task-final",
      workspaceId: "workspace-1",
    });

    expect(lineage.nodes).toEqual([
      { entityType: "source", id: "source-1", version: 1, auditRequestIds: ["task-request-2"] },
      { entityType: "evidence", id: "evidence-1", version: 1, auditRequestIds: ["task-request-3"] },
      { entityType: "finding", id: "finding-1", version: 1, auditRequestIds: ["task-request-4"] },
      { entityType: "recommendation", id: "recommendation-1", version: 1, auditRequestIds: ["task-request-5"] },
      { entityType: "task", id: "task-shared", version: 1, auditRequestIds: ["task-request-6"] },
      { entityType: "task", id: "task-dependency-a", version: 1, auditRequestIds: ["task-request-7"] },
      { entityType: "task", id: "task-dependency-b", version: 1, auditRequestIds: ["task-request-8"] },
      { entityType: "task", id: "task-final", version: 1, auditRequestIds: ["task-request-9"] },
    ]);
    expect(lineage.edges).toEqual([
      { from: { entityType: "source", id: "source-1" }, to: { entityType: "evidence", id: "evidence-1" } },
      { from: { entityType: "evidence", id: "evidence-1" }, to: { entityType: "finding", id: "finding-1" } },
      { from: { entityType: "finding", id: "finding-1" }, to: { entityType: "recommendation", id: "recommendation-1" } },
      { from: { entityType: "recommendation", id: "recommendation-1" }, to: { entityType: "task", id: "task-shared" } },
      { from: { entityType: "recommendation", id: "recommendation-1" }, to: { entityType: "task", id: "task-dependency-a" } },
      { from: { entityType: "recommendation", id: "recommendation-1" }, to: { entityType: "task", id: "task-dependency-b" } },
      { from: { entityType: "recommendation", id: "recommendation-1" }, to: { entityType: "task", id: "task-final" } },
      { from: { entityType: "task", id: "task-shared" }, to: { entityType: "task", id: "task-dependency-a" } },
      { from: { entityType: "task", id: "task-shared" }, to: { entityType: "task", id: "task-dependency-b" } },
      { from: { entityType: "task", id: "task-dependency-a" }, to: { entityType: "task", id: "task-final" } },
      { from: { entityType: "task", id: "task-dependency-b" }, to: { entityType: "task", id: "task-final" } },
    ]);
  });

  it.each([
    ["dataset", "missing", undefined],
    ["dataset", "null", null],
    ["dataset", "numeric", 42],
    ["evidence", "missing", undefined],
    ["evidence", "null", null],
    ["evidence", "numeric", 42],
  ] as const)(
    "returns not found for %s lineage with a %s scalar source reference",
    async (entityType, _label, sourceId) => {
      const brokenRecord = {
        id: `${entityType}-broken`,
        workspaceId: "workspace-1",
        version: 1,
        createdAt: firstNow,
        updatedAt: firstNow,
        sourceId,
      };
      const brokenStore: Store = {
        transaction: (work) => store.transaction((repos) => work({
          ...repos,
          datasets: { ...repos.datasets, get: async () => brokenRecord },
          evidence: { ...repos.evidence, get: async () => brokenRecord },
        })),
        close: () => undefined,
      };
      const brokenService = new MarketingService(brokenStore, clock, ids);

      await expect(
        brokenService.getLineage({
          entityType,
          id: brokenRecord.id,
          workspaceId: "workspace-1",
        }),
      ).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    },
  );

  it("returns not found for a broken lineage reference", async () => {
    await createRecommendation();
    await createTask("task-1");
    const brokenStore: Store = {
      transaction: (work) => store.transaction((repos) => work({
        ...repos,
        sources: { ...repos.sources, get: async () => undefined },
      })),
      close: () => undefined,
    };
    const brokenService = new MarketingService(brokenStore, clock, ids);

    await expect(
      brokenService.getLineage({ entityType: "task", id: "task-1", workspaceId: "workspace-1" }),
    ).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
  });

  it("projects analysis graph dataset, evidence, and fork-parent lineage", async () => {
    await service.registerDataset({
      input: datasetInput(),
      context: nextContext(),
    });
    const parent = createAnalysisGraph({
      id: "analysis-parent",
      workspaceId: "workspace-1",
      createdAt: firstNow,
      nodes: [
        { id: "question-node", kind: "question", payload: { text: "How?" } },
        { id: "dataset-node", kind: "dataset", payload: { datasetId: "dataset-1" } },
        {
          id: "metric-node",
          kind: "metric",
          payload: { datasetId: "dataset-1", evidenceId: "evidence-1" },
        },
      ],
      edges: [
        { id: "edge-1", fromNodeId: "question-node", toNodeId: "dataset-node" },
        { id: "edge-2", fromNodeId: "dataset-node", toNodeId: "metric-node" },
      ],
    });
    const fork = forkAnalysisGraph(parent, {
      id: "analysis-fork",
      forkNodeId: "metric-node",
      createdAt: secondNow,
    });
    await store.transaction(async (repos) => {
      await repos.analysisGraphs.insert(parent);
      await repos.analysisGraphs.insert(fork);
      for (const [id, entityId, requestId] of [
        ["audit-analysis-parent", parent.id, "analysis-request-parent"],
        ["audit-analysis-fork", fork.id, "analysis-request-fork"],
      ] as const) {
        await repos.audit.append({
          id,
          workspaceId: "workspace-1",
          requestId,
          actor: "agent-1",
          action: "analysis_graph.test",
          entityType: "analysis_graph",
          entityId,
          details: {},
          createdAt: firstNow,
        });
      }
    });

    expect(parent.version).toBe(1);
    await expect(service.getLineage({
      entityType: "analysis_graph",
      id: fork.id,
      workspaceId: "workspace-1",
    })).resolves.toEqual({
      workspaceId: "workspace-1",
      nodes: [
        { entityType: "source", id: "source-1", version: 1, auditRequestIds: ["task-request-2"] },
        { entityType: "dataset", id: "dataset-1", version: 1, auditRequestIds: ["task-request-5"] },
        { entityType: "evidence", id: "evidence-1", version: 1, auditRequestIds: ["task-request-3"] },
        { entityType: "analysis_graph", id: parent.id, version: 1, auditRequestIds: ["analysis-request-parent"] },
        { entityType: "analysis_graph", id: fork.id, version: 1, auditRequestIds: ["analysis-request-fork"] },
      ],
      edges: [
        { from: { entityType: "source", id: "source-1" }, to: { entityType: "dataset", id: "dataset-1" } },
        { from: { entityType: "source", id: "source-1" }, to: { entityType: "evidence", id: "evidence-1" } },
        { from: { entityType: "dataset", id: "dataset-1" }, to: { entityType: "analysis_graph", id: parent.id } },
        { from: { entityType: "dataset", id: "dataset-1" }, to: { entityType: "analysis_graph", id: fork.id } },
        { from: { entityType: "evidence", id: "evidence-1" }, to: { entityType: "analysis_graph", id: parent.id } },
        { from: { entityType: "evidence", id: "evidence-1" }, to: { entityType: "analysis_graph", id: fork.id } },
        { from: { entityType: "analysis_graph", id: parent.id }, to: { entityType: "analysis_graph", id: fork.id } },
      ],
    });
  });

  it("traverses declared Dashboard refs and structured Recommendation evidence/graph refs", async () => {
    await createRecommendation();
    await createTask("task-1");
    await store.transaction(async (repos) => {
      await repos.datasets.insert({
        ...datasetInput(),
        version: 1,
        createdAt: firstNow,
        updatedAt: firstNow,
      });
      await repos.analysisGraphs.insert(createAnalysisGraph({
        id: "graph-structured",
        workspaceId: "workspace-1",
        createdAt: firstNow,
        nodes: [{
          id: "metric-structured",
          kind: "metric",
          payload: { datasetId: "dataset-1", evidenceId: "evidence-1" },
        }],
      }));
      await repos.competitorDiffs.insert({
        id: "diff-structured",
        workspaceId: "workspace-1",
        version: 1,
        createdAt: firstNow,
        updatedAt: firstNow,
        competitorIds: [],
        entries: [],
        findingIds: ["finding-1"],
      });
      const recommendation = (await repos.recommendations.get("recommendation-1", "workspace-1"))!;
      await repos.recommendations.update({
        ...recommendation,
        evidenceIds: ["evidence-1"],
        analysisNodeRefs: [{ graphId: "graph-structured", nodeId: "metric-structured" }],
      }, 1);
      await repos.dashboards.insert(createDashboard({
        id: "dashboard-structured",
        workspaceId: "workspace-1",
        createdAt: firstNow,
        generatedAt: secondNow,
        renderer: { type: "controlled_renderer", id: "controlled_html_svg_v1", professionalTool: false },
        views: [createDashboardView({
          id: "competitor-view",
          kind: "competitor_comparison",
          competitorDiffId: "diff-structured",
          sourceUpdatedAt: secondNow,
          sources: [{ sourceId: "source-1", updatedAt: firstNow }],
          metrics: [],
        })],
        artifacts: [
          { id: "dashboard-html", kind: "html", contentHash: "c".repeat(64), byteLength: 10, mediaType: "text/html; charset=utf-8" },
          { id: "dashboard-manifest", kind: "manifest", contentHash: "d".repeat(64), byteLength: 10, mediaType: "application/json" },
        ],
        sourceIds: ["source-1"],
        datasetIds: ["dataset-1"],
        evidenceIds: ["evidence-1"],
        graphIds: ["graph-structured"],
        competitorDiffIds: ["diff-structured"],
        taskIds: ["task-1"],
        sourceVersions: [
          { entityType: "source", id: "source-1", version: 1 },
          { entityType: "dataset", id: "dataset-1", version: 1 },
          { entityType: "evidence", id: "evidence-1", version: 1 },
          { entityType: "analysis_graph", id: "graph-structured", version: 1 },
          { entityType: "competitor_diff", id: "diff-structured", version: 1 },
          { entityType: "task", id: "task-1", version: 1 },
        ],
      }));
    });

    const recommendationLineage = await service.getLineage({
      entityType: "recommendation", id: "recommendation-1", workspaceId: "workspace-1",
    });
    expect(recommendationLineage.edges).toEqual(expect.arrayContaining([
      { from: { entityType: "evidence", id: "evidence-1" }, to: { entityType: "recommendation", id: "recommendation-1" } },
      { from: { entityType: "analysis_graph", id: "graph-structured" }, to: { entityType: "recommendation", id: "recommendation-1" } },
    ]));

    const dashboardLineage = await service.getLineage({
      entityType: "dashboard", id: "dashboard-structured", workspaceId: "workspace-1",
    });
    expect(dashboardLineage.nodes.map((node) => [node.entityType, node.id])).toEqual(expect.arrayContaining([
      ["source", "source-1"],
      ["dataset", "dataset-1"],
      ["evidence", "evidence-1"],
      ["analysis_graph", "graph-structured"],
      ["competitor_diff", "diff-structured"],
      ["task", "task-1"],
      ["dashboard", "dashboard-structured"],
    ]));
    expect(dashboardLineage.edges).toEqual(expect.arrayContaining([
      { from: { entityType: "analysis_graph", id: "graph-structured" }, to: { entityType: "dashboard", id: "dashboard-structured" } },
      { from: { entityType: "competitor_diff", id: "diff-structured" }, to: { entityType: "dashboard", id: "dashboard-structured" } },
      { from: { entityType: "task", id: "task-1" }, to: { entityType: "dashboard", id: "dashboard-structured" } },
    ]));
  });

  it("does not leak lineage across workspaces", async () => {
    await createRecommendation();
    await createTask("task-1");
    await service.createWorkspace({
      input: { id: "workspace-2", name: "Contoso" },
      context: nextContext(),
    });

    await expect(
      service.getLineage({ entityType: "task", id: "task-1", workspaceId: "workspace-2" }),
    ).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
  });

  it("bounds lineage traversal by entity count", async () => {
    await store.transaction(async (repos) => {
      for (let index = 0; index < 1_001; index += 1) {
        await repos.evidence.insert({
          id: `bounded-evidence-${index}`,
          workspaceId: "workspace-1",
          version: 1,
          createdAt: firstNow,
          updatedAt: firstNow,
          sourceId: "source-1",
        });
      }
      await repos.findings.insert({
        id: "bounded-finding",
        workspaceId: "workspace-1",
        version: 1,
        createdAt: firstNow,
        updatedAt: firstNow,
        evidenceIds: Array.from({ length: 1_001 }, (_, index) => `bounded-evidence-${index}`),
      });
    });

    await expect(
      service.getLineage({ entityType: "finding", id: "bounded-finding", workspaceId: "workspace-1" }),
    ).rejects.toMatchObject<DomainError>({ code: "CONFLICT" });
  });

  it.each([
    { label: "sparse IDs", findingIds: new Array(1) as never },
    { label: "non-string IDs", findingIds: [42] as never },
    { label: "blank IDs", findingIds: [" \t"] },
    { label: "duplicate IDs", findingIds: ["finding-1", "finding-1"] },
  ])(
    "rejects recommendation $label from a direct service call without residue",
    async ({ findingIds }) => {
      const attemptContext = nextContext();
      await expect(
        service.createRecommendation({
          input: { ...recommendationInput(), findingIds },
          context: attemptContext,
        }),
      ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });

      const persisted = await store.transaction(async (repos) => ({
        recommendation: await repos.recommendations.get(
          "recommendation-1",
          "workspace-1",
        ),
        audit: await repos.audit.get("audit-5", "workspace-1"),
        idempotency: await repos.idempotency.get(
          "workspace-1",
          attemptContext.idempotencyKey,
        ),
      }));
      expect(persisted).toEqual({
        recommendation: undefined,
        audit: undefined,
        idempotency: undefined,
      });
    },
  );

  it.each([
    { field: "recommendationIds", label: "sparse IDs", value: new Array(1) as never },
    { field: "recommendationIds", label: "non-string IDs", value: [42] as never },
    { field: "recommendationIds", label: "blank IDs", value: [" \t"] },
    {
      field: "recommendationIds",
      label: "duplicate IDs",
      value: ["recommendation-1", "recommendation-1"],
    },
    { field: "dependencyIds", label: "sparse IDs", value: new Array(1) as never },
    { field: "dependencyIds", label: "non-string IDs", value: [42] as never },
    { field: "dependencyIds", label: "blank IDs", value: [" \t"] },
    {
      field: "dependencyIds",
      label: "duplicate IDs",
      value: ["dependency-1", "dependency-1"],
    },
    { field: "assetRequirements", label: "a sparse array", value: new Array(1) as never },
    { field: "assetRequirements", label: "non-string entries", value: [42] as never },
    { field: "assetRequirements", label: "blank entries", value: [" \t"] },
    { field: "acceptanceCriteria", label: "a sparse array", value: new Array(1) as never },
    { field: "acceptanceCriteria", label: "non-string entries", value: [42] as never },
    { field: "acceptanceCriteria", label: "blank entries", value: [" \t"] },
  ])(
    "rejects task $field with $label from a direct service call without residue",
    async ({ field, value }) => {
      await createRecommendation();
      const attemptContext = nextContext();
      await expect(
        service.createTask({
          input: { ...taskInput(), [field]: value },
          context: attemptContext,
        }),
      ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });

      const persisted = await store.transaction(async (repos) => ({
        task: await repos.tasks.get("task-1", "workspace-1"),
        audit: await repos.audit.get("audit-6", "workspace-1"),
        idempotency: await repos.idempotency.get(
          "workspace-1",
          attemptContext.idempotencyKey,
        ),
      }));
      expect(persisted).toEqual({
        task: undefined,
        audit: undefined,
        idempotency: undefined,
      });
    },
  );
});

describe("MarketingService capability registry", () => {
  let store: Store;
  let clock: TestClock;
  let ids: TestIds;
  let service: MarketingService;
  let commandSequence: number;

  beforeEach(async () => {
    store = openStore(":memory:");
    clock = new TestClock();
    ids = new TestIds(Array.from({ length: 100 }, (_, index) => `audit-${index + 1}`));
    service = new MarketingService(store, clock, ids);
    commandSequence = 0;
    await service.createWorkspace({ input: workspaceInput(), context: nextContext() });
  });

  afterEach(() => {
    store.close();
  });

  function nextContext(): CommandContext {
    commandSequence += 1;
    return {
      actor: "agent-1",
      requestId: `capability-request-${commandSequence}`,
      idempotencyKey: `capability-command-${commandSequence}`,
    };
  }

  function capabilityInput() {
    return {
      id: "capability-1",
      workspaceId: "workspace-1",
      name: "Approved analytics adapter",
      adapterKind: "api_cli" as const,
      origin: "user_extension" as const,
    };
  }

  async function registerCapability() {
    return service.registerCapability({
      input: capabilityInput(),
      context: nextContext(),
    });
  }

  function successfulHealthInput() {
    return {
      id: "capability-1",
      workspaceId: "workspace-1",
      expectedVersion: 1,
      healthy: true,
      checkedAt: "2026-10-26T12:29:00.000Z",
      toolVersion: "2.4.1",
      evidenceId: "evidence-1",
    };
  }

  async function recordToolHealthEvidence(
    overrides: Partial<ToolHealthEvidence> | null = {},
  ) {
    await service.registerSource({
      input: {
        id: "source-1",
        workspaceId: "workspace-1",
        name: "Health check evidence",
        type: "manual",
        ownership: "owned",
      },
      context: nextContext(),
    });
    return service.recordEvidence({
      input: {
        ...evidenceInput(),
        ...(overrides === null
          ? {}
          : {
              toolHealth: {
                purpose: "tool_health",
                capabilityId: "capability-1",
                healthy: true,
                checkedAt: "2026-10-26T12:29:00.000Z",
                toolVersion: "2.4.1",
                ...overrides,
              },
            }),
      },
      context: nextContext(),
    });
  }

  it("capability registration is registered rather than verified and is auditable", async () => {
    const capability = await registerCapability();

    expect(capability).toEqual({
      ...capabilityInput(),
      state: "registered",
      version: 1,
      createdAt: firstNow,
      updatedAt: firstNow,
    });
    const persisted = await store.transaction(async (repos) => ({
      capability: await repos.capabilities.get("capability-1", "workspace-1"),
      audit: await repos.audit.get("audit-2", "workspace-1"),
      idempotency: await repos.idempotency.get(
        "workspace-1",
        "capability-command-2",
      ),
    }));
    expect(persisted.capability).toEqual(capability);
    expect(persisted.audit).toMatchObject({
      action: "capability.register",
      entityType: "capability",
      entityId: "capability-1",
    });
    expect(persisted.idempotency?.response).toEqual(capability);
  });

  it("capability configuration marks an explicit user extension configured", async () => {
    const capability = await service.registerCapability({
      input: {
        ...capabilityInput(),
        id: "capability-extension",
        origin: "user_extension",
        configuration: { endpoint: "https://example.test/health" },
      },
      context: nextContext(),
    });

    expect(capability).toMatchObject({
      id: "capability-extension",
      origin: "user_extension",
      state: "configured",
      configuration: { endpoint: "https://example.test/health" },
    });
  });

  it("capability public registration rejects self-asserted controlled catalog origins", async () => {
    const attemptContext = nextContext();

    await expect(
      service.registerCapability({
        input: { ...capabilityInput(), origin: "controlled_catalog" as never },
        context: attemptContext,
      }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    const persisted = await store.transaction(async (repos) => ({
      capability: await repos.capabilities.get("capability-1", "workspace-1"),
      audit: await repos.audit.get("audit-2", "workspace-1"),
      idempotency: await repos.idempotency.get(
        "workspace-1",
        attemptContext.idempotencyKey,
      ),
    }));
    expect(persisted).toEqual({
      capability: undefined,
      audit: undefined,
      idempotency: undefined,
    });
  });

  it("capability health failure stores a safe reason and unavailable state", async () => {
    await registerCapability();
    clock.set(secondNow);

    const capability = await service.recordCapabilityHealth({
      input: {
        id: "capability-1",
        workspaceId: "workspace-1",
        expectedVersion: 1,
        healthy: false,
        checkedAt: "2026-10-26T12:29:00.000Z",
        reason: "The approved health check did not pass",
      },
      context: nextContext(),
    });

    expect(capability).toEqual({
      ...capabilityInput(),
      state: "unavailable",
      checkedAt: "2026-10-26T12:29:00.000Z",
      unavailableReason: "The approved health check did not pass",
      version: 2,
      createdAt: firstNow,
      updatedAt: secondNow,
    });
    expect(
      await store.transaction((repos) =>
        repos.capabilities.get("capability-1", "workspace-1"),
      ),
    ).toEqual(capability);
  });

  it("capability health success requires matching structured evidence and enables verified", async () => {
    await recordToolHealthEvidence();
    await registerCapability();
    clock.set(secondNow);

    const capability = await service.recordCapabilityHealth({
      input: successfulHealthInput(),
      context: nextContext(),
    });

    expect(capability).toEqual({
      ...capabilityInput(),
      state: "verified",
      checkedAt: "2026-10-26T12:29:00.000Z",
      toolVersion: "2.4.1",
      evidenceId: "evidence-1",
      version: 2,
      createdAt: firstNow,
      updatedAt: secondNow,
    });
    expect(await service.listCapabilities({ workspaceId: "workspace-1" })).toEqual([
      capability,
    ]);
  });

  it.each([
    { label: "ordinary evidence", overrides: null },
    { label: "another capability", overrides: { capabilityId: "capability-other" } },
    { label: "a failed check", overrides: { healthy: false } },
    { label: "a mismatched version", overrides: { toolVersion: "9.9.9" } },
    {
      label: "a mismatched check time",
      overrides: { checkedAt: "2026-10-26T12:28:00.000Z" },
    },
  ])("capability verification rejects $label", async ({ overrides }) => {
    await recordToolHealthEvidence(overrides);
    await registerCapability();
    const attemptContext = nextContext();

    await expect(
      service.recordCapabilityHealth({
        input: successfulHealthInput(),
        context: attemptContext,
      }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    const persisted = await store.transaction(async (repos) => ({
      capability: await repos.capabilities.get("capability-1", "workspace-1"),
      idempotency: await repos.idempotency.get(
        "workspace-1",
        attemptContext.idempotencyKey,
      ),
    }));
    expect(persisted.capability).toMatchObject({ state: "registered", version: 1 });
    expect(persisted.idempotency).toBeUndefined();
  });

  it("capability verification rejects a stored non-health purpose", async () => {
    const evidence = await recordToolHealthEvidence();
    await store.transaction((repos) =>
      repos.evidence.update(
        {
          ...evidence,
          toolHealth: { ...evidence.toolHealth!, purpose: "marketing_research" as never },
        },
        evidence.version,
      ),
    );
    await registerCapability();

    await expect(
      service.recordCapabilityHealth({
        input: successfulHealthInput(),
        context: nextContext(),
      }),
    ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    expect(
      await store.transaction((repos) =>
        repos.capabilities.get("capability-1", "workspace-1"),
      ),
    ).toMatchObject({ state: "registered", version: 1 });
  });

  it.each(["checkedAt", "toolVersion", "evidenceId"] as const)(
    "capability verification rejects missing %s without changing state",
    async (field) => {
      await registerCapability();
      const input = {
        id: "capability-1",
        workspaceId: "workspace-1",
        expectedVersion: 1,
        healthy: true,
        checkedAt: "2026-10-26T12:29:00.000Z",
        toolVersion: "2.4.1",
        evidenceId: "evidence-1",
      };
      const missingInput: Partial<typeof input> = { ...input };
      delete missingInput[field];
      const attemptContext = nextContext();

      await expect(
        service.recordCapabilityHealth({
          input: missingInput as typeof input,
          context: attemptContext,
        }),
      ).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
      const persisted = await store.transaction(async (repos) => ({
        capability: await repos.capabilities.get("capability-1", "workspace-1"),
        idempotency: await repos.idempotency.get(
          "workspace-1",
          attemptContext.idempotencyKey,
        ),
      }));
      expect(persisted.capability).toMatchObject({ state: "registered", version: 1 });
      expect(persisted.idempotency).toBeUndefined();
    },
  );

  it("capability verification rejects real evidence from another workspace", async () => {
    await registerCapability();
    await service.createWorkspace({
      input: { id: "workspace-2", name: "Contoso" },
      context: nextContext(),
    });
    await service.registerSource({
      input: {
        id: "source-other",
        workspaceId: "workspace-2",
        name: "Other health checks",
        type: "manual",
        ownership: "owned",
      },
      context: nextContext(),
    });
    await service.registerCapability({
      input: {
        ...capabilityInput(),
        id: "capability-other",
        workspaceId: "workspace-2",
      },
      context: nextContext(),
    });
    await service.recordEvidence({
      input: {
        ...evidenceInput(),
        id: "evidence-other",
        workspaceId: "workspace-2",
        sourceId: "source-other",
        toolHealth: {
          purpose: "tool_health",
          capabilityId: "capability-1",
          healthy: true,
          checkedAt: "2026-10-26T12:29:00.000Z",
          toolVersion: "2.4.1",
        },
      },
      context: nextContext(),
    });
    expect(
      await store.transaction((repos) =>
        repos.evidence.get("evidence-other", "workspace-2"),
      ),
    ).toBeDefined();
    expect(await service.listCapabilities({ workspaceId: "workspace-2" })).toEqual([
      expect.objectContaining({ id: "capability-other" }),
    ]);

    await expect(
      service.recordCapabilityHealth({
        input: { ...successfulHealthInput(), evidenceId: "evidence-other" },
        context: nextContext(),
      }),
    ).rejects.toMatchObject<DomainError>({ code: "NOT_FOUND" });
    expect(
      await store.transaction((repos) =>
        repos.capabilities.get("capability-1", "workspace-1"),
      ),
    ).toMatchObject({ state: "registered", version: 1 });
  });

  it("capability listing returns empty filters and isolates real workspaces", async () => {
    const first = await registerCapability();
    await service.createWorkspace({
      input: { id: "workspace-2", name: "Contoso" },
      context: nextContext(),
    });
    const other = await service.registerCapability({
      input: {
        ...capabilityInput(),
        id: "capability-other",
        workspaceId: "workspace-2",
      },
      context: nextContext(),
    });

    expect(await service.listCapabilities({ workspaceId: "workspace-1" })).toEqual([
      first,
    ]);
    expect(await service.listCapabilities({ workspaceId: "workspace-2" })).toEqual([
      other,
    ]);
    expect(
      await service.listCapabilities({ workspaceId: "workspace-1", state: "verified" }),
    ).toEqual([]);
    expect(await service.listCapabilities({ workspaceId: "workspace-unknown" })).toEqual(
      [],
    );
  });

  it("capability commands reject secrets before entity, audit, or idempotency persistence", async () => {
    const secret = "synthetic-capability-secret";
    const attemptContext = nextContext();

    const error = await service.registerCapability({
      input: {
        ...capabilityInput(),
        configuration: { nested: { apiKey: secret } },
      },
      context: attemptContext,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(JSON.stringify(error)).not.toContain(secret);
    const persisted = await store.transaction(async (repos) => ({
      capability: await repos.capabilities.get("capability-1", "workspace-1"),
      audit: await repos.audit.get("audit-2", "workspace-1"),
      idempotency: await repos.idempotency.get(
        "workspace-1",
        attemptContext.idempotencyKey,
      ),
    }));
    expect(persisted).toEqual({
      capability: undefined,
      audit: undefined,
      idempotency: undefined,
    });
    expect(ids.calls).toBe(1);
  });

  it("capability registration rejects secret-bearing configuration locators", async () => {
    const secret = "synthetic-capability-url-secret";
    const attemptContext = nextContext();

    const error = await service.registerCapability({
      input: {
        ...capabilityInput(),
        configuration: {
          endpoint: `https://example.test/health?apiKey=${secret}`,
        },
      },
      context: attemptContext,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(
      await store.transaction((repos) =>
        repos.capabilities.get("capability-1", "workspace-1"),
      ),
    ).toBeUndefined();
  });

  it.each(["inline secret parameters", "embedded URL userinfo"])(
    "capability health rejects %s without command residue",
    async (kind) => {
      await registerCapability();
      const secret = "synthetic-capability-reason-secret";
      const reason =
        kind === "embedded URL userinfo"
          ? `Health failed; see https://alice:${secret}@example.test`
          : `Health check failed with password=${secret}`;
      const attemptContext = nextContext();

      const error = await service.recordCapabilityHealth({
        input: {
          id: "capability-1",
          workspaceId: "workspace-1",
          expectedVersion: 1,
          healthy: false,
          checkedAt: "2026-10-26T12:29:00.000Z",
          reason,
        },
        context: attemptContext,
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toMatchObject({ code: "INVALID_INPUT" });
      expect(JSON.stringify(error)).not.toContain(secret);
      const persisted = await store.transaction(async (repos) => ({
        capability: await repos.capabilities.get("capability-1", "workspace-1"),
        audit: await repos.audit.get("audit-3", "workspace-1"),
        idempotency: await repos.idempotency.get(
          "workspace-1",
          attemptContext.idempotencyKey,
        ),
      }));
      expect(persisted.capability).toMatchObject({ state: "registered", version: 1 });
      expect(persisted.audit).toBeUndefined();
      expect(persisted.idempotency).toBeUndefined();
    },
  );
});

describe("MarketingService content production lineage", () => {
  it("traverses benchmark, brief, source, strategy, and immutable parent references", async () => {
    const store = openStore(":memory:");
    try {
      const clock = new TestClock();
      const service = new MarketingService(store, clock, new TestIds(["audit-unused"]));
      const base = { workspaceId: "workspace-1", version: 1, createdAt: firstNow, updatedAt: firstNow };
      const benchmark = createBenchmarkAnalysis({
        id: "benchmark-1",
        workspaceId: "workspace-1",
        createdAt: firstNow,
        modality: "image",
        status: "partial",
        methods: [{
          id: "method-1",
          dimension: "layout",
          pattern: "Observed structure",
          transferableRule: "Transferable structure",
          basis: "image",
          confidence: "unknown",
          evidenceAssetRefs: [{
            sourceId: "source-1",
            evidenceId: "evidence-1",
            assetId: "asset-1",
            kind: "screenshot",
            observedAt: firstNow,
            contentHash: "a".repeat(64),
            byteLength: 10,
          }],
        }],
        gaps: [{ code: "limited_sample", message: "One observation" }],
        evidenceIds: ["evidence-1"],
        competitorDiffId: "diff-1",
        sourceVersions: [
          { entityType: "source", id: "source-1", version: 1 },
          { entityType: "evidence", id: "evidence-1", version: 1 },
          { entityType: "competitor_diff", id: "diff-1", version: 1 },
        ],
        provider: {
          type: "mcp",
          tool: "reverse_engineer",
          toolVersion: "fixture-1",
          inputHash: "b".repeat(64),
          analysisMethod: "fixture-v1",
          humanReview: "not_performed",
        },
      });
      const brief = createContentBrief({
        id: "brief-1",
        workspaceId: "workspace-1",
        createdAt: firstNow,
        channel: "xhs",
        taskId: "task-1",
        recommendationId: "recommendation-1",
        benchmarkAnalysisId: "benchmark-1",
        methodIds: ["method-1"],
        objective: "Objective",
        audience: "Audience",
        copy: {
          hook: { id: "hook", kind: "creative", text: "Hook" },
          body: [{ id: "body", kind: "creative", text: "Body" }],
          cta: { id: "cta", kind: "creative", text: "CTA" },
        },
        frames: [],
        assetRequirements: [],
        findingIds: [],
        evidenceIds: ["evidence-1"],
        sourceVersions: [
          { entityType: "task", id: "task-1", version: 1 },
          { entityType: "recommendation", id: "recommendation-1", version: 1 },
          { entityType: "benchmark_analysis", id: "benchmark-1", version: 1 },
          { entityType: "evidence", id: "evidence-1", version: 1 },
          { entityType: "source", id: "source-1", version: 1 },
        ],
      });
      const root = createAssetVersion({
        id: "asset-1",
        workspaceId: "workspace-1",
        createdAt: firstNow,
        contentId: "content-1",
        channel: "xhs",
        briefId: "brief-1",
        briefVersion: 1,
        taskId: "task-1",
        recommendationId: "recommendation-1",
        parentVersionId: null,
        parentVersion: null,
        artifact: { id: "primary", kind: "primary", mediaType: "image/png", contentHash: "c".repeat(64), byteLength: 10 },
        sourceMaterials: [],
        modification: { summary: "Initial", revisionInstructions: "Generate", actor: "agent", requestId: "request-1", createdAt: firstNow },
        provider: { type: "mcp", tool: "render", toolVersion: "fixture-1", inputHash: "d".repeat(64) },
        validation: {
          status: "passed",
          profileId: "xhs_png_1080x1440_v1",
          guarantee: "internal_acceptance_only",
          decoder: "playwright_chromium",
          width: 1080,
          height: 1440,
          durationMs: null,
          videoCodec: null,
          audioCodec: null,
        },
        evidenceIds: ["evidence-1"],
        sourceVersions: [
          { entityType: "content_brief", id: "brief-1", version: 1 },
          { entityType: "task", id: "task-1", version: 1 },
          { entityType: "recommendation", id: "recommendation-1", version: 1 },
          { entityType: "evidence", id: "evidence-1", version: 1 },
          { entityType: "source", id: "source-1", version: 1 },
        ],
      });
      const derivative = createAssetVersion({
        ...root,
        id: "asset-2",
        version: 2,
        createdAt: secondNow,
        parentVersionId: "asset-1",
        parentVersion: 1,
        sourceMaterials: [{ role: "parent", assetVersionId: "asset-1", artifactId: "primary", mediaType: "image/png", contentHash: "c".repeat(64), byteLength: 10 }],
        sourceVersions: [...root.sourceVersions, { entityType: "asset_version", id: "asset-1", version: 1 }],
      });
      await store.transaction(async (repos) => {
        await repos.workspaces.insert({ ...base, id: "workspace-1", name: "Workspace" });
        await repos.sources.insert({ ...base, id: "source-1", name: "Source", type: "manual", ownership: "owned" });
        await repos.evidence.insert({ ...base, id: "evidence-1", sourceId: "source-1" });
        await repos.findings.insert({ ...base, id: "finding-1", evidenceIds: ["evidence-1"] });
        await repos.competitorDiffs.insert({ ...base, id: "diff-1", findingIds: ["finding-1"] });
        await repos.recommendations.insert({ ...base, id: "recommendation-1", findingIds: ["finding-1"] });
        await repos.tasks.insert({ ...base, id: "task-1", recommendationIds: ["recommendation-1"], dependencyIds: [] });
        await repos.benchmarkAnalyses.insert(benchmark);
        await repos.contentBriefs.insert(brief);
        await repos.assetVersions.insert(root);
        await repos.assetVersions.insert(derivative);
      });

      const lineage = await service.getLineage({ entityType: "asset_version", id: "asset-2", workspaceId: "workspace-1" });
      expect(lineage.nodes.map((node) => [node.entityType, node.id])).toEqual(expect.arrayContaining([
        ["source", "source-1"],
        ["evidence", "evidence-1"],
        ["finding", "finding-1"],
        ["competitor_diff", "diff-1"],
        ["recommendation", "recommendation-1"],
        ["task", "task-1"],
        ["benchmark_analysis", "benchmark-1"],
        ["content_brief", "brief-1"],
        ["asset_version", "asset-1"],
        ["asset_version", "asset-2"],
      ]));
      expect(lineage.edges).toEqual(expect.arrayContaining([
        { from: { entityType: "source", id: "source-1" }, to: { entityType: "benchmark_analysis", id: "benchmark-1" } },
        { from: { entityType: "evidence", id: "evidence-1" }, to: { entityType: "benchmark_analysis", id: "benchmark-1" } },
        { from: { entityType: "competitor_diff", id: "diff-1" }, to: { entityType: "benchmark_analysis", id: "benchmark-1" } },
        { from: { entityType: "benchmark_analysis", id: "benchmark-1" }, to: { entityType: "content_brief", id: "brief-1" } },
        { from: { entityType: "task", id: "task-1" }, to: { entityType: "content_brief", id: "brief-1" } },
        { from: { entityType: "recommendation", id: "recommendation-1" }, to: { entityType: "content_brief", id: "brief-1" } },
        { from: { entityType: "content_brief", id: "brief-1" }, to: { entityType: "asset_version", id: "asset-2" } },
        { from: { entityType: "asset_version", id: "asset-1" }, to: { entityType: "asset_version", id: "asset-2" } },
      ]));
    } finally {
      store.close();
    }
  });
});

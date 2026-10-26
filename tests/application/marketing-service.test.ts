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
    ]);
    service = new MarketingService(store, clock, ids);
  });

  afterEach(() => {
    store.close();
  });

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
        sourceLocator: "https://example.test/research",
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
      sourceLocator: "https://example.test/research",
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
});

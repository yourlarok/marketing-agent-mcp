import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDir, removeTempDir } from "../helpers.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const serverPath = join(projectRoot, "dist", "index.js");

function payload(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  expect(result.content[0]).toMatchObject({ type: "text" });
  return JSON.parse((result.content[0] as { text: string }).text) as Record<
    string,
    unknown
  >;
}

async function startClient(dataDir: string): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  const client = new Client({ name: "stdio-acceptance", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: projectRoot,
    env: { MARKETING_DATA_DIR: dataDir },
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.kill("SIGTERM");
  return exited;
}

describe("built stdio server acceptance", () => {
  let dataDir: string;
  const clients: Client[] = [];

  beforeEach(async () => {
    dataDir = await createTempDir();
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await removeTempDir(dataDir);
  });

  it("runs the marketing chain, replays commands, and reads persisted data after restart", async () => {
    const firstProcess = await startClient(dataDir);
    clients.push(firstProcess.client);
    const { client } = firstProcess;

    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "capability_health_record",
      "capability_list",
      "capability_register",
      "competitor_confirm",
      "competitor_diff_create",
      "data_request_decline",
      "data_request_plan",
      "data_research_get",
      "dataset_register",
      "evidence_asset_get",
      "evidence_record",
      "finding_record",
      "ingest_content_links",
      "ingest_files",
      "ingest_temporary_api",
      "lineage_get",
      "recommendation_create",
      "research_permission_set",
      "research_session_create",
      "research_session_run",
      "source_register",
      "task_create",
      "task_transition",
      "workspace_create",
    ]);

    const workspaceArguments = {
      id: "workspace-e2e",
      name: "stdio acceptance",
      actor: "acceptance-agent",
      requestId: "request-workspace",
      idempotencyKey: "command-workspace",
    };
    const workspace = await client.callTool({
      name: "workspace_create",
      arguments: workspaceArguments,
    });
    expect(payload(workspace)).toMatchObject({ id: "workspace-e2e", version: 1 });
    expect(
      await client.callTool({
        name: "workspace_create",
        arguments: workspaceArguments,
      }),
    ).toEqual(workspace);

    expect(
      payload(
        await client.callTool({
          name: "source_register",
          arguments: {
            id: "source-e2e",
            workspaceId: "workspace-e2e",
            name: "Owned records",
            type: "manual",
            ownership: "owned",
            actor: "acceptance-agent",
            requestId: "request-source",
            idempotencyKey: "command-source",
          },
        }),
      ),
    ).toMatchObject({ id: "source-e2e" });

    expect(
      payload(
        await client.callTool({
          name: "dataset_register",
          arguments: {
            id: "dataset-e2e",
            workspaceId: "workspace-e2e",
            sourceId: "source-e2e",
            name: "October observations",
            coverageStart: "2026-10-01T00:00:00.000Z",
            coverageEnd: "2026-10-25T23:59:59.999Z",
            fieldDefinitions: [{ name: "observation", type: "string" }],
            metricDefinitions: [{ name: "mentions", aggregation: "count" }],
            limitations: ["Acceptance fixture only"],
            actor: "acceptance-agent",
            requestId: "request-dataset",
            idempotencyKey: "command-dataset",
          },
        }),
      ),
    ).toMatchObject({ id: "dataset-e2e", sourceId: "source-e2e" });

    expect(
      payload(
        await client.callTool({
          name: "evidence_record",
          arguments: {
            id: "evidence-e2e",
            workspaceId: "workspace-e2e",
            sourceId: "source-e2e",
            sourceLocator: "fixtures/october-observations",
            observedAt: "2026-10-26T08:00:00.000Z",
            summary: "An owned operating observation",
            contentHash: "a".repeat(64),
            classification: "owned_operating",
            actor: "acceptance-agent",
            requestId: "request-evidence",
            idempotencyKey: "command-evidence",
          },
        }),
      ),
    ).toMatchObject({ id: "evidence-e2e" });

    expect(
      payload(
        await client.callTool({
          name: "finding_record",
          arguments: {
            id: "finding-e2e",
            workspaceId: "workspace-e2e",
            kind: "fact",
            statement: "The fixture contains one operating observation",
            evidenceIds: ["evidence-e2e"],
            actor: "acceptance-agent",
            requestId: "request-finding",
            idempotencyKey: "command-finding",
          },
        }),
      ),
    ).toMatchObject({ id: "finding-e2e", kind: "fact" });

    expect(
      payload(
        await client.callTool({
          name: "recommendation_create",
          arguments: {
            id: "recommendation-e2e",
            workspaceId: "workspace-e2e",
            findingIds: ["finding-e2e"],
            hypothesis: "Reviewing the observation will clarify the next action",
            affectedStage: "retention",
            priority: "high",
            expectedMetric: "retained_accounts",
            actor: "acceptance-agent",
            requestId: "request-recommendation",
            idempotencyKey: "command-recommendation",
          },
        }),
      ),
    ).toMatchObject({ id: "recommendation-e2e" });

    const dependencyTasks = [
      { id: "task-shared-e2e", dependencyIds: [] },
      { id: "task-dependency-a-e2e", dependencyIds: ["task-shared-e2e"] },
      { id: "task-dependency-b-e2e", dependencyIds: ["task-shared-e2e"] },
    ];
    for (const dependencyTask of dependencyTasks) {
      expect(payload(await client.callTool({
        name: "task_create",
        arguments: {
          ...dependencyTask,
          workspaceId: "workspace-e2e",
          recommendationIds: ["recommendation-e2e"],
          assignee: "lifecycle-marketer",
          assetRequirements: [],
          acceptanceCriteria: ["Dependency work is complete"],
          actor: "acceptance-agent",
          requestId: `request-${dependencyTask.id}`,
          idempotencyKey: `command-${dependencyTask.id}`,
        },
      }))).toMatchObject({ id: dependencyTask.id, state: "draft" });
    }

    expect(
      payload(
        await client.callTool({
          name: "task_create",
          arguments: {
            id: "task-e2e",
            workspaceId: "workspace-e2e",
            recommendationIds: ["recommendation-e2e"],
            assignee: "lifecycle-marketer",
            dependencyIds: ["task-dependency-a-e2e", "task-dependency-b-e2e"],
            assetRequirements: ["approved review template"],
            acceptanceCriteria: ["The observation has a documented decision"],
            actor: "acceptance-agent",
            requestId: "request-task",
            idempotencyKey: "command-task",
          },
        }),
      ),
    ).toMatchObject({ id: "task-e2e", state: "draft" });

    expect(
      payload(
        await client.callTool({
          name: "lineage_get",
          arguments: {
            entityType: "task",
            id: "task-e2e",
            workspaceId: "workspace-e2e",
          },
        }),
      ),
    ).toMatchObject({
      workspaceId: "workspace-e2e",
      nodes: [
        { entityType: "source", id: "source-e2e" },
        { entityType: "evidence", id: "evidence-e2e" },
        { entityType: "finding", id: "finding-e2e" },
        { entityType: "recommendation", id: "recommendation-e2e" },
        { entityType: "task", id: "task-shared-e2e", auditRequestIds: ["request-task-shared-e2e"] },
        { entityType: "task", id: "task-dependency-a-e2e", auditRequestIds: ["request-task-dependency-a-e2e"] },
        { entityType: "task", id: "task-dependency-b-e2e", auditRequestIds: ["request-task-dependency-b-e2e"] },
        { entityType: "task", id: "task-e2e" },
      ],
    });

    expect(
      payload(
        await client.callTool({
          name: "capability_register",
          arguments: {
            id: "capability-e2e",
            workspaceId: "workspace-e2e",
            name: "Externally checked adapter",
            adapterKind: "api_cli",
            origin: "user_extension",
            actor: "acceptance-agent",
            requestId: "request-capability",
            idempotencyKey: "command-capability",
          },
        }),
      ),
    ).toMatchObject({ id: "capability-e2e", state: "registered" });

    expect(
      payload(
        await client.callTool({
          name: "evidence_record",
          arguments: {
            id: "evidence-health-e2e",
            workspaceId: "workspace-e2e",
            sourceId: "source-e2e",
            sourceLocator: "fixtures/capability-health",
            observedAt: "2026-10-26T09:00:00.000Z",
            summary: "External health check passed",
            contentHash: "b".repeat(64),
            classification: "owned_operating",
            toolHealth: {
              purpose: "tool_health",
              capabilityId: "capability-e2e",
              healthy: true,
              checkedAt: "2026-10-26T09:00:00.000Z",
              toolVersion: "1.2.3",
            },
            actor: "acceptance-agent",
            requestId: "request-health-evidence",
            idempotencyKey: "command-health-evidence",
          },
        }),
      ),
    ).toMatchObject({ id: "evidence-health-e2e" });

    expect(
      payload(
        await client.callTool({
          name: "capability_health_record",
          arguments: {
            id: "capability-e2e",
            workspaceId: "workspace-e2e",
            expectedVersion: 1,
            healthy: true,
            checkedAt: "2026-10-26T09:00:00.000Z",
            toolVersion: "1.2.3",
            evidenceId: "evidence-health-e2e",
            actor: "acceptance-agent",
            requestId: "request-health",
            idempotencyKey: "command-health",
          },
        }),
      ),
    ).toMatchObject({ state: "verified", evidenceId: "evidence-health-e2e" });

    expect(
      payload(
        await client.callTool({
          name: "capability_list",
          arguments: { workspaceId: "workspace-e2e", state: "verified" },
        }),
      ),
    ).toEqual([
      expect.objectContaining({ id: "capability-e2e", state: "verified" }),
    ]);

    const malformed = await client.callTool({
      name: "workspace_create",
      arguments: { ...workspaceArguments, id: "malformed-e2e", name: "" },
    });
    expect(malformed).toMatchObject({ isError: true });
    expect(JSON.stringify(malformed)).toContain("Input validation error");
    expect(JSON.stringify(malformed)).not.toContain("stack");
    expect((await client.listTools()).tools).toHaveLength(24);

    await firstProcess.client.close();
    clients.splice(clients.indexOf(firstProcess.client), 1);

    const secondProcess = await startClient(dataDir);
    clients.push(secondProcess.client);
    expect(
      payload(
        await secondProcess.client.callTool({
          name: "lineage_get",
          arguments: {
            entityType: "task",
            id: "task-e2e",
            workspaceId: "workspace-e2e",
          },
        }),
      ),
    ).toMatchObject({
      nodes: [
        { entityType: "source", id: "source-e2e" },
        { entityType: "evidence", id: "evidence-e2e" },
        { entityType: "finding", id: "finding-e2e" },
        { entityType: "recommendation", id: "recommendation-e2e" },
        { entityType: "task", id: "task-shared-e2e", auditRequestIds: ["request-task-shared-e2e"] },
        { entityType: "task", id: "task-dependency-a-e2e", auditRequestIds: ["request-task-dependency-a-e2e"] },
        { entityType: "task", id: "task-dependency-b-e2e", auditRequestIds: ["request-task-dependency-b-e2e"] },
        { entityType: "task", id: "task-e2e" },
      ],
    });
    expect(
      payload(
        await secondProcess.client.callTool({
          name: "capability_list",
          arguments: { workspaceId: "workspace-e2e", state: "verified" },
        }),
      ),
    ).toEqual([
      expect.objectContaining({ id: "capability-e2e", state: "verified" }),
    ]);
    expect(
      await secondProcess.client.callTool({
        name: "workspace_create",
        arguments: workspaceArguments,
      }),
    ).toEqual(workspace);
  }, 30_000);

  it("enforces the complete-argument UTF-8 boundary over stdio without persistence", async () => {
    const { client } = await startClient(dataDir);
    clients.push(client);
    const boundaryArguments = {
      id: "workspace-stdio-boundary",
      name: "Stdio boundary",
      metadata: { note: "" },
      actor: "acceptance-agent",
      requestId: "request-stdio-boundary",
      idempotencyKey: "command-stdio-boundary",
    };
    const remaining = 65_536 - Buffer.byteLength(JSON.stringify(boundaryArguments), "utf8");
    const multibyteLength = Math.floor(remaining / 3);
    boundaryArguments.metadata.note =
      "€".repeat(multibyteLength) + "x".repeat(remaining - multibyteLength * 3);
    expect(Buffer.byteLength(JSON.stringify(boundaryArguments), "utf8")).toBe(65_536);
    expect(payload(await client.callTool({
      name: "workspace_create",
      arguments: boundaryArguments,
    }))).toMatchObject({ id: "workspace-stdio-boundary" });

    const oversizedArguments = {
      ...boundaryArguments,
      id: "workspace-stdio-oversized",
      requestId: "request-stdio-oversized",
      idempotencyKey: "command-stdio-oversized",
      metadata: { ...boundaryArguments.metadata, extra: "€" },
    };
    expect(Buffer.byteLength(JSON.stringify(oversizedArguments), "utf8")).toBeGreaterThan(65_536);
    const rejected = await client.callTool({
      name: "workspace_create",
      arguments: oversizedArguments,
    });
    expect(rejected).toMatchObject({ isError: true });

    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(join(dataDir, "marketing.db"));
    try {
      expect(raw.prepare(
        `SELECT
          (SELECT COUNT(*) FROM workspaces) AS workspaces,
          (SELECT COUNT(*) FROM audit_records) AS audits,
          (SELECT COUNT(*) FROM idempotency_records) AS idempotency`,
      ).get()).toEqual({ workspaces: 1, audits: 1, idempotency: 1 });
      expect(raw.prepare("SELECT id FROM workspaces WHERE id = ?").get("workspace-stdio-oversized")).toBeUndefined();
    } finally {
      raw.close();
    }
  }, 30_000);

  it("reports startup failures on stderr with a nonzero exit and clean stdout", async () => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: projectRoot,
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exit = await new Promise<{ code: number | null }>((resolve) => {
      child.once("close", (code) => resolve({ code }));
    });

    expect(exit.code).not.toBe(0);
    expect(stderr).toContain("MARKETING_DATA_DIR is required");
    expect(stdout).toBe("");
  });

  it("keeps stdout protocol-only after malformed JSON and shuts down cleanly", async () => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: projectRoot,
      env: { ...process.env, MARKETING_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.write("not-json\n");
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "raw-acceptance", version: "1.0.0" },
        },
      })}\n`,
    );
    await new Promise<void>((resolve) => {
      const onData = (chunk: string) => {
        if (chunk.includes('"id":1')) {
          child.stdout.off("data", onData);
          resolve();
        }
      };
      child.stdout.on("data", onData);
    });

    const exit = await stopChild(child);
    expect(stderr).not.toContain("MCP shutdown failed");
    expect(exit).toEqual({ code: 0, signal: null });
    const messages = stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { jsonrpc: string });
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((message) => message.jsonrpc === "2.0")).toBe(true);
  });
});

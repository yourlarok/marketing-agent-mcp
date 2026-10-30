import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDir, removeTempDir } from "../helpers.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const serverPath = join(projectRoot, "dist", "index.js");
const benchmarkFixture = fileURLToPath(new URL("../fixtures/benchmark-reverse-mcp.mjs", import.meta.url));
const mediaFixture = fileURLToPath(new URL("../fixtures/professional-media-mcp.mjs", import.meta.url));
const publishingFixture = fileURLToPath(new URL("../fixtures/trusted-publishing-mcp.mjs", import.meta.url));
const ffmpeg = process.env.MARKETING_TEST_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const ffprobe = process.env.MARKETING_TEST_FFPROBE ?? "/opt/homebrew/bin/ffprobe";
const workspaceId = "workspace-publishing-effect-stdio";
const assetId = "asset-publishing-v1";
const derivedAssetId = "asset-publishing-v2";
const briefId = "brief-publishing";
const approvalId = "approval-publishing-v1";
const accountId = "independent-fixture-account";

type JsonRecord = Record<string, unknown>;

interface RunningClient {
  client: Client;
  transport: StdioClientTransport;
  stderr: () => string;
  stdout: () => string;
}

interface AssetVersion extends JsonRecord {
  id: string;
  version: number;
  artifact: {
    id: string;
    contentHash: string;
    byteLength: number;
    mediaType: string;
  };
}

interface Publication extends JsonRecord {
  id: string;
  version: number;
  status: string;
  operationKey: string;
  scheduleId: string;
}

function payload(result: CallToolResult): JsonRecord {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.content[0]).toMatchObject({ type: "text" });
  return JSON.parse((result.content[0] as { text: string }).text) as JsonRecord;
}

function context(suffix: string): JsonRecord {
  return {
    actor: "publishing-effect-stdio-acceptance",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function future(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function expectExited(pid: number): Promise<void> {
  await expect.poll(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, { timeout: 5_000 }).toBe(true);
}

describe("built publishing and effect stdio acceptance", () => {
  let dataDir: string;
  let importDir: string;
  let artifactDir: string;
  let fixtureDir: string;
  let publishingStatePath: string;
  let publishingCapturePath: string;
  let publishingPidPath: string;
  let fixtureServer: Server;
  let fixtureOrigin: string;
  const clients: RunningClient[] = [];

  beforeEach(async () => {
    [dataDir, importDir, artifactDir, fixtureDir] = await Promise.all([
      createTempDir(), createTempDir(), createTempDir(), createTempDir(),
    ]);
    publishingStatePath = join(fixtureDir, "publishing-state.json");
    publishingCapturePath = join(fixtureDir, "publishing-calls.jsonl");
    publishingPidPath = join(fixtureDir, "publishing-pids.txt");
    await Promise.all([
      writeFile(publishingCapturePath, "", "utf8"),
      writeFile(publishingPidPath, "", "utf8"),
    ]);
    expect(isAbsolute(ffmpeg)).toBe(true);
    expect(isAbsolute(ffprobe)).toBe(true);
    expect(execFileSync(ffmpeg, ["-version"], { encoding: "utf8" })).toContain("ffmpeg version");
    expect(execFileSync(ffprobe, ["-version"], { encoding: "utf8" })).toContain("ffprobe version");
    fixtureServer = createServer((request, response) => {
      if (request.url === "/benchmark") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><html><body><main>Independent structural benchmark fixture</main></body></html>");
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
    fixtureOrigin = `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(({ client }) => client.close()));
    fixtureServer.closeAllConnections();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    await Promise.all([dataDir, importDir, artifactDir, fixtureDir].map(removeTempDir));
  });

  async function startClient(mode = "success"): Promise<RunningClient> {
    const client = new Client({ name: "publishing-effect-stdio-acceptance", version: "1.0.0" });
    let stderr = "";
    let stdout = "";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: projectRoot,
      env: {
        ...getDefaultEnvironment(),
        MARKETING_DATA_DIR: dataDir,
        MARKETING_IMPORT_ROOT: importDir,
        MARKETING_ARTIFACT_DIR: artifactDir,
        MARKETING_HTTP_ALLOWLIST: "127.0.0.1",
        MARKETING_BENCHMARK_MCP_COMMAND: process.execPath,
        MARKETING_BENCHMARK_MCP_ARGS: JSON.stringify([benchmarkFixture]),
        MARKETING_MEDIA_MCP_COMMAND: process.execPath,
        MARKETING_MEDIA_MCP_ARGS: JSON.stringify([mediaFixture]),
        MARKETING_MEDIA_MCP_ENV_ALLOWLIST: "MARKETING_TEST_FFMPEG",
        MARKETING_TEST_FFMPEG: ffmpeg,
        MARKETING_FFPROBE_COMMAND: ffprobe,
        MARKETING_PUBLISHING_MCP_COMMAND: process.execPath,
        MARKETING_PUBLISHING_MCP_ARGS: JSON.stringify([publishingFixture]),
        MARKETING_PUBLISHING_MCP_ENV_ALLOWLIST: "PUBLISHING_FIXTURE_MODE,PUBLISHING_FIXTURE_STATE,PUBLISHING_FIXTURE_CAPTURE,PUBLISHING_FIXTURE_PID_FILE",
        PUBLISHING_FIXTURE_MODE: mode,
        PUBLISHING_FIXTURE_STATE: publishingStatePath,
        PUBLISHING_FIXTURE_CAPTURE: publishingCapturePath,
        PUBLISHING_FIXTURE_PID_FILE: publishingPidPath,
      },
      stderr: "pipe",
    });
    transport.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    transport.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    await client.connect(transport);
    const running = { client, transport, stderr: () => stderr, stdout: () => stdout };
    clients.push(running);
    return running;
  }

  async function stopClient(running: RunningClient): Promise<void> {
    const pid = running.transport.pid;
    expect(pid).not.toBeNull();
    await running.client.close();
    clients.splice(clients.indexOf(running), 1);
    await expectExited(pid!);
    expect(running.stderr()).not.toContain("MCP shutdown failed");
    for (const line of running.stdout().split("\n").filter((value) => value.trim().length > 0)) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }
  }

  async function call<T = JsonRecord>(
    client: Client,
    name: string,
    arguments_: JsonRecord = {},
  ): Promise<T> {
    return payload(await client.callTool({ name, arguments: arguments_ })) as T;
  }

  async function expectToolError(
    client: Client,
    name: string,
    arguments_: JsonRecord,
    message: "Invalid input" | "Resource not found" | "Resource conflict",
  ): Promise<void> {
    const result = await client.callTool({ name, arguments: arguments_ });
    expect(result, name).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain(message);
  }

  async function publishingCalls(): Promise<JsonRecord[]> {
    const capture = await readFile(publishingCapturePath, "utf8");
    return capture.trim().length === 0 ? [] : capture.trim().split("\n").map((line) => JSON.parse(line) as JsonRecord);
  }

  async function prepareAsset(client: Client): Promise<{ root: AssetVersion; derived: AssetVersion }> {
    await call(client, "workspace_create", {
      id: workspaceId, name: "Publishing and effect built acceptance", ...context("workspace"),
    });
    const acquired = await call(client, "ingest_content_links", {
      id: "batch-publishing-benchmark", workspaceId,
      links: [{ url: `${fixtureOrigin}/benchmark`, fields: {} }],
      ...context("benchmark-acquisition"),
    });
    expect(acquired).toMatchObject({ state: "completed", failures: [] });
    const analysis = await call(client, "benchmark_reverse_create", {
      id: "benchmark-publishing", workspaceId, modality: "image",
      evidenceIds: acquired.evidenceIds, ...context("benchmark-reverse"),
    });
    expect(analysis).toMatchObject({ id: "benchmark-publishing", version: 1, status: "completed" });

    const ownedBytes = Buffer.from("Owned publishing acceptance fact", "utf8");
    await call(client, "source_register", {
      id: "source-owned-publishing", workspaceId, name: "Owned publishing records",
      type: "manual", ownership: "owned", ...context("owned-source"),
    });
    await call(client, "evidence_record", {
      id: "evidence-owned-fact", workspaceId, sourceId: "source-owned-publishing",
      sourceLocator: "manual/publishing-fact", observedAt: new Date().toISOString(),
      summary: "Owned fact for the publishing workflow", contentHash: sha256(ownedBytes),
      classification: "owned_operating", ...context("owned-fact-evidence"),
    });
    await call(client, "finding_record", {
      id: "finding-publishing", workspaceId, kind: "fact",
      statement: "The owned publishing fact was persisted", evidenceIds: ["evidence-owned-fact"],
      ...context("owned-finding"),
    });
    await call(client, "strategy_recommendation_generate", {
      id: "recommendation-publishing", workspaceId, findingIds: ["finding-publishing"],
      hypothesis: "An exact approved asset can follow a verified delivery workflow",
      affectedStage: "engagement", targetChannels: ["xhs"], priority: "p1",
      expectedMetrics: [{ metricId: "engagement_rate_v1", acceptance: "establish_baseline" }],
      ...context("recommendation"),
    });
    await call(client, "task_create", {
      id: "task-publishing", workspaceId, recommendationIds: ["recommendation-publishing"],
      assignee: "human-publishing-owner", dependencyIds: [], assetRequirements: ["Exact artifact review"],
      acceptanceCriteria: ["Human approval and verified delivery are separate"], ...context("task-create"),
    });
    await call(client, "task_transition", {
      id: "task-publishing", workspaceId, next: "ready", expectedVersion: 1, ...context("task-ready"),
    });
    const creative = (id: string, text: string): JsonRecord => ({ id, kind: "creative", text });
    await call(client, "content_brief_create", {
      id: briefId, workspaceId, taskId: "task-publishing", expectedTaskVersion: 2,
      recommendationId: "recommendation-publishing", expectedRecommendationVersion: 1,
      benchmarkAnalysisId: "benchmark-publishing", expectedBenchmarkVersion: 1,
      channel: "xhs", methodIds: [(analysis.methods as JsonRecord[])[0]!.id],
      objective: "Produce an original asset for independent verified-delivery acceptance",
      audience: "Operators validating a controlled publishing workflow",
      copy: {
        hook: creative("publishing-hook", "Verify the exact asset before delivery"),
        body: [creative("publishing-body", "Submission and verified publication remain distinct states")],
        cta: creative("publishing-cta", "Inspect the persisted verification evidence"),
      },
      frames: [], assetRequirements: ["Use only the independent local fixture"], ...context("brief"),
    });
    const root = await call<AssetVersion>(client, "content_asset_generate", {
      id: assetId, workspaceId, contentId: "content-publishing", briefId, expectedBriefVersion: 1,
      sourceMaterials: [], revisionInstructions: "R".repeat(30_000), ...context("asset-generate"),
    });
    expect(root).toMatchObject({
      id: assetId, version: 1,
      artifact: { mediaType: "image/png", contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      validation: { status: "passed", guarantee: "internal_acceptance_only" },
    });
    const artifactChunks: Buffer[] = [];
    for (let offset = 0; offset < root.artifact.byteLength;) {
      const length = Math.min(32_768, root.artifact.byteLength - offset);
      const chunk = await call(client, "content_artifact_get", {
        id: root.id, workspaceId, artifactId: root.artifact.id, offset, length,
      });
      const bytes = Buffer.from(chunk.content as string, "base64");
      expect(bytes.byteLength).toBe(length);
      expect(chunk).toMatchObject({ contentHash: root.artifact.contentHash, totalBytes: root.artifact.byteLength });
      artifactChunks.push(bytes);
      offset += length;
    }
    expect(sha256(Buffer.concat(artifactChunks))).toBe(root.artifact.contentHash);
    const derived = await call<AssetVersion>(client, "content_asset_derive", {
      id: derivedAssetId, workspaceId, contentId: "content-publishing", parentVersionId: assetId,
      expectedParentVersion: 1, briefId, expectedBriefVersion: 1, sourceMaterials: [],
      revisionInstructions: "Create a distinct derivative that requires a new exact approval",
      ...context("asset-derive"),
    });
    expect(derived).toMatchObject({ id: derivedAssetId, version: 2, parentVersionId: assetId });
    expect(derived.artifact.contentHash).not.toBe(root.artifact.contentHash);
    return { root, derived };
  }

  async function approveRoot(client: Client, suffix = "approval"): Promise<JsonRecord> {
    return call(client, "approval_record", {
      id: approvalId, workspaceId, assetVersionId: assetId, expectedAssetVersion: 1,
      decision: "approved", comment: "Human attested review of the exact persisted artifact",
      ...context(suffix),
    });
  }

  function scheduleArguments(
    suffix: string,
    scheduledFor: string,
    deliveryMode: "automatic" | "manual_assisted" = "automatic",
  ): JsonRecord {
    return {
      id: `schedule-${suffix}`, publicationId: `publication-${suffix}`, workspaceId,
      assetVersionId: assetId, expectedAssetVersion: 1, approvalId,
      channel: "xhs", accountId, scheduledFor, timeZone: "UTC", deliveryMode,
      ...context(`schedule-${suffix}`),
    };
  }

  async function getPublication(client: Client, id: string): Promise<Publication> {
    return call<Publication>(client, "publication_get", { id, workspaceId });
  }

  async function waitForPublication(client: Client, id: string, status: string): Promise<Publication> {
    let latest: Publication | undefined;
    await expect.poll(async () => {
      latest = await getPublication(client, id);
      return latest.status;
    }, { timeout: 30_000, interval: 50 }).toBe(status);
    return latest!;
  }

  async function readDeliveryPackage(client: Client, publicationId: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let offset = 0;
    let totalBytes = Number.POSITIVE_INFINITY;
    let contentHash = "";
    while (offset < totalBytes) {
      const chunk = await call(client, "delivery_package_get", {
        id: publicationId, workspaceId, offset, length: 32_768,
      });
      const bytes = Buffer.from(chunk.content as string, "base64");
      expect(chunk.length).toBeLessThanOrEqual(32_768);
      expect(bytes.byteLength).toBe(chunk.length);
      expect(chunk).toMatchObject({ offset, mediaType: "application/json" });
      totalBytes = chunk.totalBytes as number;
      contentHash = chunk.contentHash as string;
      chunks.push(bytes);
      offset += bytes.byteLength;
    }
    const bytes = Buffer.concat(chunks);
    expect(totalBytes).toBeGreaterThan(32_768);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(sha256(bytes)).toBe(contentHash);
    return bytes;
  }

  it("gates exact approvals and drives one due timer submission through provider verification", async () => {
    const running = await startClient();
    const { client } = running;
    const { derived } = await prepareAsset(client);
    const initialDue = future(1_500);
    await expectToolError(client, "schedule_create", scheduleArguments("unapproved", future(60_000)), "Resource not found");
    await approveRoot(client);
    await expectToolError(client, "schedule_create", {
      ...scheduleArguments("old-approval", future(60_000)),
      assetVersionId: derived.id, expectedAssetVersion: derived.version,
      ...context("schedule-old-approval"),
    }, "Resource conflict");

    const cancelled = await call(client, "schedule_create", scheduleArguments("cancelled", future(60_000)));
    const rescheduledCancelled = await call(client, "schedule_reschedule", {
      id: cancelled.id, workspaceId, expectedVersion: 1, scheduledFor: future(1_200),
      timeZone: "UTC", ...context("reschedule-cancelled"),
    });
    expect(rescheduledCancelled).toMatchObject({ version: 2, status: "scheduled" });
    expect(await call(client, "schedule_cancel", {
      id: cancelled.id, workspaceId, expectedVersion: 2, ...context("cancel-schedule"),
    })).toMatchObject({ version: 3, status: "cancelled" });

    const scheduled = await call(client, "schedule_create", scheduleArguments("automatic", initialDue));
    const before = await getPublication(client, "publication-automatic");
    const laterDue = future(3_000);
    expect(await call(client, "schedule_reschedule", {
      id: scheduled.id, workspaceId, expectedVersion: 1, scheduledFor: laterDue,
      timeZone: "UTC", ...context("reschedule-automatic"),
    })).toMatchObject({ id: scheduled.id, version: 2, status: "scheduled", scheduledFor: laterDue });
    expect((await getPublication(client, before.id)).operationKey).toBe(before.operationKey);

    await delay(1_800);
    expect(await getPublication(client, before.id)).toMatchObject({ status: "pending", delivery: null, verification: null });
    expect(await getPublication(client, "publication-cancelled")).toMatchObject({ status: "cancelled", delivery: null });
    expect(await publishingCalls()).toEqual([]);

    const verified = await waitForPublication(client, before.id, "verified");
    expect(verified).toMatchObject({
      operationKey: before.operationKey,
      delivery: { method: "provider", externalPublicationId: expect.stringMatching(/^fixture-/) },
      verification: { method: "provider" },
      attempts: [{ attempt: 1, outcome: "submitted" }],
    });
    expect(await call(client, "schedule_get", { id: scheduled.id, workspaceId }))
      .toMatchObject({ status: "completed" });
    const calls = await publishingCalls();
    expect(calls.map((entry) => entry.tool)).toEqual(["submit", "verify"]);
    expect((calls[0]!.input as JsonRecord).operationKey).toBe(before.operationKey);
    expect((calls[1]!.input as JsonRecord).operationKey).toBe(before.operationKey);
    expect(JSON.stringify(calls)).not.toContain(derived.artifact.contentHash);
    const persisted = JSON.parse(await readFile(publishingStatePath, "utf8")) as { submissions: JsonRecord };
    expect(Object.keys(persisted.submissions)).toEqual([before.operationKey]);
    await stopClient(running);
    expect((await publishingCalls()).filter((entry) => entry.tool === "submit")).toHaveLength(1);
  }, 120_000);

  it("recovers accepted timeout by verify-first and keeps definite-failure manual delivery distinct", async () => {
    const first = await startClient("accepted-built-timeout");
    const { client } = first;
    await prepareAsset(client);
    await approveRoot(client);
    await call(client, "schedule_create", scheduleArguments("unknown", future(1_200)));
    const unknown = await waitForPublication(client, "publication-unknown", "unknown");
    expect(unknown).toMatchObject({
      status: "unknown", delivery: null, verification: null,
      attempts: [{ attempt: 1, outcome: "unknown" }],
      failure: { retryable: true },
    });
    expect((await publishingCalls()).map((entry) => entry.tool)).toEqual(["submit"]);

    let retried: Publication | undefined;
    let lastStatus = unknown.status;
    const retryDeadline = Date.now() + 10_000;
    for (let attempt = 0; attempt < 40 && !retried && Date.now() < retryDeadline; attempt += 1) {
      const current = await getPublication(client, unknown.id);
      const response = await client.callTool({
        name: "publication_retry",
        arguments: {
          id: unknown.id, workspaceId, expectedVersion: current.version,
          ...context(`retry-unknown-${attempt}`),
        },
      });
      if (response.isError) {
        expect(JSON.stringify(response)).toContain("Resource conflict");
      } else {
        const outcome = payload(response) as Publication;
        lastStatus = outcome.status;
        if (outcome.status === "verified") {
          retried = outcome;
        } else {
          expect(["unknown", "submitted"], `Unexpected retry status: ${outcome.status}`)
            .toContain(outcome.status);
          await delay(50);
        }
      }
      expect((await publishingCalls()).filter((entry) => entry.tool === "submit")).toHaveLength(1);
    }
    expect(retried, `Publication did not verify before retry timeout; last status: ${lastStatus}`).toBeDefined();
    const recovered = retried!;
    expect(recovered).toMatchObject({
      status: "verified", operationKey: unknown.operationKey,
      verification: { method: "provider" }, attempts: [{ attempt: 1, outcome: "unknown" }],
    });
    expect(recovered.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "verify", receiptId: expect.any(String), contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]));
    const recoveryCalls = await publishingCalls();
    expect(recoveryCalls[0]?.tool).toBe("submit");
    expect(recoveryCalls.slice(1).map((entry) => entry.tool)).toEqual(expect.arrayContaining(["verify"]));
    expect(recoveryCalls.slice(1).every((entry) => entry.tool === "verify")).toBe(true);
    expect(recoveryCalls.filter((entry) => entry.tool === "submit")).toHaveLength(1);
    await stopClient(first);

    const second = await startClient("submit-failed");
    expect(await getPublication(second.client, unknown.id)).toEqual(retried);
    expect((await publishingCalls()).filter((entry) => entry.tool === "submit")).toHaveLength(1);
    await call(second.client, "schedule_create", scheduleArguments("failed-manual", future(1_200)));
    const failed = await waitForPublication(second.client, "publication-failed-manual", "failed");
    expect(failed).toMatchObject({
      delivery: null, verification: null,
      failure: { code: "fixture_rejected" }, attempts: [{ attempt: 1, outcome: "failed" }],
    });
    const handoff = await call<Publication>(second.client, "publication_manual_handoff", {
      id: failed.id, workspaceId, expectedVersion: failed.version, ...context("failed-manual-handoff"),
    });
    expect(handoff).toMatchObject({ status: "manual_handoff", delivery: null, verification: null });
    const packageBytes = await readDeliveryPackage(second.client, handoff.id);
    const packageValue = JSON.parse(packageBytes.toString("utf8")) as JsonRecord;
    expect(packageValue).toMatchObject({
      status: "not_published", operationKey: handoff.operationKey,
      accountId, artifactHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      approval: { id: approvalId }, schedule: { id: failed.scheduleId },
    });
    expect(packageBytes.toString("utf8")).toBe(JSON.stringify(canonical(packageValue)));
    expect(JSON.stringify(packageValue)).not.toMatch(/artifactBase64|MARKETING_PUBLISHING|credential|apiKey/);

    const evidenceBytes = Buffer.from("Human confirmed independent fixture delivery", "utf8");
    await call(second.client, "evidence_record", {
      id: "evidence-manual-completion", workspaceId, sourceId: "source-owned-publishing",
      sourceLocator: "manual/independent-delivery-completion", observedAt: new Date().toISOString(),
      summary: "Human attested completion of the independent manual handoff",
      contentHash: sha256(evidenceBytes), classification: "owned_operating",
      ...context("manual-completion-evidence"),
    });
    const publishedAt = new Date().toISOString();
    const completed = await call<Publication>(second.client, "publication_manual_complete", {
      id: "completion-failed-manual", workspaceId, publicationId: handoff.id,
      expectedPublicationVersion: handoff.version, evidenceIds: ["evidence-manual-completion"],
      externalPublicationId: "manual-independent-receipt-1", publishedAt,
      ...context("manual-complete"),
    });
    expect(completed).toMatchObject({
      status: "verified", deliveryMode: "automatic",
      delivery: { method: "manual_evidence", evidenceIds: ["evidence-manual-completion"], publishedAt },
      verification: { method: "manual_evidence", evidenceIds: ["evidence-manual-completion"] },
    });
    expect(completed.verification).not.toMatchObject({ method: "provider" });
    const allCalls = await publishingCalls();
    expect(allCalls.filter((entry) => entry.tool === "submit")).toHaveLength(2);
    expect(allCalls.filter((entry) => (entry.input as JsonRecord).operationKey === unknown.operationKey && entry.tool === "submit"))
      .toHaveLength(1);
    const state = JSON.parse(await readFile(publishingStatePath, "utf8")) as { submissions: JsonRecord };
    expect(state.submissions[unknown.operationKey]).toMatchObject({ status: "verified" });
    await stopClient(second);
    const providerPids = (await readFile(publishingPidPath, "utf8")).trim().split("\n").map(Number);
    for (const pid of providerPids) await expectExited(pid);
  }, 180_000);

  it("binds real file and manual evidence to formulas, unknowns, lineage, and restart recovery", async () => {
    const first = await startClient();
    const { client } = first;
    await prepareAsset(client);
    await approveRoot(client);
    await call(client, "schedule_create", scheduleArguments("effect-manual", future(1_200), "manual_assisted"));
    const handoff = await waitForPublication(client, "publication-effect-manual", "manual_handoff");
    expect(await publishingCalls()).toEqual([]);

    const completionBytes = Buffer.from("Human verified the manual effect publication", "utf8");
    await call(client, "evidence_record", {
      id: "evidence-effect-completion", workspaceId, sourceId: "source-owned-publishing",
      sourceLocator: "manual/effect-completion", observedAt: new Date().toISOString(),
      summary: "Human attested the manual publication used for effect review",
      contentHash: sha256(completionBytes), classification: "owned_operating",
      ...context("effect-completion-evidence"),
    });
    const publishedAt = new Date().toISOString();
    const completed = await call<Publication>(client, "publication_manual_complete", {
      id: "completion-effect-manual", workspaceId, publicationId: handoff.id,
      expectedPublicationVersion: handoff.version, evidenceIds: ["evidence-effect-completion"],
      externalPublicationId: "manual-effect-receipt-1", publishedAt, ...context("effect-manual-complete"),
    });
    expect(completed).toMatchObject({ status: "verified", verification: { method: "manual_evidence" } });

    await writeFile(join(importDir, "effect-metrics.csv"),
      "content_id,impressions,interactions,profile_visits\ncontent-publishing,1000,100,200\n", "utf8");
    const files = await call(client, "ingest_files", {
      id: "batch-effect-metrics", workspaceId, paths: ["effect-metrics.csv"], ownership: "owned",
      ...context("effect-file-ingest"),
    });
    expect(files).toMatchObject({ state: "completed", failures: [] });
    const fileEvidenceId = (files.evidenceIds as string[])[0]!;
    const batchLineage = await call(client, "data_research_get", {
      entityType: "ingestion_batch", id: files.id, workspaceId,
    });
    const fileEvidence = ((batchLineage.descriptors as JsonRecord).evidence as JsonRecord[])
      .find((evidence) => evidence.id === fileEvidenceId)!;
    expect(fileEvidence).toMatchObject({ classification: "owned_operating" });
    expect((fileEvidence.assets as JsonRecord[]).map((asset) => asset.kind))
      .toEqual(expect.arrayContaining(["original", "normalized_jsonl", "quality_report"]));

    const conversionBytes = Buffer.from("Owned conversion ledger for effect acceptance", "utf8");
    await call(client, "evidence_record", {
      id: "evidence-effect-conversion", workspaceId, sourceId: "source-owned-publishing",
      sourceLocator: "manual/effect-conversion-ledger", observedAt: new Date().toISOString(),
      summary: "Owned conversion counts reconciled by a human",
      contentHash: sha256(conversionBytes), classification: "owned_conversion",
      ...context("effect-conversion-evidence"),
    });
    const windowEnd = future(1);
    const snapshotArguments = {
      id: "snapshot-effect-rates", workspaceId, publicationId: completed.id,
      expectedPublicationVersion: completed.version, windowStart: publishedAt, windowEnd,
      observedAt: future(2),
      observations: [
        { metric: "impressions", evidenceIds: [fileEvidenceId], value: 1_000 },
        { metric: "interactions", evidenceIds: [fileEvidenceId], value: 100 },
        { metric: "profile_visits", evidenceIds: [fileEvidenceId], value: 200 },
        { metric: "leads", evidenceIds: ["evidence-effect-conversion"], value: 20 },
        { metric: "purchases", evidenceIds: ["evidence-effect-conversion"], value: 5 },
      ],
      ...context("effect-rates-snapshot"),
    };
    const snapshot = await call(client, "effect_metric_snapshot_import", snapshotArguments);
    expect(snapshot).toMatchObject({ id: snapshotArguments.id, version: 1, publicationVersion: completed.version });
    const reviewArguments = {
      id: "review-effect-rates", workspaceId,
      publicationRefs: [{ id: completed.id, version: completed.version }],
      metricSnapshotIds: [snapshot.id], baselineMetricSnapshotIds: [], benchmarkEvidenceIds: [],
      ...context("effect-rates-review"),
    };
    const review = await call(client, "effect_review_create", reviewArguments);
    const metric = (section: string, name: string): JsonRecord =>
      ((review[section] as JsonRecord).metrics as JsonRecord[]).find((candidate) => candidate.name === name)!;
    expect(metric("content", "interactionRate")).toMatchObject({ value: 0.1, status: "ok", numerator: 100, denominator: 1_000 });
    expect(metric("content", "profileVisitRate")).toMatchObject({ value: 0.2, status: "ok", numerator: 200, denominator: 1_000 });
    expect(metric("conversion", "leadRate")).toMatchObject({ value: 0.1, status: "ok", numerator: 20, denominator: 200 });
    expect(metric("conversion", "purchaseRate")).toMatchObject({ value: 0.25, status: "ok", numerator: 5, denominator: 20 });
    expect(metric("automation", "automaticVerifiedRate")).toMatchObject({ value: 0, numerator: 0, denominator: 1 });
    for (const section of ["efficiency", "content", "conversion", "automation"]) {
      expect(review[section]).toMatchObject({ causality: "not_established" });
    }

    const unknownSnapshot = await call(client, "effect_metric_snapshot_import", {
      ...snapshotArguments, id: "snapshot-effect-unknown", observedAt: future(3),
      observations: [
        { metric: "impressions", evidenceIds: [fileEvidenceId], value: 0 },
        { metric: "interactions", evidenceIds: [fileEvidenceId], value: 7 },
        { metric: "purchases", evidenceIds: ["evidence-effect-conversion"], value: 3 },
      ],
      ...context("effect-unknown-snapshot"),
    });
    const unknownReview = await call(client, "effect_review_create", {
      ...reviewArguments, id: "review-effect-unknown", metricSnapshotIds: [unknownSnapshot.id],
      ...context("effect-unknown-review"),
    });
    const unknownMetric = (section: string, name: string): JsonRecord =>
      ((unknownReview[section] as JsonRecord).metrics as JsonRecord[]).find((candidate) => candidate.name === name)!;
    expect(unknownMetric("content", "interactionRate")).toMatchObject({
      value: null, status: "unknown", reason: "zero_denominator", numerator: 7, denominator: 0,
    });
    expect(unknownMetric("conversion", "purchaseRate")).toMatchObject({
      value: null, status: "unknown", reason: "missing_denominator", numerator: 3, denominator: null,
    });

    const lineage = await call(client, "lineage_get", {
      entityType: "effect_review", id: review.id, workspaceId,
    });
    expect(lineage.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "effect_review", id: review.id as string }),
      expect.objectContaining({ entityType: "metric_snapshot", id: snapshot.id as string }),
      expect.objectContaining({ entityType: "publication", id: completed.id }),
      expect.objectContaining({ entityType: "schedule", id: completed.scheduleId }),
      expect.objectContaining({ entityType: "approval", id: approvalId }),
      expect.objectContaining({ entityType: "asset_version", id: assetId }),
      expect.objectContaining({ entityType: "content_brief", id: briefId }),
      expect.objectContaining({ entityType: "task", id: "task-publishing" }),
      expect.objectContaining({ entityType: "recommendation", id: "recommendation-publishing" }),
      expect.objectContaining({ entityType: "evidence", id: fileEvidenceId }),
      expect.objectContaining({ entityType: "evidence", id: "evidence-effect-conversion" }),
      expect.objectContaining({ entityType: "source", id: "source-owned-publishing" }),
    ]));
    await stopClient(first);

    const restarted = await startClient();
    expect(await getPublication(restarted.client, completed.id)).toEqual(completed);
    expect(await call(restarted.client, "effect_metric_snapshot_get", { id: snapshot.id, workspaceId })).toEqual(snapshot);
    expect(await call(restarted.client, "effect_review_get", { id: review.id, workspaceId })).toEqual(review);
    expect(await call(restarted.client, "lineage_get", {
      entityType: "effect_review", id: review.id, workspaceId,
    })).toEqual(lineage);
    expect(await call(restarted.client, "effect_metric_snapshot_import", snapshotArguments)).toEqual(snapshot);
    expect(await call(restarted.client, "effect_review_create", reviewArguments)).toEqual(review);
    expect(await publishingCalls()).toEqual([]);
    await stopClient(restarted);
  }, 120_000);
});

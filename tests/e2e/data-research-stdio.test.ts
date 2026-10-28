import { createHash } from "node:crypto";
import { copyFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
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
const workspaceId = "workspace-data-research-e2e";
const credentialName = "TEST_TEMPORARY_API_TOKEN";
const credentialValue = "synthetic-stdio-test-token";

type JsonRecord = Record<string, unknown>;

interface RunningClient {
  client: Client;
  transport: StdioClientTransport;
  stderr: () => string;
}

function payload(result: CallToolResult): JsonRecord {
  expect(result.isError).not.toBe(true);
  expect(result.content[0]).toMatchObject({ type: "text" });
  return JSON.parse((result.content[0] as { text: string }).text) as JsonRecord;
}

function context(suffix: string): JsonRecord {
  return {
    actor: "data-research-acceptance",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  };
}

describe("built data-research stdio acceptance", () => {
  let dataDir: string;
  let importDir: string;
  let artifactDir: string;
  let fixtureServer: Server;
  let fixtureOrigin: string;
  let requests: { path: string; authorization?: string }[];
  const clients: RunningClient[] = [];

  beforeEach(async () => {
    [dataDir, importDir, artifactDir] = await Promise.all([
      createTempDir(),
      createTempDir(),
      createTempDir(),
    ]);
    await Promise.all([
      copyFile(
        join(projectRoot, "tests/fixtures/csv/marketing.csv"),
        join(importDir, "marketing.csv"),
      ),
      copyFile(
        join(projectRoot, "tests/fixtures/xlsx/marketing.xlsx"),
        join(importDir, "marketing.xlsx"),
      ),
    ]);
    requests = [];
    fixtureServer = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
      requests.push({ path, authorization: request.headers.authorization });
      if (path === "/api/metrics.json") {
        if (request.headers.authorization !== `Bearer ${credentialValue}`) {
          response.writeHead(401).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{
          content_id: "content-1",
          published_at: "2026-10-26T12:00:00.000Z",
          impressions: 10,
          clicks: 2,
        }]));
        return;
      }
      if (path === "/content/left" || path === "/content/right") {
        const left = path.endsWith("left");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><head><title>${left ? "Left" : "Right"} competitor</title></head><body><main>Public competitor observation</main><span class="price">20</span><button class="cta">${left ? "Buy" : "Start"}</button></body></html>`);
        return;
      }
      if (path === "/research/start") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<!doctype html><html><head><title>Research start</title></head><body>Research seed<a href="/research/child">Child</a><a href="/outside">Outside</a></body></html>');
        return;
      }
      if (path === "/research/child") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<!doctype html><html><head><title>Research child</title></head><body>Research child<a href="/research/too-deep">Too deep</a></body></html>');
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body>Out of scope</body></html>");
    });
    await new Promise<void>((resolveListen) => {
      fixtureServer.listen(0, "127.0.0.1", resolveListen);
    });
    fixtureOrigin = `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(async ({ client }) => {
      await client.close();
    }));
    fixtureServer.closeAllConnections();
    await new Promise<void>((resolveClose) => {
      fixtureServer.close(() => resolveClose());
    });
    await Promise.all([dataDir, importDir, artifactDir].map(removeTempDir));
  });

  async function startClient(): Promise<RunningClient> {
    const client = new Client({ name: "data-research-stdio-acceptance", version: "1.0.0" });
    let stderr = "";
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
        MARKETING_HTTP_CREDENTIAL_ALLOWLIST: credentialName,
        [credentialName]: credentialValue,
      },
      stderr: "pipe",
    });
    transport.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    await client.connect(transport);
    const running = { client, transport, stderr: () => stderr };
    clients.push(running);
    return running;
  }

  async function stopClient(running: RunningClient): Promise<void> {
    await running.client.close();
    clients.splice(clients.indexOf(running), 1);
    expect(running.stderr()).not.toContain(credentialValue);
    expect(running.stderr()).not.toContain("MCP shutdown failed");
  }

  it("completes real file, HTTP, Chromium, research, diff, asset, and restart workflows", async () => {
    const first = await startClient();
    const { client } = first;
    const call = async (name: string, arguments_: JsonRecord): Promise<JsonRecord> =>
      payload(await client.callTool({ name, arguments: arguments_ }));
    const get = async (entityType: string, id: string, target = client): Promise<JsonRecord> =>
      payload(await target.callTool({ name: "data_research_get", arguments: { entityType, id, workspaceId } }));
    const batchEvidence = async (batchId: string): Promise<JsonRecord[]> => {
      const batch = await get("ingestion_batch", batchId);
      return (batch.descriptors as JsonRecord).evidence as JsonRecord[];
    };

    await call("workspace_create", {
      id: workspaceId,
      name: "Data research stdio acceptance",
      ...context("workspace"),
    });
    await call("data_request_plan", {
      id: "plan-e2e",
      workspaceId,
      objective: "Understand content performance with owned and public evidence",
      questionTypes: ["content_performance"],
      availableFields: [],
      ...context("plan"),
    });

    const files = await call("ingest_files", {
      id: "batch-files-e2e",
      workspaceId,
      paths: ["marketing.csv", "marketing.xlsx"],
      planId: "plan-e2e",
      expectedPlanVersion: 1,
      limits: { maxFiles: 2, maxRows: 100, maxFileBytes: 1024 * 1024 },
      ...context("files"),
    });
    expect(files).toMatchObject({ state: "completed", failures: [] });
    expect(files.datasetIds).toHaveLength(3);
    expect(files.evidenceIds).toHaveLength(3);
    expect((await readdir(artifactDir)).length).toBeGreaterThan(0);
    await expect(readdir(join(dataDir, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
    const fileEvidence = (await batchEvidence(files.id as string))[0]!;
    expect(fileEvidence.id).toBe((files.evidenceIds as string[])[0]);
    const fileAssets = fileEvidence.assets as { id: string; kind: string }[];
    const qualityAsset = fileAssets.find((asset) => asset.kind === "quality_report")!;
    const quality = await call("evidence_asset_get", {
      workspaceId,
      evidenceId: fileEvidence.id as string,
      assetId: qualityAsset.id,
    });
    expect(JSON.parse(Buffer.from(quality.content as string, "base64").toString("utf8")))
      .toMatchObject({
        statistics: { rowCount: 2, duplicateRowCount: 0 },
        issues: [
          { code: "DUPLICATE_HEADER" },
          { code: "EMPTY_HEADER" },
          { code: "INCONSISTENT_COLUMNS" },
        ],
      });

    const api = await call("ingest_temporary_api", {
      id: "batch-api-e2e",
      workspaceId,
      url: `${fixtureOrigin}/api/metrics.json`,
      ownership: "authorized",
      expiresAt: "2099-01-01T00:00:00.000Z",
      credentialRef: `env:${credentialName}`,
      planId: "plan-e2e",
      expectedPlanVersion: 2,
      ...context("api"),
    });
    expect(api).toMatchObject({ state: "completed", failures: [] });
    expect(requests).toContainEqual({
      path: "/api/metrics.json",
      authorization: `Bearer ${credentialValue}`,
    });
    const apiEvidenceId = (api.evidenceIds as string[])[0]!;
    const apiEvidence = (await batchEvidence(api.id as string))[0]!;
    expect(apiEvidence.id).toBe(apiEvidenceId);
    const originalAsset = (apiEvidence.assets as { id: string; kind: string }[])
      .find((asset) => asset.kind === "api_response")!;
    const original = await call("evidence_asset_get", {
      workspaceId,
      evidenceId: apiEvidenceId,
      assetId: originalAsset.id,
    });
    expect(Buffer.from(original.content as string, "base64").toString("utf8"))
      .toContain('"content_id":"content-1"');

    const links = await call("ingest_content_links", {
      id: "batch-links-e2e",
      workspaceId,
      links: [
        { url: `${fixtureOrigin}/content/left`, fields: { price: ".price", cta: ".cta" } },
        { url: `${fixtureOrigin}/content/right`, fields: { price: ".price", cta: ".cta" } },
      ],
      ...context("links"),
    });
    expect(links).toMatchObject({ state: "completed", failures: [] });
    const contentEvidenceIds = links.evidenceIds as string[];
    const competitorIds = links.competitorIds as string[];
    expect(contentEvidenceIds).toHaveLength(2);
    expect(competitorIds).toHaveLength(2);

    await call("research_session_create", {
      id: "session-e2e",
      workspaceId,
      goal: "Observe only the approved local research pages",
      seeds: [`${fixtureOrigin}/research/start`],
      expansion: true,
      scope: {
        hosts: ["127.0.0.1"],
        pathPrefixes: ["/research"],
        maxDepth: 1,
        maxPages: 2,
        maxDurationMs: 30_000,
        maxBytes: 2 * 1024 * 1024,
      },
      ...context("research-create"),
    });
    const permission = await call("research_permission_set", {
      id: "session-e2e",
      workspaceId,
      expectedVersion: 1,
      expansion: "allowed",
      ...context("research-permission"),
    });
    expect(permission).toMatchObject({ expansion: "allowed", state: "ready", version: 2 });
    const research = await call("research_session_run", {
      id: "session-e2e",
      workspaceId,
      expectedVersion: 2,
      ...context("research-run"),
    });
    expect(research).toMatchObject({
      state: "partial",
      stopReason: "max_depth",
      attemptCount: 2,
      version: 3,
    });
    expect(research.evidenceIds).toHaveLength(2);
    expect(requests.map((request) => request.path)).not.toContain("/outside");
    expect(requests.map((request) => request.path)).not.toContain("/research/too-deep");

    for (const [index, id] of competitorIds.entries()) {
      const candidate = await get("competitor", id);
      expect(candidate.entity).toMatchObject({ status: "excluded", evidenceIds: [contentEvidenceIds[index]] });
      const confirmed = await call("competitor_confirm", {
        id,
        workspaceId,
        expectedVersion: 1,
        status: "confirmed",
        ...context(`competitor-confirm-${index}`),
      });
      expect(confirmed).toMatchObject({ id, status: "confirmed", version: 2 });
    }
    const diff = await call("competitor_diff_create", {
      id: "diff-e2e",
      workspaceId,
      competitorIds: competitorIds as [string, string],
      dimensions: ["price", "cta"],
      ...context("diff"),
    });
    const sortedContentEvidenceIds = [...contentEvidenceIds].sort();
    expect(diff).toMatchObject({
      entries: [
        { dimension: "price", result: "same", evidenceIds: sortedContentEvidenceIds },
        { dimension: "cta", result: "different", evidenceIds: sortedContentEvidenceIds },
      ],
      findingIds: [],
    });

    await stopClient(first);
    const second = await startClient();
    const restoredPlan = await get("data_request_plan", "plan-e2e", second.client);
    expect(restoredPlan.entity).toMatchObject({ id: "plan-e2e", version: 3, round: 3 });
    expect(restoredPlan.descriptors).toMatchObject({
      rounds: [{ round: 1 }, { round: 2 }, { round: 3 }],
      batches: [{ entityType: "ingestion_batch", id: "batch-files-e2e" }, { entityType: "ingestion_batch", id: "batch-api-e2e" }],
    });
    const restoredSession = await get("research_session", "session-e2e", second.client);
    expect(restoredSession.entity).toMatchObject({ id: "session-e2e", version: 3, attemptCount: 2 });
    expect((restoredSession.descriptors as JsonRecord).evidence).toHaveLength(2);
    const restoredDiff = await get("competitor_diff", "diff-e2e", second.client);
    expect(restoredDiff.entity).toMatchObject({ id: "diff-e2e", version: 1, competitorIds });
    expect(restoredDiff.descriptors).toMatchObject({ entries: diff.entries });
    for (const [entityType, id, version] of [
      ["data_request_plan", "plan-e2e", 3],
      ["research_session", "session-e2e", 3],
      ["competitor_diff", "diff-e2e", 1],
    ] as const) {
      const restored = await get(entityType, id, second.client);
      expect(restored.workspaceId).toBe(workspaceId);
      expect(restored.nodes).toContainEqual(expect.objectContaining({ entityType, id, version }));
    }
    const restoredOriginal = payload(await second.client.callTool({
      name: "evidence_asset_get",
      arguments: { workspaceId, evidenceId: apiEvidenceId, assetId: originalAsset.id },
    }));
    expect(restoredOriginal).toEqual(original);
    expect(restoredOriginal).toMatchObject({ id: originalAsset.id, kind: "api_response", contentHash: original.contentHash, byteLength: original.byteLength });
    expect(second.stderr()).not.toContain(credentialValue);
    await stopClient(second);
  }, 90_000);

  it("reads large evidence assets in bounded chunks with hash verification and restart recovery", async () => {
    const originalContent = Buffer.from(`name,amount\n${Array.from(
      { length: 12_000 },
      (_, index) => `product-${index},${index}\n`,
    ).join("")}`);
    expect(originalContent.length).toBeGreaterThan(64 * 1024);
    await writeFile(join(importDir, "large.csv"), originalContent);
    const first = await startClient();
    const { client } = first;
    const call = async (name: string, arguments_: JsonRecord): Promise<JsonRecord> =>
      payload(await client.callTool({ name, arguments: arguments_ }));
    await call("workspace_create", {
      id: workspaceId,
      name: "Chunked evidence assets",
      ...context("chunk-workspace"),
    });
    const batch = await call("ingest_files", {
      id: "batch-large-asset",
      workspaceId,
      paths: ["large.csv"],
      ...context("chunk-ingest"),
    });
    const lineage = await call("data_research_get", {
      entityType: "ingestion_batch",
      id: batch.id as string,
      workspaceId,
    });
    const evidence = ((lineage.descriptors as JsonRecord).evidence as JsonRecord[])[0]!;
    const asset = (evidence.assets as JsonRecord[])
      .find((candidate) => candidate.kind === "original")!;
    const selector = {
      workspaceId,
      evidenceId: evidence.id as string,
      assetId: asset.id as string,
    };

    const firstChunk = await call("evidence_asset_get", selector);
    expect(firstChunk).toMatchObject({
      offset: 0,
      length: 32 * 1024,
      totalBytes: originalContent.length,
      contentHash: asset.contentHash,
    });
    const chunks = [Buffer.from(firstChunk.content as string, "base64")];
    while (chunks.reduce((sum, chunk) => sum + chunk.length, 0) < originalContent.length) {
      const offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const chunk = await call("evidence_asset_get", { ...selector, offset, length: 16_384 });
      expect(chunk).toMatchObject({
        offset,
        totalBytes: originalContent.length,
        contentHash: asset.contentHash,
      });
      const content = Buffer.from(chunk.content as string, "base64");
      expect(content.length).toBe(chunk.length);
      expect(content.length).toBeLessThanOrEqual(16_384);
      chunks.push(content);
    }
    const restored = Buffer.concat(chunks);
    expect(restored.equals(originalContent)).toBe(true);
    expect(createHash("sha256").update(restored).digest("hex")).toBe(asset.contentHash);
    expect(chunks.length).toBeGreaterThan(2);

    for (const [page, message] of [
      [{ offset: -1, length: 1 }, "Input validation error"],
      [{ offset: 0, length: 0 }, "Input validation error"],
      [{ offset: 0, length: 32 * 1024 + 1 }, "Input validation error"],
      [{ offset: 1.5, length: 1 }, "Input validation error"],
      [{ offset: originalContent.length + 1, length: 1 }, "Invalid input"],
    ] as const) {
      const result = await client.callTool({
        name: "evidence_asset_get",
        arguments: { ...selector, ...page },
      });
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain(message);
    }
    const end = await call("evidence_asset_get", {
      ...selector,
      offset: originalContent.length,
      length: 1,
    });
    expect(end).toMatchObject({ offset: originalContent.length, length: 0, content: "" });

    await stopClient(first);
    const second = await startClient();
    const restoredChunk = payload(await second.client.callTool({
      name: "evidence_asset_get",
      arguments: { ...selector, offset: chunks[0]!.length, length: 16_384 },
    }));
    expect(Buffer.from(restoredChunk.content as string, "base64").equals(chunks[1]!)).toBe(true);
    expect(restoredChunk).toMatchObject({
      offset: chunks[0]!.length,
      totalBytes: originalContent.length,
      contentHash: asset.contentHash,
    });
    await stopClient(second);
  }, 60_000);
});

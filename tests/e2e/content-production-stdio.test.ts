import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDir, removeTempDir } from "../helpers.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const serverPath = join(projectRoot, "dist", "index.js");
const benchmarkFixture = fileURLToPath(
  new URL("../fixtures/benchmark-reverse-mcp.mjs", import.meta.url),
);
const mediaFixture = fileURLToPath(
  new URL("../fixtures/professional-media-mcp.mjs", import.meta.url),
);
const ffmpeg = process.env.MARKETING_TEST_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const ffprobe = process.env.MARKETING_TEST_FFPROBE ?? "/opt/homebrew/bin/ffprobe";
const workspaceId = "workspace-content-production-stdio";
const analysisId = "benchmark-content-production";
const xhsBriefId = "brief-original-xhs";
const channelsBriefId = "brief-original-channels";
const xhsRootId = "asset-xhs-v1";
const xhsDerivedId = "asset-xhs-v2";
const channelsRootId = "asset-channels-v1";
const publicExcerpt = "PUBLIC_FIXTURE_EXCERPT_NEVER_COPY_9f27c6";

type JsonRecord = Record<string, unknown>;

interface RunningClient {
  client: Client;
  transport: StdioClientTransport;
  stderr: () => string;
  stdout: () => string;
}

interface ArtifactDescriptor extends JsonRecord {
  id: string;
  contentHash: string;
  byteLength: number;
  mediaType: "image/png" | "video/mp4";
}

interface AssetVersion extends JsonRecord {
  id: string;
  version: number;
  contentId: string;
  artifact: ArtifactDescriptor;
}

function payload(result: CallToolResult): JsonRecord {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.content[0]).toMatchObject({ type: "text" });
  return JSON.parse((result.content[0] as { text: string }).text) as JsonRecord;
}

function context(suffix: string): JsonRecord {
  return {
    actor: "content-production-stdio-acceptance",
    requestId: `request-${suffix}`,
    idempotencyKey: `command-${suffix}`,
  };
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function creative(id: string, text: string): JsonRecord {
  return { id, kind: "creative", text };
}

function ownedFact(id: string): JsonRecord {
  return {
    id,
    kind: "fact",
    text: "自有账本已在本次观察窗口完成核对。",
    findingId: "finding-owned-fact",
  };
}

function briefArguments(channel: "xhs" | "channels"): JsonRecord {
  const suffix = channel === "xhs" ? "xhs" : "channels";
  const frames = channel === "channels" ? [
    {
      id: "channels-shot-1",
      order: 1,
      purpose: "建立原创工作流场景",
      visualDirection: "原创广角镜头展示操作台与屏幕",
      onScreenText: [creative("channels-shot-1-screen", "先看核对流程")],
      narration: [creative("channels-shot-1-narration", "第一步，打开本次账本的核对视图。")],
      durationMs: 1_000,
    },
    {
      id: "channels-shot-2",
      order: 2,
      purpose: "展示可追溯的事实表达",
      visualDirection: "原创近景镜头展示已核对标记",
      onScreenText: [ownedFact("channels-shot-2-fact")],
      narration: [creative("channels-shot-2-narration", "第二步，只引用已经保存的事实。")],
      durationMs: 1_000,
    },
  ] : [{
    id: "xhs-frame-1",
    order: 1,
    purpose: "呈现原创账本核对流程",
    visualDirection: "原创俯拍画面，账本与核对标记分层排列",
    onScreenText: [creative("xhs-frame-screen", "把事实和创作分开")],
    narration: [ownedFact("xhs-frame-fact")],
    durationMs: null,
  }];
  return {
    id: channel === "xhs" ? xhsBriefId : channelsBriefId,
    workspaceId,
    taskId: "task-content-production",
    expectedTaskVersion: 2,
    recommendationId: "recommendation-content-production",
    expectedRecommendationVersion: 1,
    benchmarkAnalysisId: analysisId,
    expectedBenchmarkVersion: 1,
    channel,
    methodIds: ["method-hook", "method-order", "method-cta"],
    objective: "用中文原创表达说明如何复核并引用一条自有事实",
    audience: "需要整理自有经营记录的中文内容创作者",
    copy: {
      hook: creative(`hook-${suffix}`, "先核对来源，再写下一句能追溯的话。"),
      body: [ownedFact(`body-${suffix}`)],
      cta: creative(`cta-${suffix}`, "打开你的原始记录，独立完成下一次核对。"),
    },
    frames,
    assetRequirements: ["仅使用独立自有或已授权素材", "保留人工终审环节"],
    ...context(`brief-${suffix}`),
  };
}

function generateArguments(channel: "xhs" | "channels"): JsonRecord {
  return {
    id: channel === "xhs" ? xhsRootId : channelsRootId,
    workspaceId,
    contentId: `content-${channel}`,
    briefId: channel === "xhs" ? xhsBriefId : channelsBriefId,
    expectedBriefVersion: 1,
    sourceMaterials: [],
    revisionInstructions: channel === "xhs"
      ? "按内部 XHS 配置生成原创中文账本核对图片"
      : "按内部 Channels 配置生成两个各一秒的原创中文镜头",
    ...context(`generate-${channel}`),
  };
}

async function expectExited(pid: number): Promise<void> {
  expect(() => process.kill(pid, 0)).toThrow();
}

describe("built content production stdio acceptance", () => {
  let dataDir: string;
  let importDir: string;
  let artifactDir: string;
  let fixtureDir: string;
  let fixtureServer: Server;
  let fixtureOrigin: string;
  let fixturePaths: string[];
  let mediaCapturePath: string;
  let mediaPidPath: string;
  let configuredBenchmarkFixture: string;
  let configuredMediaFixture: string;
  const clients: RunningClient[] = [];

  beforeEach(async () => {
    [dataDir, importDir, artifactDir, fixtureDir] = await Promise.all([
      createTempDir(),
      createTempDir(),
      createTempDir(),
      createTempDir(),
    ]);
    const require = createRequire(import.meta.url);
    const externalizeImports = (source: string): string => source
      .replace(
        'from "@modelcontextprotocol/sdk/server/mcp.js"',
        `from ${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/mcp.js"))}`,
      )
      .replace(
        'from "@modelcontextprotocol/sdk/server/stdio.js"',
        `from ${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/stdio.js"))}`,
      )
      .replace('from "zod"', `from ${JSON.stringify(require.resolve("zod"))}`);
    const benchmarkSource = externalizeImports(await readFile(benchmarkFixture, "utf8"));
    const visualBranch = `  } else if (byKind("screenshot").length > 0) {
    methods = [method("method-layout", "layout", "image", "medium", byKind("screenshot"))];
  } else {`;
    const completeImageMethods = `  } else if (byKind("screenshot").length > 0) {
    methods = [
      method("method-hook", "hook", "text", "high", byKind("page_text")),
      method("method-order", "information_order", "text", "unknown", byKind("page_text")),
      method("method-cta", "cta", "text", "low", byKind("page_text")),
      method("method-layout", "layout", "image", "medium", byKind("screenshot")),
    ];
  } else {`;
    expect(benchmarkSource).toContain(visualBranch);
    configuredBenchmarkFixture = join(fixtureDir, "benchmark-reverse-mcp.mjs");
    await writeFile(
      configuredBenchmarkFixture,
      benchmarkSource.replace(visualBranch, completeImageMethods),
      { flag: "wx" },
    );
    const mediaSource = externalizeImports(await readFile(mediaFixture, "utf8"));
    const pngInput = "color=c=${color}:s=${width}x${height}";
    const videoInput = "color=c=${color}:s=${width}x1920:r=1";
    expect(mediaSource).toContain(pngInput);
    expect(mediaSource).toContain(videoInput);
    configuredMediaFixture = join(fixtureDir, "professional-media-mcp.mjs");
    await writeFile(
      configuredMediaFixture,
      mediaSource
        .replace(pngInput, `${pngInput},noise=alls=20:allf=t+u`)
        .replace(videoInput, `${videoInput},noise=alls=20:allf=t+u`),
      { flag: "wx" },
    );
    mediaCapturePath = join(fixtureDir, "media-calls.jsonl");
    mediaPidPath = join(fixtureDir, "media-pids.txt");
    await writeFile(mediaCapturePath, "", "utf8");
    await writeFile(mediaPidPath, "", "utf8");
    expect(isAbsolute(ffmpeg)).toBe(true);
    expect(isAbsolute(ffprobe)).toBe(true);
    expect(execFileSync(ffmpeg, ["-version"], { encoding: "utf8" })).toContain("ffmpeg version");
    expect(execFileSync(ffprobe, ["-version"], { encoding: "utf8" })).toContain("ffprobe version");
    fixturePaths = [];
    fixtureServer = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
      fixturePaths.push(path);
      if (path === "/benchmark/left" || path === "/benchmark/right") {
        const left = path.endsWith("left");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><head><title>${left ? "Left" : "Right"} legal public benchmark</title></head><body><main>${publicExcerpt} authorized structural observation</main><span class="price">${left ? 20 : 30}</span><button class="cta">Start</button></body></html>`);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolveListen) => {
      fixtureServer.listen(0, "127.0.0.1", resolveListen);
    });
    fixtureOrigin = `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(({ client }) => client.close()));
    fixtureServer.closeAllConnections();
    await new Promise<void>((resolveClose) => {
      fixtureServer.close(() => resolveClose());
    });
    await Promise.all([dataDir, importDir, artifactDir, fixtureDir].map(removeTempDir));
  });

  async function startClient(providers = true): Promise<RunningClient> {
    const client = new Client({ name: "content-production-stdio-acceptance", version: "1.0.0" });
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
        ...(providers ? {
          MARKETING_BENCHMARK_MCP_COMMAND: process.execPath,
          MARKETING_BENCHMARK_MCP_ARGS: JSON.stringify([configuredBenchmarkFixture]),
          MARKETING_MEDIA_MCP_COMMAND: process.execPath,
          MARKETING_MEDIA_MCP_ARGS: JSON.stringify([configuredMediaFixture]),
          MARKETING_MEDIA_MCP_ENV_ALLOWLIST: "MARKETING_TEST_FFMPEG,MEDIA_FIXTURE_CAPTURE,MEDIA_FIXTURE_PID_FILE",
          MARKETING_TEST_FFMPEG: ffmpeg,
          MEDIA_FIXTURE_CAPTURE: mediaCapturePath,
          MEDIA_FIXTURE_PID_FILE: mediaPidPath,
          MARKETING_FFPROBE_COMMAND: ffprobe,
        } : {}),
      },
      stderr: "pipe",
    });
    transport.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    transport.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    await client.connect(transport);
    const running = {
      client,
      transport,
      stderr: () => stderr,
      stdout: () => stdout,
    };
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
    code?: string,
  ): Promise<CallToolResult> {
    const result = await client.callTool({ name, arguments: arguments_ });
    expect(result, `${name} must reject the requested operation`).toMatchObject({ isError: true });
    if (code) {
      const safeMessage = {
        INVALID_INPUT: "Invalid input",
        NOT_FOUND: "Resource not found",
        CONFLICT: "Resource conflict",
      }[code];
      expect(safeMessage, `Unsupported expected error code ${code}`).toBeDefined();
      expect(JSON.stringify(result)).toContain(safeMessage);
    }
    return result;
  }

  async function batchEvidence(client: Client, batchId: string): Promise<JsonRecord[]> {
    const lineage = await call(client, "data_research_get", {
      entityType: "ingestion_batch",
      id: batchId,
      workspaceId,
    });
    return (lineage.descriptors as JsonRecord).evidence as JsonRecord[];
  }

  async function readEvidenceAsset(
    client: Client,
    evidenceId: string,
    asset: JsonRecord,
  ): Promise<Buffer> {
    const totalBytes = asset.byteLength as number;
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < totalBytes;) {
      const length = Math.min(32_768, totalBytes - offset);
      const chunk = await call(client, "evidence_asset_get", {
        workspaceId,
        evidenceId,
        assetId: asset.id as string,
        offset,
        length,
      });
      const bytes = Buffer.from(chunk.content as string, "base64");
      expect(chunk).toMatchObject({ offset, length, totalBytes, contentHash: asset.contentHash });
      expect(bytes.byteLength).toBe(length);
      chunks.push(bytes);
      offset += length;
    }
    const bytes = Buffer.concat(chunks);
    expect(sha256(bytes)).toBe(asset.contentHash);
    return bytes;
  }

  async function readContentArtifact(
    client: Client,
    asset: AssetVersion,
  ): Promise<{ bytes: Buffer; chunks: number }> {
    const descriptor = asset.artifact;
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < descriptor.byteLength;) {
      const length = Math.min(32_768, descriptor.byteLength - offset);
      const chunk = await call(client, "content_artifact_get", {
        id: asset.id,
        workspaceId,
        artifactId: descriptor.id,
        offset,
        length,
      });
      const bytes = Buffer.from(chunk.content as string, "base64");
      expect(length).toBeLessThanOrEqual(32_768);
      expect(chunk).toMatchObject({
        offset,
        length,
        totalBytes: descriptor.byteLength,
        contentHash: descriptor.contentHash,
        mediaType: descriptor.mediaType,
      });
      expect(bytes.byteLength).toBe(length);
      chunks.push(bytes);
      offset += length;
    }
    const bytes = Buffer.concat(chunks);
    expect(bytes.byteLength).toBe(descriptor.byteLength);
    expect(sha256(bytes)).toBe(descriptor.contentHash);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    return { bytes, chunks: chunks.length };
  }

  async function decodePng(bytes: Buffer): Promise<void> {
    const browser = await chromium.launch({ headless: true });
    try {
      const browserContext = await browser.newContext({ offline: true });
      const page = await browserContext.newPage();
      const dimensions = await page.evaluate(async (source) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      }, `data:image/png;base64,${bytes.toString("base64")}`);
      expect(dimensions).toEqual({ width: 1080, height: 1440 });
      await browserContext.close();
    } finally {
      await browser.close();
    }
  }

  async function probeMp4(bytes: Buffer, expectedValidation: JsonRecord): Promise<void> {
    const mediaPath = join(fixtureDir, "independent-channels-probe.mp4");
    await writeFile(mediaPath, bytes, { flag: "wx", mode: 0o600 });
    const inspection = JSON.parse(execFileSync(ffprobe, [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name,width,height:format=duration",
      "-show_streams",
      "-show_format",
      "-of", "json",
      mediaPath,
    ], { encoding: "utf8", timeout: 10_000 })) as {
      streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
      format: { duration: string };
    };
    const videos = inspection.streams.filter((stream) => stream.codec_type === "video");
    const audio = inspection.streams.filter((stream) => stream.codec_type === "audio");
    expect(videos).toHaveLength(1);
    expect(audio).toHaveLength(1);
    expect(videos[0]).toMatchObject({ codec_name: "h264", width: 1080, height: 1920 });
    expect(audio[0]).toMatchObject({ codec_name: "aac" });
    const durationMs = Math.round(Number(inspection.format.duration) * 1_000);
    expect(Number.isFinite(durationMs)).toBe(true);
    expect(Math.abs(durationMs - 2_000)).toBeLessThanOrEqual(50);
    expect(Math.abs((expectedValidation.durationMs as number) - 2_000)).toBeLessThanOrEqual(50);
  }

  it("runs real acquisition, reverse, original briefs, media, derivation, replay, restart, and unavailable gaps", async () => {
    const acquisitionStarted = Date.now();
    const first = await startClient();
    const { client } = first;
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "benchmark_reverse_create", "benchmark_reverse_get", "content_brief_create", "content_brief_get",
      "content_asset_generate", "content_asset_derive", "content_asset_get", "content_artifact_get",
    ]));
    expect(tools.map((tool) => tool.name).filter((name) => /approve|approval|schedule|publish|effect.review/i.test(name)))
      .toEqual(expect.arrayContaining([
        "approval_record", "approval_get", "schedule_create", "schedule_reschedule", "schedule_cancel",
        "schedule_get", "effect_review_create", "effect_review_get",
      ]));

    await call(client, "workspace_create", {
      id: workspaceId,
      name: "Content production stdio acceptance",
      ...context("workspace"),
    });
    const acquired = await call(client, "ingest_content_links", {
      id: "batch-public-benchmarks",
      workspaceId,
      links: [
        { url: `${fixtureOrigin}/benchmark/left`, fields: { price: ".price", cta: ".cta" } },
        { url: `${fixtureOrigin}/benchmark/right`, fields: { price: ".price", cta: ".cta" } },
      ],
      ...context("public-benchmarks"),
    });
    expect(acquired).toMatchObject({ state: "completed", failures: [] });
    expect(fixturePaths).toEqual(expect.arrayContaining(["/benchmark/left", "/benchmark/right"]));
    const publicEvidenceIds = acquired.evidenceIds as string[];
    const competitorIds = acquired.competitorIds as string[];
    expect(publicEvidenceIds).toHaveLength(2);
    expect(competitorIds).toHaveLength(2);
    const publicEvidence = await batchEvidence(client, acquired.id as string);
    for (const evidence of publicEvidence) {
      const observedMs = Date.parse(evidence.observedAt as string);
      expect(observedMs).toBeGreaterThanOrEqual(acquisitionStarted - 1_000);
      expect(observedMs).toBeLessThanOrEqual(Date.now() + 1_000);
      expect((evidence.assets as JsonRecord[]).map((asset) => asset.kind)).toEqual(
        expect.arrayContaining(["page_text", "screenshot"]),
      );
    }
    for (const [index, id] of competitorIds.entries()) {
      expect(await call(client, "competitor_confirm", {
        id,
        workspaceId,
        expectedVersion: 1,
        status: "confirmed",
        ...context(`confirm-competitor-${index}`),
      })).toMatchObject({ id, status: "confirmed", version: 2 });
    }
    const diff = await call(client, "competitor_diff_create", {
      id: "diff-public-benchmarks",
      workspaceId,
      competitorIds,
      dimensions: ["price", "cta", "audience"],
      ...context("competitor-diff"),
    });
    expect(diff.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: "price", result: "different" }),
      expect.objectContaining({ dimension: "audience", result: "unknown" }),
    ]));
    expect((diff.entries as JsonRecord[]).some((entry) => entry.result === "different")).toBe(true);
    expect((diff.entries as JsonRecord[]).some((entry) => entry.result === "unknown")).toBe(true);

    const reverseArguments = {
      id: analysisId,
      workspaceId,
      modality: "image",
      evidenceIds: publicEvidenceIds,
      competitorDiffId: "diff-public-benchmarks",
      expectedCompetitorDiffVersion: 1,
      ...context("benchmark-reverse"),
    };
    const analysis = await call(client, "benchmark_reverse_create", reverseArguments);
    expect(analysis).toMatchObject({
      id: analysisId,
      version: 1,
      modality: "image",
      competitorDiffId: "diff-public-benchmarks",
      provider: {
        type: "mcp",
        tool: "reverse_engineer",
        toolVersion: "fixture-2026.10.28",
        analysisMethod: "independent-test-fixture-structural-v1",
        humanReview: "not_performed",
      },
    });
    expect(analysis.provider as JsonRecord).toMatchObject({ inputHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const methods = analysis.methods as JsonRecord[];
    expect(methods.map((method) => [method.id, method.dimension, method.confidence])).toEqual(expect.arrayContaining([
      ["method-hook", "hook", "high"],
      ["method-order", "information_order", "unknown"],
      ["method-cta", "cta", "low"],
    ]));
    const observations: JsonRecord[] = [];
    const assetByIdentity = new Map<string, JsonRecord>();
    for (const evidence of publicEvidence) {
      const assets: JsonRecord[] = [];
      for (const asset of evidence.assets as JsonRecord[]) {
        if (asset.kind !== "page_text" && asset.kind !== "screenshot") continue;
        const bytes = await readEvidenceAsset(client, evidence.id as string, asset);
        const reference = {
          sourceId: evidence.sourceId,
          evidenceId: evidence.id,
          assetId: asset.id,
          kind: asset.kind,
          observedAt: evidence.observedAt,
          contentHash: asset.contentHash,
          byteLength: asset.byteLength,
        };
        assetByIdentity.set(`${evidence.id}:${asset.id}`, reference as JsonRecord);
        assets.push({
          ...reference,
          ...(asset.kind === "page_text"
            ? { text: bytes.toString("utf8") }
            : { base64: bytes.toString("base64") }),
        });
      }
      observations.push({
        sourceId: evidence.sourceId,
        evidenceId: evidence.id,
        observedAt: evidence.observedAt,
        assets,
      });
    }
    expect((analysis.provider as JsonRecord).inputHash).toBe(
      sha256(JSON.stringify(canonical({ modality: "image", observations }))),
    );
    for (const method of methods) {
      for (const reference of method.evidenceAssetRefs as JsonRecord[]) {
        expect(reference).toEqual(assetByIdentity.get(`${reference.evidenceId}:${reference.assetId}`));
        expect(reference.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(Date.parse(reference.observedAt as string)).toBeLessThanOrEqual(Date.now() + 1_000);
      }
    }
    const analysisJson = JSON.stringify(analysis);
    expect(analysisJson).not.toContain(publicExcerpt);
    expect(analysisJson).not.toMatch(/causal|human viewing|metric/i);
    for (const forbidden of ["excerpt", "metricValue", "causalEffect", "humanViewed"]) {
      expect(analysisJson).not.toContain(forbidden);
    }
    expect(await call(client, "benchmark_reverse_get", { id: analysisId, workspaceId })).toEqual(analysis);

    const factBytes = Buffer.from("Owned ledger reconciled in the declared observation window.", "utf8");
    await call(client, "source_register", {
      id: "source-owned-facts",
      workspaceId,
      name: "Owned manual facts",
      type: "manual",
      ownership: "owned",
      ...context("owned-source"),
    });
    await call(client, "evidence_record", {
      id: "evidence-owned-fact",
      workspaceId,
      sourceId: "source-owned-facts",
      sourceLocator: "manual/owned-ledger-reconciliation",
      observedAt: "2026-10-28T08:00:00.000Z",
      summary: "The owned ledger was reconciled in the declared observation window",
      contentHash: sha256(factBytes),
      classification: "owned_operating",
      ...context("owned-evidence"),
    });
    await call(client, "finding_record", {
      id: "finding-owned-fact",
      workspaceId,
      kind: "fact",
      statement: "自有账本已在本次观察窗口完成核对。",
      evidenceIds: ["evidence-owned-fact"],
      ...context("owned-finding"),
    });
    const recommendation = await call(client, "strategy_recommendation_generate", {
      id: "recommendation-content-production",
      workspaceId,
      findingIds: ["finding-owned-fact"],
      hypothesis: "分别制作原创图文和短视频，以清晰展示事实复核过程",
      affectedStage: "engagement",
      targetChannels: ["xhs", "channels"],
      priority: "p1",
      expectedMetrics: [{ metricId: "engagement_rate_v1", acceptance: "establish_baseline" }],
      ...context("recommendation"),
    });
    expect(recommendation.targetChannels).toEqual(["xhs", "channels"]);
    expect(await call(client, "task_create", {
      id: "task-content-production",
      workspaceId,
      recommendationIds: ["recommendation-content-production"],
      assignee: "human-content-owner",
      dependencyIds: [],
      assetRequirements: ["原创渠道素材"],
      acceptanceCriteria: ["人工确认后才可进入后续外部流程"],
      ...context("task-create"),
    })).toMatchObject({ state: "draft", version: 1 });
    expect(await call(client, "task_transition", {
      id: "task-content-production",
      workspaceId,
      next: "ready",
      expectedVersion: 1,
      ...context("task-ready"),
    })).toMatchObject({ state: "ready", version: 2 });

    await call(client, "source_register", {
      id: "source-unreferenced",
      workspaceId,
      name: "Unreferenced owned record",
      type: "manual",
      ownership: "owned",
      ...context("unreferenced-source"),
    });
    await call(client, "evidence_record", {
      id: "evidence-unreferenced",
      workspaceId,
      sourceId: "source-unreferenced",
      sourceLocator: "manual/unreferenced",
      observedAt: "2026-10-28T09:00:00.000Z",
      summary: "An owned fact outside the recommendation context",
      contentHash: "c".repeat(64),
      classification: "owned_operating",
      ...context("unreferenced-evidence"),
    });
    await call(client, "finding_record", {
      id: "finding-unreferenced",
      workspaceId,
      kind: "fact",
      statement: "一条不属于当前建议上下文的自有事实。",
      evidenceIds: ["evidence-unreferenced"],
      ...context("unreferenced-finding"),
    });
    const invalidBrief = briefArguments("xhs");
    invalidBrief.id = "brief-rejected-unreferenced-fact";
    (invalidBrief.copy as JsonRecord).body = [{
      id: "unreferenced-body",
      kind: "fact",
      text: "不应被接受的未关联事实。",
      findingId: "finding-unreferenced",
    }];
    Object.assign(invalidBrief, context("brief-unreferenced-rejection"));
    await expectToolError(client, "content_brief_create", invalidBrief, "INVALID_INPUT");
    await expectToolError(client, "content_brief_get", {
      id: "brief-rejected-unreferenced-fact",
      workspaceId,
    }, "NOT_FOUND");

    const xhsBrief = await call(client, "content_brief_create", briefArguments("xhs"));
    const channelsBrief = await call(client, "content_brief_create", briefArguments("channels"));
    for (const brief of [xhsBrief, channelsBrief]) {
      expect(brief).toMatchObject({
        version: 1,
        findingIds: ["finding-owned-fact"],
        evidenceIds: ["evidence-owned-fact"],
      });
      expect(brief.methodIds).toEqual(["method-hook", "method-order", "method-cta"]);
      expect((brief.copy as JsonRecord).body).toEqual([expect.objectContaining({
        kind: "fact",
        findingId: "finding-owned-fact",
      })]);
    }
    expect((channelsBrief.frames as JsonRecord[]).map((frame) => frame.durationMs)).toEqual([1_000, 1_000]);
    expect(await call(client, "content_brief_get", { id: xhsBriefId, workspaceId })).toEqual(xhsBrief);
    expect(await call(client, "content_brief_get", { id: channelsBriefId, workspaceId })).toEqual(channelsBrief);

    const xhsGenerateArguments = generateArguments("xhs");
    const channelsGenerateArguments = generateArguments("channels");
    const xhsRoot = await call<AssetVersion>(client, "content_asset_generate", xhsGenerateArguments);
    const channelsRoot = await call<AssetVersion>(client, "content_asset_generate", channelsGenerateArguments);
    expect(xhsRoot).toMatchObject({ id: xhsRootId, contentId: "content-xhs", version: 1, parentVersionId: null });
    expect(channelsRoot).toMatchObject({ id: channelsRootId, contentId: "content-channels", version: 1, parentVersionId: null });
    expect(xhsRoot.id).not.toBe(channelsRoot.id);
    expect(xhsRoot.contentId).not.toBe(channelsRoot.contentId);
    expect(xhsRoot.artifact.contentHash).not.toBe(channelsRoot.artifact.contentHash);
    expect(xhsRoot.artifact).toMatchObject({ mediaType: "image/png", contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(channelsRoot.artifact).toMatchObject({ mediaType: "video/mp4", contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(xhsRoot.provider as JsonRecord).toMatchObject({ inputHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(channelsRoot.provider as JsonRecord).toMatchObject({ inputHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(xhsRoot.validation).toMatchObject({
      status: "passed",
      profileId: "xhs_png_1080x1440_v1",
      guarantee: "internal_acceptance_only",
      decoder: "playwright_chromium",
      width: 1080,
      height: 1440,
    });
    expect(channelsRoot.validation).toMatchObject({
      status: "passed",
      profileId: "channels_mp4_1080x1920_h264_aac_v1",
      guarantee: "internal_acceptance_only",
      probe: "ffprobe",
      width: 1080,
      height: 1920,
      videoCodec: "h264",
      audioCodec: "aac",
    });
    const xhsRootBytes = await readContentArtifact(client, xhsRoot);
    const channelsRootBytes = await readContentArtifact(client, channelsRoot);
    await decodePng(xhsRootBytes.bytes);
    await probeMp4(channelsRootBytes.bytes, channelsRoot.validation as JsonRecord);

    const deriveArguments = {
      id: xhsDerivedId,
      workspaceId,
      contentId: "content-xhs",
      parentVersionId: xhsRootId,
      expectedParentVersion: 1,
      briefId: xhsBriefId,
      expectedBriefVersion: 1,
      sourceMaterials: [],
      revisionInstructions: "改变原创图片的构图层次，同时保留相同事实引用",
      ...context("derive-xhs-v2"),
    };
    const derived = await call<AssetVersion>(client, "content_asset_derive", deriveArguments);
    expect(derived).toMatchObject({
      id: xhsDerivedId,
      contentId: "content-xhs",
      version: 2,
      parentVersionId: xhsRootId,
      parentVersion: 1,
      modification: {
        revisionInstructions: deriveArguments.revisionInstructions,
        actor: "content-production-stdio-acceptance",
        requestId: "request-derive-xhs-v2",
      },
    });
    expect(Date.parse((derived.modification as JsonRecord).createdAt as string)).not.toBeNaN();
    expect(derived.artifact.contentHash).not.toBe(xhsRoot.artifact.contentHash);
    expect(derived.sourceMaterials).toEqual([expect.objectContaining({
      role: "parent",
      assetVersionId: xhsRootId,
      artifactId: xhsRoot.artifact.id,
      contentHash: xhsRoot.artifact.contentHash,
      byteLength: xhsRoot.artifact.byteLength,
    })]);
    expect(await call(client, "content_asset_get", { id: xhsRootId, workspaceId })).toEqual(xhsRoot);
    const derivedBytes = await readContentArtifact(client, derived);
    await decodePng(derivedBytes.bytes);
    await expectToolError(client, "content_asset_derive", {
      ...deriveArguments,
      id: "asset-xhs-stale-parent",
      ...context("derive-xhs-stale-parent"),
    }, "CONFLICT");
    await expectToolError(client, "content_asset_get", { id: "asset-xhs-stale-parent", workspaceId }, "NOT_FOUND");

    const capturesBeforeReplay = await readFile(mediaCapturePath, "utf8");
    expect(capturesBeforeReplay.trim().split("\n")).toHaveLength(3);
    expect(await call(client, "content_asset_generate", xhsGenerateArguments)).toEqual(xhsRoot);
    expect(await call(client, "content_asset_generate", channelsGenerateArguments)).toEqual(channelsRoot);
    expect(await call(client, "content_asset_derive", deriveArguments)).toEqual(derived);
    expect(await readFile(mediaCapturePath, "utf8")).toBe(capturesBeforeReplay);
    const capturedRequests = capturesBeforeReplay.trim().split("\n").map((line) => JSON.parse(line) as JsonRecord);
    expect(capturedRequests.map((request) => request.operation)).toEqual([
      "render_xhs_png_v1",
      "render_channels_mp4_v1",
      "render_xhs_png_v1",
    ]);
    expect(capturedRequests[2]).toMatchObject({
      parent: { assetVersionId: xhsRootId, contentHash: xhsRoot.artifact.contentHash },
      revisionInstructions: deriveArguments.revisionInstructions,
    });
    const providerPids = (await readFile(mediaPidPath, "utf8")).trim().split("\n").map(Number);
    expect(providerPids).toHaveLength(3);
    for (const pid of providerPids) await expectExited(pid);

    const rootLineage = await call(client, "lineage_get", { entityType: "asset_version", id: xhsRootId, workspaceId });
    const derivedLineage = await call(client, "lineage_get", { entityType: "asset_version", id: xhsDerivedId, workspaceId });
    expect(derivedLineage.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "asset_version", id: xhsRootId, version: 1 }),
      expect.objectContaining({ entityType: "asset_version", id: xhsDerivedId, version: 2 }),
      expect.objectContaining({ entityType: "task", id: "task-content-production", version: 2 }),
      expect.objectContaining({ entityType: "recommendation", id: "recommendation-content-production", version: 1 }),
      expect.objectContaining({ entityType: "finding", id: "finding-owned-fact", version: 1 }),
      expect.objectContaining({ entityType: "evidence", id: "evidence-owned-fact", version: 1 }),
    ]));

    await stopClient(first);
    const restarted = await startClient();
    expect(await call(restarted.client, "benchmark_reverse_get", { id: analysisId, workspaceId })).toEqual(analysis);
    expect(await call(restarted.client, "content_brief_get", { id: xhsBriefId, workspaceId })).toEqual(xhsBrief);
    expect(await call(restarted.client, "content_brief_get", { id: channelsBriefId, workspaceId })).toEqual(channelsBrief);
    for (const asset of [xhsRoot, channelsRoot, derived]) {
      expect(await call(restarted.client, "content_asset_get", { id: asset.id, workspaceId })).toEqual(asset);
      const restored = await readContentArtifact(restarted.client, asset);
      const expected = asset.id === xhsRootId
        ? xhsRootBytes.bytes
        : asset.id === channelsRootId ? channelsRootBytes.bytes : derivedBytes.bytes;
      expect(restored.bytes.equals(expected)).toBe(true);
    }
    expect(await call(restarted.client, "lineage_get", {
      entityType: "asset_version",
      id: xhsRootId,
      workspaceId,
    })).toEqual(rootLineage);
    expect(await call(restarted.client, "lineage_get", {
      entityType: "asset_version",
      id: xhsDerivedId,
      workspaceId,
    })).toEqual(derivedLineage);
    expect(await call(restarted.client, "strategy_task_get", {
      id: "task-content-production",
      workspaceId,
    })).toMatchObject({ id: "task-content-production", state: "ready", version: 2 });
    expect(await batchEvidence(restarted.client, acquired.id as string)).toEqual(publicEvidence);
    await stopClient(restarted);

    const unavailable = await startClient(false);
    const capabilities = await call<JsonRecord[]>(unavailable.client, "marketing_capability_list");
    for (const id of ["content.reverse", "media.professional", "media.video_probe"]) {
      expect(capabilities.find((capability) => capability.id === id)).toMatchObject({
        availability: { state: "unavailable" },
      });
    }
    expect(capabilities.find((capability) => capability.id === "content.reverse")).toMatchObject({
      configuration: ["MARKETING_BENCHMARK_MCP_COMMAND and MARKETING_BENCHMARK_MCP_ARGS in the trusted deployment environment", expect.any(String), expect.any(String)],
    });
    expect(capabilities.find((capability) => capability.id === "media.professional")?.configuration).toContain(
      "MARKETING_MEDIA_MCP_COMMAND and MARKETING_MEDIA_MCP_ARGS in the trusted deployment environment",
    );
    expect(capabilities.find((capability) => capability.id === "media.video_probe")?.configuration).toContain(
      "MARKETING_FFPROBE_COMMAND as an absolute deployment-controlled executable path, independent of professional media MCP",
    );
    const reverseGap = await expectToolError(unavailable.client, "benchmark_reverse_create", {
      ...reverseArguments,
      id: "benchmark-unavailable-no-success",
      ...context("reverse-unavailable-no-success"),
    });
    expect(reverseGap.structuredContent).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "benchmark_reverse",
      reason: "mcp_not_configured",
      configurationAction: "Configure MARKETING_BENCHMARK_MCP_COMMAND and MARKETING_BENCHMARK_MCP_ARGS in the trusted deployment environment",
    });
    await expectToolError(unavailable.client, "benchmark_reverse_get", {
      id: "benchmark-unavailable-no-success",
      workspaceId,
    }, "NOT_FOUND");
    const generateGap = await expectToolError(unavailable.client, "content_asset_generate", {
      ...generateArguments("xhs"),
      id: "asset-unavailable-no-success",
      contentId: "content-unavailable-no-success",
      ...context("generate-unavailable-no-success"),
    });
    expect(generateGap.structuredContent).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "professional_media",
      reason: "mcp_not_configured",
      configurationAction: "Configure MARKETING_MEDIA_MCP_COMMAND and MARKETING_MEDIA_MCP_ARGS in the trusted deployment environment",
    });
    await expectToolError(unavailable.client, "content_asset_get", {
      id: "asset-unavailable-no-success",
      workspaceId,
    }, "NOT_FOUND");
    expect(await readFile(mediaCapturePath, "utf8")).toBe(capturesBeforeReplay);
    await stopClient(unavailable);
  }, 180_000);
});

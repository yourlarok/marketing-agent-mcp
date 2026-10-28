import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DomainError } from "../../src/domain/errors.js";
import {
  BENCHMARK_REVERSE_LIMITS,
  McpBenchmarkReverseProvider,
  type BenchmarkObservation,
  type BenchmarkObservationAsset,
} from "../../src/infrastructure/benchmark-reverse-provider.js";
import { canonicalJson } from "../../src/infrastructure/sqlite.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const fixture = fileURLToPath(new URL("../fixtures/benchmark-reverse-mcp.mjs", import.meta.url));
const rawFixture = fileURLToPath(new URL("../fixtures/raw-benchmark-reverse-mcp.mjs", import.meta.url));
const observedAt = "2026-10-28T08:00:00.000Z";
const pageText = "Persisted page text with a distinct information sequence and call to action.";
const screenshot = Buffer.from([0, 1, 2, 3, 4, 5, 250, 251, 252, 253, 254, 255]);

function asset(
  kind: "page_text" | "asr_transcript" | "screenshot" | "video_frames",
  content: Buffer,
  id = `asset-${kind}`,
): BenchmarkObservationAsset {
  const base = {
    sourceId: "source-1",
    evidenceId: "evidence-1",
    assetId: id,
    kind,
    observedAt,
    contentHash: createHash("sha256").update(content).digest("hex"),
    byteLength: content.length,
  };
  return kind === "page_text" || kind === "asr_transcript"
    ? { ...base, text: content.toString("utf8") }
    : { ...base, base64: content.toString("base64") };
}

function observation(assets: BenchmarkObservationAsset[]): BenchmarkObservation {
  return { sourceId: "source-1", evidenceId: "evidence-1", observedAt, assets };
}

function request(assets = [asset("page_text", Buffer.from(pageText)), asset("screenshot", screenshot)]) {
  const modality = assets.some((candidate) => candidate.kind === "video_frames") ? "video" as const : "image" as const;
  const observations = [observation(assets)];
  return {
    modality,
    observations,
    inputHash: createHash("sha256").update(canonicalJson({ modality, observations })).digest("hex"),
  };
}

function provider(
  mode?: string,
  patch: { timeoutMs?: number; maxResponseBytes?: number; pidFile?: string; fixturePath?: string; capture?: string } = {},
) {
  const { pidFile, fixturePath, capture, ...options } = patch;
  return new McpBenchmarkReverseProvider({
    command: process.execPath,
    args: [fixturePath ?? fixture],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MARKETING_TEST_BUSINESS_SECRET: "must-not-reach-child",
      ...(mode === undefined ? {} : { BENCHMARK_FIXTURE_MODE: mode }),
      ...(pidFile === undefined ? {} : { BENCHMARK_FIXTURE_PID_FILE: pidFile }),
      ...(capture === undefined ? {} : { BENCHMARK_FIXTURE_CAPTURE: capture }),
    },
    envAllowlist: ["BENCHMARK_FIXTURE_MODE", "BENCHMARK_FIXTURE_PID_FILE", "BENCHMARK_FIXTURE_CAPTURE"],
    ...options,
  });
}

async function expectGap(promise: Promise<unknown>, reason: string): Promise<void> {
  await expect(promise).rejects.toMatchObject<DomainError>({
    code: "CAPABILITY_UNAVAILABLE",
    details: {
      capability: "benchmark_reverse",
      reason,
      configurationAction: "Configure MARKETING_BENCHMARK_MCP_COMMAND and MARKETING_BENCHMARK_MCP_ARGS in the trusted deployment environment",
    },
  });
}

async function latestPid(pidFile: string): Promise<number> {
  const pids = (await readFile(pidFile, "utf8")).trim().split("\n");
  return Number(pids.at(-1));
}

function expectProcessExited(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
}

function runningFixturePids(fixturePath: string): number[] {
  const processes = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  return processes.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match?.[2]?.includes(fixturePath) ? [Number(match[1])] : [];
  });
}

describe("real evidence-bound benchmark reverse stdio MCP provider", () => {
  it("sends exact persisted bytes, verifies canonical input hash, and preserves structural output and fixture identity", async () => {
    const tempDir = await createTempDir();
    const capture = join(tempDir, "request.jsonl");
    try {
      const input = request();
      const response = await provider(undefined, { capture }).reverse(input);
      expect(response.inputHash).toBe(input.inputHash);
      expect(response.analysisMethod).toBe("independent-test-fixture-structural-v1");
      expect(response.toolVersion).toBe("fixture-2026.10.28");
      expect(response.gaps).toEqual([]);
      expect(response.methods).toEqual([{
        id: "method-layout",
        dimension: "layout",
        pattern: "Structural layout pattern from the independent test fixture",
        transferableRule: "Transfer only the layout structure, not source wording or media",
        basis: "image",
        confidence: "medium",
        evidenceAssetRefs: [{
          sourceId: "source-1",
          evidenceId: "evidence-1",
          assetId: "asset-screenshot",
          kind: "screenshot",
          observedAt,
          contentHash: input.observations[0]!.assets[1]!.contentHash,
          byteLength: screenshot.length,
        }],
      }]);
      expect(JSON.stringify(response)).not.toContain(pageText);
      expect(JSON.stringify(response)).not.toContain(screenshot.toString("base64"));
      const captured = JSON.parse((await readFile(capture, "utf8")).trim());
      expect(captured.observations[0].assets[0].text).toBe(pageText);
      expect(Buffer.from(captured.observations[0].assets[1].base64, "base64")).toEqual(screenshot);
      expect(response).not.toHaveProperty("humanReview");
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("does not forward the default business-secret environment", async () => {
    const response = await provider().reverse(request());
    expect(response.methods).toHaveLength(1);
  });

  it("copies snapshot descriptors rather than trusting forged response hash, length, or observation time", async () => {
    const input = request();
    const response = await provider("forged-descriptor").reverse(input);
    expect(response.methods[0]!.evidenceAssetRefs[0]).toMatchObject({
      observedAt,
      contentHash: input.observations[0]!.assets[1]!.contentHash,
      byteLength: screenshot.length,
    });
  });

  it("returns text-only methods and partial visual gaps without inventing layout evidence", async () => {
    const response = await provider().reverse(request([asset("page_text", Buffer.from(pageText))]));
    expect(response.methods.map((method) => [method.dimension, method.basis, method.confidence])).toEqual([
      ["hook", "text", "high"],
      ["information_order", "text", "unknown"],
      ["cta", "text", "low"],
    ]);
    expect(response.gaps).toEqual([{ code: "screenshot_missing", message: "Layout cannot be assessed without a screenshot" }]);
  });

  it("requires and returns declared video frame and ASR observations", async () => {
    const frames = asset("video_frames", Buffer.from("real-frame-bytes"));
    const asr = asset("asr_transcript", Buffer.from("real persisted speech transcript"));
    const response = await provider().reverse(request([frames, asr]));
    expect(response.methods[0]).toMatchObject({ basis: "video_frames_and_asr", dimension: "shot_rhythm" });
    expect(response.methods[0]!.evidenceAssetRefs.map((ref) => ref.kind)).toEqual(["video_frames", "asr_transcript"]);
    await expectGap(provider("video-no-declaration").reverse(request([
      asset("page_text", Buffer.from(pageText)), frames, asr,
    ])), "video_understanding_missing");
  });

  it("returns structured gaps when unconfigured or unable to start", async () => {
    await expectGap(new McpBenchmarkReverseProvider({}).reverse(request()), "mcp_not_configured");
    await expectGap(new McpBenchmarkReverseProvider({ command: "/definitely/missing/benchmark-provider" }).reverse(request()), "mcp_unavailable");
    expect(() => new McpBenchmarkReverseProvider({ command: "  " })).toThrowError(/must not be empty/);
  });

  it.each([
    ["malformed", "mcp_invalid_response"],
    ["unknown-field", "mcp_invalid_response"],
    ["wrong-hash", "mcp_input_hash_mismatch"],
    ["invented-ref", "mcp_invalid_response"],
  ])("rejects fixture mode %s with stable reason %s", async (mode, reason) => {
    await expectGap(provider(mode).reverse(request()), reason);
  });

  it("rejects excessive methods, media, text, and evidence before provider output or process spawn", async () => {
    const tiny = asset("screenshot", screenshot);
    const oversized = { ...tiny, byteLength: BENCHMARK_REVERSE_LIMITS.maxSingleAssetBytes + 1 };
    const unavailable = new McpBenchmarkReverseProvider({ command: "/definitely/missing/benchmark-provider" });
    await expect(unavailable.reverse(request([oversized]))).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    const tooMuchText = { ...asset("page_text", Buffer.from("tiny")), byteLength: BENCHMARK_REVERSE_LIMITS.maxTextBytes + 1 };
    await expect(unavailable.reverse(request([tooMuchText]))).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
    const observations = Array.from({ length: 11 }, (_, index) => ({
      ...observation([asset("page_text", Buffer.from(pageText), `asset-${index}`)]),
      evidenceId: `evidence-${index}`,
    }));
    const input = { modality: "image" as const, observations };
    await expect(unavailable.reverse({
      ...input,
      inputHash: createHash("sha256").update(canonicalJson(input)).digest("hex"),
    })).rejects.toMatchObject<DomainError>({ code: "INVALID_INPUT" });
  });

  it("bounds the raw JSON-RPC envelope before stdio parsing", async () => {
    const raw = new McpBenchmarkReverseProvider({
      command: process.execPath,
      args: [rawFixture],
      maxResponseBytes: 4_096,
      timeoutMs: 2_000,
    });
    await expectGap(raw.reverse(request([asset("page_text", Buffer.from(pageText))])), "mcp_response_too_large");
  });

  it("enforces response bytes before accepting an oversized structured payload", async () => {
    await expectGap(provider(undefined, { maxResponseBytes: 128 }).reverse(request()), "mcp_response_too_large");
  });

  it("confirms process exit after timeout and SIGTERM-ignore escalation", async () => {
    const fixtureDir = await mkdtemp(join(dirname(fixture), "benchmark-timeout-"));
    const fixturePath = join(fixtureDir, "timeout-fixture.mjs");
    await copyFile(fixture, fixturePath);
    try {
      for (const mode of ["timeout", "timeout-ignore-sigterm"]) {
        await expectGap(provider(mode, { timeoutMs: 100, fixturePath }).reverse(request()), "mcp_timeout");
        expect(runningFixturePids(fixturePath)).toEqual([]);
      }
    } finally {
      await removeTempDir(fixtureDir);
    }
  }, 10_000);

  it("bounds cleanup and confirms process exit after a successful hanging fixture", async () => {
    const tempDir = await createTempDir();
    const pidFile = join(tempDir, "provider-pid");
    const started = Date.now();
    try {
      const response = await provider("success-hang", { pidFile }).reverse(request());
      expect(response.analysisMethod).toBe("independent-test-fixture-structural-v1");
      expect(Date.now() - started).toBeLessThan(2_000);
      expectProcessExited(await latestPid(pidFile));
    } finally {
      await removeTempDir(tempDir);
    }
  }, 10_000);
});

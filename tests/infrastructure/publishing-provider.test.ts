import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DomainError } from "../../src/domain/errors.js";
import {
  computePublishingSubmitInputHash,
  McpPublishingProvider,
  PUBLISHING_PROVIDER_LIMITS,
  type PublishingSubmitRequest,
} from "../../src/infrastructure/publishing-provider.js";
import { canonicalJson } from "../../src/infrastructure/sqlite.js";
import { toCapabilityGapResult } from "../../src/mcp/error-mapper.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const fixture = fileURLToPath(new URL("../fixtures/trusted-publishing-mcp.mjs", import.meta.url));
const artifact = Buffer.from("exact locked artifact bytes");

function request(overrides: Partial<PublishingSubmitRequest> = {}): PublishingSubmitRequest {
  return {
    operationKey: `publish:v1:${"a".repeat(64)}`,
    publicationId: "publication-1",
    workspaceId: "workspace-1",
    scheduleId: "schedule-1",
    assetVersionId: "asset-1",
    assetVersion: 1,
    artifactHash: createHash("sha256").update(artifact).digest("hex"),
    artifactByteLength: artifact.length,
    artifactBase64: artifact.toString("base64"),
    channel: "xhs",
    accountId: "account-1",
    ...overrides,
  };
}

async function expectGap(promise: Promise<unknown>, reason: string): Promise<void> {
  await expect(promise).rejects.toMatchObject<DomainError>({
    code: "CAPABILITY_UNAVAILABLE",
    details: { capability: "trusted_publishing", reason },
  });
}

describe("trusted publishing stdio MCP provider", () => {
  let tempDir: string;
  let state: string;
  let capture: string;
  let mode: string | undefined;
  let currentProvider: McpPublishingProvider;

  beforeEach(async () => {
    tempDir = await createTempDir();
    state = join(tempDir, "fixture-state.json");
    capture = join(tempDir, "requests.jsonl");
    mode = undefined;
    currentProvider = provider();
  });

  afterEach(async () => {
    await removeTempDir(tempDir);
  });

  function provider(patch: { timeoutMs?: number; maxResponseBytes?: number; fixturePath?: string; pidFile?: string } = {}): McpPublishingProvider {
    const { fixturePath, pidFile, ...limits } = patch;
    return new McpPublishingProvider({
      command: process.execPath,
      args: [fixturePath ?? fixture],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MARKETING_TEST_BUSINESS_SECRET: "must-not-reach-child",
        PUBLISHING_FIXTURE_STATE: state,
        PUBLISHING_FIXTURE_CAPTURE: capture,
        ...(mode === undefined ? {} : { PUBLISHING_FIXTURE_MODE: mode }),
        ...(pidFile === undefined ? {} : { PUBLISHING_FIXTURE_PID_FILE: pidFile }),
      },
      envAllowlist: [
        "PUBLISHING_FIXTURE_STATE",
        "PUBLISHING_FIXTURE_CAPTURE",
        "PUBLISHING_FIXTURE_MODE",
        "PUBLISHING_FIXTURE_PID_FILE",
      ],
      ...limits,
    });
  }

  it("submits and verifies over real stdio with canonical hashes and bounded receipt bytes", async () => {
    const input = request();
    const expectedHash = createHash("sha256").update(canonicalJson(input)).digest("hex");
    expect(computePublishingSubmitInputHash(input)).toBe(expectedHash);
    const accepted = await currentProvider.submit(input);
    expect(accepted).toMatchObject({
      status: "accepted",
      inputHash: expectedHash,
      operationKey: input.operationKey,
      channel: input.channel,
      accountId: input.accountId,
      toolVersion: "fixture-publishing-2026.10.29",
      externalPublicationId: expect.stringMatching(/^fixture-/),
    });
    expect(accepted.receipt?.content).toBeInstanceOf(Uint8Array);
    expect(accepted.receipt?.content.length).toBeLessThanOrEqual(PUBLISHING_PROVIDER_LIMITS.maxReceiptBytes);
    expect(accepted.receipt?.contentHash).toBe(createHash("sha256").update(accepted.receipt!.content).digest("hex"));

    const verified = await currentProvider.verify({
      operationKey: input.operationKey,
      inputHash: expectedHash,
      channel: input.channel,
      accountId: input.accountId,
    });
    expect(verified).toMatchObject({
      status: "verified",
      operationKey: input.operationKey,
      publishedAt: "2026-10-29T12:00:00.000Z",
    });
    const calls = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.map((call) => call.tool)).toEqual(["submit", "verify"]);
    expect(calls[0].input).toEqual(input);
    expect(calls[0].input).not.toHaveProperty("command");
    expect(calls[0].input).not.toHaveProperty("env");
  });

  it("deduplicates an exact retry and rejects the same operation key with a different input hash", async () => {
    const input = request();
    const first = await currentProvider.submit(input);
    const replay = await currentProvider.submit(input);
    expect(replay.externalPublicationId).toBe(first.externalPublicationId);
    const changed = await currentProvider.submit(request({ assetVersionId: "asset-other" }));
    expect(changed).toMatchObject({ status: "failed", failure: { code: "operation_conflict", retryable: false } });
    const calls = (await readFile(capture, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(3);
  });

  it("does not forward business secrets by default", async () => {
    expect((await currentProvider.submit(request())).status).toBe("accepted");
  });

  it("returns explicit not_found, pending, and definite failure outcomes", async () => {
    const input = request();
    const missing = await currentProvider.verify({
      operationKey: input.operationKey,
      inputHash: computePublishingSubmitInputHash(input),
      channel: input.channel,
      accountId: input.accountId,
    });
    expect(missing.status).toBe("not_found");

    mode = "submit-failed";
    const failed = await provider().submit(input);
    expect(failed).toMatchObject({ status: "failed", failure: { code: "fixture_rejected", retryable: true } });

    mode = undefined;
    const accepted = await provider().submit(request({ operationKey: `publish:v1:${"b".repeat(64)}` }));
    mode = "verify-pending";
    const pending = await provider().verify({
      operationKey: accepted.operationKey,
      inputHash: accepted.inputHash,
      channel: accepted.channel,
      accountId: accepted.accountId,
    });
    expect(pending.status).toBe("pending");
  });

  it.each([
    ["malformed", "mcp_invalid_response"],
    ["unknown-field", "mcp_invalid_response"],
    ["wrong-input-hash", "mcp_input_hash_mismatch"],
    ["wrong-operation-key", "mcp_result_mismatch"],
    ["wrong-account", "mcp_result_mismatch"],
    ["wrong-channel", "mcp_result_mismatch"],
    ["bad-base64", "mcp_invalid_response"],
  ])("rejects %s with %s", async (fixtureMode, reason) => {
    mode = fixtureMode;
    await expectGap(provider().submit(request()), reason);
  }, 10_000);

  it("bounds decoded receipt bytes and raw response envelopes", async () => {
    mode = "oversized-receipt";
    await expectGap(provider().submit(request()), "mcp_response_too_large");
    await expectGap(provider({ maxResponseBytes: 4_096 }).submit(request({ operationKey: `publish:v1:${"b".repeat(64)}` })), "mcp_response_too_large");
  }, 10_000);

  it("reports configuration, process loss, and timeout gaps without leaking child processes", async () => {
    await expectGap(new McpPublishingProvider({}).submit(request()), "mcp_not_configured");
    await expectGap(new McpPublishingProvider({ command: "/definitely/missing/publisher" }).submit(request()), "mcp_unavailable");
    mode = "accepted-process-loss";
    await expectGap(provider().submit(request()), "mcp_unavailable");
    mode = "accepted-timeout";
    await expectGap(provider({ timeoutMs: 100 }).submit(request({ operationKey: `publish:v1:${"b".repeat(64)}` })), "mcp_timeout");
  }, 10_000);

  it("escalates cleanup and leaves no successful hanging child", async () => {
    const fixtureDir = await mkdtemp(join(dirname(fixture), "publishing-timeout-"));
    const fixturePath = join(fixtureDir, "timeout-fixture.mjs");
    await copyFile(fixture, fixturePath);
    const pidFile = join(tempDir, "provider-pid");
    try {
      mode = "accepted-timeout-ignore-sigterm";
      await expectGap(provider({ timeoutMs: 100, fixturePath }).submit(request()), "mcp_timeout");
      const running = execFileSync("ps", ["-eo", "args="], { encoding: "utf8" });
      expect(running.includes(fixturePath)).toBe(false);

      mode = "success-hang";
      const accepted = await provider({ pidFile }).submit(request());
      expect(accepted.status).toBe("accepted");
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      await removeTempDir(fixtureDir);
    }
  }, 10_000);

  it("maps only fixed safe publishing capability details", async () => {
    try {
      await new McpPublishingProvider({}).submit(request());
      throw new Error("Expected submit to fail");
    } catch (error) {
      expect(toCapabilityGapResult(error)?.structuredContent).toEqual({
        code: "CAPABILITY_UNAVAILABLE",
        message: "Capability unavailable",
        retryable: false,
        capability: "trusted_publishing",
        configurationAction: "Configure MARKETING_PUBLISHING_MCP_COMMAND and MARKETING_PUBLISHING_MCP_ARGS in the trusted deployment environment",
        reason: "mcp_not_configured",
      });
    }
  });
});

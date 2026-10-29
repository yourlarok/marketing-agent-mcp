import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.env.PUBLISHING_FIXTURE_PID_FILE) {
  await appendFile(process.env.PUBLISHING_FIXTURE_PID_FILE, `${process.pid}\n`, "utf8");
}
if (process.env.MARKETING_TEST_BUSINESS_SECRET) {
  throw new Error("Business environment leaked into trusted publishing fixture");
}

const memoryState = { submissions: {} };
const mode = process.env.PUBLISHING_FIXTURE_MODE ?? "success";
const identitySchema = {
  operationKey: z.string(),
  channel: z.string(),
  accountId: z.string(),
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function inputHash(input) {
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

async function loadState() {
  if (!process.env.PUBLISHING_FIXTURE_STATE) return memoryState;
  try {
    return JSON.parse(await readFile(process.env.PUBLISHING_FIXTURE_STATE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { submissions: {} };
    throw error;
  }
}

async function saveState(state) {
  if (process.env.PUBLISHING_FIXTURE_STATE) {
    await writeFile(process.env.PUBLISHING_FIXTURE_STATE, JSON.stringify(canonical(state)), "utf8");
  }
}

async function capture(tool, input) {
  if (process.env.PUBLISHING_FIXTURE_CAPTURE) {
    await appendFile(
      process.env.PUBLISHING_FIXTURE_CAPTURE,
      `${JSON.stringify({ tool, input: canonical(input) })}\n`,
      "utf8",
    );
  }
}

function receiptFor(operationKey, status) {
  const receiptId = `receipt-${createHash("sha256").update(operationKey).digest("hex").slice(0, 16)}`;
  return {
    receiptId,
    contentBase64: Buffer.from(JSON.stringify(canonical({ operationKey, receiptId, status }))).toString("base64"),
  };
}

function baseResult(input, hash, status) {
  return {
    inputHash: hash,
    operationKey: input.operationKey,
    channel: input.channel,
    accountId: input.accountId,
    status,
    receipt: null,
    externalPublicationId: null,
    publishedAt: null,
    failure: null,
  };
}

const server = new McpServer({ name: "trusted-publishing-fixture", version: "fixture-publishing-2026.10.29" });
server.registerTool("submit", {
  description: "Independent persistent test protocol; not Xiaohongshu, Channels, or a commercial publishing integration",
  inputSchema: {
    ...identitySchema,
    publicationId: z.string(),
    workspaceId: z.string(),
    scheduleId: z.string(),
    assetVersionId: z.string(),
    assetVersion: z.number(),
    artifactHash: z.string(),
    artifactByteLength: z.number(),
    artifactBase64: z.string(),
  },
}, async (input) => {
  await capture("submit", input);
  const hash = inputHash(input);
  const state = await loadState();
  const existing = state.submissions[input.operationKey];
  if (existing) {
    if (existing.inputHash !== hash) {
      return { structuredContent: {
        ...baseResult(input, hash, "failed"),
        failure: { code: "operation_conflict", message: "Operation key already has a different input hash", retryable: false },
      } };
    }
    return { structuredContent: {
      ...baseResult(input, hash, "accepted"),
      receipt: receiptFor(input.operationKey, "accepted"),
      externalPublicationId: existing.externalPublicationId,
    } };
  }
  if (mode === "submit-failed") {
    return { structuredContent: {
      ...baseResult(input, hash, "failed"),
      receipt: receiptFor(input.operationKey, "failed"),
      failure: { code: "fixture_rejected", message: "Independent fixture rejected the submission", retryable: true },
    } };
  }
  const bytes = Buffer.from(input.artifactBase64, "base64");
  if (bytes.length !== input.artifactByteLength ||
      createHash("sha256").update(bytes).digest("hex") !== input.artifactHash) {
    throw new Error("Fixture artifact descriptor mismatch");
  }
  const externalPublicationId = `fixture-${createHash("sha256").update(input.operationKey).digest("hex").slice(0, 16)}`;
  state.submissions[input.operationKey] = {
    inputHash: hash,
    channel: input.channel,
    accountId: input.accountId,
    externalPublicationId,
    status: "accepted",
  };
  await saveState(state);
  if (mode === "accepted-timeout" || mode === "accepted-timeout-ignore-sigterm") {
    if (mode === "accepted-timeout-ignore-sigterm") process.on("SIGTERM", () => undefined);
    await delay(5_000);
  }
  if (mode === "accepted-process-loss") process.exit(17);
  if (mode === "success-hang") setInterval(() => undefined, 1_000);
  let result = {
    ...baseResult(input, hash, "accepted"),
    receipt: receiptFor(input.operationKey, "accepted"),
    externalPublicationId,
  };
  if (mode === "malformed") result = { inputHash: hash };
  if (mode === "unknown-field") result = { ...result, unexpected: true };
  if (mode === "wrong-input-hash") result = { ...result, inputHash: "0".repeat(64) };
  if (mode === "wrong-operation-key") result = { ...result, operationKey: `wrong-${input.operationKey}` };
  if (mode === "wrong-account") result = { ...result, accountId: "wrong-account" };
  if (mode === "wrong-channel") result = { ...result, channel: "channels" };
  if (mode === "bad-base64") result = { ...result, receipt: { ...result.receipt, contentBase64: "not***base64" } };
  if (mode === "oversized-receipt") {
    result = { ...result, receipt: { ...result.receipt, contentBase64: Buffer.alloc(16 * 1024, 7).toString("base64") } };
  }
  return {
    content: [{ type: "text", text: "trusted publishing independent fixture" }],
    structuredContent: result,
  };
});

server.registerTool("verify", {
  description: "Verify the independent fixture's persisted operation without submitting it",
  inputSchema: {
    ...identitySchema,
    inputHash: z.string(),
  },
}, async (input) => {
  await capture("verify", input);
  const state = await loadState();
  const existing = state.submissions[input.operationKey];
  if (!existing || mode === "verify-not-found") {
    return { structuredContent: baseResult(input, input.inputHash, "not_found") };
  }
  if (existing.inputHash !== input.inputHash || existing.channel !== input.channel || existing.accountId !== input.accountId) {
    return { structuredContent: {
      ...baseResult(input, input.inputHash, "failed"),
      failure: { code: "operation_conflict", message: "Verification identity does not match the submission", retryable: false },
    } };
  }
  if (mode === "verify-pending") {
    return { structuredContent: {
      ...baseResult(input, input.inputHash, "pending"),
      receipt: receiptFor(input.operationKey, "pending"),
    } };
  }
  if (mode === "verify-failed") {
    return { structuredContent: {
      ...baseResult(input, input.inputHash, "failed"),
      receipt: receiptFor(input.operationKey, "failed"),
      failure: { code: "fixture_delivery_failed", message: "Independent fixture delivery failed", retryable: false },
    } };
  }
  existing.status = "verified";
  await saveState(state);
  return { structuredContent: {
    ...baseResult(input, input.inputHash, "verified"),
    receipt: receiptFor(input.operationKey, "verified"),
    externalPublicationId: existing.externalPublicationId,
    publishedAt: "2026-10-29T12:00:00.000Z",
  } };
});

await server.connect(new StdioServerTransport());

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

const STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_TIMEOUT_MS = 10_000;

async function acquireStateLock(statePath) {
  const lockPath = `${statePath}.lock`;
  const ownerPath = `${lockPath}/owner`;
  const token = randomUUID();
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(ownerPath, token, { flag: "wx" });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        try {
          if (await readFile(ownerPath, "utf8") !== token) return;
          const releasePath = `${lockPath}.release.${process.pid}.${token}`;
          await rename(lockPath, releasePath);
          await rm(releasePath, { recursive: true, force: true });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (Date.now() - startedAt > STATE_LOCK_TIMEOUT_MS) {
      throw new Error("Timed out waiting for publishing fixture state lock");
    }
    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs > STATE_LOCK_STALE_MS) {
        const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
        try {
          await rename(lockPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(5);
  }
}

async function saveState(state) {
  const statePath = process.env.PUBLISHING_FIXTURE_STATE;
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(canonical(state)), { flag: "wx" });
    await rename(temporaryPath, statePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function withState(mutator) {
  const statePath = process.env.PUBLISHING_FIXTURE_STATE;
  if (!statePath) return (await mutator(memoryState)).value;
  const release = await acquireStateLock(statePath);
  try {
    const state = await loadState();
    const outcome = await mutator(state);
    if (outcome.changed) await saveState(state);
    return outcome.value;
  } finally {
    await release();
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
  const outcome = await withState((state) => {
    const existing = state.submissions[input.operationKey];
    if (existing) {
      return {
        changed: false,
        value: existing.inputHash === hash
          ? { kind: "existing", externalPublicationId: existing.externalPublicationId }
          : { kind: "conflict" },
      };
    }
    if (mode === "submit-failed") return { changed: false, value: { kind: "failed" } };
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
    return { changed: true, value: { kind: "accepted", externalPublicationId } };
  });
  if (outcome.kind === "conflict") {
    return { structuredContent: {
      ...baseResult(input, hash, "failed"),
      failure: { code: "operation_conflict", message: "Operation key already has a different input hash", retryable: false },
    } };
  }
  if (outcome.kind === "existing") {
    return { structuredContent: {
      ...baseResult(input, hash, "accepted"),
      receipt: receiptFor(input.operationKey, "accepted"),
      externalPublicationId: outcome.externalPublicationId,
    } };
  }
  if (outcome.kind === "failed") {
    return { structuredContent: {
      ...baseResult(input, hash, "failed"),
      receipt: receiptFor(input.operationKey, "failed"),
      failure: { code: "fixture_rejected", message: "Independent fixture rejected the submission", retryable: true },
    } };
  }
  const externalPublicationId = outcome.externalPublicationId;
  if (mode === "accepted-timeout" || mode === "accepted-timeout-ignore-sigterm") {
    if (mode === "accepted-timeout-ignore-sigterm") process.on("SIGTERM", () => undefined);
    await delay(5_000);
  }
  if (mode === "accepted-built-timeout") await delay(20_000);
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
  return withState((state) => {
    const existing = state.submissions[input.operationKey];
    if (!existing || mode === "verify-not-found") {
      return { changed: false, value: { structuredContent: baseResult(input, input.inputHash, "not_found") } };
    }
    if (existing.inputHash !== input.inputHash || existing.channel !== input.channel || existing.accountId !== input.accountId) {
      return { changed: false, value: { structuredContent: {
        ...baseResult(input, input.inputHash, "failed"),
        failure: { code: "operation_conflict", message: "Verification identity does not match the submission", retryable: false },
      } } };
    }
    if (mode === "verify-pending") {
      return { changed: false, value: { structuredContent: {
        ...baseResult(input, input.inputHash, "pending"),
        receipt: receiptFor(input.operationKey, "pending"),
      } } };
    }
    if (mode === "verify-failed") {
      return { changed: false, value: { structuredContent: {
        ...baseResult(input, input.inputHash, "failed"),
        receipt: receiptFor(input.operationKey, "failed"),
        failure: { code: "fixture_delivery_failed", message: "Independent fixture delivery failed", retryable: false },
      } } };
    }
    const changed = existing.status !== "verified";
    existing.status = "verified";
    return { changed, value: { structuredContent: {
      ...baseResult(input, input.inputHash, "verified"),
      receipt: receiptFor(input.operationKey, "verified"),
      externalPublicationId: mode === "verify-invalid-external-id" ? ` ${existing.externalPublicationId}` : existing.externalPublicationId,
      publishedAt: mode === "verify-invalid-published-at" ? "2026-02-30T12:00:00.000Z" : "2026-10-29T12:00:00.000Z",
    } } };
  });
});

await server.connect(new StdioServerTransport());

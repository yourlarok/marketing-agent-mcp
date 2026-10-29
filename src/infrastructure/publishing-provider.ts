import { createHash } from "node:crypto";
import { z } from "zod";
import type { ContentChannel } from "../domain/content-production-model.js";
import { assertEntityReferenceId, assertUtcInstant } from "../domain/contract-validation.js";
import { DomainError } from "../domain/errors.js";
import { ControlledMcpClient } from "./controlled-mcp-client.js";
import { canonicalJson } from "./sqlite.js";

export const PUBLISHING_PROVIDER_LIMITS = {
  maxArtifactBytes: 16 * 1024 * 1024,
  maxReceiptBytes: 8 * 1024,
  maxResponseBytes: 64 * 1024,
  timeoutMs: 15_000,
} as const;

const CONFIGURATION_ACTION =
  "Configure MARKETING_PUBLISHING_MCP_COMMAND and MARKETING_PUBLISHING_MCP_ARGS in the trusted deployment environment";
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const idSchema = z.string().min(1).max(256).refine((value) => {
  try {
    assertEntityReferenceId(value, "Trusted publishing identifier");
    return true;
  } catch {
    return false;
  }
});
const utcInstantSchema = z.string().refine((value) => {
  try {
    assertUtcInstant(value, "Trusted publishing publishedAt");
    return true;
  } catch {
    return false;
  }
});
const operationKeySchema = z.string().regex(/^publish:v1:[0-9a-f]{64}$/);
const channelSchema = z.enum(["xhs", "channels"]);

export interface PublishingSubmitRequest {
  operationKey: string;
  publicationId: string;
  workspaceId: string;
  scheduleId: string;
  assetVersionId: string;
  assetVersion: number;
  artifactHash: string;
  artifactByteLength: number;
  artifactBase64: string;
  channel: ContentChannel;
  accountId: string;
}

export interface PublishingVerifyRequest {
  operationKey: string;
  inputHash: string;
  channel: ContentChannel;
  accountId: string;
}

export interface PublishingProviderReceipt {
  receiptId: string;
  content: Uint8Array;
  contentHash: string;
}

export interface PublishingProviderFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export type PublishingProviderStatus = "accepted" | "pending" | "verified" | "failed" | "not_found";

export interface PublishingProviderResult {
  status: PublishingProviderStatus;
  inputHash: string;
  operationKey: string;
  channel: ContentChannel;
  accountId: string;
  receipt: PublishingProviderReceipt | null;
  externalPublicationId: string | null;
  publishedAt: string | null;
  failure: PublishingProviderFailure | null;
  toolVersion: string;
}

export interface PublishingProvider {
  isConfigured(channel: ContentChannel, accountId: string): boolean;
  submit(request: PublishingSubmitRequest): Promise<PublishingProviderResult>;
  verify(request: PublishingVerifyRequest): Promise<PublishingProviderResult>;
}

export interface McpPublishingProviderOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  envAllowlist?: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const submitRequestSchema = z.strictObject({
  operationKey: operationKeySchema,
  publicationId: idSchema,
  workspaceId: idSchema,
  scheduleId: idSchema,
  assetVersionId: idSchema,
  assetVersion: z.number().int().positive(),
  artifactHash: hashSchema,
  artifactByteLength: z.number().int().positive().max(PUBLISHING_PROVIDER_LIMITS.maxArtifactBytes),
  artifactBase64: z.string().min(4),
  channel: channelSchema,
  accountId: idSchema,
});

const verifyRequestSchema = z.strictObject({
  operationKey: operationKeySchema,
  inputHash: hashSchema,
  channel: channelSchema,
  accountId: idSchema,
});

const responseSchema = z.strictObject({
  inputHash: hashSchema,
  operationKey: idSchema,
  channel: channelSchema,
  accountId: idSchema,
  status: z.enum(["accepted", "pending", "verified", "failed", "not_found"]),
  receipt: z.strictObject({
    receiptId: idSchema,
    contentBase64: z.string().min(4),
  }).nullable(),
  externalPublicationId: idSchema.nullable(),
  publishedAt: utcInstantSchema.nullable(),
  failure: z.strictObject({
    code: idSchema,
    message: z.string().trim().min(1).max(4096),
    retryable: z.boolean(),
  }).nullable(),
});

type ProviderResponse = z.infer<typeof responseSchema>;

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

export function publishingProviderCapabilityGap(reason: string, message: string, retryable = false): DomainError {
  return new DomainError("CAPABILITY_UNAVAILABLE", message, retryable, {
    capability: "trusted_publishing",
    reason,
    configurationAction: CONFIGURATION_ACTION,
  });
}

function invalidResponse(message = "Trusted publishing MCP returned an invalid response schema"): never {
  throw publishingProviderCapabilityGap("mcp_invalid_response", message);
}

function resultMismatch(message: string): never {
  throw publishingProviderCapabilityGap("mcp_result_mismatch", message);
}

function decodeBase64(value: string, maximum: number): Buffer {
  if (value.length > Math.ceil(maximum / 3) * 4) {
    throw publishingProviderCapabilityGap("mcp_response_too_large", "Trusted publishing receipt exceeds the byte limit");
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) invalidResponse("Trusted publishing receipt must use canonical base64");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if ((value.length / 4) * 3 - padding > maximum) {
    throw publishingProviderCapabilityGap("mcp_response_too_large", "Trusted publishing receipt exceeds the byte limit");
  }
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) invalidResponse("Trusted publishing receipt must use canonical base64");
  return content;
}

function decodeArtifact(value: string, expectedLength: number, expectedHash: string): void {
  if (value.length > Math.ceil(PUBLISHING_PROVIDER_LIMITS.maxArtifactBytes / 3) * 4 ||
      value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    invalid("Publishing artifact must use bounded canonical base64");
  }
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) invalid("Publishing artifact must use canonical base64");
  if (content.length !== expectedLength || createHash("sha256").update(content).digest("hex") !== expectedHash) {
    invalid("Publishing artifact bytes do not match their locked descriptor");
  }
}

export function computePublishingSubmitInputHash(request: PublishingSubmitRequest): string {
  const parsed = submitRequestSchema.safeParse(request);
  if (!parsed.success) invalid("Publishing submit request contains unsupported or invalid fields");
  decodeArtifact(request.artifactBase64, request.artifactByteLength, request.artifactHash);
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function parseResponse(
  structuredContent: unknown,
  expected: { operationKey: string; inputHash: string; channel: ContentChannel; accountId: string },
  operation: "submit" | "verify",
): Omit<PublishingProviderResult, "toolVersion"> {
  const parsed = responseSchema.safeParse(structuredContent);
  if (!parsed.success) invalidResponse();
  const response: ProviderResponse = parsed.data;
  if (response.inputHash !== expected.inputHash) {
    throw publishingProviderCapabilityGap("mcp_input_hash_mismatch", "Trusted publishing MCP response input hash does not match");
  }
  if (response.operationKey !== expected.operationKey || response.channel !== expected.channel || response.accountId !== expected.accountId) {
    resultMismatch("Trusted publishing MCP response identity does not match the request");
  }
  if (operation === "submit" ? !["accepted", "failed"].includes(response.status) : response.status === "accepted") {
    invalidResponse("Trusted publishing MCP returned a status invalid for the operation");
  }
  if ((response.status === "accepted" || response.status === "verified") && !response.receipt) {
    invalidResponse("Accepted and verified publishing outcomes require a receipt");
  }
  if (response.status === "verified" && (!response.externalPublicationId || !response.publishedAt)) {
    invalidResponse("Verified publishing outcomes require an external ID and publication time");
  }
  if (response.status === "failed" && !response.failure) {
    invalidResponse("Failed publishing outcomes require a failure descriptor");
  }
  if (response.status === "not_found" && (response.receipt || response.externalPublicationId || response.publishedAt || response.failure)) {
    invalidResponse("Not-found publishing outcomes cannot contain delivery data");
  }
  const receipt = response.receipt ? (() => {
    const content = decodeBase64(response.receipt!.contentBase64, PUBLISHING_PROVIDER_LIMITS.maxReceiptBytes);
    return {
      receiptId: response.receipt!.receiptId,
      content: new Uint8Array(content),
      contentHash: createHash("sha256").update(content).digest("hex"),
    };
  })() : null;
  return {
    status: response.status,
    inputHash: response.inputHash,
    operationKey: response.operationKey,
    channel: response.channel,
    accountId: response.accountId,
    receipt,
    externalPublicationId: response.externalPublicationId,
    publishedAt: response.publishedAt,
    failure: response.failure,
  };
}

export class McpPublishingProvider implements PublishingProvider {
  constructor(private readonly options: McpPublishingProviderOptions = {}) {
    if (options.command !== undefined && options.command.trim().length === 0) {
      throw new DomainError("INVALID_INPUT", "Trusted publishing MCP command must not be empty");
    }
  }

  isConfigured(_channel: ContentChannel, _accountId: string): boolean {
    return this.options.command !== undefined;
  }

  async submit(request: PublishingSubmitRequest): Promise<PublishingProviderResult> {
    const inputHash = computePublishingSubmitInputHash(request);
    const response = await this.client().call<Omit<PublishingProviderResult, "toolVersion">>(
      "submit",
      { ...request },
      (structuredContent) => parseResponse(structuredContent, { ...request, inputHash }, "submit"),
    );
    return this.withToolVersion(response.result, response.toolVersion);
  }

  async verify(request: PublishingVerifyRequest): Promise<PublishingProviderResult> {
    const parsed = verifyRequestSchema.safeParse(request);
    if (!parsed.success) invalid("Publishing verify request contains unsupported or invalid fields");
    const response = await this.client().call<Omit<PublishingProviderResult, "toolVersion">>(
      "verify",
      { ...request },
      (structuredContent) => parseResponse(structuredContent, request, "verify"),
    );
    return this.withToolVersion(response.result, response.toolVersion);
  }

  private client(): ControlledMcpClient {
    return new ControlledMcpClient({
      clientName: "marketing-trusted-publishing",
      capability: "trusted_publishing",
      configurationAction: CONFIGURATION_ACTION,
      command: this.options.command,
      args: this.options.args,
      env: this.options.env,
      envAllowlist: this.options.envAllowlist,
      timeoutMs: this.options.timeoutMs ?? PUBLISHING_PROVIDER_LIMITS.timeoutMs,
      maxResponseBytes: this.options.maxResponseBytes ?? PUBLISHING_PROVIDER_LIMITS.maxResponseBytes,
    });
  }

  private withToolVersion(
    result: Omit<PublishingProviderResult, "toolVersion">,
    toolVersion: string,
  ): PublishingProviderResult {
    if (toolVersion.trim().length === 0 || toolVersion.length > 256) {
      invalidResponse("Trusted publishing MCP tool version is missing or unbounded");
    }
    return { ...result, toolVersion };
  }
}

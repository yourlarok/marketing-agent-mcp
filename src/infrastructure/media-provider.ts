import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CHANNEL_PROFILES,
  validateBenchmarkAnalysis,
  validateContentBrief,
  type BenchmarkAnalysis,
  type ContentBrief,
  type EvidenceAssetRef,
} from "../domain/content-production-model.js";
import { assertEntityReferenceId } from "../domain/contract-validation.js";
import { DomainError } from "../domain/errors.js";
import { ControlledMcpClient } from "./controlled-mcp-client.js";
import { canonicalJson } from "./sqlite.js";

export const MEDIA_PROVIDER_LIMITS = {
  maxResponseBytes: 24 * 1024 * 1024,
  maxSourceAssets: 8,
  maxTotalSourceBytes: 16 * 1024 * 1024,
  timeoutMs: 120_000,
} as const;

const CONFIGURATION_ACTION =
  "Configure MARKETING_MEDIA_MCP_COMMAND and MARKETING_MEDIA_MCP_ARGS in the trusted deployment environment";
const OPERATIONS = ["render_xhs_png_v1", "render_channels_mp4_v1"] as const;
const REQUEST_KEYS = [
  "operation",
  "brief",
  "benchmarkAnalysis",
  "sourceAssets",
  "parent",
  "revisionInstructions",
  "profile",
] as const;
const SOURCE_KEYS = ["role", "source", "ownership", "contentBase64"] as const;
const REFERENCE_KEYS = [
  "sourceId",
  "evidenceId",
  "assetId",
  "kind",
  "observedAt",
  "contentHash",
  "byteLength",
] as const;
const PARENT_KEYS = [
  "role",
  "assetVersionId",
  "artifactId",
  "mediaType",
  "contentHash",
  "byteLength",
  "contentBase64",
] as const;

export type MediaRenderOperation = (typeof OPERATIONS)[number];
export type MediaChannelProfile = (typeof CHANNEL_PROFILES)[keyof typeof CHANNEL_PROFILES];

export interface MediaSourceAsset {
  role: "source";
  source: EvidenceAssetRef;
  ownership: "owned" | "authorized";
  contentBase64: string;
}

export interface MediaParentAsset {
  role: "parent";
  assetVersionId: string;
  artifactId: string;
  mediaType: "image/png" | "video/mp4";
  contentHash: string;
  byteLength: number;
  contentBase64: string;
}

export interface MediaRenderRequest {
  operation: MediaRenderOperation;
  brief: ContentBrief;
  benchmarkAnalysis: BenchmarkAnalysis;
  sourceAssets?: MediaSourceAsset[];
  parent?: MediaParentAsset;
  revisionInstructions: string;
  profile: MediaChannelProfile;
}

export interface VerifiedMediaArtifact {
  mediaType: "image/png" | "video/mp4";
  contentHash: string;
  byteLength: number;
}

export interface MediaRenderResponse {
  content: Uint8Array;
  artifact: VerifiedMediaArtifact;
  inputHash: string;
  toolVersion: string;
}

export interface MediaProvider {
  render(request: MediaRenderRequest): Promise<MediaRenderResponse>;
}

export interface McpMediaProviderOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  envAllowlist?: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const responseSchema = z.strictObject({
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  artifact: z.strictObject({
    mediaType: z.enum(["image/png", "video/mp4"]),
    contentBase64: z.string(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().positive(),
  }),
});

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

export function mediaProviderCapabilityGap(reason: string, message: string, retryable = false): DomainError {
  return new DomainError("CAPABILITY_UNAVAILABLE", message, retryable, {
    capability: "professional_media",
    reason,
    configurationAction: CONFIGURATION_ACTION,
  });
}

function invalidResponse(message = "Professional media MCP returned an invalid response schema"): never {
  throw mediaProviderCapabilityGap("mcp_invalid_response", message);
}

function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.some((key) => !expected.includes(key)) || expected.some((key) =>
    !actual.includes(key) && !(key === "sourceAssets" || key === "parent")
  )) {
    invalid(`${label} contains unsupported or missing fields`);
  }
}

function decodeBase64(
  value: unknown,
  response: boolean,
  maxBytes: number,
  tooLarge: () => never,
): Buffer {
  const malformed = (): never => {
    if (response) invalidResponse("Professional media must use canonical base64");
    invalid("Production source media must use canonical base64");
  };
  if (typeof value !== "string") return malformed();
  if (value.length === 0) return malformed();
  if (value.length > Math.ceil(maxBytes / 3) * 4) tooLarge();
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) malformed();
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if ((value.length / 4) * 3 - padding > maxBytes) tooLarge();
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) malformed();
  return content;
}

function validateReference(reference: EvidenceAssetRef): void {
  exactKeys(reference, REFERENCE_KEYS, "Production source Evidence ref");
  for (const value of [reference.sourceId, reference.evidenceId, reference.assetId, reference.kind, reference.observedAt]) {
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
      invalid("Production source Evidence ref contains an invalid string");
    }
  }
  if (!/^[a-f0-9]{64}$/.test(reference.contentHash) || !Number.isSafeInteger(reference.byteLength) ||
      reference.byteLength < 1 || reference.byteLength > MEDIA_PROVIDER_LIMITS.maxTotalSourceBytes) {
    invalid("Production source Evidence ref contains an invalid descriptor");
  }
}

function validateRequest(request: MediaRenderRequest): number {
  exactKeys(request, REQUEST_KEYS, "Media render request");
  if (!OPERATIONS.includes(request.operation)) invalid("Media render operation is not supported");
  if (typeof request.revisionInstructions !== "string" || request.revisionInstructions.length > 32 * 1024) {
    invalid("Media revision instructions must be a bounded string");
  }
  validateContentBrief(request.brief);
  validateBenchmarkAnalysis(request.benchmarkAnalysis);
  if (request.brief.benchmarkAnalysisId !== request.benchmarkAnalysis.id) {
    invalid("Media brief and BenchmarkAnalysis do not match");
  }
  const expectedProfile = request.operation === "render_xhs_png_v1" ? CHANNEL_PROFILES.xhs : CHANNEL_PROFILES.channels;
  if (canonicalJson(request.profile) !== canonicalJson(expectedProfile) || request.brief.channel !== expectedProfile.channel) {
    invalid("Media render request must contain the exact internal channel profile");
  }
  const sources = request.sourceAssets ?? [];
  if (!Array.isArray(sources) || sources.length > MEDIA_PROVIDER_LIMITS.maxSourceAssets) {
    invalid(`Media source assets must contain at most ${MEDIA_PROVIDER_LIMITS.maxSourceAssets} entries`);
  }
  const selectedRefs = request.benchmarkAnalysis.methods.flatMap((method) => method.evidenceAssetRefs);
  const selectedHashes = new Set(selectedRefs.map((reference) => reference.contentHash));
  const hasSelectedIdentity = (reference: EvidenceAssetRef): boolean =>
    request.benchmarkAnalysis.evidenceIds.includes(reference.evidenceId) || selectedRefs.some((selected) =>
      selected.evidenceId === reference.evidenceId ||
      (selected.sourceId === reference.sourceId && selected.assetId === reference.assetId)
    );
  let totalBytes = 0;
  for (const asset of sources) {
    exactKeys(asset, SOURCE_KEYS, "Production source asset");
    if (asset.role !== "source" || (asset.ownership !== "owned" && asset.ownership !== "authorized")) {
      invalid("Production source bytes must be independently owned or authorized");
    }
    validateReference(asset.source);
    if (hasSelectedIdentity(asset.source)) {
      invalid("BenchmarkAnalysis Evidence identities cannot be reused as production source media");
    }
    const content = decodeBase64(
      asset.contentBase64,
      false,
      MEDIA_PROVIDER_LIMITS.maxTotalSourceBytes - totalBytes,
      () => invalid("Production source and parent bytes exceed the total byte limit"),
    );
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (selectedHashes.has(actualHash)) {
      invalid("BenchmarkAnalysis Evidence bytes cannot be reused as production source media");
    }
    if (content.length !== asset.source.byteLength || actualHash !== asset.source.contentHash) {
      invalid("Production source bytes do not match their descriptor");
    }
    totalBytes += content.length;
  }
  if (request.parent !== undefined) {
    const parent = request.parent;
    exactKeys(parent, PARENT_KEYS, "Parent production asset");
    if (parent.role !== "parent" || parent.mediaType !== expectedProfile.mediaType ||
        !/^[a-f0-9]{64}$/.test(parent.contentHash) || !Number.isSafeInteger(parent.byteLength) ||
        parent.byteLength < 1 || parent.byteLength > MEDIA_PROVIDER_LIMITS.maxTotalSourceBytes) {
      invalid("Parent production asset descriptor is invalid");
    }
    assertEntityReferenceId(parent.assetVersionId, "Parent source assetVersionId");
    assertEntityReferenceId(parent.artifactId, "Parent source artifactId");
    const content = decodeBase64(
      parent.contentBase64,
      false,
      MEDIA_PROVIDER_LIMITS.maxTotalSourceBytes - totalBytes,
      () => invalid("Production source and parent bytes exceed the total byte limit"),
    );
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (selectedHashes.has(actualHash)) {
      invalid("BenchmarkAnalysis Evidence bytes cannot be reused as parent production media");
    }
    if (content.length !== parent.byteLength || actualHash !== parent.contentHash) {
      invalid("Parent production bytes do not match their descriptor");
    }
    totalBytes += content.length;
  }
  if (totalBytes > MEDIA_PROVIDER_LIMITS.maxTotalSourceBytes) {
    invalid("Production source and parent bytes exceed the total byte limit");
  }
  return totalBytes;
}

function providerInput(request: MediaRenderRequest): Record<string, unknown> {
  return {
    operation: request.operation,
    brief: request.brief,
    benchmarkAnalysis: request.benchmarkAnalysis,
    sourceAssets: request.sourceAssets ?? [],
    ...(request.parent === undefined ? {} : { parent: request.parent }),
    revisionInstructions: request.revisionInstructions,
    profile: request.profile,
  };
}

export function computeMediaRenderInputHash(request: MediaRenderRequest): string {
  return createHash("sha256").update(canonicalJson(providerInput(request))).digest("hex");
}

export class McpMediaProvider implements MediaProvider {
  constructor(private readonly options: McpMediaProviderOptions = {}) {
    if (options.command !== undefined && options.command.trim().length === 0) {
      throw new DomainError("INVALID_INPUT", "Professional media MCP command must not be empty");
    }
  }

  isConfigured(): boolean {
    return this.options.command !== undefined;
  }

  async render(request: MediaRenderRequest): Promise<MediaRenderResponse> {
    if (!this.options.command) {
      throw mediaProviderCapabilityGap("mcp_not_configured", "Professional media MCP is not configured");
    }
    validateRequest(request);
    const input = providerInput(request);
    const computedHash = computeMediaRenderInputHash(request);
    const client = new ControlledMcpClient({
      clientName: "marketing-professional-media",
      capability: "professional_media",
      configurationAction: CONFIGURATION_ACTION,
      command: this.options.command,
      args: this.options.args,
      env: this.options.env,
      envAllowlist: this.options.envAllowlist,
      timeoutMs: this.options.timeoutMs ?? MEDIA_PROVIDER_LIMITS.timeoutMs,
      maxResponseBytes: this.options.maxResponseBytes ?? MEDIA_PROVIDER_LIMITS.maxResponseBytes,
    });
    const response = await client.call("render", input, (structuredContent) => {
      const parsed = responseSchema.safeParse(structuredContent);
      if (!parsed.success) invalidResponse();
      if (parsed.data.inputHash !== computedHash) {
        throw mediaProviderCapabilityGap(
          "mcp_input_hash_mismatch",
          "Professional media MCP response input hash does not match",
        );
      }
      const expectedMediaType: VerifiedMediaArtifact["mediaType"] =
        request.operation === "render_xhs_png_v1" ? "image/png" : "video/mp4";
      if (parsed.data.artifact.mediaType !== expectedMediaType) {
        throw mediaProviderCapabilityGap("mcp_result_mismatch", "Professional media MCP returned the wrong media type");
      }
      const maxOutputBytes = request.operation === "render_xhs_png_v1" ? 4 * 1024 * 1024 : 16 * 1024 * 1024;
      const content = decodeBase64(
        parsed.data.artifact.contentBase64,
        true,
        maxOutputBytes,
        () => {
          throw mediaProviderCapabilityGap("mcp_response_too_large", "Professional media output exceeds the operation byte limit");
        },
      );
      const contentHash = createHash("sha256").update(content).digest("hex");
      if (content.length !== parsed.data.artifact.byteLength || contentHash !== parsed.data.artifact.contentHash) {
        throw mediaProviderCapabilityGap("mcp_result_mismatch", "Professional media bytes do not match their declared descriptor");
      }
      return {
        content: new Uint8Array(content),
        artifact: { mediaType: expectedMediaType, contentHash, byteLength: content.length },
        inputHash: computedHash,
      };
    });
    if (typeof response.toolVersion !== "string" || response.toolVersion.trim().length === 0 ||
        response.toolVersion.length > 256) {
      invalidResponse("Professional media MCP tool version is missing or unbounded");
    }
    return { ...response.result, toolVersion: response.toolVersion };
  }
}

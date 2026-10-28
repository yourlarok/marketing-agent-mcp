import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BENCHMARK_METHOD_DIMENSIONS,
  METHOD_CONFIDENCES,
  OBSERVATION_BASES,
  type BenchmarkGap,
  type BenchmarkMethod,
  type EvidenceAssetRef,
} from "../domain/content-production-model.js";
import { DomainError } from "../domain/errors.js";
import { canonicalJson } from "./sqlite.js";
import { ControlledMcpClient } from "./controlled-mcp-client.js";

export const BENCHMARK_REVERSE_LIMITS = {
  maxEvidence: 10,
  maxSingleAssetBytes: 16 * 1024 * 1024,
  maxTotalAssetBytes: 24 * 1024 * 1024,
  maxTextBytes: 1024 * 1024,
  maxResponseBytes: 1024 * 1024,
  timeoutMs: 60_000,
  maxMethods: 20,
} as const;

const CONFIGURATION_ACTION =
  "Configure MARKETING_BENCHMARK_MCP_COMMAND and MARKETING_BENCHMARK_MCP_ARGS in the trusted deployment environment";

const textKinds = ["page_text", "asr_transcript"] as const;
const mediaKinds = ["screenshot", "video_frames"] as const;
const observationKinds = [...textKinds, ...mediaKinds] as const;

export interface BenchmarkObservationAsset extends EvidenceAssetRef {
  kind: (typeof observationKinds)[number];
  text?: string;
  base64?: string;
}

export interface BenchmarkObservation {
  sourceId: string;
  evidenceId: string;
  observedAt: string;
  assets: BenchmarkObservationAsset[];
}

export interface BenchmarkReverseProviderRequest {
  modality: "image" | "video";
  observations: BenchmarkObservation[];
  inputHash: string;
}

export interface BenchmarkReverseProviderResponse {
  inputHash: string;
  analysisMethod: string;
  toolVersion: string;
  methods: BenchmarkMethod[];
  gaps: BenchmarkGap[];
}

export interface BenchmarkReverseProvider {
  reverse(request: BenchmarkReverseProviderRequest): Promise<BenchmarkReverseProviderResponse>;
}

export interface McpBenchmarkReverseProviderOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  envAllowlist?: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const assetRefSchema = z.strictObject({
  sourceId: z.string().min(1).max(256),
  evidenceId: z.string().min(1).max(256),
  assetId: z.string().min(1).max(256),
  kind: z.enum(observationKinds),
  observedAt: z.string().min(1).max(100),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative().max(BENCHMARK_REVERSE_LIMITS.maxSingleAssetBytes),
});

const methodSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/),
  dimension: z.enum(BENCHMARK_METHOD_DIMENSIONS),
  pattern: z.string().min(1).max(8_192),
  transferableRule: z.string().min(1).max(8_192),
  basis: z.enum(OBSERVATION_BASES),
  confidence: z.enum(METHOD_CONFIDENCES),
  evidenceAssetRefs: z.array(assetRefSchema).min(1).max(100),
});

const responseSchema = z.strictObject({
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  analysisMethod: z.string().min(1).max(256),
  methods: z.array(methodSchema).max(BENCHMARK_REVERSE_LIMITS.maxMethods),
  gaps: z.array(z.strictObject({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(1_024),
  })).max(20),
});

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

export function benchmarkReverseCapabilityGap(reason: string, message: string, retryable = false): DomainError {
  return new DomainError("CAPABILITY_UNAVAILABLE", message, retryable, {
    capability: "benchmark_reverse",
    reason,
    configurationAction: CONFIGURATION_ACTION,
  });
}

function invalidResponse(message = "Benchmark reverse MCP returned an invalid response schema"): never {
  throw benchmarkReverseCapabilityGap("mcp_invalid_response", message);
}

function decodeBase64(value: string): Buffer {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    invalid("Benchmark media must use canonical base64");
  }
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) invalid("Benchmark media must use canonical base64");
  return content;
}

function validateInput(request: BenchmarkReverseProviderRequest): void {
  if (request.modality !== "image" && request.modality !== "video") invalid("modality must be image or video");
  if (!/^[a-f0-9]{64}$/.test(request.inputHash)) invalid("inputHash must be a lowercase SHA-256 hash");
  if (!Array.isArray(request.observations) || request.observations.length < 1 ||
      request.observations.length > BENCHMARK_REVERSE_LIMITS.maxEvidence) {
    invalid(`Benchmark observations must contain 1-${BENCHMARK_REVERSE_LIMITS.maxEvidence} Evidence entries`);
  }
  if (new Set(request.observations.map((observation) => observation.evidenceId)).size !== request.observations.length) {
    invalid("Benchmark observations must not contain duplicate Evidence");
  }
  let totalBytes = 0;
  let totalTextBytes = 0;
  const refs = new Set<string>();
  for (const observation of request.observations) {
    if (!observation || typeof observation.sourceId !== "string" || observation.sourceId.length === 0 ||
        typeof observation.evidenceId !== "string" || observation.evidenceId.length === 0 ||
        typeof observation.observedAt !== "string" || observation.observedAt.length === 0 ||
        !Array.isArray(observation.assets)) {
      invalid("Benchmark observations must contain persisted Source/Evidence descriptors");
    }
    for (const asset of observation.assets) {
      if (!observationKinds.includes(asset.kind) || asset.sourceId !== observation.sourceId ||
          asset.evidenceId !== observation.evidenceId || asset.observedAt !== observation.observedAt ||
          !/^[a-f0-9]{64}$/.test(asset.contentHash) || !Number.isSafeInteger(asset.byteLength) ||
          asset.byteLength < 1 || asset.byteLength > BENCHMARK_REVERSE_LIMITS.maxSingleAssetBytes) {
        invalid("Benchmark observation asset descriptor is invalid or exceeds the single-asset limit");
      }
      const key = canonicalJson([asset.sourceId, asset.evidenceId, asset.assetId, asset.kind]);
      if (refs.has(key)) invalid("Benchmark observation assets must not contain duplicate refs");
      refs.add(key);
      let content: Buffer;
      if ((textKinds as readonly string[]).includes(asset.kind)) {
        if (typeof asset.text !== "string" || asset.base64 !== undefined) {
          invalid("Benchmark text observations must contain only actual text");
        }
        content = Buffer.from(asset.text, "utf8");
        totalTextBytes += content.length;
        if (totalTextBytes > BENCHMARK_REVERSE_LIMITS.maxTextBytes) {
          invalid("Benchmark observation text exceeds the total text limit");
        }
      } else {
        if (typeof asset.base64 !== "string" || asset.text !== undefined) {
          invalid("Benchmark media observations must contain only actual base64 media");
        }
        content = decodeBase64(asset.base64);
      }
      if (content.length !== asset.byteLength ||
          createHash("sha256").update(content).digest("hex") !== asset.contentHash) {
        invalid("Benchmark observation bytes do not match their persisted descriptor");
      }
      totalBytes += content.length;
      if (totalBytes > BENCHMARK_REVERSE_LIMITS.maxTotalAssetBytes) {
        invalid("Benchmark observation assets exceed the total byte limit");
      }
    }
  }
  if (request.modality === "image" && !request.observations.some((observation) =>
    observation.assets.some((asset) => asset.kind === "page_text" || asset.kind === "screenshot")
  )) {
    throw benchmarkReverseCapabilityGap("image_observation_missing", "Image analysis requires page text or a screenshot");
  }
  if (request.modality === "video") {
    for (const observation of request.observations) {
      if (!observation.assets.some((asset) => asset.kind === "video_frames")) {
        throw benchmarkReverseCapabilityGap("video_frames_missing", "Every video Evidence requires persisted video frames");
      }
      if (!observation.assets.some((asset) => asset.kind === "asr_transcript")) {
        throw benchmarkReverseCapabilityGap("asr_transcript_missing", "Every video Evidence requires a persisted ASR transcript");
      }
    }
  }
}

function canonicalRef(responseRef: EvidenceAssetRef, supplied: Map<string, BenchmarkObservationAsset>): EvidenceAssetRef {
  const key = canonicalJson([responseRef.sourceId, responseRef.evidenceId, responseRef.assetId, responseRef.kind]);
  const asset = supplied.get(key);
  if (!asset) invalidResponse("Benchmark reverse MCP returned an invented Evidence asset ref");
  return {
    sourceId: asset.sourceId,
    evidenceId: asset.evidenceId,
    assetId: asset.assetId,
    kind: asset.kind,
    observedAt: asset.observedAt,
    contentHash: asset.contentHash,
    byteLength: asset.byteLength,
  };
}

function validateBasis(method: BenchmarkMethod, modality: "image" | "video"): void {
  const kinds = new Set(method.evidenceAssetRefs.map((ref) => ref.kind));
  const only = (...allowed: string[]) => [...kinds].every((kind) => allowed.includes(kind));
  const valid = method.basis === "text"
    ? only(...textKinds)
    : method.basis === "image"
      ? modality === "image" && only("screenshot")
      : method.basis === "video_frames"
        ? modality === "video" && only("video_frames")
        : method.basis === "asr"
          ? modality === "video" && only("asr_transcript")
          : modality === "video" && kinds.has("video_frames") && kinds.has("asr_transcript") &&
            only("video_frames", "asr_transcript");
  if (!valid || (method.dimension === "layout" && method.basis !== "image")) {
    invalidResponse("Benchmark reverse MCP method basis does not match its Evidence refs");
  }
}

export function computeBenchmarkReverseInputHash(
  modality: "image" | "video",
  observations: BenchmarkObservation[],
): string {
  return createHash("sha256").update(canonicalJson({ modality, observations })).digest("hex");
}

export class McpBenchmarkReverseProvider implements BenchmarkReverseProvider {
  constructor(private readonly options: McpBenchmarkReverseProviderOptions = {}) {
    if (options.command !== undefined && options.command.trim().length === 0) {
      throw new DomainError("INVALID_INPUT", "Benchmark reverse MCP command must not be empty");
    }
  }

  async reverse(request: BenchmarkReverseProviderRequest): Promise<BenchmarkReverseProviderResponse> {
    if (!this.options.command) {
      throw benchmarkReverseCapabilityGap("mcp_not_configured", "Benchmark reverse MCP is not configured");
    }
    validateInput(request);
    const input = { modality: request.modality, observations: request.observations };
    const computedHash = computeBenchmarkReverseInputHash(request.modality, request.observations);
    if (computedHash !== request.inputHash) {
      throw benchmarkReverseCapabilityGap("mcp_input_hash_mismatch", "Benchmark reverse request input hash does not match");
    }
    const supplied = new Map(request.observations.flatMap((observation) => observation.assets.map((asset) => [
      canonicalJson([asset.sourceId, asset.evidenceId, asset.assetId, asset.kind]), asset,
    ] as const)));
    const client = new ControlledMcpClient({
      clientName: "marketing-benchmark-reverse",
      capability: "benchmark_reverse",
      configurationAction: CONFIGURATION_ACTION,
      command: this.options.command,
      args: this.options.args,
      env: this.options.env,
      envAllowlist: this.options.envAllowlist,
      timeoutMs: this.options.timeoutMs ?? BENCHMARK_REVERSE_LIMITS.timeoutMs,
      maxResponseBytes: this.options.maxResponseBytes ?? BENCHMARK_REVERSE_LIMITS.maxResponseBytes,
    });
    const response = await client.call("reverse_engineer", input, (structuredContent) => {
      const parsed = responseSchema.safeParse(structuredContent);
      if (!parsed.success) invalidResponse();
      if (parsed.data.inputHash !== computedHash) {
        throw benchmarkReverseCapabilityGap(
          "mcp_input_hash_mismatch",
          "Benchmark reverse MCP response input hash does not match",
        );
      }
      const methodIds = new Set<string>();
      const methods = parsed.data.methods.map((method): BenchmarkMethod => {
        if (methodIds.has(method.id)) invalidResponse("Benchmark reverse MCP returned duplicate method IDs");
        methodIds.add(method.id);
        const canonical = {
          ...method,
          evidenceAssetRefs: method.evidenceAssetRefs.map((ref) => canonicalRef(ref, supplied)),
        };
        const refIds = new Set<string>();
        for (const ref of canonical.evidenceAssetRefs) {
          const key = canonicalJson([ref.evidenceId, ref.assetId]);
          if (refIds.has(key)) invalidResponse("Benchmark reverse MCP returned duplicate method refs");
          refIds.add(key);
        }
        validateBasis(canonical, request.modality);
        return canonical;
      });
      if (request.modality === "video" && !methods.some((method) =>
        method.basis === "video_frames_and_asr" &&
        method.evidenceAssetRefs.some((ref) => ref.kind === "video_frames") &&
        method.evidenceAssetRefs.some((ref) => ref.kind === "asr_transcript")
      )) {
        throw benchmarkReverseCapabilityGap(
          "video_understanding_missing",
          "Benchmark reverse MCP did not declare video frame and ASR understanding",
        );
      }
      return {
        inputHash: computedHash,
        analysisMethod: parsed.data.analysisMethod,
        methods,
        gaps: parsed.data.gaps,
      };
    });
    if (typeof response.toolVersion !== "string" || response.toolVersion.trim().length === 0 ||
        response.toolVersion.length > 256) {
      invalidResponse("Benchmark reverse MCP tool version is missing or unbounded");
    }
    return { ...response.result, toolVersion: response.toolVersion };
  }
}

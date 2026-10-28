import type { EntityRecord } from "../application/ports.js";
import {
  assertEntityReferenceId,
  assertJsonValue,
  assertRecord,
  assertStableId,
  assertUtcInstant,
  invalid,
} from "./contract-validation.js";
import { ARTIFACT_KINDS, type ArtifactKind } from "./model.js";

export const ASSET_ARTIFACT_CHUNK_MAX_BYTES = 32 * 1024;
export const MAX_ASSET_RESPONSE_BYTES = 64 * 1024;

export const CONTENT_CHANNELS = ["xhs", "channels"] as const;
export type ContentChannel = (typeof CONTENT_CHANNELS)[number];

export const CHANNEL_PROFILES = {
  xhs: {
    profileId: "xhs_png_1080x1440_v1",
    channel: "xhs",
    mediaType: "image/png",
    width: 1080,
    height: 1440,
    maxBytes: 4 * 1024 * 1024,
    maxDurationMs: null,
    videoCodec: null,
    audioCodec: null,
    decoder: "playwright_chromium",
    guarantee: "internal_acceptance_only",
  },
  channels: {
    profileId: "channels_mp4_1080x1920_h264_aac_v1",
    channel: "channels",
    mediaType: "video/mp4",
    width: 1080,
    height: 1920,
    maxBytes: 16 * 1024 * 1024,
    maxDurationMs: 60_000,
    videoCodec: "h264",
    audioCodec: "aac",
    probe: "ffprobe",
    guarantee: "internal_acceptance_only",
  },
} as const;

export interface EvidenceAssetRef {
  sourceId: string;
  evidenceId: string;
  assetId: string;
  kind: ArtifactKind;
  observedAt: string;
  contentHash: string;
  byteLength: number;
}

export const BENCHMARK_METHOD_DIMENSIONS = [
  "hook",
  "information_order",
  "layout",
  "shot_rhythm",
  "cta",
  "other",
] as const;
export type BenchmarkMethodDimension = (typeof BENCHMARK_METHOD_DIMENSIONS)[number];

export const OBSERVATION_BASES = [
  "text",
  "image",
  "video_frames",
  "asr",
  "video_frames_and_asr",
] as const;
export type ObservationBasis = (typeof OBSERVATION_BASES)[number];

export const METHOD_CONFIDENCES = ["high", "medium", "low", "unknown"] as const;
export type MethodConfidence = (typeof METHOD_CONFIDENCES)[number];

export interface BenchmarkMethod {
  id: string;
  dimension: BenchmarkMethodDimension;
  pattern: string;
  transferableRule: string;
  basis: ObservationBasis;
  confidence: MethodConfidence;
  evidenceAssetRefs: EvidenceAssetRef[];
}

export interface BenchmarkGap {
  code: string;
  message: string;
}

export interface ContentEntityVersionRef {
  entityType:
    | "source"
    | "evidence"
    | "finding"
    | "competitor_diff"
    | "task"
    | "recommendation"
    | "benchmark_analysis"
    | "content_brief"
    | "asset_version";
  id: string;
  version: number;
}

export interface BenchmarkAnalysis extends EntityRecord {
  modality: "image" | "video";
  status: "completed" | "partial";
  methods: BenchmarkMethod[];
  gaps: BenchmarkGap[];
  evidenceIds: string[];
  competitorDiffId: string | null;
  sourceVersions: ContentEntityVersionRef[];
  provider: {
    type: "mcp";
    tool: "reverse_engineer";
    toolVersion: string;
    inputHash: string;
    analysisMethod: string;
    humanReview: "not_performed";
  };
}

export type ContentSegment =
  | { id: string; kind: "creative"; text: string }
  | { id: string; kind: "fact"; text: string; findingId: string };

export interface ContentCopy {
  hook: ContentSegment;
  body: ContentSegment[];
  cta: ContentSegment;
}

export interface ContentFrame {
  id: string;
  order: number;
  purpose: string;
  visualDirection: string;
  onScreenText: ContentSegment[];
  narration: ContentSegment[];
  durationMs: number | null;
}

export interface ContentBrief extends EntityRecord {
  channel: ContentChannel;
  taskId: string;
  recommendationId: string;
  benchmarkAnalysisId: string;
  methodIds: string[];
  objective: string;
  audience: string;
  copy: ContentCopy;
  frames: ContentFrame[];
  assetRequirements: string[];
  findingIds: string[];
  evidenceIds: string[];
  sourceVersions: ContentEntityVersionRef[];
}

export interface AssetArtifact {
  id: string;
  kind: "primary";
  mediaType: "image/png" | "video/mp4";
  contentHash: string;
  byteLength: number;
}

interface AssetValidationBase {
  status: "passed";
  profileId: string;
  guarantee: "internal_acceptance_only";
  width: number;
  height: number;
  durationMs: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

export interface PngAssetValidation extends AssetValidationBase {
  decoder: "playwright_chromium";
  width: 1080;
  height: 1440;
  durationMs: null;
  videoCodec: null;
  audioCodec: null;
}

export interface Mp4AssetValidation extends AssetValidationBase {
  probe: "ffprobe";
  probeVersion: string;
  width: 1080;
  height: 1920;
  durationMs: number;
  videoCodec: "h264";
  audioCodec: "aac";
}

export type AssetValidation = PngAssetValidation | Mp4AssetValidation;

export type SourceMaterialDescriptor =
  | {
      role: "source";
      source: EvidenceAssetRef;
      ownership: "owned" | "authorized";
    }
  | {
      role: "parent";
      assetVersionId: string;
      artifactId: string;
      mediaType: "image/png" | "video/mp4";
      contentHash: string;
      byteLength: number;
    };

export interface AssetModification {
  summary: string;
  revisionInstructions: string;
  actor: string;
  requestId: string;
  createdAt: string;
}

export interface AssetVersion extends EntityRecord {
  contentId: string;
  channel: ContentChannel;
  briefId: string;
  briefVersion: number;
  taskId: string;
  recommendationId: string;
  parentVersionId: string | null;
  parentVersion: number | null;
  artifact: AssetArtifact;
  sourceMaterials: SourceMaterialDescriptor[];
  modification: AssetModification;
  provider: {
    type: "mcp";
    tool: "render";
    toolVersion: string;
    inputHash: string;
  };
  validation: AssetValidation;
  evidenceIds: string[];
  sourceVersions: ContentEntityVersionRef[];
}

export type CreateBenchmarkAnalysisInput = Omit<BenchmarkAnalysis, "version" | "updatedAt">;
export type CreateContentBriefInput = Omit<ContentBrief, "version" | "updatedAt">;
export type CreateAssetVersionInput = Omit<AssetVersion, "version" | "updatedAt"> & {
  version?: number;
};

const ENTITY_KEYS = ["id", "workspaceId", "version", "createdAt", "updatedAt"] as const;
const BENCHMARK_KEYS = [
  ...ENTITY_KEYS,
  "modality",
  "status",
  "methods",
  "gaps",
  "evidenceIds",
  "competitorDiffId",
  "sourceVersions",
  "provider",
] as const;
const BRIEF_KEYS = [
  ...ENTITY_KEYS,
  "channel",
  "taskId",
  "recommendationId",
  "benchmarkAnalysisId",
  "methodIds",
  "objective",
  "audience",
  "copy",
  "frames",
  "assetRequirements",
  "findingIds",
  "evidenceIds",
  "sourceVersions",
] as const;
const ASSET_KEYS = [
  ...ENTITY_KEYS,
  "contentId",
  "channel",
  "briefId",
  "briefVersion",
  "taskId",
  "recommendationId",
  "parentVersionId",
  "parentVersion",
  "artifact",
  "sourceMaterials",
  "modification",
  "provider",
  "validation",
  "evidenceIds",
  "sourceVersions",
] as const;
const VERSION_ENTITY_TYPES = [
  "source",
  "evidence",
  "finding",
  "competitor_diff",
  "task",
  "recommendation",
  "benchmark_analysis",
  "content_brief",
  "asset_version",
] as const;

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${label} must be a non-empty string`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    invalid(`${label} must be a lowercase SHA-256 hexadecimal hash`);
  }
}

function assertByteLength(value: unknown, label: string, allowZero = true): asserts value is number {
  if (!Number.isSafeInteger(value) || (allowZero ? (value as number) < 0 : (value as number) < 1)) {
    invalid(`${label} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
}

function assertPositiveVersion(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid(`${label} must be a positive safe integer`);
  }
}

function assertStringArray(
  value: unknown,
  label: string,
  options: { nonEmpty?: boolean; maximum?: number } = {},
): asserts value is string[] {
  const maximum = options.maximum ?? 1000;
  if (!Array.isArray(value) || value.length > maximum || (options.nonEmpty && value.length === 0)) {
    invalid(`${label} must be a bounded string array`);
  }
  for (const id of value) assertEntityReferenceId(id, label);
  if (new Set(value).size !== value.length) invalid(`${label} must not contain duplicates`);
}

function assertSourceVersions(value: unknown): asserts value is ContentEntityVersionRef[] {
  if (!Array.isArray(value) || value.length > 1000) {
    invalid("sourceVersions must be a bounded array");
  }
  const seen = new Set<string>();
  for (const reference of value) {
    assertRecord(reference, "Content source version", ["entityType", "id", "version"]);
    if (!(VERSION_ENTITY_TYPES as readonly string[]).includes(reference.entityType as string)) {
      invalid("Content source version entityType must be supported");
    }
    assertEntityReferenceId(reference.id, "Content source version ID");
    assertPositiveVersion(reference.version, "Content source version");
    const key = JSON.stringify([reference.entityType, reference.id]);
    if (seen.has(key)) invalid("sourceVersions must not contain duplicates");
    seen.add(key);
  }
}

function validateEvidenceAssetRef(ref: EvidenceAssetRef): void {
  assertRecord(ref, "Evidence asset ref", [
    "sourceId",
    "evidenceId",
    "assetId",
    "kind",
    "observedAt",
    "contentHash",
    "byteLength",
  ]);
  assertEntityReferenceId(ref.sourceId, "Evidence asset sourceId");
  assertEntityReferenceId(ref.evidenceId, "Evidence asset evidenceId");
  assertEntityReferenceId(ref.assetId, "Evidence asset assetId");
  if (!(ARTIFACT_KINDS as readonly string[]).includes(ref.kind)) {
    invalid("Evidence asset kind must be supported");
  }
  assertUtcInstant(ref.observedAt, "Evidence asset observedAt");
  assertHash(ref.contentHash, "Evidence asset contentHash");
  assertByteLength(ref.byteLength, "Evidence asset byteLength");
}

function validateMethod(method: BenchmarkMethod): void {
  assertRecord(method, "Benchmark method", [
    "id",
    "dimension",
    "pattern",
    "transferableRule",
    "basis",
    "confidence",
    "evidenceAssetRefs",
  ]);
  assertStableId(method.id, "Benchmark method ID");
  if (!(BENCHMARK_METHOD_DIMENSIONS as readonly string[]).includes(method.dimension)) {
    invalid("Benchmark method dimension must be supported");
  }
  assertNonEmptyString(method.pattern, "Benchmark method pattern");
  assertNonEmptyString(method.transferableRule, "Benchmark method transferableRule");
  if (!(OBSERVATION_BASES as readonly string[]).includes(method.basis)) {
    invalid("Benchmark method basis must be supported");
  }
  if (!(METHOD_CONFIDENCES as readonly string[]).includes(method.confidence)) {
    invalid("Benchmark method confidence must be supported");
  }
  if (!Array.isArray(method.evidenceAssetRefs) || method.evidenceAssetRefs.length === 0 ||
      method.evidenceAssetRefs.length > 100) {
    invalid("Benchmark method evidenceAssetRefs must be a non-empty bounded array");
  }
  const seen = new Set<string>();
  for (const ref of method.evidenceAssetRefs) {
    validateEvidenceAssetRef(ref);
    const key = JSON.stringify([ref.evidenceId, ref.assetId]);
    if (seen.has(key)) invalid("Benchmark method evidenceAssetRefs must not contain duplicates");
    seen.add(key);
  }
}

function assertEntityBase(record: EntityRecord, label: string): void {
  assertStableId(record.id, `${label} ID`);
  assertEntityReferenceId(record.workspaceId, `${label} workspaceId`);
  assertPositiveVersion(record.version, `${label} version`);
  assertUtcInstant(record.createdAt, `${label} createdAt`);
  assertUtcInstant(record.updatedAt, `${label} updatedAt`);
}

function assertEntitySize(record: EntityRecord, label: string): void {
  assertJsonValue(record, label);
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_ASSET_RESPONSE_BYTES) {
    invalid(`${label} must not exceed 64 KiB`);
  }
}

export function validateBenchmarkAnalysis(analysis: BenchmarkAnalysis): void {
  assertRecord(analysis, "BenchmarkAnalysis", BENCHMARK_KEYS);
  assertEntityBase(analysis, "BenchmarkAnalysis");
  if (analysis.version !== 1) invalid("BenchmarkAnalysis is immutable and must have version 1");
  if (analysis.modality !== "image" && analysis.modality !== "video") {
    invalid("BenchmarkAnalysis modality must be image or video");
  }
  if (analysis.status !== "completed" && analysis.status !== "partial") {
    invalid("BenchmarkAnalysis status must be completed or partial");
  }
  if (!Array.isArray(analysis.methods) || analysis.methods.length > 20) {
    invalid("BenchmarkAnalysis methods must contain at most 20 entries");
  }
  const methodIds = new Set<string>();
  for (const method of analysis.methods) {
    validateMethod(method);
    if (methodIds.has(method.id)) invalid("BenchmarkAnalysis method IDs must not contain duplicates");
    methodIds.add(method.id);
  }
  if (!Array.isArray(analysis.gaps) || analysis.gaps.length > 20) {
    invalid("BenchmarkAnalysis gaps must contain at most 20 entries");
  }
  for (const gap of analysis.gaps) {
    assertRecord(gap, "Benchmark gap", ["code", "message"]);
    assertNonEmptyString(gap.code, "Benchmark gap code");
    assertNonEmptyString(gap.message, "Benchmark gap message");
  }
  assertStringArray(analysis.evidenceIds, "BenchmarkAnalysis evidenceIds", { nonEmpty: true, maximum: 10 });
  const evidenceIds = new Set(analysis.evidenceIds);
  for (const method of analysis.methods) {
    for (const reference of method.evidenceAssetRefs) {
      if (!evidenceIds.has(reference.evidenceId)) {
        invalid("Benchmark method Evidence refs must be included in BenchmarkAnalysis evidenceIds");
      }
    }
  }
  if (analysis.competitorDiffId !== null) {
    assertEntityReferenceId(analysis.competitorDiffId, "BenchmarkAnalysis competitorDiffId");
  }
  assertSourceVersions(analysis.sourceVersions);
  assertRecord(analysis.provider, "BenchmarkAnalysis provider", [
    "type",
    "tool",
    "toolVersion",
    "inputHash",
    "analysisMethod",
    "humanReview",
  ]);
  if (analysis.provider.type !== "mcp" || analysis.provider.tool !== "reverse_engineer") {
    invalid("BenchmarkAnalysis provider must be the reverse_engineer MCP tool");
  }
  assertNonEmptyString(analysis.provider.toolVersion, "BenchmarkAnalysis provider toolVersion");
  assertHash(analysis.provider.inputHash, "BenchmarkAnalysis provider inputHash");
  assertNonEmptyString(analysis.provider.analysisMethod, "BenchmarkAnalysis provider analysisMethod");
  if (analysis.provider.humanReview !== "not_performed") {
    invalid("BenchmarkAnalysis humanReview must be not_performed");
  }
  assertEntitySize(analysis, "BenchmarkAnalysis");
}

export function createBenchmarkAnalysis(input: CreateBenchmarkAnalysisInput): BenchmarkAnalysis {
  const analysis = { ...input, version: 1, updatedAt: input.createdAt } as BenchmarkAnalysis;
  validateBenchmarkAnalysis(analysis);
  return analysis;
}

function validateSegment(segment: ContentSegment, segmentIds: Set<string>, findingIds: Set<string>): void {
  assertRecord(segment, "Content segment", ["id", "kind", "text", "findingId"]);
  assertStableId(segment.id, "Content segment ID");
  if (segmentIds.has(segment.id)) invalid("Content segment IDs must not contain duplicates");
  segmentIds.add(segment.id);
  assertNonEmptyString(segment.text, "Content segment text");
  if (segment.kind === "fact") {
    assertRecord(segment, "Fact content segment", ["id", "kind", "text", "findingId"]);
    assertEntityReferenceId(segment.findingId, "Fact segment findingId");
    if (!findingIds.has(segment.findingId)) {
      invalid("Fact segment findingId must be included in ContentBrief findingIds");
    }
  } else if (segment.kind === "creative") {
    assertRecord(segment, "Creative content segment", ["id", "kind", "text"]);
  } else {
    invalid("Content segment kind must be creative or fact");
  }
}

export function validateContentBrief(brief: ContentBrief): void {
  assertRecord(brief, "ContentBrief", BRIEF_KEYS);
  assertEntityBase(brief, "ContentBrief");
  if (brief.version !== 1) invalid("ContentBrief is immutable and must have version 1");
  if (!(CONTENT_CHANNELS as readonly string[]).includes(brief.channel)) {
    invalid("ContentBrief channel must be supported");
  }
  assertEntityReferenceId(brief.taskId, "ContentBrief taskId");
  assertEntityReferenceId(brief.recommendationId, "ContentBrief recommendationId");
  assertEntityReferenceId(brief.benchmarkAnalysisId, "ContentBrief benchmarkAnalysisId");
  assertStringArray(brief.methodIds, "ContentBrief methodIds", { nonEmpty: true, maximum: 20 });
  assertNonEmptyString(brief.objective, "ContentBrief objective");
  assertNonEmptyString(brief.audience, "ContentBrief audience");
  assertStringArray(brief.assetRequirements, "ContentBrief assetRequirements", { maximum: 100 });
  assertStringArray(brief.findingIds, "ContentBrief findingIds", { maximum: 100 });
  assertStringArray(brief.evidenceIds, "ContentBrief evidenceIds", { maximum: 100 });
  assertSourceVersions(brief.sourceVersions);

  const findingIds = new Set(brief.findingIds);
  const segmentIds = new Set<string>();
  assertRecord(brief.copy, "ContentBrief copy", ["hook", "body", "cta"]);
  validateSegment(brief.copy.hook, segmentIds, findingIds);
  if (!Array.isArray(brief.copy.body) || brief.copy.body.length < 1 || brief.copy.body.length > 20) {
    invalid("ContentBrief body must contain between 1 and 20 segments");
  }
  for (const segment of brief.copy.body) validateSegment(segment, segmentIds, findingIds);
  validateSegment(brief.copy.cta, segmentIds, findingIds);

  if (!Array.isArray(brief.frames) || brief.frames.length > 20) {
    invalid("ContentBrief frames must contain at most 20 entries");
  }
  const frameIds = new Set<string>();
  let totalDuration = 0;
  for (const [index, frame] of brief.frames.entries()) {
    assertRecord(frame, "Content frame", [
      "id",
      "order",
      "purpose",
      "visualDirection",
      "onScreenText",
      "narration",
      "durationMs",
    ]);
    assertStableId(frame.id, "Content frame ID");
    if (frameIds.has(frame.id)) invalid("Content frame IDs must not contain duplicates");
    frameIds.add(frame.id);
    if (!Number.isSafeInteger(frame.order) || frame.order !== index + 1) {
      invalid("Content frame orders must be consecutive starting at 1");
    }
    assertNonEmptyString(frame.purpose, "Content frame purpose");
    assertNonEmptyString(frame.visualDirection, "Content frame visualDirection");
    for (const [field, segments] of [["onScreenText", frame.onScreenText], ["narration", frame.narration]] as const) {
      if (!Array.isArray(segments) || segments.length > 20) {
        invalid(`Content frame ${field} must be a bounded segment array`);
      }
      for (const segment of segments) validateSegment(segment, segmentIds, findingIds);
    }
    if (brief.channel === "xhs") {
      if (frame.durationMs !== null) invalid("XHS frame durationMs must be null");
    } else {
      if (!Number.isSafeInteger(frame.durationMs) || (frame.durationMs as number) < 1) {
        invalid("Channels frame durationMs must be a positive safe integer");
      }
      totalDuration += frame.durationMs as number;
    }
  }
  if (brief.channel === "channels" && totalDuration > 60_000) {
    invalid("Channels frame durations must not exceed 60,000 ms");
  }
  assertEntitySize(brief, "ContentBrief");
}

export function createContentBrief(input: CreateContentBriefInput): ContentBrief {
  const brief = { ...input, version: 1, updatedAt: input.createdAt } as ContentBrief;
  validateContentBrief(brief);
  return brief;
}

function validateArtifact(artifact: AssetArtifact, channel: ContentChannel): void {
  assertRecord(artifact, "Asset artifact", ["id", "kind", "mediaType", "contentHash", "byteLength"]);
  assertStableId(artifact.id, "Asset artifact ID");
  if (artifact.kind !== "primary") invalid("Asset artifact kind must be primary");
  if (artifact.mediaType !== CHANNEL_PROFILES[channel].mediaType) {
    invalid("Asset artifact mediaType must match the channel profile");
  }
  assertHash(artifact.contentHash, "Asset artifact contentHash");
  assertByteLength(artifact.byteLength, "Asset artifact byteLength", false);
  if (artifact.byteLength > CHANNEL_PROFILES[channel].maxBytes) {
    invalid("Asset artifact byteLength exceeds the channel profile");
  }
}

function validateSourceMaterial(material: SourceMaterialDescriptor): void {
  if (material.role === "source") {
    assertRecord(material, "Source material", ["role", "source", "ownership"]);
    validateEvidenceAssetRef(material.source);
    if (material.ownership !== "owned" && material.ownership !== "authorized") {
      invalid("Source material ownership must be owned or authorized");
    }
  } else if (material.role === "parent") {
    assertRecord(material, "Parent source material", [
      "role",
      "assetVersionId",
      "artifactId",
      "mediaType",
      "contentHash",
      "byteLength",
    ]);
    assertEntityReferenceId(material.assetVersionId, "Parent source assetVersionId");
    assertEntityReferenceId(material.artifactId, "Parent source artifactId");
    if (material.mediaType !== "image/png" && material.mediaType !== "video/mp4") {
      invalid("Parent source mediaType must be supported");
    }
    assertHash(material.contentHash, "Parent source contentHash");
    assertByteLength(material.byteLength, "Parent source byteLength", false);
  } else {
    invalid("Source material role must be source or parent");
  }
}

function validateAssetValidation(validation: AssetValidation, channel: ContentChannel): void {
  const profile = CHANNEL_PROFILES[channel];
  if (channel === "xhs") {
    assertRecord(validation, "PNG asset validation", [
      "status",
      "profileId",
      "guarantee",
      "decoder",
      "width",
      "height",
      "durationMs",
      "videoCodec",
      "audioCodec",
    ]);
    if (validation.decoder !== "playwright_chromium" || validation.durationMs !== null ||
        validation.videoCodec !== null || validation.audioCodec !== null) {
      invalid("PNG validation must contain the exact Playwright decoder result");
    }
  } else {
    assertRecord(validation, "MP4 asset validation", [
      "status",
      "profileId",
      "guarantee",
      "probe",
      "probeVersion",
      "width",
      "height",
      "durationMs",
      "videoCodec",
      "audioCodec",
    ]);
    const mp4 = validation as Mp4AssetValidation;
    if (mp4.probe !== "ffprobe" || mp4.videoCodec !== "h264" || mp4.audioCodec !== "aac") {
      invalid("MP4 validation must contain the exact ffprobe codec result");
    }
    assertNonEmptyString(mp4.probeVersion, "MP4 validation probeVersion");
    if (!Number.isSafeInteger(mp4.durationMs) || mp4.durationMs < 1 || mp4.durationMs > 60_000) {
      invalid("MP4 validation durationMs must be between 1 and 60,000 ms");
    }
  }
  if (validation.status !== "passed" || validation.profileId !== profile.profileId ||
      validation.guarantee !== "internal_acceptance_only" || validation.width !== profile.width ||
      validation.height !== profile.height) {
    invalid("Asset validation must exactly match the internal channel profile");
  }
}

export function validateAssetVersion(asset: AssetVersion): void {
  assertRecord(asset, "AssetVersion", ASSET_KEYS);
  assertEntityBase(asset, "AssetVersion");
  if (!(CONTENT_CHANNELS as readonly string[]).includes(asset.channel)) {
    invalid("AssetVersion channel must be supported");
  }
  assertEntityReferenceId(asset.contentId, "AssetVersion contentId");
  assertEntityReferenceId(asset.briefId, "AssetVersion briefId");
  assertPositiveVersion(asset.briefVersion, "AssetVersion briefVersion");
  assertEntityReferenceId(asset.taskId, "AssetVersion taskId");
  assertEntityReferenceId(asset.recommendationId, "AssetVersion recommendationId");
  if (asset.version === 1) {
    if (asset.parentVersionId !== null || asset.parentVersion !== null) {
      invalid("Root AssetVersion must have null parent fields");
    }
  } else {
    if (asset.parentVersionId === null || asset.parentVersion === null) {
      invalid("Derivative AssetVersion requires both parent fields");
    }
    assertEntityReferenceId(asset.parentVersionId, "AssetVersion parentVersionId");
    assertPositiveVersion(asset.parentVersion, "AssetVersion parentVersion");
    if (asset.parentVersion !== asset.version - 1) {
      invalid("Derivative AssetVersion version must be parentVersion + 1");
    }
  }
  validateArtifact(asset.artifact, asset.channel);
  if (!Array.isArray(asset.sourceMaterials) || asset.sourceMaterials.length > 9) {
    invalid("AssetVersion sourceMaterials must be a bounded array");
  }
  for (const material of asset.sourceMaterials) validateSourceMaterial(material);
  assertRecord(asset.modification, "Asset modification", [
    "summary",
    "revisionInstructions",
    "actor",
    "requestId",
    "createdAt",
  ]);
  assertNonEmptyString(asset.modification.summary, "Asset modification summary");
  assertNonEmptyString(asset.modification.revisionInstructions, "Asset modification revisionInstructions");
  assertNonEmptyString(asset.modification.actor, "Asset modification actor");
  assertNonEmptyString(asset.modification.requestId, "Asset modification requestId");
  assertUtcInstant(asset.modification.createdAt, "Asset modification createdAt");
  assertRecord(asset.provider, "AssetVersion provider", ["type", "tool", "toolVersion", "inputHash"]);
  if (asset.provider.type !== "mcp" || asset.provider.tool !== "render") {
    invalid("AssetVersion provider must be the render MCP tool");
  }
  assertNonEmptyString(asset.provider.toolVersion, "AssetVersion provider toolVersion");
  assertHash(asset.provider.inputHash, "AssetVersion provider inputHash");
  validateAssetValidation(asset.validation, asset.channel);
  assertStringArray(asset.evidenceIds, "AssetVersion evidenceIds", { maximum: 100 });
  const evidenceIds = new Set(asset.evidenceIds);
  for (const material of asset.sourceMaterials) {
    if (material.role === "source" && !evidenceIds.has(material.source.evidenceId)) {
      invalid("AssetVersion source material Evidence refs must be included in AssetVersion evidenceIds");
    }
  }
  assertSourceVersions(asset.sourceVersions);
  assertEntitySize(asset, "AssetVersion");
}

export function createAssetVersion(input: CreateAssetVersionInput): AssetVersion {
  const asset = { ...input, version: input.version ?? 1, updatedAt: input.createdAt } as AssetVersion;
  validateAssetVersion(asset);
  return asset;
}

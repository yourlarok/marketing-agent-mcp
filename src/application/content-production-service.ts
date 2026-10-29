import { TextDecoder } from "node:util";
import {
  ASSET_ARTIFACT_CHUNK_MAX_BYTES,
  CHANNEL_PROFILES,
  CONTENT_CHANNELS,
  createAssetVersion,
  createContentBrief,
  type AssetValidation,
  type AssetVersion,
  type BenchmarkAnalysis,
  type ContentBrief,
  type ContentEntityVersionRef,
  type ContentSegment,
  type EvidenceAssetRef,
  type SourceMaterialDescriptor,
} from "../domain/content-production-model.js";
import type { CompetitorDiff } from "../domain/data-research-model.js";
import { assertRecord } from "../domain/contract-validation.js";
import { DomainError } from "../domain/errors.js";
import {
  ARTIFACT_KINDS,
  type Evidence,
  type EvidenceAsset,
  type Finding,
  type Recommendation,
  type Source,
  type Task,
} from "../domain/model.js";
import { ArtifactStore, type StoredArtifact } from "../infrastructure/artifact-store.js";
import {
  MEDIA_PROVIDER_LIMITS,
  McpMediaProvider,
  type MediaParentAsset,
  type MediaProvider,
  type MediaRenderRequest,
  type MediaRenderResponse,
  type MediaSourceAsset,
} from "../infrastructure/media-provider.js";
import { MediaValidator } from "../infrastructure/media-validation.js";
import { canonicalJson } from "../infrastructure/sqlite.js";
import type {
  CreateContentBrief,
  DeriveAssetVersion,
  GenerateAssetVersion,
  GetContentArtifact,
  GetContentBrief,
  GetAssetVersion,
  ProductionSourceMaterial,
} from "./content-production-commands.js";
import { AuditableCommandPipeline, type Command, type CommandPipeline } from "./commands.js";
import { requireWorkspace } from "./marketing-service.js";
import type { Clock, IdGenerator, Repositories, Store } from "./ports.js";

const COPY_RUN_CODE_POINTS = 40;
const VALIDATION_TIME = "1970-01-01T00:00:00.000Z";
const CREATE_BRIEF_KEYS = [
  "id", "workspaceId", "taskId", "expectedTaskVersion", "recommendationId",
  "expectedRecommendationVersion", "benchmarkAnalysisId", "expectedBenchmarkVersion",
  "channel", "methodIds", "objective", "audience", "copy", "frames", "assetRequirements",
] as const;
const GENERATE_KEYS = [
  "id", "workspaceId", "contentId", "briefId", "expectedBriefVersion", "sourceMaterials", "revisionInstructions",
] as const;
const DERIVE_KEYS = [
  "id", "workspaceId", "contentId", "parentVersionId", "expectedParentVersion", "briefId",
  "expectedBriefVersion", "sourceMaterials", "revisionInstructions",
] as const;

interface BriefSnapshot {
  task: Task;
  recommendation: Recommendation;
  benchmark: BenchmarkAnalysis;
  findings: Finding[];
  evidence: Evidence[];
  sources: Source[];
  benchmarkEvidence: Evidence[];
  benchmarkSources: Source[];
  externalTextAssets: { evidence: Evidence; asset: EvidenceAsset }[];
}

interface BriefLineage {
  findings: Finding[];
  evidence: Evidence[];
  sources: Source[];
}

interface MaterialSnapshot {
  evidence: Evidence;
  source: Source;
  asset: EvidenceAsset;
  descriptor: SourceMaterialDescriptor & { role: "source" };
}

interface GenerationSnapshot {
  brief: ContentBrief;
  benchmark: BenchmarkAnalysis;
  competitorDiff: CompetitorDiff | null;
  task: Task;
  recommendation: Recommendation;
  lineage: BriefLineage;
  benchmarkEvidence: Evidence[];
  benchmarkSources: Source[];
  parent: AssetVersion | null;
  latestId: string | null;
  materials: MaterialSnapshot[];
}

interface PreparedGeneration {
  snapshot: GenerationSnapshot;
  sourceAssets: MediaSourceAsset[];
  parentAsset?: MediaParentAsset;
  response: MediaRenderResponse;
  validation: AssetValidation;
  stored: StoredArtifact;
}

export interface ContentArtifactChunk {
  content: Buffer;
  offset: number;
  length: number;
  totalBytes: number;
  contentHash: string;
  mediaType: "image/png" | "video/mp4";
}

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

function conflict(message: string): never {
  throw new DomainError("CONFLICT", message);
}

function notFound(message: string, details: Record<string, string>): never {
  throw new DomainError("NOT_FOUND", message, false, details);
}

function positiveVersion(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid(`${field} must be a positive integer`);
  }
}

function unique<T>(values: T[], key: (value: T) => string = (value) => String(value)): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function segments(brief: Pick<CreateContentBrief, "copy" | "frames">): ContentSegment[] {
  return [
    brief.copy.hook,
    ...brief.copy.body,
    brief.copy.cta,
    ...brief.frames.flatMap((frame) => [...frame.onScreenText, ...frame.narration]),
  ];
}

function publishableTexts(input: CreateContentBrief): string[] {
  const copy = [input.copy.hook, ...input.copy.body, input.copy.cta].map((segment) => segment.text);
  const frameText = input.frames.flatMap((frame) =>
    [...frame.onScreenText, ...frame.narration].map((segment) => segment.text)
  );
  const joinedFrames = input.frames.map((frame) =>
    [...frame.onScreenText, ...frame.narration].map((segment) => segment.text).join(" ")
  );
  const concatenatedFrames = input.frames.map((frame) =>
    [...frame.onScreenText, ...frame.narration].map((segment) => segment.text).join("")
  );
  return [
    input.objective,
    input.audience,
    ...copy,
    copy.join(" "),
    copy.join(""),
    ...input.frames.flatMap((frame) => [frame.purpose, frame.visualDirection]),
    ...frameText,
    ...joinedFrames,
    ...concatenatedFrames,
    ...input.assetRequirements,
  ];
}

function normalizeForCopyCheck(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function windowHash(codePoints: string[], start: number): number {
  let hash = 0;
  for (let index = start; index < start + COPY_RUN_CODE_POINTS; index += 1) {
    hash = (Math.imul(hash, 31) + codePoints[index]!.codePointAt(0)!) >>> 0;
  }
  return hash;
}

function containsExternalCopy(output: string, sources: string[]): boolean {
  const candidate = Array.from(normalizeForCopyCheck(output));
  if (candidate.length < COPY_RUN_CODE_POINTS) return false;
  for (const source of sources) {
    const text = normalizeForCopyCheck(source);
    const codePoints = Array.from(text);
    if (codePoints.length < COPY_RUN_CODE_POINTS) continue;
    const hashes = new Set<number>();
    for (let start = 0; start <= codePoints.length - COPY_RUN_CODE_POINTS; start += 1) {
      hashes.add(windowHash(codePoints, start));
    }
    for (let start = 0; start <= candidate.length - COPY_RUN_CODE_POINTS; start += 1) {
      if (!hashes.has(windowHash(candidate, start))) continue;
      const run = candidate.slice(start, start + COPY_RUN_CODE_POINTS).join("");
      if (text.includes(run)) return true;
    }
  }
  return false;
}

function decodeText(content: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return conflict("External-public benchmark text artifacts must be valid UTF-8");
  }
}

function validateCreateInput(input: CreateContentBrief): void {
  assertRecord(input, "CreateContentBrief", CREATE_BRIEF_KEYS);
  positiveVersion(input.expectedTaskVersion, "expectedTaskVersion");
  positiveVersion(input.expectedRecommendationVersion, "expectedRecommendationVersion");
  positiveVersion(input.expectedBenchmarkVersion, "expectedBenchmarkVersion");
}

function validateGenerationInput(input: GenerateAssetVersion | DeriveAssetVersion, derivative: boolean): void {
  assertRecord(input, derivative ? "DeriveAssetVersion" : "GenerateAssetVersion", derivative ? DERIVE_KEYS : GENERATE_KEYS);
  positiveVersion(input.expectedBriefVersion, "expectedBriefVersion");
  if (derivative) positiveVersion((input as DeriveAssetVersion).expectedParentVersion, "expectedParentVersion");
  if (typeof input.revisionInstructions !== "string" || input.revisionInstructions.trim().length === 0 ||
      input.revisionInstructions.length > 32 * 1024) {
    invalid("revisionInstructions must be non-empty bounded guidance");
  }
  if (!Array.isArray(input.sourceMaterials) || input.sourceMaterials.length > MEDIA_PROVIDER_LIMITS.maxSourceAssets) {
    invalid(`sourceMaterials must contain at most ${MEDIA_PROVIDER_LIMITS.maxSourceAssets} entries`);
  }
  const identities = new Set<string>();
  for (const material of input.sourceMaterials) {
    assertRecord(material, "Production source material", ["evidenceId", "assetId"]);
    if (typeof material.evidenceId !== "string" || material.evidenceId.trim().length === 0 ||
        typeof material.assetId !== "string" || material.assetId.trim().length === 0) {
      invalid("Production source material IDs must not be empty");
    }
    const identity = canonicalJson([material.evidenceId, material.assetId]);
    if (identities.has(identity)) invalid("sourceMaterials must not contain duplicates");
    identities.add(identity);
  }
}

async function requireTask(repos: Repositories, workspaceId: string, id: string): Promise<Task> {
  const task = await repos.tasks.get(id, workspaceId) as Task | undefined;
  if (!task) notFound("Task not found in workspace", { taskId: id, workspaceId });
  return task;
}

async function requireRecommendation(repos: Repositories, workspaceId: string, id: string): Promise<Recommendation> {
  const recommendation = await repos.recommendations.get(id, workspaceId) as Recommendation | undefined;
  if (!recommendation) notFound("Recommendation not found in workspace", { recommendationId: id, workspaceId });
  return recommendation;
}

async function requireBenchmark(repos: Repositories, workspaceId: string, id: string): Promise<BenchmarkAnalysis> {
  const benchmark = await repos.benchmarkAnalyses.get(id, workspaceId);
  if (!benchmark) notFound("BenchmarkAnalysis not found in workspace", { benchmarkAnalysisId: id, workspaceId });
  return benchmark;
}

async function requireBenchmarkCompetitorDiff(
  repos: Repositories,
  benchmark: BenchmarkAnalysis,
): Promise<CompetitorDiff | null> {
  if (benchmark.competitorDiffId === null) return null;
  const expected = benchmark.sourceVersions.find((reference) =>
    reference.entityType === "competitor_diff" && reference.id === benchmark.competitorDiffId
  );
  if (!expected) conflict("BenchmarkAnalysis CompetitorDiff source version descriptor is missing");
  const diff = await repos.competitorDiffs.get(benchmark.competitorDiffId, benchmark.workspaceId);
  if (!diff) {
    notFound("Benchmark CompetitorDiff not found in workspace", {
      competitorDiffId: benchmark.competitorDiffId, workspaceId: benchmark.workspaceId,
    });
  }
  if (diff.version !== expected.version) conflict("CompetitorDiff version differs from BenchmarkAnalysis sourceVersions");
  return diff;
}

async function requireEvidence(repos: Repositories, workspaceId: string, id: string): Promise<Evidence> {
  const evidence = await repos.evidence.get(id, workspaceId) as Evidence | undefined;
  if (!evidence) notFound("Evidence not found in workspace", { evidenceId: id, workspaceId });
  return evidence;
}

async function requireSource(repos: Repositories, workspaceId: string, id: string): Promise<Source> {
  const source = await repos.sources.get(id, workspaceId) as Source | undefined;
  if (!source) notFound("Source not found in workspace", { sourceId: id, workspaceId });
  return source;
}

function assertTaskAndChannel(task: Task, recommendation: Recommendation, channel: ContentBrief["channel"]): void {
  if (task.state !== "ready" && task.state !== "in_progress") {
    conflict("Content production requires a ready or in_progress Task");
  }
  if (!(CONTENT_CHANNELS as readonly string[]).includes(channel) ||
      !Array.isArray(recommendation.targetChannels) || !recommendation.targetChannels.includes(channel)) {
    invalid("Recommendation targetChannels must include the selected brief channel");
  }
}

async function loadBriefLineage(repos: Repositories, brief: ContentBrief): Promise<BriefLineage> {
  const findings: Finding[] = [];
  for (const findingId of brief.findingIds) {
    const finding = await repos.findings.get(findingId, brief.workspaceId) as Finding | undefined;
    if (!finding) notFound("Content brief Finding not found in workspace", { findingId, workspaceId: brief.workspaceId });
    findings.push(finding);
  }
  const evidence: Evidence[] = [];
  for (const evidenceId of brief.evidenceIds) evidence.push(await requireEvidence(repos, brief.workspaceId, evidenceId));
  const sources: Source[] = [];
  const sourceIds = unique([
    ...evidence.map((record) => record.sourceId),
    ...brief.sourceVersions.filter((reference) => reference.entityType === "source").map((reference) => reference.id),
  ]);
  for (const sourceId of sourceIds) sources.push(await requireSource(repos, brief.workspaceId, sourceId));
  return { findings, evidence, sources };
}

function lineageVersionRefs(lineage: BriefLineage): ContentEntityVersionRef[] {
  return [
    ...lineage.findings.map((finding) => ({ entityType: "finding" as const, id: finding.id, version: finding.version })),
    ...lineage.evidence.map((evidence) => ({ entityType: "evidence" as const, id: evidence.id, version: evidence.version })),
    ...lineage.sources.map((source) => ({ entityType: "source" as const, id: source.id, version: source.version })),
  ];
}

function assertBriefFactLineageCurrent(brief: ContentBrief, lineage: BriefLineage): void {
  const current = new Map(lineageVersionRefs(lineage).map((reference) => [
    canonicalJson([reference.entityType, reference.id]), reference.version,
  ]));
  for (const reference of brief.sourceVersions) {
    if (reference.entityType !== "finding" && reference.entityType !== "evidence" && reference.entityType !== "source") {
      continue;
    }
    if (current.get(canonicalJson([reference.entityType, reference.id])) !== reference.version) {
      conflict("Content brief fact Finding, Evidence, or Source changed after brief creation");
    }
  }
}

async function loadBriefSnapshot(repos: Repositories, input: CreateContentBrief): Promise<BriefSnapshot> {
  await requireWorkspace(repos, input.workspaceId);
  const task = await requireTask(repos, input.workspaceId, input.taskId);
  if (task.version !== input.expectedTaskVersion) conflict("Task version does not match expectedTaskVersion");
  const recommendation = await requireRecommendation(repos, input.workspaceId, input.recommendationId);
  if (recommendation.version !== input.expectedRecommendationVersion) {
    conflict("Recommendation version does not match expectedRecommendationVersion");
  }
  if (!task.recommendationIds.includes(recommendation.id)) {
    invalid("Recommendation must belong to the selected Task");
  }
  assertTaskAndChannel(task, recommendation, input.channel);
  const benchmark = await requireBenchmark(repos, input.workspaceId, input.benchmarkAnalysisId);
  if (benchmark.version !== input.expectedBenchmarkVersion) {
    conflict("BenchmarkAnalysis version does not match expectedBenchmarkVersion");
  }
  const methodIds = new Set(benchmark.methods.map((method) => method.id));
  if (!Array.isArray(input.methodIds) || input.methodIds.some((id) => !methodIds.has(id))) {
    invalid("Every selected method must belong to the BenchmarkAnalysis");
  }

  const findingIds = unique(segments(input).flatMap((segment) => segment.kind === "fact" ? [segment.findingId] : []));
  const findings: Finding[] = [];
  const recommendationEvidence = new Set(recommendation.evidenceIds ?? []);
  for (const findingId of findingIds) {
    const finding = await repos.findings.get(findingId, input.workspaceId) as Finding | undefined;
    if (!finding) notFound("Fact segment Finding not found in workspace", { findingId, workspaceId: input.workspaceId });
    if (finding.kind !== "fact" || !Array.isArray(finding.evidenceIds) || finding.evidenceIds.length === 0) {
      invalid("Every fact segment requires a fact Finding with non-empty Evidence");
    }
    const connected = recommendation.findingIds.includes(finding.id) ||
      finding.evidenceIds.some((evidenceId) => recommendationEvidence.has(evidenceId));
    if (!connected) invalid("Fact segment Finding is outside the Recommendation Finding/Evidence context");
    findings.push(finding);
  }
  const evidenceIds = unique(findings.flatMap((finding) => finding.evidenceIds));
  const evidence: Evidence[] = [];
  for (const evidenceId of evidenceIds) evidence.push(await requireEvidence(repos, input.workspaceId, evidenceId));
  const sources: Source[] = [];
  for (const sourceId of unique(evidence.map((record) => record.sourceId))) {
    sources.push(await requireSource(repos, input.workspaceId, sourceId));
  }

  const benchmarkEvidence: Evidence[] = [];
  const benchmarkSources: Source[] = [];
  const externalTextAssets: BriefSnapshot["externalTextAssets"] = [];
  for (const evidenceId of benchmark.evidenceIds) {
    const record = await requireEvidence(repos, input.workspaceId, evidenceId);
    const source = await requireSource(repos, input.workspaceId, record.sourceId);
    benchmarkEvidence.push(record);
    benchmarkSources.push(source);
    if (source.ownership === "external_public") {
      for (const asset of record.assets ?? []) {
        if (asset.kind === "page_text" || asset.kind === "asr_transcript") {
          externalTextAssets.push({ evidence: record, asset });
        }
      }
    }
  }
  return { task, recommendation, benchmark, findings, evidence, sources, benchmarkEvidence, benchmarkSources, externalTextAssets };
}

function briefSourceVersions(snapshot: BriefSnapshot): ContentEntityVersionRef[] {
  return [
    { entityType: "task", id: snapshot.task.id, version: snapshot.task.version },
    { entityType: "recommendation", id: snapshot.recommendation.id, version: snapshot.recommendation.version },
    { entityType: "benchmark_analysis", id: snapshot.benchmark.id, version: snapshot.benchmark.version },
    ...snapshot.findings.map((finding) => ({ entityType: "finding" as const, id: finding.id, version: finding.version })),
    ...snapshot.evidence.map((evidence) => ({ entityType: "evidence" as const, id: evidence.id, version: evidence.version })),
    ...snapshot.sources.map((source) => ({ entityType: "source" as const, id: source.id, version: source.version })),
  ];
}

function briefFromSnapshot(input: CreateContentBrief, snapshot: BriefSnapshot, createdAt: string): ContentBrief {
  return createContentBrief({
    id: input.id,
    workspaceId: input.workspaceId,
    createdAt,
    channel: input.channel,
    taskId: input.taskId,
    recommendationId: input.recommendationId,
    benchmarkAnalysisId: input.benchmarkAnalysisId,
    methodIds: [...input.methodIds],
    objective: input.objective,
    audience: input.audience,
    copy: input.copy,
    frames: input.frames,
    assetRequirements: [...input.assetRequirements],
    findingIds: snapshot.findings.map((finding) => finding.id),
    evidenceIds: snapshot.evidence.map((evidence) => evidence.id),
    sourceVersions: briefSourceVersions(snapshot),
  });
}

function validateSourceDescriptor(evidence: Evidence, asset: EvidenceAsset): void {
  if (!(ARTIFACT_KINDS as readonly string[]).includes(asset.kind) || !/^[a-f0-9]{64}$/.test(asset.contentHash) ||
      !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 1 ||
      asset.byteLength > MEDIA_PROVIDER_LIMITS.maxTotalSourceBytes) {
    conflict("Production Evidence asset descriptor is invalid or unsupported");
  }
  if (evidence.observedAt !== undefined && typeof evidence.observedAt !== "string") {
    conflict("Production Evidence observation is invalid");
  }
}

async function loadGenerationSnapshot(
  repos: Repositories,
  input: GenerateAssetVersion | DeriveAssetVersion,
  derivative: boolean,
): Promise<GenerationSnapshot> {
  await requireWorkspace(repos, input.workspaceId);
  const brief = await repos.contentBriefs.get(input.briefId, input.workspaceId);
  if (!brief) notFound("ContentBrief not found in workspace", { briefId: input.briefId, workspaceId: input.workspaceId });
  if (brief.version !== input.expectedBriefVersion) conflict("ContentBrief version does not match expectedBriefVersion");
  const benchmark = await requireBenchmark(repos, input.workspaceId, brief.benchmarkAnalysisId);
  const competitorDiff = await requireBenchmarkCompetitorDiff(repos, benchmark);
  const task = await requireTask(repos, input.workspaceId, brief.taskId);
  const recommendation = await requireRecommendation(repos, input.workspaceId, brief.recommendationId);
  if (!task.recommendationIds.includes(recommendation.id)) invalid("Content brief Recommendation must belong to its Task");
  assertTaskAndChannel(task, recommendation, brief.channel);
  const lineage = await loadBriefLineage(repos, brief);
  assertBriefFactLineageCurrent(brief, lineage);
  const latest = await repos.assetVersions.latest(input.contentId, input.workspaceId);
  let parent: AssetVersion | null = null;
  if (derivative) {
    const derive = input as DeriveAssetVersion;
    parent = await repos.assetVersions.get(derive.parentVersionId, input.workspaceId) ?? null;
    if (!parent) notFound("Parent AssetVersion not found in workspace", { parentVersionId: derive.parentVersionId, workspaceId: input.workspaceId });
    if (parent.version !== derive.expectedParentVersion || latest?.id !== parent.id) {
      conflict("Parent AssetVersion must be the latest version at expectedParentVersion");
    }
    if (parent.contentId !== input.contentId || parent.channel !== brief.channel ||
        parent.taskId !== brief.taskId || parent.recommendationId !== brief.recommendationId) {
      invalid("Derivative brief and parent must share content series, channel, Task, and Recommendation");
    }
  } else if (latest) {
    conflict("Root AssetVersion contentId already has a version");
  }

  const benchmarkEvidenceIds = new Set([
    ...benchmark.evidenceIds,
    ...benchmark.methods.flatMap((method) => method.evidenceAssetRefs.map((reference) => reference.evidenceId)),
  ]);
  const benchmarkEvidence: Evidence[] = [];
  const benchmarkSources: Source[] = [];
  for (const evidenceId of benchmark.evidenceIds) {
    const evidence = await requireEvidence(repos, input.workspaceId, evidenceId);
    benchmarkEvidence.push(evidence);
    const source = await requireSource(repos, input.workspaceId, evidence.sourceId);
    if (!benchmarkSources.some((candidate) => candidate.id === source.id)) benchmarkSources.push(source);
  }
  const materials: MaterialSnapshot[] = [];
  for (const material of input.sourceMaterials) {
    if (benchmarkEvidenceIds.has(material.evidenceId)) {
      invalid("Every Evidence ID referenced in BenchmarkAnalysis is forbidden as production source material");
    }
    const evidence = await requireEvidence(repos, input.workspaceId, material.evidenceId);
    const source = await requireSource(repos, input.workspaceId, evidence.sourceId);
    if (source.ownership !== "owned" && source.ownership !== "authorized") {
      invalid("Production source material must be independently owned or authorized, never external_public");
    }
    const asset = (evidence.assets ?? []).find((candidate) => candidate.id === material.assetId);
    if (!asset) notFound("Production Evidence asset not found", { evidenceId: material.evidenceId, assetId: material.assetId });
    validateSourceDescriptor(evidence, asset);
    const reference: EvidenceAssetRef = {
      sourceId: source.id,
      evidenceId: evidence.id,
      assetId: asset.id,
      kind: asset.kind,
      observedAt: evidence.observedAt,
      contentHash: asset.contentHash,
      byteLength: asset.byteLength,
    };
    materials.push({
      evidence,
      source,
      asset,
      descriptor: { role: "source", source: reference, ownership: source.ownership },
    });
  }
  const declaredBytes = materials.reduce((sum, material) => sum + material.asset.byteLength, 0) +
    (parent?.artifact.byteLength ?? 0);
  if (declaredBytes > MEDIA_PROVIDER_LIMITS.maxTotalSourceBytes) {
    invalid("Production source and parent bytes exceed 16 MiB");
  }
  return {
    brief, benchmark, competitorDiff, task, recommendation, lineage, benchmarkEvidence, benchmarkSources,
    parent, latestId: latest?.id ?? null, materials,
  };
}

function assetSourceVersions(snapshot: GenerationSnapshot): ContentEntityVersionRef[] {
  const materialRefs = snapshot.materials.flatMap((material): ContentEntityVersionRef[] => [
    { entityType: "evidence", id: material.evidence.id, version: material.evidence.version },
    { entityType: "source", id: material.source.id, version: material.source.version },
  ]);
  const currentRefs: ContentEntityVersionRef[] = [
    { entityType: "task", id: snapshot.task.id, version: snapshot.task.version },
    { entityType: "recommendation", id: snapshot.recommendation.id, version: snapshot.recommendation.version },
    { entityType: "benchmark_analysis", id: snapshot.benchmark.id, version: snapshot.benchmark.version },
    ...(snapshot.competitorDiff ? [{
      entityType: "competitor_diff" as const,
      id: snapshot.competitorDiff.id,
      version: snapshot.competitorDiff.version,
    }] : []),
    ...lineageVersionRefs(snapshot.lineage),
  ];
  const references: ContentEntityVersionRef[] = [
    { entityType: "content_brief", id: snapshot.brief.id, version: snapshot.brief.version },
    ...materialRefs,
    ...currentRefs,
    ...(snapshot.parent ? [{ entityType: "asset_version" as const, id: snapshot.parent.id, version: snapshot.parent.version }] : []),
  ];
  return unique(references, (reference) => canonicalJson([reference.entityType, reference.id]));
}

export class ContentProductionService {
  private readonly commands: CommandPipeline;

  constructor(
    private readonly store: Store,
    clock: Clock,
    ids: IdGenerator,
    private readonly artifacts: ArtifactStore = new ArtifactStore(),
    private readonly provider: MediaProvider = new McpMediaProvider(),
    private readonly validator: MediaValidator = new MediaValidator(),
  ) {
    this.commands = new AuditableCommandPipeline(store, clock, ids);
  }

  hasProfessionalMediaProvider(): boolean {
    const provider = this.provider as MediaProvider & { isConfigured?: () => boolean };
    return provider.isConfigured?.() ?? true;
  }

  hasConfiguredVideoProbe(): boolean {
    return this.validator.hasConfiguredFfprobe?.() ?? true;
  }

  async createBrief(command: Command<CreateContentBrief>): Promise<ContentBrief> {
    validateCreateInput(command.input);
    let prepared: { snapshot: BriefSnapshot; externalTexts: string[] } | undefined;
    const prepare = async (): Promise<void> => {
      prepared = undefined;
      const snapshot = await this.store.transaction((repos) => loadBriefSnapshot(repos, command.input));
      briefFromSnapshot(command.input, snapshot, VALIDATION_TIME);
      const externalTexts: string[] = [];
      for (const { asset } of snapshot.externalTextAssets) {
        const content = await this.artifacts.read(asset.contentHash, asset.byteLength);
        if (content.length !== asset.byteLength || content.length < 1) {
          conflict("External-public benchmark text length does not match its descriptor");
        }
        externalTexts.push(decodeText(content));
      }
      for (const text of publishableTexts(command.input)) {
        if (containsExternalCopy(text, externalTexts)) {
          invalid("Publishable brief text contains an exact external-public source-text run of at least 40 Unicode code points");
        }
      }
      prepared = { snapshot, externalTexts };
    };
    return this.commands.executeBatch({
      workspaceId: command.input.workspaceId,
      action: "content.brief.create",
      entityType: "content_brief",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        if (!prepared) throw new Error("Content brief preparation did not complete");
        const current = await loadBriefSnapshot(repos, input);
        if (canonicalJson(current) !== canonicalJson(prepared.snapshot)) {
          conflict("Content brief source versions or assets changed before commit");
        }
        const brief = briefFromSnapshot(input, current, timestamp);
        return repos.contentBriefs.insert(brief) as Promise<ContentBrief>;
      },
    }, prepare);
  }

  async getBrief(query: GetContentBrief): Promise<ContentBrief> {
    assertRecord(query, "GetContentBrief", ["id", "workspaceId"]);
    return this.store.transaction(async (repos) => {
      const brief = await repos.contentBriefs.get(query.id, query.workspaceId);
      if (!brief) notFound("ContentBrief not found in workspace", { id: query.id, workspaceId: query.workspaceId });
      return brief;
    });
  }

  getContentBrief(query: GetContentBrief): Promise<ContentBrief> {
    return this.getBrief(query);
  }

  generate(command: Command<GenerateAssetVersion>): Promise<AssetVersion> {
    return this.executeGeneration(command, false);
  }

  derive(command: Command<DeriveAssetVersion>): Promise<AssetVersion> {
    return this.executeGeneration(command, true);
  }

  private async executeGeneration<T extends GenerateAssetVersion | DeriveAssetVersion>(
    command: Command<T>,
    derivative: boolean,
  ): Promise<AssetVersion> {
    validateGenerationInput(command.input, derivative);
    let prepared: PreparedGeneration | undefined;
    const prepare = async (): Promise<void> => {
      prepared = undefined;
      const snapshot = await this.store.transaction((repos) => loadGenerationSnapshot(repos, command.input, derivative));
      const sourceAssets: MediaSourceAsset[] = [];
      for (const material of snapshot.materials) {
        const content = await this.artifacts.read(material.asset.contentHash, material.asset.byteLength);
        if (content.length !== material.asset.byteLength || content.length < 1) {
          conflict("Production source bytes do not match their descriptor");
        }
        sourceAssets.push({ ...material.descriptor, contentBase64: content.toString("base64") });
      }
      let parentAsset: MediaParentAsset | undefined;
      if (snapshot.parent) {
        const parent = snapshot.parent;
        const content = await this.artifacts.read(parent.artifact.contentHash, parent.artifact.byteLength);
        if (content.length !== parent.artifact.byteLength || content.length < 1) {
          conflict("Parent production bytes do not match their descriptor");
        }
        parentAsset = {
          role: "parent",
          assetVersionId: parent.id,
          artifactId: parent.artifact.id,
          mediaType: parent.artifact.mediaType,
          contentHash: parent.artifact.contentHash,
          byteLength: parent.artifact.byteLength,
          contentBase64: content.toString("base64"),
        };
      }
      const request: MediaRenderRequest = {
        operation: snapshot.brief.channel === "xhs" ? "render_xhs_png_v1" : "render_channels_mp4_v1",
        brief: snapshot.brief,
        benchmarkAnalysis: snapshot.benchmark,
        ...(sourceAssets.length === 0 ? {} : { sourceAssets }),
        ...(parentAsset === undefined ? {} : { parent: parentAsset }),
        revisionInstructions: command.input.revisionInstructions,
        profile: CHANNEL_PROFILES[snapshot.brief.channel],
      };
      const response = await this.provider.render(request);
      const bytes = Buffer.from(response.content.buffer, response.content.byteOffset, response.content.byteLength);
      if (bytes.length !== response.artifact.byteLength ||
          response.artifact.mediaType !== CHANNEL_PROFILES[snapshot.brief.channel].mediaType) {
        throw new DomainError("CAPABILITY_UNAVAILABLE", "Professional media result descriptor is inconsistent", false, {
          capability: "professional_media", reason: "mcp_result_mismatch",
        });
      }
      const validation = snapshot.brief.channel === "xhs"
        ? await this.validator.validateXhsPng(response.content)
        : await this.validator.validateChannelsMp4(response.content);
      const stored = await this.artifacts.put(response.content);
      if (stored.contentHash !== response.artifact.contentHash || stored.byteLength !== response.artifact.byteLength) {
        throw new DomainError("CAPABILITY_UNAVAILABLE", "Professional media stored bytes do not match the validated descriptor", false, {
          capability: "professional_media", reason: "mcp_result_mismatch",
        });
      }
      prepared = { snapshot, sourceAssets, ...(parentAsset === undefined ? {} : { parentAsset }), response, validation, stored };
    };
    return this.commands.executeBatch({
      workspaceId: command.input.workspaceId,
      action: derivative ? "content.asset.derive" : "content.asset.generate",
      entityType: "asset_version",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        if (!prepared) throw new Error("Asset generation preparation did not complete");
        const current = await loadGenerationSnapshot(repos, input, derivative);
        if (canonicalJson(current) !== canonicalJson(prepared.snapshot)) {
          conflict("Content production entities, versions, assets, or parent changed before commit");
        }
        const parentDescriptor: SourceMaterialDescriptor[] = current.parent ? [{
          role: "parent",
          assetVersionId: current.parent.id,
          artifactId: current.parent.artifact.id,
          mediaType: current.parent.artifact.mediaType,
          contentHash: current.parent.artifact.contentHash,
          byteLength: current.parent.artifact.byteLength,
        }] : [];
        const sourceMaterials = [...parentDescriptor, ...current.materials.map((material) => material.descriptor)];
        const asset = createAssetVersion({
          id: input.id,
          workspaceId: input.workspaceId,
          version: current.parent ? current.parent.version + 1 : 1,
          createdAt: timestamp,
          contentId: input.contentId,
          channel: current.brief.channel,
          briefId: current.brief.id,
          briefVersion: current.brief.version,
          taskId: current.task.id,
          recommendationId: current.recommendation.id,
          parentVersionId: current.parent?.id ?? null,
          parentVersion: current.parent?.version ?? null,
          artifact: {
            id: input.id,
            kind: "primary",
            mediaType: prepared.response.artifact.mediaType,
            contentHash: prepared.stored.contentHash,
            byteLength: prepared.stored.byteLength,
          },
          sourceMaterials,
          modification: {
            summary: current.parent ? "Derived controlled asset version" : "Initial controlled asset version",
            revisionInstructions: input.revisionInstructions,
            actor: command.context.actor,
            requestId: command.context.requestId,
            createdAt: timestamp,
          },
          provider: {
            type: "mcp",
            tool: "render",
            toolVersion: prepared.response.toolVersion,
            inputHash: prepared.response.inputHash,
          },
          validation: prepared.validation,
          evidenceIds: unique([
            ...current.brief.evidenceIds,
            ...current.materials.map((material) => material.evidence.id),
          ]),
          sourceVersions: assetSourceVersions(current),
        });
        return repos.assetVersions.insert(asset);
      },
    }, prepare);
  }

  async getAssetVersion(query: GetAssetVersion): Promise<AssetVersion> {
    assertRecord(query, "GetAssetVersion", ["id", "workspaceId"]);
    return this.store.transaction(async (repos) => {
      const asset = await repos.assetVersions.get(query.id, query.workspaceId);
      if (!asset) notFound("AssetVersion not found in workspace", { id: query.id, workspaceId: query.workspaceId });
      return asset;
    });
  }

  async getContentArtifact(query: GetContentArtifact): Promise<ContentArtifactChunk> {
    assertRecord(query, "GetContentArtifact", ["id", "workspaceId", "artifactId", "offset", "length"]);
    const offset = query.offset ?? 0;
    const length = query.length ?? ASSET_ARTIFACT_CHUNK_MAX_BYTES;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) ||
        length < 1 || length > ASSET_ARTIFACT_CHUNK_MAX_BYTES) {
      invalid(`Artifact offset must be non-negative and length must be 1-${ASSET_ARTIFACT_CHUNK_MAX_BYTES}`);
    }
    const asset = await this.getAssetVersion({ id: query.id, workspaceId: query.workspaceId });
    if (asset.artifact.id !== query.artifactId) {
      notFound("Content artifact not found on AssetVersion", { id: query.id, artifactId: query.artifactId });
    }
    const content = await this.artifacts.readRange(
      asset.artifact.contentHash,
      offset,
      length,
      asset.artifact.byteLength,
    );
    return {
      content,
      offset,
      length: content.length,
      totalBytes: asset.artifact.byteLength,
      contentHash: asset.artifact.contentHash,
      mediaType: asset.artifact.mediaType,
    };
  }

  getArtifact(query: GetContentArtifact): Promise<ContentArtifactChunk> {
    return this.getContentArtifact(query);
  }
}

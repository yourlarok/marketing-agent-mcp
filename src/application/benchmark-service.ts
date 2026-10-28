import { TextDecoder } from "node:util";
import {
  createBenchmarkAnalysis,
  type BenchmarkAnalysis,
  type BenchmarkMethod,
  type ContentEntityVersionRef,
} from "../domain/content-production-model.js";
import type { CompetitorDiff } from "../domain/data-research-model.js";
import { assertRecord, assertUtcInstant } from "../domain/contract-validation.js";
import { DomainError } from "../domain/errors.js";
import type { Evidence, EvidenceAsset, Source } from "../domain/model.js";
import { ArtifactStore } from "../infrastructure/artifact-store.js";
import {
  BENCHMARK_REVERSE_LIMITS,
  McpBenchmarkReverseProvider,
  benchmarkReverseCapabilityGap,
  computeBenchmarkReverseInputHash,
  type BenchmarkObservation,
  type BenchmarkObservationAsset,
  type BenchmarkReverseProvider,
  type BenchmarkReverseProviderResponse,
} from "../infrastructure/benchmark-reverse-provider.js";
import { canonicalJson } from "../infrastructure/sqlite.js";
import type { GetBenchmarkAnalysis, ReverseBenchmark } from "./benchmark-commands.js";
import { AuditableCommandPipeline, type Command, type CommandPipeline } from "./commands.js";
import type { Clock, IdGenerator, Repositories, Store } from "./ports.js";

const RELEVANT_KINDS = ["page_text", "asr_transcript", "screenshot", "video_frames"] as const;
const TEXT_KINDS = ["page_text", "asr_transcript"] as const;
const COPY_RUN_CODE_POINTS = 40;

interface BenchmarkSnapshot {
  sources: Source[];
  evidence: Evidence[];
  diff: CompetitorDiff | null;
}

interface PreparedBenchmark {
  snapshot: BenchmarkSnapshot;
  observations: BenchmarkObservation[];
  response: BenchmarkReverseProviderResponse;
  inputHash: string;
}

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

function conflict(message: string): never {
  throw new DomainError("CONFLICT", message);
}

function validateReverseInput(input: ReverseBenchmark): void {
  assertRecord(input, "ReverseBenchmark", [
    "id", "workspaceId", "modality", "evidenceIds", "competitorDiffId", "expectedCompetitorDiffVersion",
  ]);
  if (input.modality !== "image" && input.modality !== "video") invalid("modality must be image or video");
  if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length < 1 ||
      input.evidenceIds.length > BENCHMARK_REVERSE_LIMITS.maxEvidence ||
      input.evidenceIds.some((id) => typeof id !== "string" || id.trim().length === 0)) {
    invalid(`evidenceIds must contain 1-${BENCHMARK_REVERSE_LIMITS.maxEvidence} Evidence IDs`);
  }
  if (new Set(input.evidenceIds).size !== input.evidenceIds.length) {
    invalid("evidenceIds must not contain duplicates");
  }
  if ((input.competitorDiffId === undefined) !== (input.expectedCompetitorDiffVersion === undefined)) {
    invalid("competitorDiffId and expectedCompetitorDiffVersion must be provided together");
  }
  if (input.competitorDiffId !== undefined &&
      (typeof input.competitorDiffId !== "string" || input.competitorDiffId.trim().length === 0)) {
    invalid("competitorDiffId must not be empty");
  }
  if (input.expectedCompetitorDiffVersion !== undefined &&
      (!Number.isSafeInteger(input.expectedCompetitorDiffVersion) || input.expectedCompetitorDiffVersion < 1)) {
    invalid("expectedCompetitorDiffVersion must be a positive integer");
  }
}

async function requireWorkspace(repos: Repositories, workspaceId: string): Promise<void> {
  if (!(await repos.workspaces.get(workspaceId, workspaceId))) {
    throw new DomainError("NOT_FOUND", "Workspace not found", false, { workspaceId });
  }
}

function assertClassification(source: Source, evidence: Evidence): void {
  const valid = source.ownership === "external_public"
    ? evidence.classification === "external_observation"
    : (source.ownership === "owned" || source.ownership === "authorized") &&
      (evidence.classification === "owned_operating" || evidence.classification === "owned_conversion");
  if (!valid) conflict("Source ownership and Evidence classification are inconsistent");
}

async function loadSnapshot(repos: Repositories, input: ReverseBenchmark): Promise<BenchmarkSnapshot> {
  await requireWorkspace(repos, input.workspaceId);
  const evidence: Evidence[] = [];
  const sources: Source[] = [];
  const sourceIds = new Set<string>();
  for (const evidenceId of input.evidenceIds) {
    const record = await repos.evidence.get(evidenceId, input.workspaceId) as Evidence | undefined;
    if (!record) {
      throw new DomainError("NOT_FOUND", "Benchmark Evidence not found in workspace", false, {
        evidenceId, workspaceId: input.workspaceId,
      });
    }
    assertUtcInstant(record.observedAt, "Evidence observedAt");
    const source = await repos.sources.get(record.sourceId, input.workspaceId) as Source | undefined;
    if (!source) {
      throw new DomainError("NOT_FOUND", "Benchmark Source not found in workspace", false, {
        sourceId: record.sourceId, workspaceId: input.workspaceId,
      });
    }
    assertClassification(source, record);
    evidence.push(record);
    if (!sourceIds.has(source.id)) {
      sources.push(source);
      sourceIds.add(source.id);
    }
  }
  let diff: CompetitorDiff | null = null;
  if (input.competitorDiffId !== undefined) {
    const record = await repos.competitorDiffs.get(input.competitorDiffId, input.workspaceId);
    if (!record) {
      throw new DomainError("NOT_FOUND", "CompetitorDiff not found in workspace", false, {
        competitorDiffId: input.competitorDiffId, workspaceId: input.workspaceId,
      });
    }
    if (record.version !== input.expectedCompetitorDiffVersion) {
      conflict("CompetitorDiff version does not match expectedCompetitorDiffVersion");
    }
    const members = new Set(record.entries.flatMap((entry) => entry.evidenceIds));
    if (input.evidenceIds.some((id) => !members.has(id))) {
      invalid("Every selected Evidence must belong to the supplied CompetitorDiff");
    }
    diff = record;
  }
  for (const record of evidence) {
    const assets = record.assets ?? [];
    if (!Array.isArray(assets)) conflict("Benchmark Evidence assets must be an array");
    const ids = new Set<string>();
    for (const asset of assets) {
      if (!asset || typeof asset.id !== "string" || asset.id.length === 0 || ids.has(asset.id)) {
        conflict("Benchmark Evidence asset IDs must be unique and non-empty");
      }
      ids.add(asset.id);
      if (!RELEVANT_KINDS.includes(asset.kind as (typeof RELEVANT_KINDS)[number])) continue;
      if (!/^[a-f0-9]{64}$/.test(asset.contentHash) || !Number.isSafeInteger(asset.byteLength) ||
          asset.byteLength < 1 || asset.byteLength > BENCHMARK_REVERSE_LIMITS.maxSingleAssetBytes) {
        conflict("Benchmark Evidence asset descriptor is invalid or exceeds the single-asset limit");
      }
    }
    const relevantBytes = assets
      .filter((asset) => RELEVANT_KINDS.includes(asset.kind as (typeof RELEVANT_KINDS)[number]))
      .reduce((total, asset) => total + asset.byteLength, 0);
    if (relevantBytes > BENCHMARK_REVERSE_LIMITS.maxTotalAssetBytes) {
      invalid("Selected Evidence assets exceed the total byte limit");
    }
    const textBytes = assets
      .filter((asset) => TEXT_KINDS.includes(asset.kind as (typeof TEXT_KINDS)[number]))
      .reduce((total, asset) => total + asset.byteLength, 0);
    if (textBytes > BENCHMARK_REVERSE_LIMITS.maxTextBytes) {
      invalid("Selected Evidence text exceeds the total text limit");
    }
  }
  if (input.modality === "image" && !evidence.some((record) =>
    (record.assets ?? []).some((asset) => asset.kind === "page_text" || asset.kind === "screenshot")
  )) {
    throw benchmarkReverseCapabilityGap("image_observation_missing", "Image analysis requires page text or a screenshot");
  }
  if (input.modality === "video") {
    for (const record of evidence) {
      if (!(record.assets ?? []).some((asset) => asset.kind === "video_frames")) {
        throw benchmarkReverseCapabilityGap("video_frames_missing", "Every video Evidence requires persisted video frames");
      }
      if (!(record.assets ?? []).some((asset) => asset.kind === "asr_transcript")) {
        throw benchmarkReverseCapabilityGap("asr_transcript_missing", "Every video Evidence requires a persisted ASR transcript");
      }
    }
  }
  return { sources, evidence, diff };
}

function decodeText(content: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return conflict("Benchmark text artifacts must be valid UTF-8");
  }
}

async function readObservations(artifacts: ArtifactStore, snapshot: BenchmarkSnapshot): Promise<BenchmarkObservation[]> {
  const observations: BenchmarkObservation[] = [];
  let totalBytes = 0;
  let totalTextBytes = 0;
  for (const evidence of snapshot.evidence) {
    const assets: BenchmarkObservationAsset[] = [];
    for (const asset of evidence.assets ?? []) {
      if (!RELEVANT_KINDS.includes(asset.kind as (typeof RELEVANT_KINDS)[number])) continue;
      const content = await artifacts.read(asset.contentHash, BENCHMARK_REVERSE_LIMITS.maxSingleAssetBytes);
      if (content.length !== asset.byteLength || content.length < 1) {
        conflict("Evidence artifact length does not match its descriptor");
      }
      totalBytes += content.length;
      if (totalBytes > BENCHMARK_REVERSE_LIMITS.maxTotalAssetBytes) {
        invalid("Selected Evidence assets exceed the total byte limit");
      }
      const reference = {
        sourceId: evidence.sourceId,
        evidenceId: evidence.id,
        assetId: asset.id,
        kind: asset.kind as BenchmarkObservationAsset["kind"],
        observedAt: evidence.observedAt,
        contentHash: asset.contentHash,
        byteLength: asset.byteLength,
      };
      if (TEXT_KINDS.includes(asset.kind as (typeof TEXT_KINDS)[number])) {
        totalTextBytes += content.length;
        if (totalTextBytes > BENCHMARK_REVERSE_LIMITS.maxTextBytes) {
          invalid("Selected Evidence text exceeds the total text limit");
        }
        assets.push({ ...reference, text: decodeText(content) });
      } else {
        assets.push({ ...reference, base64: content.toString("base64") });
      }
    }
    observations.push({
      sourceId: evidence.sourceId,
      evidenceId: evidence.id,
      observedAt: evidence.observedAt,
      assets,
    });
  }
  return observations;
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

function sourceVersions(snapshot: BenchmarkSnapshot): ContentEntityVersionRef[] {
  const versions: ContentEntityVersionRef[] = [];
  const sources = new Set<string>();
  for (const evidence of snapshot.evidence) {
    if (!sources.has(evidence.sourceId)) {
      const source = snapshot.sources.find((candidate) => candidate.id === evidence.sourceId)!;
      versions.push({ entityType: "source", id: source.id, version: source.version });
      sources.add(source.id);
    }
    versions.push({ entityType: "evidence", id: evidence.id, version: evidence.version });
  }
  if (snapshot.diff) {
    versions.push({ entityType: "competitor_diff", id: snapshot.diff.id, version: snapshot.diff.version });
  }
  return versions;
}

export class BenchmarkService {
  private readonly commands: CommandPipeline;

  constructor(
    private readonly store: Store,
    clock: Clock,
    ids: IdGenerator,
    private readonly artifacts: ArtifactStore = new ArtifactStore(),
    private readonly provider: BenchmarkReverseProvider = new McpBenchmarkReverseProvider(),
  ) {
    this.commands = new AuditableCommandPipeline(store, clock, ids);
  }

  async reverse(command: Command<ReverseBenchmark>): Promise<BenchmarkAnalysis> {
    validateReverseInput(command.input);
    let prepared: PreparedBenchmark | undefined;
    const prepare = async (): Promise<void> => {
      prepared = undefined;
      const snapshot = await this.store.transaction((repos) => loadSnapshot(repos, command.input));
      const observations = await readObservations(this.artifacts, snapshot);
      const inputHash = computeBenchmarkReverseInputHash(command.input.modality, observations);
      const rawResponse = await this.provider.reverse({
        modality: command.input.modality,
        observations,
        inputHash,
      });
      const response = this.validateResponse(rawResponse, observations, inputHash, command.input.modality);
      const externalTexts = snapshot.evidence.flatMap((record, index) => {
        const source = snapshot.sources.find((candidate) => candidate.id === record.sourceId)!;
        return source.ownership === "external_public"
          ? observations[index]!.assets.filter((asset) => TEXT_KINDS.includes(asset.kind as (typeof TEXT_KINDS)[number]))
            .map((asset) => asset.text!)
          : [];
      });
      for (const method of response.methods) {
        if (containsExternalCopy(method.pattern, externalTexts) ||
            containsExternalCopy(method.transferableRule, externalTexts)) {
          invalid("Provider pattern or rule contains an exact external-public source-text run of at least 40 Unicode code points");
        }
      }
      prepared = { snapshot, observations, response, inputHash };
    };
    return this.commands.executeBatch({
      workspaceId: command.input.workspaceId,
      action: "benchmark.reverse.create",
      entityType: "benchmark_analysis",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        if (!prepared) throw new Error("Benchmark preparation did not complete");
        const current = await loadSnapshot(repos, input);
        if (canonicalJson(current) !== canonicalJson(prepared.snapshot)) {
          conflict("Benchmark Source, Evidence, or CompetitorDiff changed before commit");
        }
        const analysis = createBenchmarkAnalysis({
          id: input.id,
          workspaceId: input.workspaceId,
          createdAt: timestamp,
          modality: input.modality,
          status: prepared.response.gaps.length > 0 ? "partial" : "completed",
          methods: prepared.response.methods,
          gaps: prepared.response.gaps,
          evidenceIds: [...input.evidenceIds],
          competitorDiffId: input.competitorDiffId ?? null,
          sourceVersions: sourceVersions(current),
          provider: {
            type: "mcp",
            tool: "reverse_engineer",
            toolVersion: prepared.response.toolVersion,
            inputHash: prepared.inputHash,
            analysisMethod: prepared.response.analysisMethod,
            humanReview: "not_performed",
          },
        });
        return repos.benchmarkAnalyses.insert(analysis) as Promise<BenchmarkAnalysis>;
      },
    }, prepare);
  }

  async get(query: GetBenchmarkAnalysis): Promise<BenchmarkAnalysis> {
    assertRecord(query, "GetBenchmarkAnalysis", ["id", "workspaceId"]);
    if (typeof query.id !== "string" || query.id.trim().length === 0 ||
        typeof query.workspaceId !== "string" || query.workspaceId.trim().length === 0) {
      invalid("id and workspaceId must not be empty");
    }
    return this.store.transaction(async (repos) => {
      const analysis = await repos.benchmarkAnalyses.get(query.id, query.workspaceId);
      if (!analysis) {
        throw new DomainError("NOT_FOUND", "Benchmark analysis not found in workspace", false, {
          id: query.id, workspaceId: query.workspaceId,
        });
      }
      return analysis;
    });
  }

  private validateResponse(
    response: BenchmarkReverseProviderResponse,
    observations: BenchmarkObservation[],
    inputHash: string,
    modality: "image" | "video",
  ): BenchmarkReverseProviderResponse {
    assertRecord(response, "Benchmark provider response", [
      "inputHash", "analysisMethod", "toolVersion", "methods", "gaps",
    ]);
    if (response.inputHash !== inputHash || typeof response.analysisMethod !== "string" ||
        response.analysisMethod.trim().length === 0 || response.analysisMethod.length > 256 ||
        typeof response.toolVersion !== "string" || response.toolVersion.trim().length === 0 ||
        response.toolVersion.length > 256 || !Array.isArray(response.methods) ||
        response.methods.length > BENCHMARK_REVERSE_LIMITS.maxMethods || !Array.isArray(response.gaps) ||
        response.gaps.length > 20) {
      throw benchmarkReverseCapabilityGap("mcp_invalid_response", "Benchmark provider returned an invalid bounded response");
    }
    const supplied = new Map(observations.flatMap((observation) => observation.assets.map((asset) => [
      canonicalJson([asset.sourceId, asset.evidenceId, asset.assetId, asset.kind]), asset,
    ] as const)));
    const methods = response.methods.map((method): BenchmarkMethod => {
      assertRecord(method, "Benchmark provider method", [
        "id", "dimension", "pattern", "transferableRule", "basis", "confidence", "evidenceAssetRefs",
      ]);
      if (!Array.isArray(method.evidenceAssetRefs) || method.evidenceAssetRefs.length < 1 ||
          method.evidenceAssetRefs.length > 100) {
        throw benchmarkReverseCapabilityGap("mcp_invalid_response", "Benchmark provider method refs are invalid");
      }
      const refs = method.evidenceAssetRefs.map((ref) => {
        assertRecord(ref, "Benchmark provider ref", [
          "sourceId", "evidenceId", "assetId", "kind", "observedAt", "contentHash", "byteLength",
        ]);
        const asset = supplied.get(canonicalJson([ref.sourceId, ref.evidenceId, ref.assetId, ref.kind]));
        if (!asset) {
          throw benchmarkReverseCapabilityGap("mcp_invalid_response", "Benchmark provider returned an invented Evidence ref");
        }
        return {
          sourceId: asset.sourceId,
          evidenceId: asset.evidenceId,
          assetId: asset.assetId,
          kind: asset.kind,
          observedAt: asset.observedAt,
          contentHash: asset.contentHash,
          byteLength: asset.byteLength,
        };
      });
      return { ...method, evidenceAssetRefs: refs };
    });
    if (modality === "video" && !methods.some((method) =>
      method.basis === "video_frames_and_asr" &&
      method.evidenceAssetRefs.some((ref) => ref.kind === "video_frames") &&
      method.evidenceAssetRefs.some((ref) => ref.kind === "asr_transcript")
    )) {
      throw benchmarkReverseCapabilityGap(
        "video_understanding_missing",
        "Benchmark provider did not declare video frame and ASR understanding",
      );
    }
    return { inputHash, analysisMethod: response.analysisMethod, toolVersion: response.toolVersion, methods, gaps: response.gaps };
  }
}

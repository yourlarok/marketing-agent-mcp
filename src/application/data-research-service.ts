import {
  DATASET_FIELD_TYPES,
  PARSED_ISSUE_CODES,
  QUESTION_TYPES,
  createDataQualityReports,
  planDataRequestRound,
  type DataQualityReport,
  type DataRequestPlanDetails,
  type QuestionType,
} from "../domain/data-preparation.js";
import type {
  DataRequestPlan,
  IngestionBatch,
  IngestionFileFailure,
} from "../domain/data-research-model.js";
import { DomainError } from "../domain/errors.js";
import type { Dataset, Evidence, Source } from "../domain/model.js";
import { ArtifactStore, type StoredArtifact } from "../infrastructure/artifact-store.js";
import {
  DEFAULT_INGEST_LIMITS,
  MAX_BATCH_JSONL_BYTES,
  ingestFileWithOriginal,
  type ParsedDataset,
} from "../infrastructure/file-ingestor.js";
import {
  AuditableCommandPipeline,
  type Command,
  type CommandPipeline,
} from "./commands.js";
import type {
  CreateDataRequestPlan,
  DeclineDataRound,
  EvidenceAssetContent,
  EvidenceAssetQuery,
  ImportFiles,
  ReconcileDataRequestPlan,
} from "./data-research-commands.js";
import type {
  Clock,
  IdGenerator,
  Repositories,
  Store,
} from "./ports.js";

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${field} must not be empty`);
  }
}

function assertQuestionType(value: unknown): asserts value is QuestionType {
  if (typeof value !== "string" || !(QUESTION_TYPES as readonly string[]).includes(value)) {
    invalid("questionType must be a supported question type");
  }
}

function assertBatch(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("batch must be an object");
  }
  const datasets = (value as { datasets?: unknown }).datasets;
  if (!Array.isArray(datasets)) {
    invalid("batch.datasets must be an array");
  }
  for (const dataset of datasets) {
    if (dataset === null || typeof dataset !== "object" || Array.isArray(dataset)) {
      invalid("batch datasets must be objects");
    }
    const candidate = dataset as Record<string, unknown>;
    if (candidate.source === null || typeof candidate.source !== "object" || Array.isArray(candidate.source)) {
      invalid("dataset.source must be an object");
    }
    const source = candidate.source as Record<string, unknown>;
    assertNonEmptyString(source.path, "dataset.source.path");
    assertNonEmptyString(source.fileName, "dataset.source.fileName");
    if (source.format !== "csv" && source.format !== "xlsx") {
      invalid("dataset.source.format must be csv or xlsx");
    }
    if (!Number.isSafeInteger(source.sizeBytes) || (source.sizeBytes as number) < 0) {
      invalid("dataset.source.sizeBytes must be a non-negative integer");
    }
    if (source.sheetName !== undefined) {
      assertNonEmptyString(source.sheetName, "dataset.source.sheetName");
    }
    if (typeof candidate.rowsJsonl !== "string" || !Array.isArray(candidate.fields) || !Array.isArray(candidate.issues)) {
      invalid("dataset fields, rowsJsonl, and issues are required");
    }
    for (const field of candidate.fields) {
      if (field === null || typeof field !== "object" || Array.isArray(field)) {
        invalid("dataset fields must be objects");
      }
      const definition = field as Record<string, unknown>;
      assertNonEmptyString(definition.name, "dataset field name");
      if (
        typeof definition.inferredType !== "string" ||
        !(DATASET_FIELD_TYPES as readonly string[]).includes(definition.inferredType)
      ) {
        invalid("dataset field inferredType is not supported");
      }
      if (!Number.isSafeInteger(definition.index) || (definition.index as number) < 0) {
        invalid("dataset field index must be a non-negative integer");
      }
    }
    if (candidate.quality === null || typeof candidate.quality !== "object" || Array.isArray(candidate.quality)) {
      invalid("dataset.quality must be an object");
    }
    const quality = candidate.quality as Record<string, unknown>;
    for (const field of ["rowCount", "columnCount", "duplicateRowCount", "emptyRowCount", "typeInconsistencyCount"]) {
      if (!Number.isSafeInteger(quality[field]) || (quality[field] as number) < 0) {
        invalid(`dataset.quality.${field} must be a non-negative integer`);
      }
    }
    for (const issue of candidate.issues) {
      if (issue === null || typeof issue !== "object" || Array.isArray(issue)) {
        invalid("dataset issues must be objects");
      }
      const detail = issue as Record<string, unknown>;
      if (typeof detail.code !== "string" || !(PARSED_ISSUE_CODES as readonly string[]).includes(detail.code)) {
        invalid("dataset issue code is not supported");
      }
      assertNonEmptyString(detail.message, "dataset issue message");
      for (const field of ["rowNumber", "columnNumber"]) {
        if (
          detail[field] !== undefined &&
          (!Number.isSafeInteger(detail[field]) || (detail[field] as number) <= 0)
        ) {
          invalid(`dataset issue ${field} must be a positive integer or undefined`);
        }
      }
    }
  }
}

async function requireWorkspace(repos: Repositories, workspaceId: string): Promise<void> {
  if (!(await repos.workspaces.get(workspaceId, workspaceId))) {
    throw new DomainError("NOT_FOUND", "Workspace not found", false, { workspaceId });
  }
}

function requirePlanDetails(plan: DataRequestPlan): DataRequestPlan & DataRequestPlanDetails {
  if (
    typeof plan.objective !== "string" ||
    !Array.isArray(plan.questionTypes) ||
    !Array.isArray(plan.availableFields) ||
    !Array.isArray(plan.answerableQuestionTypes) ||
    !Array.isArray(plan.declinedQuestionTypes) ||
    !Array.isArray(plan.limitations) ||
    !Array.isArray(plan.qualityReports) ||
    !Array.isArray(plan.rounds)
  ) {
    throw new DomainError("CONFLICT", "Data request plan is not a guided plan", false, { id: plan.id });
  }
  return plan as DataRequestPlan & DataRequestPlanDetails;
}

interface PreparedDataset {
  parsed: ParsedDataset;
  normalized: StoredArtifact;
  quality: StoredArtifact;
  qualityReport: DataQualityReport;
}

interface PreparedFile {
  source: ParsedDataset["source"];
  original: StoredArtifact;
  datasets: PreparedDataset[];
}

export class DataResearchService {
  private readonly commands: CommandPipeline;

  constructor(
    private readonly store: Store,
    clock: Clock,
    private readonly ids: IdGenerator,
    private readonly artifacts: ArtifactStore = new ArtifactStore(),
  ) {
    this.commands = new AuditableCommandPipeline(store, clock, ids);
  }

  async importFiles(command: Command<ImportFiles>): Promise<IngestionBatch> {
    const input = command.input;
    if (!Array.isArray(input.paths) || input.paths.length === 0) {
      invalid("paths must be a non-empty array");
    }
    for (const path of input.paths) {
      assertNonEmptyString(path, "paths");
    }
    if ((input.planId === undefined) !== (input.expectedPlanVersion === undefined)) {
      invalid("planId and expectedPlanVersion must be provided together");
    }
    if (input.planId !== undefined) {
      assertNonEmptyString(input.planId, "planId");
      if (!Number.isInteger(input.expectedPlanVersion) || input.expectedPlanVersion! < 1) {
        invalid("expectedPlanVersion must be a positive integer");
      }
    }
    if (
      input.freshness !== undefined &&
      (input.freshness === null || typeof input.freshness !== "object" || Array.isArray(input.freshness))
    ) {
      invalid("freshness must be an object");
    }

    const limits = input.limits ?? {};
    for (const key of ["maxFileBytes", "maxFiles", "maxRows", "maxColumns"] as const) {
      const requested = limits[key];
      if (requested !== undefined && (!Number.isSafeInteger(requested) || requested <= 0)) {
        throw new Error(`${key} must be a positive integer`);
      }
    }
    const maxFiles = Math.min(
      DEFAULT_INGEST_LIMITS.maxFiles,
      limits.maxFiles ?? DEFAULT_INGEST_LIMITS.maxFiles,
    );
    if (input.paths.length > maxFiles) {
      throw new Error(`Import exceeds ${maxFiles === DEFAULT_INGEST_LIMITS.maxFiles ? "100 files" : "file limit"}`);
    }
    const maxRows = Math.min(
      DEFAULT_INGEST_LIMITS.maxRows,
      limits.maxRows ?? DEFAULT_INGEST_LIMITS.maxRows,
    );
    let files: PreparedFile[] = [];
    let failures: IngestionFileFailure[] = [];
    const prepare = async (): Promise<void> => {
      let remainingRows = maxRows;
      let jsonlBytes = 0;
      files = [];
      failures = [];
      for (const path of input.paths) {
        try {
          const parsed = await ingestFileWithOriginal(path, {
            ...limits,
            maxRows: Math.max(1, remainingRows),
          });
          const rowCount = parsed.datasets.reduce((sum, dataset) => sum + dataset.quality.rowCount, 0);
          if (rowCount > remainingRows) {
            throw new Error(`Import exceeds ${maxRows === DEFAULT_INGEST_LIMITS.maxRows ? "100000 rows" : "row limit"}`);
          }
          const parsedBytes = parsed.datasets.reduce(
            (sum, dataset) => sum + Buffer.byteLength(dataset.rowsJsonl),
            0,
          );
          if (jsonlBytes + parsedBytes > MAX_BATCH_JSONL_BYTES) {
            throw new Error("Batch exceeds 100 MiB normalized JSONL limit");
          }
          const first = parsed.datasets[0];
          if (!first) {
            throw new Error(`Import contains no datasets: ${path}`);
          }
          const original = await this.artifacts.put(parsed.original);
          const qualityReports = createDataQualityReports(parsed, input.freshness);
          const datasets: PreparedDataset[] = [];
          for (let index = 0; index < parsed.datasets.length; index += 1) {
            const dataset = parsed.datasets[index]!;
            const qualityReport = qualityReports[index]!;
            const [normalized, quality] = await Promise.all([
              this.artifacts.put(Buffer.from(dataset.rowsJsonl)),
              this.artifacts.put(Buffer.from(JSON.stringify(qualityReport))),
            ]);
            datasets.push({ parsed: dataset, normalized, quality, qualityReport });
          }
          files.push({ source: first.source, original, datasets });
          remainingRows -= rowCount;
          jsonlBytes += parsedBytes;
        } catch (error) {
          failures.push({
            path,
            message: error instanceof Error ? error.message : "File import failed",
          });
        }
      }
    };

    return this.commands.executeBatch({
      workspaceId: input.workspaceId,
      action: "ingestion_batch.import",
      entityType: "ingestion_batch",
      input,
      context: command.context,
      write: async (repos, _input, timestamp) => {
        await requireWorkspace(repos, input.workspaceId);
        const sourceIds: string[] = [];
        const datasetIds: string[] = [];
        const evidenceIds: string[] = [];
        for (const file of files) {
          const { sheetName: _sheetName, ...sourceMetadata } = file.source;
          const source: Source = {
            id: this.ids.next(),
            workspaceId: input.workspaceId,
            version: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
            name: file.source.fileName,
            type: "file",
            ownership: "owned",
            metadata: {
              ...sourceMetadata,
              originalContentHash: file.original.contentHash,
              originalByteLength: file.original.byteLength,
            },
          };
          await repos.sources.insert(source);
          sourceIds.push(source.id);
          for (const prepared of file.datasets) {
            const { parsed } = prepared;
            const dataset: Dataset = {
              id: this.ids.next(),
              workspaceId: input.workspaceId,
              version: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
              sourceId: source.id,
              name: `${parsed.source.fileName}${parsed.source.sheetName ? `#${parsed.source.sheetName}` : ""}`,
              coverageStart: timestamp,
              coverageEnd: timestamp,
              fieldDefinitions: parsed.fields.map((field) => ({ ...field })),
              metricDefinitions: [],
              limitations: parsed.issues.map((issue) => issue.message),
              quality: { ...parsed.quality },
            };
            await repos.datasets.insert(dataset);
            datasetIds.push(dataset.id);
            const evidence: Evidence = {
              id: this.ids.next(),
              workspaceId: input.workspaceId,
              version: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
              sourceId: source.id,
              sourceLocator: `${parsed.source.path}${parsed.source.sheetName ? `#${parsed.source.sheetName}` : ""}`,
              observedAt: timestamp,
              summary: `Imported ${dataset.name}`,
              contentHash: prepared.normalized.contentHash,
              classification: "owned_operating",
              assets: [
                { id: this.ids.next(), kind: "original", ...file.original },
                { id: this.ids.next(), kind: "normalized_jsonl", ...prepared.normalized },
                { id: this.ids.next(), kind: "quality_report", ...prepared.quality },
              ],
            };
            await repos.evidence.insert(evidence);
            evidenceIds.push(evidence.id);
          }
        }

        if (input.planId !== undefined && files.length > 0) {
          const stored = await repos.dataRequestPlans.get(input.planId, input.workspaceId);
          if (!stored) {
            throw new DomainError("NOT_FOUND", "Data request plan not found in workspace", false, {
              planId: input.planId,
              workspaceId: input.workspaceId,
            });
          }
          const current = requirePlanDetails(stored);
          if (current.version !== input.expectedPlanVersion) {
            throw new DomainError("CONFLICT", "Data request plan version does not match", false, {
              planId: input.planId,
            });
          }
          const importedFields = files.flatMap((file) =>
            file.datasets.flatMap((dataset) => dataset.parsed.fields.map((field) => field.name))
          );
          const availableFields = [...new Set([...current.availableFields, ...importedFields])];
          const planned = planDataRequestRound(
            current.questionTypes,
            availableFields,
            current.declinedQuestionTypes,
          );
          const round = current.round + 1;
          await repos.dataRequestPlans.update({
            ...current,
            ...planned,
            availableFields,
            qualityReports: [
              ...current.qualityReports,
              ...files.flatMap((file) => file.datasets.map((dataset) => dataset.qualityReport)),
            ],
            round,
            updatedAt: timestamp,
            rounds: [...current.rounds, { round, ...planned }],
          }, input.expectedPlanVersion!);
        }

        const batch: IngestionBatch = {
          id: input.id,
          workspaceId: input.workspaceId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          state: failures.length === 0 ? "completed" : files.length === 0 ? "blocked" : "partial",
          sourceIds,
          datasetIds,
          evidenceIds,
          failures,
        };
        return repos.ingestionBatches.insert(batch) as Promise<IngestionBatch>;
      },
    }, prepare);
  }

  async getEvidenceAsset(query: EvidenceAssetQuery): Promise<EvidenceAssetContent> {
    assertNonEmptyString(query.workspaceId, "workspaceId");
    assertNonEmptyString(query.evidenceId, "evidenceId");
    assertNonEmptyString(query.assetId, "assetId");
    const evidence = await this.store.transaction(async (repos) =>
      repos.evidence.get(query.evidenceId, query.workspaceId) as Promise<Evidence | undefined>
    );
    const asset = evidence?.assets?.find((candidate) => candidate.id === query.assetId);
    if (!evidence || !asset) {
      throw new DomainError("NOT_FOUND", "Evidence asset not found in workspace", false, {
        workspaceId: query.workspaceId,
        evidenceId: query.evidenceId,
        assetId: query.assetId,
      });
    }
    const content = await this.artifacts.read(asset.contentHash);
    if (content.length !== asset.byteLength) {
      throw new DomainError("CONFLICT", "Evidence artifact length does not match");
    }
    return { ...asset, content };
  }

  planDataRequests(command: Command<CreateDataRequestPlan>): Promise<DataRequestPlan> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "data_request_plan.create",
      entityType: "data_request_plan",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        assertNonEmptyString(input.objective, "objective");
        assertBatch(input.batch);
        if (
          input.freshness !== undefined &&
          (input.freshness === null || typeof input.freshness !== "object" || Array.isArray(input.freshness))
        ) {
          invalid("freshness must be an object");
        }
        await requireWorkspace(repos, input.workspaceId);
        const planned = planDataRequestRound(input.questionTypes, input.availableFields);
        const qualityReports = input.batch
          ? createDataQualityReports(input.batch, input.freshness)
          : [];
        const plan: DataRequestPlan = {
          id: input.id,
          workspaceId: input.workspaceId,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          objective: input.objective,
          questionTypes: [...input.questionTypes],
          availableFields: [...input.availableFields],
          ...planned,
          round: 1,
          declinedQuestionTypes: [],
          limitations: [],
          qualityReports,
          rounds: [{ round: 1, ...planned }],
        };
        return repos.dataRequestPlans.insert(plan) as Promise<DataRequestPlan>;
      },
    });
  }

  reconcileDataRequests(command: Command<ReconcileDataRequestPlan>): Promise<DataRequestPlan> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "data_request_plan.reconcile",
      entityType: "data_request_plan",
      input: { ...command.input, id: command.input.planId },
      context: command.context,
      write: async (repos, rawInput, timestamp) => {
        const input = rawInput as ReconcileDataRequestPlan & { id: string };
        if (!Number.isInteger(input.expectedPlanVersion) || input.expectedPlanVersion < 1) {
          invalid("expectedPlanVersion must be a positive integer");
        }
        assertBatch(input.batch);
        if (
          input.freshness !== undefined &&
          (input.freshness === null || typeof input.freshness !== "object" || Array.isArray(input.freshness))
        ) {
          invalid("freshness must be an object");
        }
        await requireWorkspace(repos, input.workspaceId);
        const stored = await repos.dataRequestPlans.get(input.planId, input.workspaceId);
        if (!stored) {
          throw new DomainError("NOT_FOUND", "Data request plan not found in workspace", false, {
            planId: input.planId,
            workspaceId: input.workspaceId,
          });
        }
        const current = requirePlanDetails(stored);
        if (current.version !== input.expectedPlanVersion) {
          throw new DomainError("CONFLICT", "Data request plan version does not match", false, {
            planId: input.planId,
          });
        }
        const availableFields = [...new Set([...current.availableFields, ...input.availableFields])];
        const planned = planDataRequestRound(
          current.questionTypes,
          availableFields,
          current.declinedQuestionTypes,
        );
        const qualityReports = input.batch
          ? [...current.qualityReports, ...createDataQualityReports(input.batch, input.freshness)]
          : current.qualityReports;
        const round = current.round + 1;
        const updated: DataRequestPlan = {
          ...current,
          ...planned,
          availableFields,
          qualityReports,
          round,
          updatedAt: timestamp,
          rounds: [...current.rounds, { round, ...planned }],
        };
        return repos.dataRequestPlans.update(updated, input.expectedPlanVersion) as Promise<DataRequestPlan>;
      },
    });
  }

  declineDataRound(command: Command<DeclineDataRound>): Promise<DataRequestPlan> {
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "data_request_plan.decline",
      entityType: "data_request_plan",
      input: { ...command.input, id: command.input.planId },
      context: command.context,
      write: async (repos, rawInput, timestamp) => {
        const input = rawInput as DeclineDataRound & { id: string };
        assertQuestionType(input.questionType);
        assertNonEmptyString(input.reason, "reason");
        if (!Number.isInteger(input.expectedPlanVersion) || input.expectedPlanVersion < 1) {
          invalid("expectedPlanVersion must be a positive integer");
        }
        await requireWorkspace(repos, input.workspaceId);
        const stored = await repos.dataRequestPlans.get(input.planId, input.workspaceId);
        if (!stored) {
          throw new DomainError("NOT_FOUND", "Data request plan not found in workspace", false, {
            planId: input.planId,
            workspaceId: input.workspaceId,
          });
        }
        const current = requirePlanDetails(stored);
        if (current.version !== input.expectedPlanVersion) {
          throw new DomainError("CONFLICT", "Data request plan version does not match", false, {
            planId: input.planId,
          });
        }
        if (
          !current.questionTypes.includes(input.questionType) ||
          current.declinedQuestionTypes.includes(input.questionType)
        ) {
          throw new DomainError("CONFLICT", "Only an active plan question can be declined", false, {
            planId: input.planId,
          });
        }
        const declinedQuestionTypes = [...current.declinedQuestionTypes, input.questionType];
        const planned = planDataRequestRound(
          current.questionTypes,
          current.availableFields,
          declinedQuestionTypes,
        );
        const limitation = `${input.questionType}: ${input.reason.trim()}`;
        const round = current.round + 1;
        const updated: DataRequestPlan = {
          ...current,
          ...planned,
          round,
          declinedQuestionTypes,
          limitations: [...current.limitations, limitation],
          updatedAt: timestamp,
          rounds: [...current.rounds, {
            round,
            ...planned,
            declinedQuestionType: input.questionType,
            limitation,
          }],
        };
        return repos.dataRequestPlans.update(updated, input.expectedPlanVersion) as Promise<DataRequestPlan>;
      },
    });
  }
}

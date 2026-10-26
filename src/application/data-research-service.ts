import {
  DATASET_FIELD_TYPES,
  PARSED_ISSUE_CODES,
  QUESTION_TYPES,
  createDataQualityReports,
  planDataRequestRound,
  type DataRequestPlanDetails,
  type QuestionType,
} from "../domain/data-preparation.js";
import type { DataRequestPlan } from "../domain/data-research-model.js";
import { DomainError } from "../domain/errors.js";
import {
  AuditableCommandPipeline,
  type Command,
  type CommandPipeline,
} from "./commands.js";
import type {
  CreateDataRequestPlan,
  DeclineDataRound,
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

export class DataResearchService {
  private readonly commands: CommandPipeline;

  constructor(
    private readonly store: Store,
    clock: Clock,
    ids: IdGenerator,
  ) {
    this.commands = new AuditableCommandPipeline(store, clock, ids);
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

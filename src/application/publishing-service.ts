import { createHash } from "node:crypto";
import { assertRecord, assertUtcInstant } from "../domain/contract-validation.js";
import type { AssetVersion, ContentChannel } from "../domain/content-production-model.js";
import { DomainError } from "../domain/errors.js";
import {
  createApproval,
  createPublication,
  createSchedule,
  type Approval,
  type Publication,
  type Schedule,
} from "../domain/publishing-model.js";
import { ArtifactStore } from "../infrastructure/artifact-store.js";
import { canonicalJson } from "../infrastructure/sqlite.js";
import {
  AuditableCommandPipeline,
  type Command,
  type CommandPipeline,
} from "./commands.js";
import { requireWorkspace } from "./marketing-service.js";
import type { Clock, IdGenerator, Repositories, Store } from "./ports.js";
import type {
  CancelSchedule,
  CreateSchedule,
  GetApproval,
  GetSchedule,
  RecordApproval,
  Reschedule,
} from "./publishing-commands.js";

const VALIDATION_TIME = "1970-01-01T00:00:00.000Z";
const RECORD_APPROVAL_KEYS = [
  "id", "workspaceId", "assetVersionId", "expectedAssetVersion", "decision", "comment",
] as const;
const CREATE_SCHEDULE_KEYS = [
  "id", "publicationId", "workspaceId", "assetVersionId", "expectedAssetVersion", "approvalId",
  "channel", "accountId", "scheduledFor", "timeZone", "deliveryMode",
] as const;
const RESCHEDULE_KEYS = ["id", "workspaceId", "expectedVersion", "scheduledFor", "timeZone"] as const;
const CANCEL_SCHEDULE_KEYS = ["id", "workspaceId", "expectedVersion"] as const;
const GET_KEYS = ["id", "workspaceId"] as const;

export interface PublishingProviderConfiguration {
  isConfigured(channel: ContentChannel, accountId: string): boolean;
}

export interface PublicationOperationIdentity {
  workspaceId: string;
  scheduleId: string;
  assetVersionId: string;
  assetVersion: number;
  artifactHash: string;
  channel: ContentChannel;
  accountId: string;
}

interface ScheduleSnapshot {
  asset: AssetVersion;
  approval: Approval;
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
    invalid(`${field} must be a positive safe integer`);
  }
}

function assertScheduleTimeSyntax(scheduledFor: string, timeZone: string): void {
  assertUtcInstant(scheduledFor, "scheduledFor");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    invalid("timeZone must be a bounded IANA time zone");
  }
}

function assertFutureTime(scheduledFor: string, now: string): void {
  assertUtcInstant(now, "clock now");
  if (Date.parse(scheduledFor) <= Date.parse(now)) {
    invalid("scheduledFor must be in the future");
  }
}

function validateApprovalInput(input: RecordApproval): void {
  assertRecord(input, "RecordApproval", RECORD_APPROVAL_KEYS);
  positiveVersion(input.expectedAssetVersion, "expectedAssetVersion");
  createApproval({
    id: input.id,
    workspaceId: input.workspaceId,
    createdAt: VALIDATION_TIME,
    assetVersionId: input.assetVersionId,
    assetVersion: input.expectedAssetVersion,
    artifactHash: "0".repeat(64),
    decision: input.decision,
    reviewer: { actor: "validation", attestation: "human_attested" },
    comment: input.comment,
    decidedAt: VALIDATION_TIME,
  });
}

function validateCreateScheduleInput(input: CreateSchedule): void {
  assertRecord(input, "CreateSchedule", CREATE_SCHEDULE_KEYS);
  positiveVersion(input.expectedAssetVersion, "expectedAssetVersion");
  createSchedule({
    id: input.id,
    workspaceId: input.workspaceId,
    createdAt: VALIDATION_TIME,
    assetVersionId: input.assetVersionId,
    assetVersion: input.expectedAssetVersion,
    approvalId: input.approvalId,
    channel: input.channel,
    accountId: input.accountId,
    scheduledFor: input.scheduledFor,
    timeZone: input.timeZone,
    deliveryMode: input.deliveryMode,
    status: "scheduled",
  });
  createPublication({
    id: input.publicationId,
    workspaceId: input.workspaceId,
    createdAt: VALIDATION_TIME,
    scheduleId: input.id,
    scheduleVersion: 1,
    assetVersionId: input.assetVersionId,
    assetVersion: input.expectedAssetVersion,
    approvalId: input.approvalId,
    artifactHash: "0".repeat(64),
    operationKey: `publish:v1:${"0".repeat(64)}`,
    channel: input.channel,
    accountId: input.accountId,
    deliveryMode: input.deliveryMode,
    status: "pending",
    attempts: [],
    receipts: [],
    failure: null,
    delivery: null,
    verification: null,
  });
  assertScheduleTimeSyntax(input.scheduledFor, input.timeZone);
}

async function requireAsset(
  repos: Repositories,
  input: Pick<RecordApproval, "workspaceId" | "assetVersionId" | "expectedAssetVersion">,
): Promise<AssetVersion> {
  await requireWorkspace(repos, input.workspaceId);
  const asset = await repos.assetVersions.get(input.assetVersionId, input.workspaceId);
  if (!asset) {
    notFound("AssetVersion not found in workspace", {
      assetVersionId: input.assetVersionId,
      workspaceId: input.workspaceId,
    });
  }
  if (asset.version !== input.expectedAssetVersion) {
    conflict("AssetVersion does not match expectedAssetVersion");
  }
  return asset;
}

async function loadScheduleSnapshot(repos: Repositories, input: CreateSchedule): Promise<ScheduleSnapshot> {
  const asset = await requireAsset(repos, input);
  const approval = await repos.approvals.get(input.approvalId, input.workspaceId);
  if (!approval) {
    notFound("Approval not found in workspace", {
      approvalId: input.approvalId,
      workspaceId: input.workspaceId,
    });
  }
  if (
    approval.decision !== "approved" ||
    approval.assetVersionId !== asset.id ||
    approval.assetVersion !== asset.version ||
    approval.artifactHash !== asset.artifact.contentHash
  ) {
    conflict("Schedule requires an approved exact AssetVersion and artifact hash");
  }
  if (input.channel !== asset.channel) {
    conflict("Schedule channel must exactly match the AssetVersion channel");
  }
  return { asset, approval };
}

async function requireSchedule(repos: Repositories, input: { id: string; workspaceId: string }): Promise<Schedule> {
  const schedule = await repos.schedules.get(input.id, input.workspaceId);
  if (!schedule) {
    notFound("Schedule not found in workspace", { id: input.id, workspaceId: input.workspaceId });
  }
  return schedule;
}

export function publicationOperationKey(identity: PublicationOperationIdentity): string {
  const canonicalIdentity = canonicalJson({
    workspaceId: identity.workspaceId,
    scheduleId: identity.scheduleId,
    assetVersionId: identity.assetVersionId,
    assetVersion: identity.assetVersion,
    artifactHash: identity.artifactHash,
    channel: identity.channel,
    accountId: identity.accountId,
  });
  return `publish:v1:${createHash("sha256").update(canonicalIdentity).digest("hex")}`;
}

export class PublishingService {
  private readonly commands: CommandPipeline;

  constructor(
    private readonly store: Store,
    clock: Clock,
    ids: IdGenerator,
    private readonly artifacts: ArtifactStore = new ArtifactStore(),
    private readonly providerConfiguration: PublishingProviderConfiguration = { isConfigured: () => false },
  ) {
    this.commands = new AuditableCommandPipeline(store, clock, ids);
  }

  async recordApproval(command: Command<RecordApproval>): Promise<Approval> {
    validateApprovalInput(command.input);
    let prepared: AssetVersion | undefined;
    const prepare = async (): Promise<void> => {
      prepared = undefined;
      const asset = await this.store.transaction((repos) => requireAsset(repos, command.input));
      await this.readActualArtifact(asset);
      prepared = asset;
    };
    return this.commands.executeBatch({
      workspaceId: command.input.workspaceId,
      action: "approval.record",
      entityType: "approval",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        if (!prepared) throw new Error("Approval preparation did not complete");
        const current = await requireAsset(repos, input);
        if (canonicalJson(current) !== canonicalJson(prepared)) {
          conflict("AssetVersion changed before approval commit");
        }
        const approval = createApproval({
          id: input.id,
          workspaceId: input.workspaceId,
          createdAt: timestamp,
          assetVersionId: current.id,
          assetVersion: current.version,
          artifactHash: current.artifact.contentHash,
          decision: input.decision,
          reviewer: { actor: command.context.actor, attestation: "human_attested" },
          comment: input.comment,
          decidedAt: timestamp,
        });
        return repos.approvals.insert(approval);
      },
    }, prepare);
  }

  async getApproval(query: GetApproval): Promise<Approval> {
    assertRecord(query, "GetApproval", GET_KEYS);
    return this.store.transaction(async (repos) => {
      const approval = await repos.approvals.get(query.id, query.workspaceId);
      if (!approval) notFound("Approval not found in workspace", { id: query.id, workspaceId: query.workspaceId });
      return approval;
    });
  }

  async createSchedule(command: Command<CreateSchedule>): Promise<Schedule> {
    validateCreateScheduleInput(command.input);
    let prepared: ScheduleSnapshot | undefined;
    const prepare = async (): Promise<void> => {
      prepared = undefined;
      const snapshot = await this.store.transaction((repos) => loadScheduleSnapshot(repos, command.input));
      this.assertProviderConfiguration(command.input);
      await this.readActualArtifact(snapshot.asset);
      prepared = snapshot;
    };
    return this.commands.executeBatch({
      workspaceId: command.input.workspaceId,
      action: "schedule.create",
      entityType: "schedule",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        if (!prepared) throw new Error("Schedule preparation did not complete");
        assertFutureTime(input.scheduledFor, timestamp);
        const current = await loadScheduleSnapshot(repos, input);
        this.assertProviderConfiguration(input);
        if (canonicalJson(current) !== canonicalJson(prepared)) {
          conflict("AssetVersion or Approval changed before schedule commit");
        }
        const schedule = createSchedule({
          id: input.id,
          workspaceId: input.workspaceId,
          createdAt: timestamp,
          assetVersionId: current.asset.id,
          assetVersion: current.asset.version,
          approvalId: current.approval.id,
          channel: input.channel,
          accountId: input.accountId,
          scheduledFor: input.scheduledFor,
          timeZone: input.timeZone,
          deliveryMode: input.deliveryMode,
          status: "scheduled",
        });
        await repos.schedules.insert(schedule);
        const publication = createPublication({
          id: input.publicationId,
          workspaceId: input.workspaceId,
          createdAt: timestamp,
          scheduleId: schedule.id,
          scheduleVersion: schedule.version,
          assetVersionId: current.asset.id,
          assetVersion: current.asset.version,
          approvalId: current.approval.id,
          artifactHash: current.asset.artifact.contentHash,
          operationKey: publicationOperationKey({
            workspaceId: input.workspaceId,
            scheduleId: schedule.id,
            assetVersionId: current.asset.id,
            assetVersion: current.asset.version,
            artifactHash: current.asset.artifact.contentHash,
            channel: input.channel,
            accountId: input.accountId,
          }),
          channel: input.channel,
          accountId: input.accountId,
          deliveryMode: input.deliveryMode,
          status: "pending",
          attempts: [],
          receipts: [],
          failure: null,
          delivery: null,
          verification: null,
        });
        await repos.publications.insert(publication);
        return schedule;
      },
    }, prepare);
  }

  reschedule(command: Command<Reschedule>): Promise<Schedule> {
    assertRecord(command.input, "Reschedule", RESCHEDULE_KEYS);
    positiveVersion(command.input.expectedVersion, "expectedVersion");
    assertScheduleTimeSyntax(command.input.scheduledFor, command.input.timeZone);
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "schedule.reschedule",
      entityType: "schedule",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        const current = await requireSchedule(repos, input);
        this.assertScheduledVersion(current, input.expectedVersion);
        assertFutureTime(input.scheduledFor, timestamp);
        return repos.schedules.update({
          ...current,
          scheduledFor: input.scheduledFor,
          timeZone: input.timeZone,
          updatedAt: timestamp,
        }, input.expectedVersion);
      },
    });
  }

  cancelSchedule(command: Command<CancelSchedule>): Promise<Schedule> {
    assertRecord(command.input, "CancelSchedule", CANCEL_SCHEDULE_KEYS);
    positiveVersion(command.input.expectedVersion, "expectedVersion");
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "schedule.cancel",
      entityType: "schedule",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        const current = await requireSchedule(repos, input);
        this.assertScheduledVersion(current, input.expectedVersion);
        const publication = await repos.publications.getByScheduleId(current.id, current.workspaceId);
        if (!publication || publication.status !== "pending") {
          conflict("Only a Schedule with a pending Publication can be cancelled");
        }
        const cancelled = await repos.schedules.update({
          ...current,
          status: "cancelled",
          updatedAt: timestamp,
        }, input.expectedVersion);
        await repos.publications.update({
          ...publication,
          status: "cancelled",
          updatedAt: timestamp,
        }, publication.version);
        return cancelled;
      },
    });
  }

  async getSchedule(query: GetSchedule): Promise<Schedule> {
    assertRecord(query, "GetSchedule", GET_KEYS);
    return this.store.transaction((repos) => requireSchedule(repos, query));
  }

  private assertScheduledVersion(schedule: Schedule, expectedVersion: number): void {
    if (schedule.version !== expectedVersion) {
      conflict("Schedule version does not match expectedVersion");
    }
    if (schedule.status !== "scheduled") {
      conflict("Only a scheduled Schedule can be changed or cancelled");
    }
  }

  private assertProviderConfiguration(input: CreateSchedule): void {
    if (
      input.deliveryMode === "automatic" &&
      !this.providerConfiguration.isConfigured(input.channel, input.accountId)
    ) {
      throw new DomainError(
        "CAPABILITY_UNAVAILABLE",
        "Automatic scheduling requires a configured trusted publishing provider for the exact channel and account",
        false,
        { channel: input.channel, accountId: input.accountId },
      );
    }
  }

  private async readActualArtifact(asset: AssetVersion): Promise<void> {
    const content = await this.artifacts.read(asset.artifact.contentHash, asset.artifact.byteLength);
    if (content.length !== asset.artifact.byteLength) {
      conflict("AssetVersion artifact length does not match its descriptor");
    }
  }
}

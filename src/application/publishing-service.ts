import { createHash } from "node:crypto";
import { assertEntityReferenceId, assertRecord, assertUtcInstant } from "../domain/contract-validation.js";
import type { AssetVersion, ContentBrief, ContentChannel } from "../domain/content-production-model.js";
import { DomainError } from "../domain/errors.js";
import type { Evidence, Source } from "../domain/model.js";
import {
  createApproval,
  createPublication,
  createSchedule,
  MAX_PUBLICATION_ATTEMPTS,
  MAX_PUBLICATION_RECEIPTS,
  type Approval,
  type Publication,
  type PublicationAttempt,
  type PublicationReceipt,
  type Schedule,
} from "../domain/publishing-model.js";
import { ArtifactStore } from "../infrastructure/artifact-store.js";
import {
  computePublishingSubmitInputHash,
  McpPublishingProvider,
  type PublishingProvider,
  type PublishingProviderResult,
  type PublishingSubmitRequest,
} from "../infrastructure/publishing-provider.js";
import { canonicalJson } from "../infrastructure/sqlite.js";
import {
  assertBoundedCommandResponse,
  AuditableCommandPipeline,
  type Command,
  type CommandContext,
  type CommandPipeline,
} from "./commands.js";
import { requireWorkspace } from "./marketing-service.js";
import type { Clock, IdGenerator, JsonValue, Repositories, Store } from "./ports.js";
import type {
  CancelSchedule,
  CreateSchedule,
  DeliveryPackageChunk,
  GetApproval,
  GetDeliveryPackage,
  GetPublication,
  GetSchedule,
  ManualComplete,
  PublicationOperation,
  RecordApproval,
  Reschedule,
} from "./publishing-commands.js";

const VALIDATION_TIME = "1970-01-01T00:00:00.000Z";
const SUBMISSION_LEASE_MS = 30_000;
const DELIVERY_PACKAGE_CHUNK_MAX_BYTES = 32_768;
const MANUAL_COMPLETE_KEYS = [
  "id", "workspaceId", "publicationId", "expectedPublicationVersion", "evidenceIds",
  "externalPublicationId", "publishedAt",
] as const;
const GET_DELIVERY_PACKAGE_KEYS = ["id", "workspaceId", "offset", "length"] as const;
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
const PUBLICATION_OPERATION_KEYS = ["id", "workspaceId", "expectedVersion"] as const;

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

interface PublicationSnapshot extends ScheduleSnapshot {
  schedule: Schedule;
  publication: Publication;
  brief: ContentBrief;
}

interface PreparedPublication extends PublicationSnapshot {
  request: PublishingSubmitRequest;
  inputHash: string;
}

type PublicationClaim =
  | { kind: "claimed"; prepared: PreparedPublication; claimed: Publication }
  | { kind: "complete"; publication: Publication };

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

function validatePublicationOperation(input: PublicationOperation, context: CommandContext): void {
  assertRecord(input, "PublicationOperation", PUBLICATION_OPERATION_KEYS);
  positiveVersion(input.expectedVersion, "expectedVersion");
  for (const [field, value] of Object.entries(context)) {
    if (typeof value !== "string" || value.trim().length === 0) invalid(`${field} must not be empty`);
  }
}

function validateManualComplete(input: ManualComplete): void {
  assertRecord(input, "ManualComplete", MANUAL_COMPLETE_KEYS);
  positiveVersion(input.expectedPublicationVersion, "expectedPublicationVersion");
  assertEntityReferenceId(input.publicationId, "publicationId");
  assertEntityReferenceId(input.externalPublicationId, "externalPublicationId");
  assertUtcInstant(input.publishedAt, "publishedAt");
  if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length < 1 || input.evidenceIds.length > 100) {
    invalid("evidenceIds must contain 1-100 persisted Evidence IDs");
  }
  for (const id of input.evidenceIds) assertEntityReferenceId(id, "evidenceIds");
  if (new Set(input.evidenceIds).size !== input.evidenceIds.length) {
    invalid("evidenceIds must not contain duplicates");
  }
}

function publicationRequestHash(action: string, input: PublicationOperation): string {
  return createHash("sha256").update(canonicalJson({ action, input })).digest("hex");
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

async function requirePublicationSnapshot(
  repos: Repositories,
  input: { id: string; workspaceId: string },
  requireAutomatic = true,
): Promise<PublicationSnapshot> {
  const publication = await repos.publications.get(input.id, input.workspaceId);
  if (!publication) notFound("Publication not found in workspace", { id: input.id, workspaceId: input.workspaceId });
  const schedule = await requireSchedule(repos, { id: publication.scheduleId, workspaceId: input.workspaceId });
  const asset = await repos.assetVersions.get(publication.assetVersionId, input.workspaceId);
  const approval = await repos.approvals.get(publication.approvalId, input.workspaceId);
  if (!asset || !approval) conflict("Publication locked AssetVersion or Approval is missing");
  if (
    publication.scheduleId !== schedule.id ||
    publication.assetVersionId !== schedule.assetVersionId ||
    publication.assetVersion !== schedule.assetVersion ||
    publication.approvalId !== schedule.approvalId ||
    publication.channel !== schedule.channel ||
    publication.accountId !== schedule.accountId ||
    publication.deliveryMode !== schedule.deliveryMode ||
    (requireAutomatic && schedule.deliveryMode !== "automatic") ||
    schedule.assetVersionId !== asset.id ||
    schedule.assetVersion !== asset.version ||
    schedule.channel !== asset.channel ||
    approval.decision !== "approved" ||
    approval.assetVersionId !== asset.id ||
    approval.assetVersion !== asset.version ||
    approval.artifactHash !== asset.artifact.contentHash ||
    publication.artifactHash !== asset.artifact.contentHash
  ) {
    conflict("Publication requires the exact approved AssetVersion, artifact, account, channel, and Schedule");
  }
  const brief = await repos.contentBriefs.get(asset.briefId, input.workspaceId);
  if (!brief || brief.version !== asset.briefVersion || brief.channel !== asset.channel) {
    conflict("Publication locked ContentBrief is missing or does not match the AssetVersion");
  }
  return { publication, schedule, asset, approval, brief };
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
  private readonly activeSubmissions = new Map<string, Promise<Publication>>();

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly artifacts: ArtifactStore = new ArtifactStore(),
    private readonly providerConfiguration: PublishingProviderConfiguration = { isConfigured: () => false },
    private readonly provider: PublishingProvider = new McpPublishingProvider(),
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
        const publication = await repos.publications.getByScheduleId(current.id, current.workspaceId);
        if (!publication || publication.status !== "pending") {
          conflict("Only a Schedule with a pending Publication can be rescheduled");
        }
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

  async submit(command: Command<PublicationOperation>): Promise<Publication> {
    validatePublicationOperation(command.input, command.context);
    return this.startSubmission(command, "publication.submit");
  }

  async verify(command: Command<PublicationOperation>): Promise<Publication> {
    validatePublicationOperation(command.input, command.context);
    return this.performVerify(command, "publication.verify");
  }

  async retry(command: Command<PublicationOperation>): Promise<Publication> {
    validatePublicationOperation(command.input, command.context);
    const action = "publication.retry";
    const replay = await this.replay(command, action);
    if (replay) return replay;
    const active = this.activeSubmissions.get(this.publicationKey(command.input));
    if (active) {
      await active;
      const current = await this.get({ id: command.input.id, workspaceId: command.input.workspaceId });
      if (current.status === "submitted" || current.status === "verified") {
        return this.completeNoop(command, action, current.version, ["submitted", "verified"]);
      }
      return this.performRetry({ ...command, input: { ...command.input, expectedVersion: current.version } });
    }
    return this.performRetry(command);
  }

  private async performRetry(command: Command<PublicationOperation>): Promise<Publication> {
    const action = "publication.retry";
    const replay = await this.replay(command, action);
    if (replay) return replay;
    const current = await this.get({ id: command.input.id, workspaceId: command.input.workspaceId });
    if (current.status === "verified") {
      return this.completeNoop(command, action, command.input.expectedVersion, ["verified"]);
    }
    if (["submitting", "submitted", "unknown"].includes(current.status)) {
      const checked = await this.performVerify(command, action, true);
      if (checked.status === "failed" && checked.failure?.code === "not_found") {
        return this.startSubmission(command, action, checked.version);
      }
      return this.store.transaction(async (repos) => {
        const previous = await this.replayInTransaction(repos, command, action);
        if (previous) return previous;
        await this.putIdempotency(repos, command, action, checked);
        return checked;
      });
    }
    return this.startSubmission(command, action);
  }

  async get(query: GetPublication): Promise<Publication> {
    assertRecord(query, "GetPublication", GET_KEYS);
    return this.store.transaction(async (repos) => {
      const publication = await repos.publications.get(query.id, query.workspaceId);
      if (!publication) notFound("Publication not found in workspace", { id: query.id, workspaceId: query.workspaceId });
      return publication;
    });
  }

  async manualHandoff(command: Command<PublicationOperation>): Promise<Publication> {
    validatePublicationOperation(command.input, command.context);
    let prepared: { snapshot: PublicationSnapshot; bytes: Buffer } | undefined;
    const prepare = async (): Promise<void> => {
      prepared = undefined;
      const snapshot = await this.store.transaction((repos) =>
        requirePublicationSnapshot(repos, command.input, false)
      );
      this.assertManualHandoff(snapshot, command.input.expectedVersion);
      await this.readActualArtifact(snapshot.asset);
      const bytes = this.buildDeliveryPackage(snapshot);
      await this.artifacts.put(bytes);
      prepared = { snapshot, bytes };
    };
    return this.commands.executeBatch({
      workspaceId: command.input.workspaceId,
      action: "publication.manual_handoff",
      entityType: "publication",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        if (!prepared) throw new Error("Manual handoff preparation did not complete");
        const current = await requirePublicationSnapshot(repos, input, false);
        this.assertManualHandoff(current, input.expectedVersion);
        if (canonicalJson(current) !== canonicalJson(prepared.snapshot)) {
          conflict("Publication, ContentBrief, Approval, AssetVersion, or Schedule changed before manual handoff");
        }
        if (current.schedule.status === "scheduled") {
          await repos.schedules.update({
            ...current.schedule,
            status: "triggered",
            updatedAt: timestamp,
          }, current.schedule.version);
        }
        return repos.publications.update({
          ...current.publication,
          status: "manual_handoff",
          updatedAt: timestamp,
        }, input.expectedVersion);
      },
    }, prepare);
  }

  async manualComplete(command: Command<ManualComplete>): Promise<Publication> {
    validateManualComplete(command.input);
    return this.commands.execute({
      workspaceId: command.input.workspaceId,
      action: "publication.manual_complete",
      entityType: "publication",
      input: command.input,
      context: command.context,
      write: async (repos, input, timestamp) => {
        const snapshot = await requirePublicationSnapshot(repos, {
          id: input.publicationId,
          workspaceId: input.workspaceId,
        }, false);
        this.assertPublicationVersion(snapshot.publication, input.expectedPublicationVersion);
        if (snapshot.publication.status !== "manual_handoff") {
          conflict("Only a manual handoff can be completed with manual evidence");
        }
        for (const evidenceId of input.evidenceIds) {
          const evidence = await repos.evidence.get(evidenceId, input.workspaceId) as Evidence | undefined;
          if (!evidence) notFound("Manual completion Evidence not found in workspace", {
            evidenceId,
            workspaceId: input.workspaceId,
          });
          const source = await repos.sources.get(evidence.sourceId, input.workspaceId) as Source | undefined;
          if (!source || !["owned", "authorized"].includes(source.ownership) ||
              evidence.classification !== "owned_operating") {
            conflict("Manual completion requires owned or authorized owned_operating Evidence");
          }
        }
        if (snapshot.schedule.status !== "triggered") {
          conflict("Manual completion requires a triggered Schedule");
        }
        await repos.schedules.update({
          ...snapshot.schedule,
          status: "completed",
          updatedAt: timestamp,
        }, snapshot.schedule.version);
        return repos.publications.update({
          ...snapshot.publication,
          status: "verified",
          failure: null,
          delivery: {
            method: "manual_evidence",
            externalPublicationId: input.externalPublicationId,
            publishedAt: input.publishedAt,
            evidenceIds: [...input.evidenceIds],
          },
          verification: {
            method: "manual_evidence",
            verifiedAt: timestamp,
            externalPublicationId: input.externalPublicationId,
            evidenceIds: [...input.evidenceIds],
          },
          updatedAt: timestamp,
        }, input.expectedPublicationVersion);
      },
    });
  }

  async getDeliveryPackage(query: GetDeliveryPackage): Promise<DeliveryPackageChunk> {
    assertRecord(query, "GetDeliveryPackage", GET_DELIVERY_PACKAGE_KEYS);
    const offset = query.offset ?? 0;
    const length = query.length ?? DELIVERY_PACKAGE_CHUNK_MAX_BYTES;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) ||
        length < 1 || length > DELIVERY_PACKAGE_CHUNK_MAX_BYTES) {
      invalid(`Delivery package offset must be non-negative and length must be 1-${DELIVERY_PACKAGE_CHUNK_MAX_BYTES}`);
    }
    const snapshot = await this.store.transaction((repos) =>
      requirePublicationSnapshot(repos, query, false)
    );
    if (snapshot.publication.status !== "manual_handoff" &&
        !(snapshot.publication.status === "verified" && snapshot.publication.verification?.method === "manual_evidence")) {
      conflict("Delivery package requires a manual handoff");
    }
    const bytes = this.buildDeliveryPackage(snapshot);
    if (offset > bytes.length) invalid("Delivery package offset exceeds totalBytes");
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const content = await this.artifacts.readRange(contentHash, offset, length, bytes.length);
    return {
      content,
      offset,
      length: content.length,
      totalBytes: bytes.length,
      contentHash,
      mediaType: "application/json",
    };
  }

  async reconcileSchedule(publication: Publication): Promise<void> {
    await this.store.transaction(async (repos) => {
      const schedule = await repos.schedules.get(publication.scheduleId, publication.workspaceId);
      if (!schedule || !["scheduled", "triggered"].includes(schedule.status) || publication.status === "pending") return;
      const status = publication.status === "verified" ? "completed" : "triggered";
      if (schedule.status !== status) {
        await repos.schedules.update({ ...schedule, status, updatedAt: this.clock.now() }, schedule.version);
      }
    });
  }

  private async performSubmit(
    command: Command<PublicationOperation>,
    action: string,
    expectedVersion = command.input.expectedVersion,
  ): Promise<Publication> {
    const replay = await this.replay(command, action);
    if (replay) return replay;
    const snapshot = await this.store.transaction((repos) => requirePublicationSnapshot(repos, command.input));
    this.assertPublicationVersion(snapshot.publication, expectedVersion);
    if (snapshot.publication.status === "verified" || snapshot.publication.status === "submitted") {
      return this.completeNoop(command, action, expectedVersion, ["verified", "submitted"]);
    }
    if (snapshot.publication.status !== "pending" && snapshot.publication.status !== "failed") {
      conflict("Submission is uncertain; retry must verify before any new submission");
    }
    if (Date.parse(snapshot.schedule.scheduledFor) > Date.parse(this.clock.now())) {
      return this.completeNoop(command, action, expectedVersion, ["pending"], true);
    }
    this.assertDueAndConfigured(snapshot);
    this.assertAttemptCapacity(snapshot.publication);
    const content = await this.readActualArtifact(snapshot.asset);
    const prepared = this.preparePublication(snapshot, content);
    const claim = await this.claim(command, action, "submit", prepared, expectedVersion);
    if (claim.kind === "complete") return claim.publication;
    let result: PublishingProviderResult | undefined;
    let providerError: unknown;
    try {
      result = await this.provider.submit(prepared.request);
    } catch (error) {
      providerError = error;
    }
    return this.completeProviderOperation(command, action, "submit", claim, result, providerError);
  }

  private async startSubmission(
    command: Command<PublicationOperation>,
    action: string,
    expectedVersion = command.input.expectedVersion,
  ): Promise<Publication> {
    const key = this.publicationKey(command.input);
    const active = this.activeSubmissions.get(key);
    if (active) {
      await active;
      const current = await this.get({ id: command.input.id, workspaceId: command.input.workspaceId });
      return this.startSubmission(command, action, current.version);
    }
    const submission = this.performSubmit(command, action, expectedVersion);
    const tracked = submission.finally(() => {
      if (this.activeSubmissions.get(key) === tracked) this.activeSubmissions.delete(key);
    });
    this.activeSubmissions.set(key, tracked);
    return tracked;
  }

  private publicationKey(input: Pick<PublicationOperation, "id" | "workspaceId">): string {
    return canonicalJson({ workspaceId: input.workspaceId, id: input.id });
  }

  private async performVerify(
    command: Command<PublicationOperation>,
    action: string,
    deferIdempotency = false,
  ): Promise<Publication> {
    const replay = await this.replay(command, action);
    if (replay) return replay;
    const snapshot = await this.store.transaction((repos) => requirePublicationSnapshot(repos, command.input));
    this.assertPublicationVersion(snapshot.publication, command.input.expectedVersion);
    if (snapshot.publication.status === "verified") {
      return this.completeNoop(command, action, command.input.expectedVersion, ["verified"]);
    }
    if (!["submitting", "submitted", "unknown"].includes(snapshot.publication.status)) {
      conflict("Only a submitted or uncertain Publication can be verified");
    }
    this.assertSubmissionLeaseExpired(snapshot.publication);
    this.assertDueAndConfigured(snapshot);
    const content = await this.readActualArtifact(snapshot.asset);
    const prepared = this.preparePublication(snapshot, content);
    const claim = await this.claim(command, action, "verify", prepared, command.input.expectedVersion);
    if (claim.kind === "complete") return claim.publication;
    let result: PublishingProviderResult | undefined;
    let providerError: unknown;
    try {
      result = await this.provider.verify({
        operationKey: prepared.publication.operationKey,
        inputHash: prepared.inputHash,
        channel: prepared.publication.channel,
        accountId: prepared.publication.accountId,
      });
    } catch (error) {
      providerError = error;
    }
    return this.completeProviderOperation(command, action, "verify", claim, result, providerError, deferIdempotency);
  }

  private preparePublication(snapshot: PublicationSnapshot, content: Buffer): PreparedPublication {
    const publication = snapshot.publication;
    const request: PublishingSubmitRequest = {
      operationKey: publication.operationKey,
      publicationId: publication.id,
      workspaceId: publication.workspaceId,
      scheduleId: publication.scheduleId,
      assetVersionId: publication.assetVersionId,
      assetVersion: publication.assetVersion,
      artifactHash: publication.artifactHash,
      artifactByteLength: content.length,
      artifactBase64: content.toString("base64"),
      channel: publication.channel,
      accountId: publication.accountId,
    };
    return {
      ...snapshot,
      request,
      inputHash: computePublishingSubmitInputHash(request),
    };
  }

  private async claim(
    command: Command<PublicationOperation>,
    action: string,
    operation: "submit" | "verify",
    prepared: PreparedPublication,
    expectedVersion: number,
  ): Promise<PublicationClaim> {
    return this.store.transaction(async (repos): Promise<PublicationClaim> => {
      const previous = await this.replayInTransaction(repos, command, action);
      if (previous) return { kind: "complete", publication: previous };
      const current = await requirePublicationSnapshot(repos, command.input);
      const currentIdentity = {
        publication: current.publication,
        schedule: current.schedule,
        asset: current.asset,
        approval: current.approval,
      };
      const preparedIdentity = {
        publication: prepared.publication,
        schedule: prepared.schedule,
        asset: prepared.asset,
        approval: prepared.approval,
      };
      if (canonicalJson(currentIdentity) !== canonicalJson(preparedIdentity)) {
        conflict("Publication, Approval, AssetVersion, or Schedule changed before provider claim");
      }
      this.assertPublicationVersion(current.publication, expectedVersion);
      if (operation === "submit" && ["verified", "submitted"].includes(current.publication.status)) {
        return { kind: "complete", publication: await this.recordResponse(repos, command, action, current.publication) };
      }
      if (operation === "verify" && current.publication.status === "verified") {
        return { kind: "complete", publication: await this.recordResponse(repos, command, action, current.publication) };
      }
      if (operation === "submit" && Date.parse(current.schedule.scheduledFor) > Date.parse(this.clock.now())) {
        if (current.publication.status !== "pending") conflict("Only a pending Publication can be a before-due no-op");
        return { kind: "complete", publication: await this.recordResponse(repos, command, action, current.publication) };
      }
      this.assertDueAndConfigured(current);
      const timestamp = this.clock.now();
      let claimed: Publication;
      if (operation === "submit") {
        if (current.publication.status !== "pending" && current.publication.status !== "failed") {
          conflict("Submission is uncertain; retry must verify before any new submission");
        }
        this.assertAttemptCapacity(current.publication);
        if (current.schedule.status === "scheduled") {
          await repos.schedules.update({
            ...current.schedule,
            status: "triggered",
            updatedAt: timestamp,
          }, current.schedule.version);
        }
        const attempt: PublicationAttempt = {
          attempt: current.publication.attempts.length + 1,
          startedAt: timestamp,
          completedAt: null,
          outcome: "submitting",
        };
        claimed = await repos.publications.update({
          ...current.publication,
          status: "submitting",
          attempts: [...current.publication.attempts, attempt],
          failure: null,
          updatedAt: timestamp,
        }, current.publication.version);
      } else {
        if (!["submitting", "submitted", "unknown"].includes(current.publication.status)) {
          conflict("Only a submitted or uncertain Publication can be verified");
        }
        this.assertSubmissionLeaseExpired(current.publication);
        claimed = await repos.publications.update({
          ...current.publication,
          updatedAt: timestamp,
        }, current.publication.version);
      }
      await this.appendAudit(repos, command, `${action}.claim`, claimed, timestamp);
      return { kind: "claimed", prepared: { ...prepared, ...current }, claimed };
    });
  }

  private async completeProviderOperation(
    command: Command<PublicationOperation>,
    action: string,
    operation: "submit" | "verify",
    claim: Extract<PublicationClaim, { kind: "claimed" }>,
    result: PublishingProviderResult | undefined,
    providerError: unknown,
    deferIdempotency = false,
  ): Promise<Publication> {
    const timestamp = this.clock.now();
    return this.store.transaction(async (repos) => {
      const previous = await this.replayInTransaction(repos, command, action);
      if (previous) return previous;
      const current = await repos.publications.get(command.input.id, command.input.workspaceId);
      if (!current) notFound("Publication not found in workspace", { id: command.input.id, workspaceId: command.input.workspaceId });
      if (current.version !== claim.claimed.version || current.status !== claim.claimed.status) {
        conflict("Publication changed before provider outcome commit");
      }
      let status = current.status;
      let failure = current.failure;
      let delivery = current.delivery;
      let verification = current.verification;
      let attempts = current.attempts;
      if (providerError !== undefined || !result) {
        status = "unknown";
        failure = this.uncertainFailure(providerError, timestamp);
      } else if (operation === "submit") {
        if (result.status === "accepted") {
          status = "submitted";
          failure = null;
        } else if (result.status === "failed" && result.failure) {
          status = "failed";
          failure = { ...result.failure, failedAt: timestamp };
        } else {
          conflict("Trusted provider returned an invalid submit outcome");
        }
        attempts = current.attempts.map((attempt, index) => index === current.attempts.length - 1 ? {
          ...attempt,
          completedAt: timestamp,
          outcome: status === "submitted" ? "submitted" : "failed",
        } : attempt);
      } else if (result.status === "verified" && result.externalPublicationId && result.publishedAt) {
        status = "verified";
        failure = null;
        delivery = {
          method: "provider",
          externalPublicationId: result.externalPublicationId,
          publishedAt: result.publishedAt,
          evidenceIds: [],
        };
        verification = {
          method: "provider",
          verifiedAt: timestamp,
          externalPublicationId: result.externalPublicationId,
          evidenceIds: [],
        };
      } else if (result.status === "pending") {
        status = "submitted";
        failure = null;
      } else if (result.status === "failed" && result.failure) {
        status = "failed";
        failure = { ...result.failure, failedAt: timestamp };
      } else if (result.status === "not_found") {
        status = "failed";
        failure = {
          code: "not_found",
          message: "Trusted provider explicitly reported that the operation was not found",
          failedAt: timestamp,
          retryable: true,
        };
      } else {
        conflict("Trusted provider returned an invalid verification outcome");
      }
      if (status === "unknown" && operation === "submit") {
        attempts = current.attempts.map((attempt, index) => index === current.attempts.length - 1 ? {
          ...attempt,
          completedAt: timestamp,
          outcome: "unknown",
        } : attempt);
      }
      const receipts = result?.receipt ? this.appendReceipt(current.receipts, {
        kind: operation,
        provider: "mcp",
        receiptId: result.receipt.receiptId,
        receivedAt: timestamp,
        contentHash: result.receipt.contentHash,
      }) : current.receipts;
      const updated = await repos.publications.update({
        ...current,
        status,
        attempts,
        receipts,
        failure,
        delivery,
        verification,
        updatedAt: timestamp,
      }, claim.claimed.version);
      const schedule = await repos.schedules.get(updated.scheduleId, updated.workspaceId);
      if (!schedule) conflict("Publication Schedule is missing before outcome commit");
      if (["scheduled", "triggered"].includes(schedule.status)) {
        const scheduleStatus = status === "verified" ? "completed" : "triggered";
        if (schedule.status !== scheduleStatus) {
          await repos.schedules.update({ ...schedule, status: scheduleStatus, updatedAt: timestamp }, schedule.version);
        }
      }
      assertBoundedCommandResponse(updated);
      await this.appendAudit(repos, command, action, updated, timestamp);
      if (!deferIdempotency) await this.putIdempotency(repos, command, action, updated, timestamp);
      return updated;
    });
  }

  private appendReceipt(receipts: PublicationReceipt[], receipt: PublicationReceipt): PublicationReceipt[] {
    if (receipts.some((current) => current.kind === receipt.kind && current.receiptId === receipt.receiptId)) {
      return receipts;
    }
    if (receipts.length >= MAX_PUBLICATION_RECEIPTS) return receipts;
    return [...receipts, receipt];
  }

  private uncertainFailure(error: unknown, timestamp: string): NonNullable<Publication["failure"]> {
    const reason = error instanceof DomainError && typeof error.details?.reason === "string"
      ? error.details.reason
      : error instanceof DomainError ? error.code.toLowerCase() : "provider_outcome_unknown";
    return {
      code: reason,
      message: "Trusted publishing outcome is unknown and requires verification before retry",
      failedAt: timestamp,
      retryable: true,
    };
  }

  private async completeNoop(
    command: Command<PublicationOperation>,
    action: string,
    expectedVersion: number,
    statuses: Publication["status"][],
    beforeDueOnly = false,
  ): Promise<Publication> {
    return this.store.transaction(async (repos) => {
      const previous = await this.replayInTransaction(repos, command, action);
      if (previous) return previous;
      const snapshot = await requirePublicationSnapshot(repos, command.input);
      this.assertPublicationVersion(snapshot.publication, expectedVersion);
      if (!statuses.includes(snapshot.publication.status)) conflict("Publication state changed before no-op completion");
      const beforeDue = Date.parse(snapshot.schedule.scheduledFor) > Date.parse(this.clock.now());
      if (beforeDueOnly && !beforeDue) conflict("Publication became due before no-op completion");
      return this.recordResponse(repos, command, action, snapshot.publication);
    });
  }

  private async replay(
    command: Command<PublicationOperation>,
    action: string,
  ): Promise<Publication | undefined> {
    return this.store.transaction((repos) => this.replayInTransaction(repos, command, action));
  }

  private async replayInTransaction(
    repos: Repositories,
    command: Command<PublicationOperation>,
    action: string,
  ): Promise<Publication | undefined> {
    const previous = await repos.idempotency.get(command.input.workspaceId, command.context.idempotencyKey);
    if (!previous) return undefined;
    if (previous.requestHash !== publicationRequestHash(action, command.input)) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used with different input", false, {
        key: command.context.idempotencyKey,
      });
    }
    return previous.response as unknown as Publication;
  }

  private async recordResponse(
    repos: Repositories,
    command: Command<PublicationOperation>,
    action: string,
    publication: Publication,
    timestamp = this.clock.now(),
  ): Promise<Publication> {
    assertBoundedCommandResponse(publication);
    await this.appendAudit(repos, command, action, publication, timestamp);
    await this.putIdempotency(repos, command, action, publication, timestamp);
    return publication;
  }

  private async putIdempotency(
    repos: Repositories,
    command: Command<PublicationOperation>,
    action: string,
    publication: Publication,
    timestamp = this.clock.now(),
  ): Promise<void> {
    await repos.idempotency.put({
      workspaceId: publication.workspaceId,
      key: command.context.idempotencyKey,
      requestHash: publicationRequestHash(action, command.input),
      response: publication as unknown as JsonValue,
      createdAt: timestamp,
    });
  }

  private async appendAudit(
    repos: Repositories,
    command: Command<PublicationOperation>,
    action: string,
    publication: Publication,
    timestamp: string,
  ): Promise<void> {
    await repos.audit.append({
      id: this.ids.next(),
      workspaceId: publication.workspaceId,
      requestId: command.context.requestId,
      actor: command.context.actor,
      action,
      entityType: "publication",
      entityId: publication.id,
      details: { input: { ...command.input } },
      createdAt: timestamp,
    });
  }

  private assertPublicationVersion(publication: Publication, expectedVersion: number): void {
    if (publication.version !== expectedVersion) conflict("Publication version does not match expectedVersion");
  }

  private assertManualHandoff(snapshot: PublicationSnapshot, expectedVersion: number): void {
    this.assertPublicationVersion(snapshot.publication, expectedVersion);
    if (!["pending", "failed"].includes(snapshot.publication.status)) {
      conflict("Only a pending or definitely failed Publication can become manual handoff");
    }
    if (!["scheduled", "triggered"].includes(snapshot.schedule.status)) {
      conflict("Manual handoff requires a scheduled or triggered Schedule");
    }
    if (Date.parse(snapshot.schedule.scheduledFor) > Date.parse(this.clock.now())) {
      conflict("Publication is not due");
    }
  }

  private buildDeliveryPackage(snapshot: PublicationSnapshot): Buffer {
    const schedule = snapshot.schedule;
    return Buffer.from(canonicalJson({
      packageVersion: 1,
      status: "not_published",
      brief: snapshot.brief,
      briefHash: createHash("sha256").update(canonicalJson(snapshot.brief)).digest("hex"),
      asset: snapshot.asset,
      assetHash: createHash("sha256").update(canonicalJson(snapshot.asset)).digest("hex"),
      artifact: snapshot.asset.artifact,
      artifactHash: snapshot.asset.artifact.contentHash,
      accountId: snapshot.publication.accountId,
      channel: snapshot.publication.channel,
      schedule: {
        id: schedule.id,
        workspaceId: schedule.workspaceId,
        createdAt: schedule.createdAt,
        assetVersionId: schedule.assetVersionId,
        assetVersion: schedule.assetVersion,
        approvalId: schedule.approvalId,
        channel: schedule.channel,
        accountId: schedule.accountId,
        scheduledFor: schedule.scheduledFor,
        timeZone: schedule.timeZone,
        deliveryMode: schedule.deliveryMode,
      },
      approval: snapshot.approval,
      operationKey: snapshot.publication.operationKey,
    }), "utf8");
  }

  private assertDueAndConfigured(snapshot: PublicationSnapshot): void {
    if (!["scheduled", "triggered"].includes(snapshot.schedule.status)) {
      conflict("Only a scheduled or triggered Schedule can publish");
    }
    if (Date.parse(snapshot.schedule.scheduledFor) > Date.parse(this.clock.now())) {
      conflict("Publication is not due");
    }
    if (!this.provider.isConfigured(snapshot.publication.channel, snapshot.publication.accountId)) {
      throw new DomainError(
        "CAPABILITY_UNAVAILABLE",
        "Trusted publishing provider is not configured for the exact channel and account",
        false,
        { channel: snapshot.publication.channel, accountId: snapshot.publication.accountId },
      );
    }
  }

  private assertSubmissionLeaseExpired(publication: Publication): void {
    if (publication.status !== "submitting") return;
    const elapsed = Date.parse(this.clock.now()) - Date.parse(publication.updatedAt);
    if (elapsed < SUBMISSION_LEASE_MS) {
      throw new DomainError(
        "CONFLICT",
        "A publication submission is still active; retry after its lease expires",
        true,
        { id: publication.id, leaseMs: SUBMISSION_LEASE_MS },
      );
    }
  }

  private assertAttemptCapacity(publication: Publication): void {
    if (publication.attempts.length >= MAX_PUBLICATION_ATTEMPTS) {
      conflict(`Publication cannot exceed ${MAX_PUBLICATION_ATTEMPTS} submit attempts`);
    }
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

  private async readActualArtifact(asset: AssetVersion): Promise<Buffer> {
    const content = await this.artifacts.read(asset.artifact.contentHash, asset.artifact.byteLength);
    if (content.length !== asset.artifact.byteLength) {
      conflict("AssetVersion artifact length does not match its descriptor");
    }
    return content;
  }
}

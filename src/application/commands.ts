import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type {
  CapabilityAdapterKind,
  EvidenceClassification,
  FindingKind,
  SourceOwnership,
  SourceType,
  TaskState,
  ToolHealthEvidence,
} from "../domain/model.js";
import { isSecretLikeKey } from "../domain/secrets.js";
import { canonicalJson } from "../infrastructure/sqlite.js";
import type {
  Clock,
  EntityRecord,
  IdGenerator,
  JsonValue,
  Repositories,
  Store,
} from "./ports.js";

export interface CommandContext {
  actor: string;
  requestId: string;
  idempotencyKey: string;
}

export interface Command<T> {
  input: T;
  context: CommandContext;
}

export interface CreateWorkspace {
  id: string;
  name: string;
  metadata?: JsonValue;
}

export interface RegisterSource {
  id: string;
  workspaceId: string;
  name: string;
  type: SourceType;
  ownership: SourceOwnership;
  metadata?: JsonValue;
}

export interface RegisterDataset {
  id: string;
  workspaceId: string;
  sourceId: string;
  name: string;
  coverageStart: string;
  coverageEnd: string;
  fieldDefinitions: JsonValue;
  metricDefinitions: JsonValue;
  limitations: JsonValue;
}

export interface RecordEvidence {
  id: string;
  workspaceId: string;
  sourceId: string;
  sourceLocator: string;
  observedAt: string;
  summary: string;
  contentHash: string;
  classification: EvidenceClassification;
  toolHealth?: ToolHealthEvidence;
}

export interface RecordFinding {
  id: string;
  workspaceId: string;
  kind: FindingKind;
  statement: string;
  evidenceIds: string[];
  limitations?: string;
  unknownReason?: string;
}

export interface CreateRecommendation {
  id: string;
  workspaceId: string;
  findingIds: string[];
  hypothesis: string;
  affectedStage: string;
  priority: string;
  expectedMetric: string;
}

export interface CreateTask {
  id: string;
  workspaceId: string;
  recommendationIds: string[];
  assignee: string;
  dependencyIds: string[];
  assetRequirements: string[];
  acceptanceCriteria: string[];
}

export interface TransitionTask {
  id: string;
  workspaceId: string;
  next: TaskState;
  expectedVersion: number;
}

export interface RegisterCapability {
  id: string;
  workspaceId: string;
  name: string;
  adapterKind: CapabilityAdapterKind;
  origin: "user_extension";
  configuration?: JsonValue;
}

export interface RecordCapabilityHealth {
  id: string;
  workspaceId: string;
  expectedVersion: number;
  healthy: boolean;
  checkedAt: string;
  toolVersion?: string;
  evidenceId?: string;
  reason?: string;
}

interface WriteOperation<T, R extends EntityRecord> {
  workspaceId: string;
  action: string;
  entityType: string;
  input: T;
  context: CommandContext;
  write(repos: Repositories, input: T, timestamp: string): Promise<R>;
}

export interface CommandPipeline {
  execute<T, R extends EntityRecord>(operation: WriteOperation<T, R>): Promise<R>;
  executeBatch<T, R extends EntityRecord>(operation: WriteOperation<T, R>): Promise<R>;
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("INVALID_INPUT", `${field} must not be empty`);
  }
}

function assertCommandContext(context: CommandContext): void {
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    throw new DomainError("INVALID_INPUT", "Command context is required");
  }
  assertNonEmptyString(context.actor, "context.actor");
  assertNonEmptyString(context.requestId, "context.requestId");
  assertNonEmptyString(context.idempotencyKey, "context.idempotencyKey");
}

function assertDenseJson(value: unknown, seen = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DomainError("INVALID_INPUT", "Command input must contain finite JSON numbers");
    }
    return;
  }
  if (typeof value !== "object" || seen.has(value)) {
    throw new DomainError("INVALID_INPUT", "Command input must contain acyclic JSON values");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new DomainError("INVALID_INPUT", "Command input arrays must not be sparse");
        }
        assertDenseJson(value[index], seen);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DomainError("INVALID_INPUT", "Command input objects must be plain JSON objects");
    }
    for (const entry of Object.values(value)) {
      assertDenseJson(entry, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function assertCommonCommandInput(action: string, input: unknown): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new DomainError("INVALID_INPUT", "Command input must be an object");
  }
  const record = input as Record<string, unknown>;
  assertNonEmptyString(record.id, "id");
  if (action !== "workspace.create") {
    assertNonEmptyString(record.workspaceId, "workspaceId");
  }
  if (
    ["workspace.create", "source.register", "dataset.register", "capability.register"]
      .includes(action)
  ) {
    assertNonEmptyString(record.name, "name");
  }
  if (Object.hasOwn(record, "sourceId")) {
    assertNonEmptyString(record.sourceId, "sourceId");
  }
  assertDenseJson(input);
}

function rejectSecretLikeInput(): never {
  throw new DomainError(
    "INVALID_INPUT",
    "Secret-like fields are not allowed in command input",
  );
}

function isSecretParameter(key: string): boolean {
  let decoded = key;
  try {
    decoded = decodeURIComponent(key);
  } catch {}
  return decoded.trim().toLowerCase() === "key" || isSecretLikeKey(decoded);
}

function assertNoEmbeddedSecrets(value: string): void {
  for (const match of value.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi)) {
    let url: URL | undefined;
    try {
      url = new URL(match[0]);
    } catch {}
    if (!url) {
      continue;
    }
    if (url.username || url.password) {
      rejectSecretLikeInput();
    }
    for (const [key] of url.searchParams) {
      if (isSecretParameter(key)) {
        rejectSecretLikeInput();
      }
    }
  }

  for (const match of value.matchAll(/(?:^|[?&#;\s])([^=&#;\s]+)=/g)) {
    if (isSecretParameter(match[1]!)) {
      rejectSecretLikeInput();
    }
  }
}

function assertNoSecretLikeFields(
  value: unknown,
  seen = new Set<object>(),
  fieldName?: string,
): void {
  if (typeof value === "string") {
    assertNoEmbeddedSecrets(value);
  }
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoSecretLikeFields(entry, seen, fieldName);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretLikeKey(key)) {
      rejectSecretLikeInput();
    }
    assertNoSecretLikeFields(entry, seen, key);
  }
}

function redact(value: unknown): JsonValue {
  if (value === null || typeof value !== "object") {
    return value as JsonValue;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  const output = Object.create(null) as Record<string, JsonValue>;
  for (const [key, entry] of Object.entries(value)) {
    output[key] = isSecretLikeKey(key) ? "[REDACTED]" : redact(entry);
  }
  return output;
}

export class AuditableCommandPipeline implements CommandPipeline {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  execute<T, R extends EntityRecord>(operation: WriteOperation<T, R>): Promise<R> {
    return this.executeBatch(operation);
  }

  async executeBatch<T, R extends EntityRecord>(operation: WriteOperation<T, R>): Promise<R> {
    assertCommandContext(operation.context);
    assertCommonCommandInput(operation.action, operation.input);
    if (operation.action === "evidence.record" && Object.hasOwn(operation.input as object, "assets")) {
      throw new DomainError("INVALID_INPUT", "Evidence assets must be generated by the server");
    }
    assertNoSecretLikeFields(operation.input);
    const canonicalInput = canonicalJson({
      action: operation.action,
      input: operation.input,
    });
    const requestHash = createHash("sha256").update(canonicalInput).digest("hex");

    return this.store.transaction(async (repos) => {
      const previous = await repos.idempotency.get(
        operation.workspaceId,
        operation.context.idempotencyKey,
      );
      if (previous) {
        if (previous.requestHash !== requestHash) {
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was used with different input",
            false,
            { key: operation.context.idempotencyKey },
          );
        }
        return previous.response as unknown as R;
      }

      const input = redact(operation.input) as T;
      const timestamp = this.clock.now();
      const entity = await operation.write(repos, input, timestamp);
      await repos.audit.append({
        id: this.ids.next(),
        workspaceId: entity.workspaceId,
        requestId: operation.context.requestId,
        actor: operation.context.actor,
        action: operation.action,
        entityType: operation.entityType,
        entityId: entity.id,
        details: redact({ input }),
        createdAt: timestamp,
      });
      await repos.idempotency.put({
        workspaceId: entity.workspaceId,
        key: operation.context.idempotencyKey,
        requestHash,
        response: entity as unknown as JsonValue,
        createdAt: timestamp,
      });
      return entity;
    });
  }
}

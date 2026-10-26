import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { SourceOwnership, SourceType } from "../domain/model.js";
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
}

function assertNoSecretLikeFields(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoSecretLikeFields(entry, seen);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretLikeKey(key)) {
      throw new DomainError(
        "INVALID_INPUT",
        "Secret-like fields are not allowed in command input",
      );
    }
    assertNoSecretLikeFields(entry, seen);
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

  async execute<T, R extends EntityRecord>(operation: WriteOperation<T, R>): Promise<R> {
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

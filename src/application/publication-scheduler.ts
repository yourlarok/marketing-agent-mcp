import type { Command, CommandContext } from "./commands.js";
import type {
  Clock,
  PublicationRecoveryCursor,
  ScheduleDueCursor,
  Store,
} from "./ports.js";
import type { PublicationOperation } from "./publishing-commands.js";
import type { Publication } from "../domain/publishing-model.js";
import type { PublishingService } from "./publishing-service.js";

export interface PublicationSchedulerOptions {
  intervalMs?: number;
  batchSize?: number;
  actor?: string;
  onError?: (error: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 1_000;
const MIN_INTERVAL_MS = 10;
const MAX_INTERVAL_MS = 60_000;

export class PublicationScheduler {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly actor: string;
  private readonly onError: (error: unknown) => void;
  private timer: NodeJS.Timeout | undefined;
  private flight: Promise<void> | undefined;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly publishing: PublishingService,
    private readonly clock: Clock,
    options: PublicationSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < MIN_INTERVAL_MS ||
        this.intervalMs > MAX_INTERVAL_MS) {
      throw new RangeError(`Scheduler interval must be ${MIN_INTERVAL_MS}-${MAX_INTERVAL_MS} ms`);
    }
    this.batchSize = options.batchSize ?? 100;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1_000) {
      throw new RangeError("Scheduler batch size must be 1-1000");
    }
    this.actor = options.actor ?? "publication-scheduler";
    this.onError = options.onError ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.running) {
      await this.flight;
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      if (this.running) void this.runOnce();
    }, this.intervalMs);
    this.timer.unref();
    await this.runOnce();
  }

  runOnce(): Promise<void> {
    return this.track(async () => {
      await this.executeRecovery();
      await this.executeDue();
    });
  }

  recover(): Promise<void> {
    return this.track(() => this.executeRecovery());
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flight;
  }

  private track(work: () => Promise<void>): Promise<void> {
    if (this.flight) return this.flight;
    const flight = work().catch((error: unknown) => {
      this.onError(error);
    });
    this.flight = flight;
    void flight.finally(() => {
      if (this.flight === flight) this.flight = undefined;
    });
    return flight;
  }

  private async executeRecovery(): Promise<void> {
    const updatedThrough = this.clock.now();
    const processed = new Set<string>();
    let after: PublicationRecoveryCursor | undefined;
    while (true) {
      const candidates = await this.store.transaction((repos) =>
        repos.publications.listAllRecoveryCandidates(this.batchSize, after, updatedThrough)
      );
      if (candidates.length === 0) return;
      for (const candidate of candidates) {
        const identity = JSON.stringify([candidate.workspaceId, candidate.id]);
        if (processed.has(identity)) continue;
        processed.add(identity);
        try {
          if (candidate.deliveryMode !== "automatic") continue;
          const verified = await this.publishing.verify(this.command(candidate, "recover"));
          await this.publishing.reconcileSchedule(verified);
        } catch (error) {
          this.onError(error);
        }
      }
      const last = candidates[candidates.length - 1]!;
      after = { updatedAt: last.updatedAt, workspaceId: last.workspaceId, id: last.id };
      if (candidates.length < this.batchSize) return;
    }
  }

  private async executeDue(): Promise<void> {
    const dueBy = this.clock.now();
    let after: ScheduleDueCursor | undefined;
    while (true) {
      const schedules = await this.store.transaction((repos) =>
        repos.schedules.listAllDue(dueBy, this.batchSize, after)
      );
      if (schedules.length === 0) return;
      for (const schedule of schedules) {
        try {
          const publication = await this.store.transaction((repos) =>
            repos.publications.getByScheduleId(schedule.id, schedule.workspaceId)
          );
          if (!publication) continue;
          if (schedule.deliveryMode === "manual_assisted") {
            await this.publishing.manualHandoff(this.command(publication, "manual-handoff"));
            continue;
          }
          await this.executeAutomatic(publication);
        } catch (error) {
          this.onError(error);
        }
      }
      const last = schedules[schedules.length - 1]!;
      after = { scheduledFor: last.scheduledFor, workspaceId: last.workspaceId, id: last.id };
      if (schedules.length < this.batchSize) return;
    }
  }

  private async executeAutomatic(publication: Publication): Promise<void> {
    let current = publication;
    if (["pending", "failed"].includes(current.status)) {
      current = await this.publishing.submit(this.command(current, "submit"));
    }
    if (["submitting", "submitted", "unknown"].includes(current.status)) {
      current = await this.publishing.verify(this.command(current, "verify"));
    }
    await this.publishing.reconcileSchedule(current);
  }

  private command(publication: Publication, operation: string): Command<PublicationOperation> {
    const context: CommandContext = {
      actor: this.actor,
      requestId: `scheduler:${operation}:${publication.workspaceId}:${publication.id}:${publication.version}`,
      idempotencyKey: `scheduler:${operation}:${publication.workspaceId}:${publication.id}:${publication.version}`,
    };
    return {
      input: {
        id: publication.id,
        workspaceId: publication.workspaceId,
        expectedVersion: publication.version,
      },
      context,
    };
  }
}

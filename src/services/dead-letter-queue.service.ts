/**
 * Dead-letter queue for notification and websocket dispatch failures
 * (Issue #193). Notifications and real-time events both have user-visible
 * side effects, so silently dropping them on first error means a player
 * never learns they won, or a UI never updates. This service persists the
 * failed dispatch so an operator can inspect it, an automated retry can
 * pick it up, or it can be replayed manually via the admin route.
 *
 * Kept storage-only on purpose: the existing codebase does not run a
 * background queue (no BullMQ / Bee), so introducing one for this issue
 * would be the wrong altitude. Replays are driven by an explicit admin
 * call (`retry` / `retryAll`) which re-invokes the original dispatcher.
 */
import { DispatchChannel, DispatchStatus, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import logger from "../utils/logger";
import { redactDlqPayload } from "../utils/redact-payload";

/**
 * Hard cap so a single pathological payload (e.g. a runaway error chain)
 * can never blow up the DB column. The Prisma column is VARCHAR(1000).
 */
const MAX_ERROR_LEN = 1000;

/**
 * Default upper bound on retry attempts before a row is auto-marked
 * `ABANDONED`. Tunable so callers (cron jobs, tests) can override.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * How long a dispatch id is remembered after a successful replay.
 * Long enough to swallow duplicate retries of the same row (operator clicks
 * twice, cron overlaps, or a status write fails after the emit went out) and
 * short enough that the ledger stays bounded in memory.
 */
export const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000;

/** Upper bound on ledger entries so a DLQ storm cannot grow it without limit. */
export const DEFAULT_DEDUPE_MAX_ENTRIES = 10_000;

/**
 * Bounded, TTL-based ledger of dispatch ids that were already delivered
 * (Issue #851).
 *
 * The DLQ guarantees at-least-once delivery, so a replay can run more than
 * once for the same row. Without a ledger, a retry that follows an emit whose
 * status write failed re-broadcasts the event and clients see it twice.
 * Recordings are keyed by the dispatch id (the DLQ row id) and expire after
 * `ttlMs`, so memory stays bounded no matter how many rows are replayed.
 */
export class DispatchDeduper {
  /** dispatchId → epoch ms at which the recording expires. */
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = DEFAULT_DEDUPE_TTL_MS,
    private readonly maxEntries: number = DEFAULT_DEDUPE_MAX_ENTRIES,
  ) {}

  /** True when the dispatch id was delivered within the TTL window. */
  has(dispatchId: string, nowMs: number = Date.now()): boolean {
    const expiresAt = this.entries.get(dispatchId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= nowMs) {
      this.entries.delete(dispatchId);
      return false;
    }
    return true;
  }

  /** Remember that `dispatchId` was delivered, expiring after the TTL. */
  mark(dispatchId: string, nowMs: number = Date.now()): void {
    if (!this.entries.has(dispatchId) && this.entries.size >= this.maxEntries) {
      this.evictExpired(nowMs);
      // Still full: drop the oldest recordings (Map keeps insertion order).
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(dispatchId, nowMs + this.ttlMs);
  }

  /** Drop every expired recording. */
  evictExpired(nowMs: number = Date.now()): number {
    let removed = 0;
    for (const [id, expiresAt] of this.entries) {
      if (expiresAt <= nowMs) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Test helper: forget every recording. */
  reset(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Process-wide replay ledger shared by every DLQ replay entry point. */
export const dlqReplayDeduper = new DispatchDeduper();

export interface RecordFailureInput {
  channel: DispatchChannel;
  eventName?: string | null;
  userId?: string | null;
  payload: unknown;
  error: unknown;
}

export interface RetryHandlers {
  /**
   * Replay a `NOTIFICATION_CREATE` row. Receives the original
   * `createNotification` input that was stored as `payload`.
   */
  notificationCreate: (payload: any) => Promise<unknown>;
  /**
   * Replay a `WEBSOCKET_EMIT` row. Receives `{ eventName, userId, payload }`.
   * Callers should map `eventName` back onto the appropriate
   * `websocketService.emit*` method.
   */
  websocketEmit: (input: {
    eventName: string | null;
    userId: string | null;
    payload: any;
  }) => Promise<unknown> | unknown;
}

export interface RetryResult {
  id: string;
  status: DispatchStatus;
  attempts: number;
  /**
   * True when this replay was suppressed because another replay already won
   * the dispatch for this id (Issue #851). The row state is returned unchanged
   * (or settled to RESOLVED when the ledger proves delivery already happened).
   */
  deduped?: boolean;
}

export interface RetryDryRunResult {
  dryRun: true;
  id: string;
  channel: DispatchChannel;
  eventName: string | null;
  userId: string | null;
  status: DispatchStatus;
  attempts: number;
  redactedPayload: unknown;
}

export interface RetryOptions {
  dryRun?: boolean;
  maxAttempts?: number;
}

export interface ListOptions {
  status?: DispatchStatus;
  channel?: DispatchChannel;
  limit?: number;
  offset?: number;
}

function truncateError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.stack || err.message || String(err)
      : typeof err === "string"
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return String(err);
            }
          })();
  return raw.length > MAX_ERROR_LEN ? raw.slice(0, MAX_ERROR_LEN) : raw;
}

class DeadLetterQueueService {
  /**
   * Record a dispatch failure. Never throws — a DLQ that crashes its caller
   * defeats the whole point of a DLQ. On a DB error this only logs and
   * returns `null` so the original call path stays unaffected.
   */
  async record(input: RecordFailureInput): Promise<{ id: string } | null> {
    try {
      const row = await prisma.failedDispatch.create({
        data: {
          channel: input.channel,
          eventName: input.eventName ?? null,
          userId: input.userId ?? null,
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
          attempts: 1,
          status: DispatchStatus.PENDING,
          lastError: truncateError(input.error),
        },
        select: { id: true },
      });
      logger.warn("Dispatch failure recorded in DLQ", {
        id: row.id,
        channel: input.channel,
        eventName: input.eventName ?? null,
        userId: input.userId ?? null,
      });
      return row;
    } catch (err) {
      logger.error("Failed to persist DLQ entry", { error: err });
      return null;
    }
  }

  /**
   * Page over DLQ rows, newest first. Defaults to `PENDING` so an operator
   * eyeballing `/api/admin/dead-letter` sees actionable rows by default.
   */
  async list(
    options: ListOptions = {},
  ): Promise<{ entries: any[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const where: Prisma.FailedDispatchWhereInput = {};
    if (options.status) where.status = options.status;
    if (options.channel) where.channel = options.channel;

    const [entries, total] = await Promise.all([
      prisma.failedDispatch.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
      }),
      prisma.failedDispatch.count({ where }),
    ]);
    const redactedEntries = entries.map(row => ({
      ...row,
      payload: redactDlqPayload(row.payload),
    }));
    return { entries: redactedEntries, total, limit, offset };
  }

  /**
   * Replay one DLQ row. Wrapped in try/catch: on success the row is moved
   * to `RESOLVED`; on failure `attempts` is bumped and the row is moved to
   * `ABANDONED` once the cap is reached. Returns the final row state.
   */
  async retry(
    id: string,
    handlers: RetryHandlers,
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
    options: RetryOptions = {},
  ): Promise<RetryResult | RetryDryRunResult | null> {
    const row = await prisma.failedDispatch.findUnique({ where: { id } });
    if (!row) {
      logger.warn(`DLQ retry: entry ${id} not found`);
      return null;
    }
    if (options.dryRun) {
      return {
        dryRun: true,
        id: row.id,
        channel: row.channel,
        eventName: row.eventName,
        userId: row.userId,
        status: row.status,
        attempts: row.attempts,
        redactedPayload: redactDlqPayload(row.payload),
      };
    }
    if (row.status === DispatchStatus.RESOLVED) {
      // Idempotency: a replayed RESOLVED row is a no-op, not an error.
      return { id: row.id, status: row.status, attempts: row.attempts };
    }

    // Issue #851: the DLQ row id *is* the dispatch id. If this dispatch was
    // already delivered by an earlier attempt whose status write failed, settle
    // the row instead of re-broadcasting it.
    if (dlqReplayDeduper.has(row.id)) {
      logger.warn(`DLQ retry skipped: dispatch already delivered`, {
        id,
        channel: row.channel,
      });
      const settled = await prisma.failedDispatch.update({
        where: { id },
        data: {
          status: DispatchStatus.RESOLVED,
          resolvedAt: new Date(),
          lastRetryAt: new Date(),
          attempts: { increment: 1 },
        },
        select: { id: true, status: true, attempts: true },
      });
      return { ...settled, deduped: true };
    }

    // Issue #851: claim the row atomically before dispatching. Two concurrent
    // replays (admin retry + retryAll, or two replicas) both read the row as
    // PENDING above; only one of them can flip it to RETRYING, so only one
    // invokes the handler. The loser returns the current row state without
    // emitting.
    const claim = await prisma.failedDispatch.updateMany({
      where: {
        id,
        status: { in: [DispatchStatus.PENDING, DispatchStatus.RETRYING] },
      },
      data: {
        status: DispatchStatus.RETRYING,
        lastRetryAt: new Date(),
      },
    });
    if (claim.count === 0) {
      const current = await prisma.failedDispatch.findUnique({ where: { id } });
      logger.warn(`DLQ retry skipped: dispatch is already being replayed`, {
        id,
        channel: row.channel,
        status: current?.status ?? row.status,
      });
      return {
        id,
        status: current?.status ?? row.status,
        attempts: current?.attempts ?? row.attempts,
        deduped: true,
      };
    }

    try {
      if (row.channel === DispatchChannel.NOTIFICATION_CREATE) {
        await handlers.notificationCreate(row.payload as any);
      } else {
        await handlers.websocketEmit({
          eventName: row.eventName,
          userId: row.userId,
          payload: row.payload as any,
        });
      }
    } catch (err) {
      const nextAttempts = row.attempts + 1;
      const nextStatus =
        nextAttempts >= maxAttempts
          ? DispatchStatus.ABANDONED
          : DispatchStatus.RETRYING;
      const updated = await prisma.failedDispatch.update({
        where: { id },
        data: {
          status: nextStatus,
          attempts: nextAttempts,
          lastRetryAt: new Date(),
          lastError: truncateError(err),
        },
        select: { id: true, status: true, attempts: true },
      });
      logger.error(`DLQ retry failed`, {
        id,
        channel: row.channel,
        attempts: nextAttempts,
        status: nextStatus,
      });
      return updated;
    }

    // Mark the dispatch id as delivered *before* writing the status: if the
    // status write fails, the next retry settles the row (above) instead of
    // emitting the event a second time.
    dlqReplayDeduper.mark(row.id);

    const resolved = await prisma.failedDispatch.update({
      where: { id },
      data: {
        status: DispatchStatus.RESOLVED,
        resolvedAt: new Date(),
        lastRetryAt: new Date(),
        attempts: { increment: 1 },
      },
      select: { id: true, status: true, attempts: true },
    });
    logger.info(`DLQ retry succeeded`, { id, channel: row.channel });
    return resolved;
  }

  /**
   * Replay every `PENDING` / `RETRYING` row, capped to `limit`. Returns a
   * count summary so the admin route can render a useful response.
   */
  async retryAll(
    handlers: RetryHandlers,
    limit: number = 50,
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
    options: RetryOptions = {},
  ): Promise<
    | {
        attempted: number;
        resolved: number;
        failed: number;
        abandoned: number;
      }
    | { dryRun: true; attempted: number; previews: RetryDryRunResult[] }
  > {
    const capped = Math.min(Math.max(limit, 1), 200);
    const rows = await prisma.failedDispatch.findMany({
      where: {
        status: { in: [DispatchStatus.PENDING, DispatchStatus.RETRYING] },
      },
      orderBy: { createdAt: "asc" },
      take: capped,
    });

    if (options.dryRun) {
      const previews: RetryDryRunResult[] = rows.map(row => ({
        dryRun: true,
        id: row.id,
        channel: row.channel,
        eventName: row.eventName,
        userId: row.userId,
        status: row.status,
        attempts: row.attempts,
        redactedPayload: redactDlqPayload(row.payload),
      }));
      return { dryRun: true, attempted: rows.length, previews };
    }

    let resolved = 0;
    let failed = 0;
    let abandoned = 0;
    for (const r of rows) {
      const result = await this.retry(r.id, handlers, maxAttempts);
      if (!result || "dryRun" in result) continue;
      if (result.status === DispatchStatus.RESOLVED) resolved += 1;
      else if (result.status === DispatchStatus.ABANDONED) {
        abandoned += 1;
        failed += 1;
      } else failed += 1;
    }
    return { attempted: rows.length, resolved, failed, abandoned };
  }

  /**
   * Delete `RESOLVED` rows older than `daysOld` so the table doesn't grow
   * forever. Mirrors the cleanup pattern used by `notification.service`.
   */
  async cleanupResolved(daysOld: number = 7): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);
    const result = await prisma.failedDispatch.deleteMany({
      where: {
        status: DispatchStatus.RESOLVED,
        resolvedAt: { lt: cutoff },
      },
    });
    return result.count;
  }
}

export const deadLetterQueueService = new DeadLetterQueueService();
export default deadLetterQueueService;

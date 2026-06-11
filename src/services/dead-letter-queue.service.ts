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
    return { entries, total, limit, offset };
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
  ): Promise<RetryResult | null> {
    const row = await prisma.failedDispatch.findUnique({ where: { id } });
    if (!row) {
      logger.warn(`DLQ retry: entry ${id} not found`);
      return null;
    }
    if (row.status === DispatchStatus.RESOLVED) {
      // Idempotency: a replayed RESOLVED row is a no-op, not an error.
      return { id: row.id, status: row.status, attempts: row.attempts };
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
  }

  /**
   * Replay every `PENDING` / `RETRYING` row, capped to `limit`. Returns a
   * count summary so the admin route can render a useful response.
   */
  async retryAll(
    handlers: RetryHandlers,
    limit: number = 50,
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  ): Promise<{
    attempted: number;
    resolved: number;
    failed: number;
    abandoned: number;
  }> {
    const capped = Math.min(Math.max(limit, 1), 200);
    const rows = await prisma.failedDispatch.findMany({
      where: {
        status: { in: [DispatchStatus.PENDING, DispatchStatus.RETRYING] },
      },
      orderBy: { createdAt: "asc" },
      take: capped,
      select: { id: true },
    });

    let resolved = 0;
    let failed = 0;
    let abandoned = 0;
    for (const r of rows) {
      const result = await this.retry(r.id, handlers, maxAttempts);
      if (!result) continue;
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

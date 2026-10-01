/**
 * Transactional outbox processor (Issue #18).
 *
 * ## Why this exists
 * Before this change, `resolution.service.ts` called
 * `notificationService.createNotification()` and
 * `websocketService.emitNotification()` *after* the Prisma transaction
 * committed. If the process crashed between the commit and those calls the
 * side-effects were silently lost — a player would never learn they won.
 *
 * ## How it works
 * 1. The business transaction (payout, prediction, …) writes one or more
 *    `OutboxEvent` rows *inside the same `prisma.$transaction()`* call.
 *    Because both the state change and the event row commit atomically,
 *    the event can never be lost.
 * 2. A background poller (driven by `scheduler.service.ts`) calls
 *    `processOutbox()` on a configurable interval.
 * 3. For each PENDING row the poller:
 *    a. Marks it PROCESSING (prevents double-dispatch across instances).
 *    b. Dispatches the event (notification create or websocket emit).
 *    c. On success: marks it PROCESSED.
 *    d. On failure: increments `attempts`; marks FAILED once the cap is
 *       reached and escalates to the existing FailedDispatch DLQ so an
 *       operator can replay it via `/api/admin/dead-letter`.
 *
 * ## Env vars
 * - `OUTBOX_POLL_INTERVAL_SECONDS` – how often the poller runs (default 10).
 * - `OUTBOX_BATCH_SIZE`            – rows per poll cycle (default 50).
 * - `OUTBOX_MAX_ATTEMPTS`          – before escalating to DLQ (default 3).
 * - `OUTBOX_RETRY_BASE_MS`         – first retry delay; doubles per attempt (default 1000).
 * - `OUTBOX_RETRY_MAX_MS`          – cap on the exponential delay (default 60000).
 * - `OUTBOX_RETRY_JITTER_RATIO`    – fractional jitter added to the delay (default 0.2).
 * - `OUTBOX_RETENTION_DAYS`        – days to keep PROCESSED rows (default 7).
 *
 * Retry safety (Issue #713): a failed row stores `nextAttemptAt`, so the next
 * poll skips it until the backoff elapses instead of hammering a poison event
 * (and Postgres) on every cron tick.
 */
import { OutboxEventStatus, OutboxEventType, DispatchChannel } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import deadLetterQueueService from './dead-letter-queue.service';

// ─── tunables ────────────────────────────────────────────────────────────────

export function getOutboxPollIntervalSeconds(): number {
  const raw = process.env.OUTBOX_POLL_INTERVAL_SECONDS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10;
}

export function getOutboxBatchSize(): number {
  const raw = process.env.OUTBOX_BATCH_SIZE;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 50;
}

export function getOutboxMaxAttempts(): number {
  const raw = process.env.OUTBOX_MAX_ATTEMPTS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 3;
}

export function getOutboxRetryBaseMs(): number {
  const raw = process.env.OUTBOX_RETRY_BASE_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

export function getOutboxRetryMaxMs(): number {
  const raw = process.env.OUTBOX_RETRY_MAX_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

export function getOutboxRetryJitterRatio(): number {
  const raw = process.env.OUTBOX_RETRY_JITTER_RATIO;
  const n = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.2;
}

/**
 * Exponential backoff with jitter and a hard cap (Issue #713).
 *
 * Attempt 1 → baseMs, attempt 2 → 2×baseMs, … capped at maxMs, plus up to
 * `jitterRatio` of the window so a fleet of replicas does not retry in
 * lockstep. Exported so the delay curve is unit-testable without a DB.
 */
export function computeOutboxBackoffMs(
  attempt: number,
  options: {
    baseMs?: number;
    maxMs?: number;
    jitterRatio?: number;
    random?: () => number;
  } = {},
): number {
  const baseMs = options.baseMs ?? getOutboxRetryBaseMs();
  const maxMs = options.maxMs ?? getOutboxRetryMaxMs();
  const jitterRatio = options.jitterRatio ?? getOutboxRetryJitterRatio();
  const random = options.random ?? Math.random;

  const exponent = Math.max(1, Math.floor(attempt)) - 1;
  const exponential = Math.min(maxMs, baseMs * 2 ** exponent);
  const jitter = Math.floor(random() * exponential * jitterRatio);

  return Math.min(maxMs, Math.max(1, exponential + jitter));
}

export function getOutboxRetentionDays(): number {
  const raw = process.env.OUTBOX_RETENTION_DAYS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 7;
}

// ─── payload shapes ──────────────────────────────────────────────────────────

export interface NotificationOutboxPayload {
  userId: string;
  type: 'WIN' | 'LOSS' | 'ROUND_START' | 'BONUS_AVAILABLE' | 'ANNOUNCEMENT';
  title: string;
  message: string;
  data?: unknown;
}

export interface WebsocketOutboxPayload {
  eventName: string;
  room: string;
  data: unknown;
  userId?: string | null;
}

export interface BetAcceptedOutboxPayload {
  betId: string;
  userId: string;
  roundId: string | null;
  mode: 'UP_DOWN' | 'PRECISION';
  side?: 'UP' | 'DOWN';
  amount: number;
  predictedPrice?: number;
  state: 'accepted' | 'stub';
  txHash?: string;
  requestId?: string;
  correlationId?: string;
}

export interface BetConfirmedOutboxPayload {
  betId: string;
  userId: string;
  roundId: string | null;
  mode: 'UP_DOWN' | 'PRECISION';
  txHash: string;
  requestId?: string;
  correlationId?: string;
}

export interface BetResolvedOutboxPayload {
  betId: string;
  userId: string;
  roundId: string;
  mode: 'UP_DOWN' | 'PRECISION';
  won: boolean;
  payout: number;
  requestId?: string;
  correlationId?: string;
}

export interface BetFailedOutboxPayload {
  betId: string;
  userId: string;
  roundId: string | null;
  mode: 'UP_DOWN' | 'PRECISION';
  failureReason: string;
  requestId?: string;
  correlationId?: string;
}

// ─── dispatch handlers (injected so the service stays testable) ───────────────

export interface OutboxDispatchHandlers {
  notificationCreate: (payload: NotificationOutboxPayload) => Promise<unknown>;
  websocketEmit: (payload: WebsocketOutboxPayload) => void | Promise<void>;
  betAccepted: (payload: BetAcceptedOutboxPayload) => Promise<unknown>;
  betConfirmed: (payload: BetConfirmedOutboxPayload) => Promise<unknown>;
  betResolved: (payload: BetResolvedOutboxPayload) => Promise<unknown>;
  betFailed: (payload: BetFailedOutboxPayload) => Promise<unknown>;
}

// ─── truncation helper (mirrors DLQ) ─────────────────────────────────────────

const MAX_ERROR_LEN = 1000;

function truncateError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.stack || err.message || String(err)
      : typeof err === 'string'
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

// ─── service ─────────────────────────────────────────────────────────────────

export interface ProcessOutboxResult {
  processed: number;
  failed: number;
  escalated: number;
}

class OutboxService {
  /**
   * Poll for PENDING outbox events and dispatch them.
   * Called by the scheduler; safe to call concurrently across instances
   * because each row is claimed with a PROCESSING status update before
   * dispatch (optimistic claim — not a DB-level lock, but sufficient for
   * low-frequency polling where double-dispatch is acceptable and
   * idempotent notification creates are harmless).
   */
  async processOutbox(
    handlers: OutboxDispatchHandlers,
    batchSize: number = getOutboxBatchSize(),
    maxAttempts: number = getOutboxMaxAttempts(),
  ): Promise<ProcessOutboxResult> {
    const result: ProcessOutboxResult = { processed: 0, failed: 0, escalated: 0 };

    const now = new Date();
    const rows = await prisma.outboxEvent.findMany({
      where: {
        status: OutboxEventStatus.PENDING,
        // Rows with a future `nextAttemptAt` are still backing off and must
        // not be reselected yet (Issue #713).
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });

    if (rows.length === 0) return result;

    logger.debug(`Outbox poller: found ${rows.length} pending event(s)`);

    for (const row of rows) {
      // Claim the row — mark PROCESSING so a concurrent poller skips it.
      // If the update races and the row was already claimed, skip it.
      const claimed = await prisma.outboxEvent
        .updateMany({
          where: { id: row.id, status: OutboxEventStatus.PENDING },
          data: { status: OutboxEventStatus.PROCESSING, updatedAt: new Date() },
        })
        .catch(() => ({ count: 0 }));

      if (claimed.count === 0) {
        // Another poller instance claimed it first — skip.
        continue;
      }

      try {
        await this.dispatch(row, handlers);

        await prisma.outboxEvent.update({
          where: { id: row.id },
          data: {
            status: OutboxEventStatus.PROCESSED,
            processedAt: new Date(),
            nextAttemptAt: null,
            updatedAt: new Date(),
          },
        });

        result.processed += 1;
        logger.debug(`Outbox: dispatched event ${row.id} (${row.eventType})`);
      } catch (err) {
        const nextAttempts = row.attempts + 1;
        const exhausted = nextAttempts >= maxAttempts;
        const backoffMs = exhausted
          ? 0
          : computeOutboxBackoffMs(nextAttempts);

        await prisma.outboxEvent.update({
          where: { id: row.id },
          data: {
            status: exhausted ? OutboxEventStatus.FAILED : OutboxEventStatus.PENDING,
            attempts: nextAttempts,
            lastError: truncateError(err),
            // Nothing left to wait for once we escalate to the DLQ.
            nextAttemptAt: exhausted ? null : new Date(Date.now() + backoffMs),
            updatedAt: new Date(),
          },
        });

        result.failed += 1;

        if (exhausted) {
          // Escalate to the existing DLQ so an operator can replay it.
          await deadLetterQueueService.record({
            channel:
              row.eventType === OutboxEventType.NOTIFICATION_CREATE
                ? DispatchChannel.NOTIFICATION_CREATE
                : DispatchChannel.WEBSOCKET_EMIT,
            eventName: (row.payload as any)?.eventName ?? row.eventType,
            userId: (row.payload as any)?.userId ?? null,
            payload: row.payload,
            error: err,
          });
          result.escalated += 1;
          logger.warn(`Outbox: event ${row.id} exhausted ${maxAttempts} attempts; escalated to DLQ`);
        } else {
          logger.warn(
            `Outbox: dispatch failed for event ${row.id} (attempt ${nextAttempts}/${maxAttempts}); retrying in ${backoffMs}ms`,
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }

    return result;
  }

  /**
   * Dispatch a single outbox row to the appropriate handler.
   */
  private async dispatch(
    row: { id: string; eventType: OutboxEventType; payload: unknown },
    handlers: OutboxDispatchHandlers,
  ): Promise<void> {
    switch (row.eventType) {
      case OutboxEventType.NOTIFICATION_CREATE:
        await handlers.notificationCreate(row.payload as NotificationOutboxPayload);
        break;
      case OutboxEventType.WEBSOCKET_EMIT:
        await handlers.websocketEmit(row.payload as WebsocketOutboxPayload);
        break;
      case OutboxEventType.BET_ACCEPTED:
        await handlers.betAccepted(row.payload as BetAcceptedOutboxPayload);
        break;
      case OutboxEventType.BET_CONFIRMED:
        await handlers.betConfirmed(row.payload as BetConfirmedOutboxPayload);
        break;
      case OutboxEventType.BET_RESOLVED:
        await handlers.betResolved(row.payload as BetResolvedOutboxPayload);
        break;
      case OutboxEventType.BET_FAILED:
        await handlers.betFailed(row.payload as BetFailedOutboxPayload);
        break;
      default:
        throw new Error(`Unknown outbox event type: ${row.eventType}`);
    }
  }

  /**
   * Delete PROCESSED rows older than `retentionDays` to keep the table lean.
   * Called by the scheduler alongside other retention jobs.
   */
  async cleanupProcessed(retentionDays: number = getOutboxRetentionDays()): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const result = await prisma.outboxEvent.deleteMany({
      where: {
        status: OutboxEventStatus.PROCESSED,
        processedAt: { lt: cutoff },
      },
    });

    if (result.count > 0) {
      logger.info(`Outbox cleanup: deleted ${result.count} processed event(s) older than ${retentionDays} day(s)`);
    }

    return result.count;
  }
}

export const outboxService = new OutboxService();
export default outboxService;

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
 * - `OUTBOX_RETENTION_DAYS`        – days to keep PROCESSED rows (default 7).
 * - `OUTBOX_DB_RETRY_MAX_ATTEMPTS` – DB retries per poller query (default 3).
 * - `OUTBOX_DB_RETRY_INITIAL_DELAY_MS` – first backoff delay (default 250).
 * - `OUTBOX_DB_RETRY_MAX_DELAY_MS` – backoff ceiling (default 5000).
 *
 * ## DB failure policy (Issue #853)
 * Every database call in the poll loop goes through `withRetry` from
 * `retry.util`, which retries with exponential backoff and a capped delay.
 * Without it a failing/overloaded database turns each poll into an immediate
 * retry (and a log storm) at the scheduler's cadence; a short backoff gives
 * the connection pool time to recover and keeps the poller from becoming a
 * self-inflicted load generator.
 */
import { OutboxEventStatus, OutboxEventType, DispatchChannel } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import { withRetry } from '../utils/retry.util';
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

export function getOutboxRetentionDays(): number {
  const raw = process.env.OUTBOX_RETENTION_DAYS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 7;
}

/** Upper bound on DB retry attempts so a misconfiguration cannot stall a poll forever. */
export function getOutboxDbRetryMaxAttempts(): number {
  const raw = process.env.OUTBOX_DB_RETRY_MAX_ATTEMPTS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 3;
}

export function getOutboxDbRetryInitialDelayMs(): number {
  const raw = process.env.OUTBOX_DB_RETRY_INITIAL_DELAY_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30_000) : 250;
}

export function getOutboxDbRetryMaxDelayMs(): number {
  const raw = process.env.OUTBOX_DB_RETRY_MAX_DELAY_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60_000) : 5_000;
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
   * Run one database operation with exponential backoff (Issue #853).
   *
   * Poller DB calls previously surfaced the first failure immediately: the
   * scheduler caught it, logged it, and the next cron tick retried right away.
   * On a DB outage that is a tight, noisy loop. `withRetry` backs off between
   * attempts and gives up after a bounded number so the poll cycle ends and
   * the next scheduled tick starts a fresh, later attempt.
   */
  private async runDbOperation<T>(
    operationName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = await withRetry(operation, `outbox.${operationName}`, {
      maxAttempts: getOutboxDbRetryMaxAttempts(),
      initialDelayMs: getOutboxDbRetryInitialDelayMs(),
      maxDelayMs: getOutboxDbRetryMaxDelayMs(),
      backoffMultiplier: 2,
      // Everything wrapped here is a database read/write. Connection resets,
      // pool exhaustion and driver-level errors do not always carry a Prisma
      // error code, so treat every rejection as retryable rather than
      // depending on retry.util's default code allow-list.
      isRetryable: () => true,
    });

    if (!result.success) {
      logger.error(
        `Outbox poller: ${operationName} failed after ${result.attemptsUsed} attempt(s)`,
        {
          error: result.error?.message,
          totalDurationMs: result.totalDurationMs,
        },
      );
      throw result.error ?? new Error(`${operationName} failed`);
    }

    return result.data as T;
  }

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

    const rows = await this.runDbOperation('findPending', () =>
      prisma.outboxEvent.findMany({
        where: { status: OutboxEventStatus.PENDING },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
      }),
    );

    if (rows.length === 0) return result;

    logger.debug(`Outbox poller: found ${rows.length} pending event(s)`);

    for (const row of rows) {
      // Claim the row — mark PROCESSING so a concurrent poller skips it.
      // If the update races and the row was already claimed, skip it.
      const claimed = await this.runDbOperation('claim', () =>
        prisma.outboxEvent.updateMany({
          where: { id: row.id, status: OutboxEventStatus.PENDING },
          data: { status: OutboxEventStatus.PROCESSING, updatedAt: new Date() },
        }),
      );

      if (claimed.count === 0) {
        // Another poller instance claimed it first — skip.
        continue;
      }

      try {
        await this.dispatch(row, handlers);

        await this.runDbOperation('markProcessed', () =>
          prisma.outboxEvent.update({
            where: { id: row.id },
            data: {
              status: OutboxEventStatus.PROCESSED,
              processedAt: new Date(),
              updatedAt: new Date(),
            },
          }),
        );

        result.processed += 1;
        logger.debug(`Outbox: dispatched event ${row.id} (${row.eventType})`);
      } catch (err) {
        const nextAttempts = row.attempts + 1;
        const exhausted = nextAttempts >= maxAttempts;

        await this.runDbOperation('markFailed', () =>
          prisma.outboxEvent.update({
            where: { id: row.id },
            data: {
              status: exhausted ? OutboxEventStatus.FAILED : OutboxEventStatus.PENDING,
              attempts: nextAttempts,
              lastError: truncateError(err),
              updatedAt: new Date(),
            },
          }),
        );

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
          logger.warn(`Outbox: dispatch failed for event ${row.id} (attempt ${nextAttempts}/${maxAttempts})`, {
            error: err instanceof Error ? err.message : String(err),
          });
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

    const result = await this.runDbOperation('cleanupProcessed', () =>
      prisma.outboxEvent.deleteMany({
        where: {
          status: OutboxEventStatus.PROCESSED,
          processedAt: { lt: cutoff },
        },
      }),
    );

    if (result.count > 0) {
      logger.info(`Outbox cleanup: deleted ${result.count} processed event(s) older than ${retentionDays} day(s)`);
    }

    return result.count;
  }
}

export const outboxService = new OutboxService();
export default outboxService;

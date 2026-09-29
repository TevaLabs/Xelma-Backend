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
 *    e. On an *unknown* `eventType` (Issue #668): marks FAILED immediately,
 *       records a DLQ entry (payload + type + error), increments the
 *       `outbox_unknown_event_type` metric, and continues with the next row
 *       — a single bad event can no longer stall the dispatcher.
 *
 * ## Env vars
 * - `OUTBOX_POLL_INTERVAL_SECONDS` – how often the poller runs (default 10).
 * - `OUTBOX_BATCH_SIZE`            – rows per poll cycle (default 50).
 * - `OUTBOX_MAX_ATTEMPTS`          – before escalating to DLQ (default 3).
 * - `OUTBOX_RETENTION_DAYS`        – days to keep PROCESSED rows (default 7).
 */
import { OutboxEventStatus, OutboxEventType, DispatchChannel } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import deadLetterQueueService from './dead-letter-queue.service';
import { outboxUnknownEventTypeTotal } from '../metrics/application.metrics';

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

// ─── known event catalog (Issue #668) ─────────────────────────────────────────

/**
 * Typed catalog of every `OutboxEventType` the dispatcher knows how to
 * dispatch. Derived from the Prisma enum so the two can never drift at the
 * type level; the `default:` branch in {@link OutboxService.dispatch} is the
 * runtime guard for an enum value that was added in one PR without updating
 * the switch below.
 *
 * When you extend `OutboxEventType` in `prisma/schema.prisma`:
 *   1. Add the payload interface + dispatch handler to
 *      {@link OutboxDispatchHandlers} and the `switch` in `dispatch`.
 *   2. Extend `KNOWN_OUTBOX_EVENTS` so the compiler forces you to wire the
 *      new member into every consumer of this catalog.
 * If you skip step 1, the row is no longer dispatched — it is routed to the
 * DLQ with an `outbox_unknown_event_type` metric bump instead of stalling
 * the whole notification/websocket fan-out (Issue #668).
 */
export const KNOWN_OUTBOX_EVENTS = [
  OutboxEventType.NOTIFICATION_CREATE,
  OutboxEventType.WEBSOCKET_EMIT,
  OutboxEventType.BET_ACCEPTED,
  OutboxEventType.BET_CONFIRMED,
  OutboxEventType.BET_RESOLVED,
  OutboxEventType.BET_FAILED,
] as const;

export type KnownOutboxEvent = (typeof KNOWN_OUTBOX_EVENTS)[number];

/** Runtime narrowing helper: is this event type in the known catalog? */
export function isKnownOutboxEvent(eventType: string): eventType is KnownOutboxEvent {
  return (KNOWN_OUTBOX_EVENTS as readonly string[]).includes(eventType);
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

/**
 * Best-effort next attempt value for rows we mark FAILED outside the normal
 * retry ladder (Issue #668 unknown-event routing). Mirrors `row.attempts + 1`
 * but tolerates a malformed/null counter from a bad row.
 */
function nextAttemptSafe(attempts: number | null | undefined): number {
  const n = typeof attempts === 'number' && Number.isFinite(attempts) ? attempts : 0;
  return n + 1;
}

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
  /** Rows whose `eventType` was not in the catalog; routed to the DLQ. */
  unknown: number;
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
    const result: ProcessOutboxResult = { processed: 0, failed: 0, escalated: 0, unknown: 0 };

    const rows = await prisma.outboxEvent.findMany({
      where: { status: OutboxEventStatus.PENDING },
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
            updatedAt: new Date(),
          },
        });

        result.processed += 1;
        logger.debug(`Outbox: dispatched event ${row.id} (${row.eventType})`);
      } catch (err) {
        // Issue #668: an unknown event type must not throw and stall the
        // dispatcher — one bad row should never block notifications and
        // websocket fan-out for everyone. Route it to the DLQ immediately
        // (no retry loop; the error is deterministic, not transient) and
        // keep processing the remaining rows.
        if (!isKnownOutboxEvent(row.eventType)) {
          await prisma.outboxEvent.update({
            where: { id: row.id },
            data: {
              status: OutboxEventStatus.FAILED,
              attempts: nextAttemptSafe(row.attempts),
              lastError: truncateError(err),
              updatedAt: new Date(),
            },
          });

          result.failed += 1;
          result.unknown += 1;

          outboxUnknownEventTypeTotal.inc({ eventType: String(row.eventType) });

          await deadLetterQueueService.record({
            channel: DispatchChannel.WEBSOCKET_EMIT,
            eventName: `unknown:${row.eventType}`,
            userId: null,
            payload: row.payload,
            error: err,
          });

          logger.warn(
            `Outbox: unknown event type "${row.eventType}" for event ${row.id}; routed to DLQ and continuing`,
          );
          continue;
        }

        const nextAttempts = row.attempts + 1;
        const exhausted = nextAttempts >= maxAttempts;

        await prisma.outboxEvent.update({
          where: { id: row.id },
          data: {
            status: exhausted ? OutboxEventStatus.FAILED : OutboxEventStatus.PENDING,
            attempts: nextAttempts,
            lastError: truncateError(err),
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
   *
   * Throws on an unknown `eventType` (Issue #668); `processOutbox` catches
   * that, routes the row to the DLQ with an `outbox_unknown_event_type`
   * metric bump, and moves on to the next row instead of rethrowing.
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

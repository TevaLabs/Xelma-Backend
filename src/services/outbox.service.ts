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
 */
import { OutboxEventStatus, OutboxEventType, DispatchChannel } from '@prisma/client';
import { Counter, register } from 'prom-client';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import deadLetterQueueService from './dead-letter-queue.service';

// ─── event catalog (Issue #554) ───────────────────────────────────────────────

export interface OutboxCatalogEntry {
  eventType: string;
  channel: DispatchChannel;
  description: string;
}

export const OUTBOX_EVENT_CATALOG: Record<string, OutboxCatalogEntry> = {
  [OutboxEventType.NOTIFICATION_CREATE]: {
    eventType: OutboxEventType.NOTIFICATION_CREATE,
    channel: DispatchChannel.NOTIFICATION_CREATE,
    description: 'Notification creation event',
  },
  [OutboxEventType.WEBSOCKET_EMIT]: {
    eventType: OutboxEventType.WEBSOCKET_EMIT,
    channel: DispatchChannel.WEBSOCKET_EMIT,
    description: 'Websocket payload emit event',
  },
};

export type KnownOutboxEventType = keyof typeof OUTBOX_EVENT_CATALOG;

export function isKnownOutboxEventType(eventType: string): boolean {
  return Object.prototype.hasOwnProperty.call(OUTBOX_EVENT_CATALOG, eventType);
}

export function getOutboxCatalogEntry(eventType: string): OutboxCatalogEntry | null {
  return OUTBOX_EVENT_CATALOG[eventType] ?? null;
}

// ─── metrics (Issue #554) ─────────────────────────────────────────────────────

const UNKNOWN_OUTBOX_EVENT_METRIC_NAME = 'outbox_unknown_event_types_total';

let unknownOutboxEventCounter = register.getSingleMetric(
  UNKNOWN_OUTBOX_EVENT_METRIC_NAME
) as Counter<string>;

if (!unknownOutboxEventCounter) {
  unknownOutboxEventCounter = new Counter({
    name: UNKNOWN_OUTBOX_EVENT_METRIC_NAME,
    help: 'Total count of unknown outbox event types routed to DLQ',
    labelNames: ['eventType'] as const,
    registers: [register],
  });
}

export function recordUnknownOutboxEventTypeMetric(eventType: string): void {
  try {
    unknownOutboxEventCounter.inc({ eventType });
  } catch (err) {
    logger.error('Failed to increment unknown outbox event type metric:', err);
  }
}

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

      // Check for unknown event types against our typed catalog (Issue #554).
      if (!isKnownOutboxEventType(row.eventType)) {
        const errorMsg = `Unknown outbox event type: ${row.eventType}`;
        recordUnknownOutboxEventTypeMetric(row.eventType);

        await prisma.outboxEvent.update({
          where: { id: row.id },
          data: {
            status: OutboxEventStatus.FAILED,
            attempts: row.attempts + 1,
            lastError: truncateError(errorMsg),
            updatedAt: new Date(),
          },
        });

        await deadLetterQueueService.record({
          channel: DispatchChannel.NOTIFICATION_CREATE,
          eventName: `UNKNOWN_EVENT:${row.eventType}`,
          userId: (row.payload as any)?.userId ?? null,
          payload: {
            originalPayload: row.payload,
            eventType: row.eventType,
            catalogEntry: null,
            reason: 'UNKNOWN_OUTBOX_EVENT_TYPE',
          },
          error: new Error(errorMsg),
        });

        result.failed += 1;
        result.escalated += 1;
        logger.warn(`Outbox: event ${row.id} has unknown eventType '${row.eventType}'; routed to DLQ`);
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
          const catalogEntry = getOutboxCatalogEntry(row.eventType);
          await deadLetterQueueService.record({
            channel: catalogEntry ? catalogEntry.channel : DispatchChannel.NOTIFICATION_CREATE,
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

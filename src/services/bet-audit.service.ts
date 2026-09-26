/**
 * Bet Audit Service
 *
 * Provides structured audit events across the bet lifecycle.
 * Designed for analytics, debugging, dispute support, and on-chain migration.
 *
 * Events:
 *   BET_ACCEPTED   bet was accepted (stub or confirmed on-chain)
 *   BET_FAILED     on-chain submission was rejected
 *   BET_RECONCILED an existing record was matched to its transaction hash
 *
 * Event schema (same across all storage modes):
 * {
 *   event:    "BET_ACCEPTED" | "BET_FAILED" | "BET_RECONCILED",
 *   roundId:  string | undefined,  // enriched asynchronously from active round
 *   betId?:   string,               // bet store handle for reconciliation
 *   address:  string,               // Stellar wallet address
 *   amount:   number,               // bet amount
 *   side?:    "UP" | "DOWN",       // only for UP_DOWN mode
 *   mode:     "UP_DOWN" | "PRECISION",
 *   result:   string,               // "stub" | "on-chain-success" | ...
 *   status?:  BetStatus,            // STUB | SUBMITTED | CONFIRMED | FAILED
 *   txHash?:  string,               // present once a transaction is known
 *   failureReason?: string,         // present on BET_FAILED
 *   createdAt: string               // ISO-8601 timestamp
 * }
 *
 * Storage modes (controlled by BET_AUDIT_STORAGE env var):
 *   - "memory"   (default / hackathon)  – events held in an in-memory array
 *   - "database" (full mode)            – persisted to the AuditLog table
 *
 * Future on-chain migration:
 *   The BetAuditEvent schema maps 1:1 to a future on-chain event. Each field
 *   can be serialised as a Solidity/ Soroban event parameter. The `event`
 *   discriminator ("BET_ACCEPTED") matches the on-chain event name.
 *
 * Safety / redaction:
 *   No private keys, tokens, or sensitive wallet data are logged.
 *   The schema only contains public bet metadata.
 */

import logger from "../utils/logger";
import { prisma } from "../lib/prisma";
import { GameMode, BetStatus } from "@prisma/client";
import { getRequestId } from "../utils/requestContext";

export type BetAuditEventName =
  | "BET_ACCEPTED"
  | "BET_FAILED"
  | "BET_RECONCILED"
  | "CLAIM_ACCEPTED";

export interface BetAuditEvent {
  event: BetAuditEventName;
  roundId?: string;
  /** Bet store handle, so an audit row can be traced back to its record. */
  betId?: string;
  address: string;
  amount: number;
  side?: "UP" | "DOWN";
  mode?: "UP_DOWN" | "PRECISION";
  result: string;
  /** Reconciliation status of the bet at the time the event was emitted. */
  status?: BetStatus;
  txHash?: string;
  requestId?: string;
  /** Correlation id linking requestId ↔ txHash for distributed tracing */
  correlationId?: string;
  failureReason?: string;
  createdAt: string;
}

export interface BetAuditParams {
  betId?: string;
  address: string;
  amount: number;
  side?: "UP" | "DOWN";
  mode: "UP_DOWN" | "PRECISION";
  result: string;
  status?: BetStatus;
  txHash?: string;
  requestId?: string;
  correlationId?: string;
  failureReason?: string;
}

export interface ClaimAuditParams {
  address: string;
  amount: number;
  result: string;
  txHash?: string;
  requestId?: string;
  correlationId?: string;
}

class BetAuditService {
  private events: BetAuditEvent[] = [];

  get storageMode(): "memory" | "database" {
    const mode = process.env.BET_AUDIT_STORAGE;
    if (mode === "database") return "database";
    return "memory";
  }

  /**
   * Emit a BET_ACCEPTED audit event.
   *
   * The event is recorded synchronously in the in-memory store so callers
   * can inspect it immediately. Round enrichment and database persistence
   * happen asynchronously (fire-and-forget) to avoid blocking the bet flow.
   *
   * Rejected submissions are reported separately by {@link emitBetFailed}.
   *
   * Intended analytics usage:
   *   - Count total accepted bets per round / address / mode
   *   - Track bet volume and side distribution over time
   *   - Debug bet acceptance failures by correlating with server logs
   *   - Replay events into an analytical store (e.g. ClickHouse, BigQuery)
   *
   * Future on-chain compatibility:
   *   The returned BetAuditEvent can be serialised as an on-chain event
   *   (e.g. Soroban event topic / data, or EVM log). The `event` field
   *   serves as the event name / topic discriminator.
   */
  emitBetAccepted(params: BetAuditParams): BetAuditEvent {
    return this.emit("BET_ACCEPTED", "Bet accepted", params);
  }

  /**
   * Emit a BET_FAILED audit event for a rejected on-chain submission.
   *
   * Unlike BET_ACCEPTED this fires on the failure path, so a chain submission
   * that never landed is still visible to analytics and dispute support
   * instead of vanishing with the thrown error.
   */
  emitBetFailed(params: BetAuditParams): BetAuditEvent {
    return this.emit("BET_FAILED", "Bet failed", params);
  }

  /**
   * Emit a BET_RECONCILED audit event when an existing bet record is matched
   * to its on-chain transaction — the stub → live upgrade.
   */
  emitBetReconciled(params: BetAuditParams): BetAuditEvent {
    return this.emit("BET_RECONCILED", "Bet reconciled", params);
  }

  private emit(
    eventName: BetAuditEventName,
    message: string,
    params: BetAuditParams,
  ): BetAuditEvent {
    const requestId = params.requestId ?? getRequestId();
    const correlationId = params.correlationId ?? (requestId && params.txHash ? `${requestId}:${params.txHash}` : requestId ?? params.txHash);
    const event: BetAuditEvent = {
      event: eventName,
      roundId: undefined,
      betId: params.betId,
      address: params.address,
      amount: params.amount,
      side: params.side,
      mode: params.mode,
      result: params.result,
      status: params.status,
      txHash: params.txHash,
      requestId,
      correlationId,
      failureReason: params.failureReason,
      createdAt: new Date().toISOString(),
    };

    this.events.push(event);

    logger.info(message, { audit: true, requestId, correlationId, ...event });

    void this.enrichAndPersist(event, params);

    return event;
  }

  /**
   * Emit a CLAIM_ACCEPTED audit event for a successful claim/payout.
   * Same storage modes as BET_ACCEPTED; never emitted for failed claims.
   */
  emitClaimAccepted(params: ClaimAuditParams): BetAuditEvent {
    const requestId = params.requestId ?? getRequestId();
    const correlationId = params.correlationId ?? (requestId && params.txHash ? `${requestId}:${params.txHash}` : requestId ?? params.txHash);
    const event: BetAuditEvent = {
      event: "CLAIM_ACCEPTED",
      address: params.address,
      amount: params.amount,
      result: params.result,
      txHash: params.txHash,
      requestId,
      correlationId,
      createdAt: new Date().toISOString(),
    };

    this.events.push(event);

    logger.info("Claim accepted", { audit: true, requestId, correlationId, ...event });

    if (this.storageMode === "database") {
      void this.persistClaimToDatabase(event).catch((error) => {
        logger.error("Failed to persist claim audit event to database", {
          error: error instanceof Error ? error.message : "Unknown error",
          eventType: event.event,
        });
      });
    }

    return event;
  }

  /**
   * Asynchronously enrich the event with the active round ID and persist
   * to the database when database mode is enabled.
   *
   * Both steps are best-effort and fire-and-forget – neither will throw
   * or block the caller.
   */
  private async enrichAndPersist(
    event: BetAuditEvent,
    params: BetAuditParams,
  ): Promise<void> {
    try {
      const gameMode =
        params.mode === "UP_DOWN" ? GameMode.UP_DOWN : GameMode.LEGENDS;
      const round = await prisma.round.findFirst({
        where: { mode: gameMode, status: "ACTIVE" },
        orderBy: { startTime: "desc" },
        select: { id: true },
      });
      if (round) {
        event.roundId = round.id;
      }
    } catch {
      // Round lookup is best-effort; silent fail
    }

    if (this.storageMode === "database") {
      try {
        await this.persistToDatabase(event);
      } catch (error) {
        logger.error("Failed to persist bet audit event to database", {
          error: error instanceof Error ? error.message : "Unknown error",
          eventType: event.event,
        });
      }
    }
  }

  private async persistToDatabase(event: BetAuditEvent): Promise<void> {
    const failed = event.event === "BET_FAILED";
    const verb =
      event.event === "BET_ACCEPTED"
        ? "accepted"
        : event.event === "BET_FAILED"
          ? "failed"
          : "reconciled";

    await prisma.auditLog.create({
      data: {
        eventType: event.event,
        severity: failed ? "error" : "info",
        message: `Bet ${verb}: ${event.mode}${event.side ? " " + event.side : ""}`,
        outcome: failed ? "failure" : "success",
        actorType: "user",
        walletAddress: event.address,
        resourceType: "bet",
        resourceId: event.betId ?? event.roundId,
        metadata: {
          betId: event.betId,
          roundId: event.roundId,
          amount: event.amount,
          side: event.side,
          mode: event.mode,
          result: event.result,
          status: event.status,
          txHash: event.txHash,
          requestId: event.requestId,
          correlationId: event.correlationId,
          failureReason: event.failureReason,
        } as any,
        timestamp: new Date(event.createdAt),
      },
    });
  }

  private async persistClaimToDatabase(event: BetAuditEvent): Promise<void> {
    await prisma.auditLog.create({
      data: {
        eventType: event.event,
        severity: "info",
        message: `Claim accepted: ${event.amount} XLM`,
        outcome: "success",
        actorType: "user",
        walletAddress: event.address,
        resourceType: "claim",
        metadata: {
          amount: event.amount,
          result: event.result,
          txHash: event.txHash,
          requestId: event.requestId,
          correlationId: event.correlationId,
        } as any,
        timestamp: new Date(event.createdAt),
      },
    });
  }

   /** Return a copy of all in-memory events (for testing / analytics). */
   getEvents(): BetAuditEvent[] {
     return [...this.events];
   }

   /**
    * Query in-memory audit events with optional filtering and redaction.
    *
    * @param address - optional wallet address to filter on
    * @param limit   - maximum number of events to return (default 50)
    * @param redact  - when true, mask sensitive fields like txHash
    */
   queryEvents({
     address,
     limit = 50,
     redact = true,
   }: {
     address?: string;
     limit?: number;
     redact?: boolean;
   } = {}): BetAuditEvent[] {
     let filtered = [...this.events];

     if (address) {
       filtered = filtered.filter((e) => e.address === address);
     }

     filtered = filtered.slice(0, limit);

     if (redact) {
       filtered = filtered.map((event) => ({
         ...event,
         txHash: event.txHash
           ? `${event.txHash.slice(0, 8)}...`
           : undefined,
       }));
     }

     return filtered;
   }

   /** Clear all in-memory events (for test isolation). */
   clear(): void {
     this.events = [];
   }
}

export const betAuditService = new BetAuditService();
export default betAuditService;

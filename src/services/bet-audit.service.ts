/**
 * Bet Audit Service
 *
 * Provides structured audit events whenever a bet is accepted.
 * Designed for analytics, debugging, and future on-chain migration.
 *
 * Event schema (same across all storage modes):
 * {
 *   event:    "BET_ACCEPTED",
 *   roundId:  string | undefined,  // enriched asynchronously from active round
 *   address:  string,               // Stellar wallet address
 *   amount:   number,               // bet amount
 *   side?:    "UP" | "DOWN",       // only for UP_DOWN mode
 *   mode:     "UP_DOWN" | "PRECISION",
 *   result:   string,               // "stub" | "on-chain-success"
 *   txHash?:  string,               // present for on-chain bets
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
import { GameMode } from "@prisma/client";

export interface BetAuditEvent {
  event: "BET_ACCEPTED";
  roundId?: string;
  address: string;
  amount: number;
  side?: "UP" | "DOWN";
  mode: "UP_DOWN" | "PRECISION";
  result: string;
  txHash?: string;
  createdAt: string;
}

export interface BetAuditParams {
  address: string;
  amount: number;
  side?: "UP" | "DOWN";
  mode: "UP_DOWN" | "PRECISION";
  result: string;
  txHash?: string;
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
   * Events are emitted only for successfully accepted bets (never for
   * rejected / failed bets).
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
    const event: BetAuditEvent = {
      event: "BET_ACCEPTED",
      roundId: undefined,
      address: params.address,
      amount: params.amount,
      side: params.side,
      mode: params.mode,
      result: params.result,
      txHash: params.txHash,
      createdAt: new Date().toISOString(),
    };

    this.events.push(event);

    logger.info("Bet accepted", { audit: true, ...event });

    void this.enrichAndPersist(event, params);

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
    await prisma.auditLog.create({
      data: {
        eventType: event.event,
        severity: "info",
        message: `Bet accepted: ${event.mode}${event.side ? " " + event.side : ""}`,
        outcome: "success",
        actorType: "user",
        walletAddress: event.address,
        resourceType: "bet",
        resourceId: event.roundId,
        metadata: {
          amount: event.amount,
          side: event.side,
          mode: event.mode,
          result: event.result,
          txHash: event.txHash,
        } as any,
        timestamp: new Date(event.createdAt),
      },
    });
  }

  /** Return a copy of all in-memory events (for testing / analytics). */
  getEvents(): BetAuditEvent[] {
    return [...this.events];
  }

  /** Clear all in-memory events (for test isolation). */
  clear(): void {
    this.events = [];
  }
}

export const betAuditService = new BetAuditService();
export default betAuditService;

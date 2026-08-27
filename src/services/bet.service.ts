import { betStore, BetQuery, BetStatus, StoredBet } from "../data/bet-store";
import logger from "../utils/logger";
import sorobanService from "./soroban.service";
import betAuditService from "./bet-audit.service";
import websocketService from "./websocket.service";
import { serializeMoney } from "../utils/decimal.util";

export interface UpDownBetInput {
  address: string;
  amount: number;
  side: "UP" | "DOWN";
}

export interface PrecisionBetInput {
  address: string;
  amount: number;
  predictedPrice: number;
}

export interface BetResult {
  state: string;
  txHash?: string;
  /** Handle for reconciling this bet against an on-chain transaction later. */
  betId: string;
  status: BetStatus;
}

/**
 * Records bet intent or submits on-chain depending on BET_STUB_MODE.
 *
 * Every bet — stub or on-chain — is written to the bet store before the
 * outcome is known, so a chain submission that fails still leaves a record
 * marked FAILED rather than disappearing. Stub records can later be upgraded
 * with their transaction hash via {@link reconcileBet}, which is what makes
 * the stub → live migration auditable.
 */
export class BetService {
  private isStubMode(): boolean {
    return process.env.BET_STUB_MODE === "true";
  }

  async recordUpDownBet(
    input: UpDownBetInput,
    idempotencyKey?: string
  ): Promise<BetResult> {
    const roundId = (await betStore.getActiveRound("updown"))?.id;
    const stubMode = this.isStubMode();

    if (stubMode) {
      logger.info("UP/DOWN bet stub recorded", { ...input, idempotencyKey });
    } else {
      logger.info("Placing UP/DOWN bet on-chain", { ...input, idempotencyKey });
    }

    const bet = await betStore.addUpDownBet(
      roundId ?? "",
      input.address,
      input.amount,
      input.side,
      stubMode ? "STUB" : "SUBMITTED"
    );

    let result: BetResult;

    if (stubMode) {
      result = { state: "stub", betId: bet.id, status: "STUB" };
    } else {
      try {
        const chainResult = await sorobanService.placeBet(
          input.address,
          input.amount,
          input.side
        );
        const settled = await this.settleOnChainBet(bet.id, chainResult.txHash);
        result = {
          ...chainResult,
          betId: bet.id,
          status: settled?.status ?? "SUBMITTED",
        };
      } catch (error) {
        await this.failOnChainBet(bet.id, error, {
          address: input.address,
          amount: input.amount,
          side: input.side,
          mode: "UP_DOWN",
        });
        throw error;
      }
    }

    // Only reached on success — Soroban failures throw before this point.
    betAuditService.emitBetAccepted({
      betId: bet.id,
      address: input.address,
      amount: input.amount,
      side: input.side,
      mode: "UP_DOWN",
      result: result.state,
      status: result.status,
      txHash: result.txHash,
    });

    websocketService.emitBetAccepted({
      roundId,
      address: input.address,
      amount: serializeMoney(input.amount),
      side: input.side,
      mode: "UP_DOWN",
      state: result.state,
      txHash: result.txHash,
    });

    return result;
  }

  async recordPrecisionBet(
    input: PrecisionBetInput,
    idempotencyKey?: string
  ): Promise<BetResult> {
    const roundId = (await betStore.getActiveRound("precision"))?.id;
    const stubMode = this.isStubMode();

    if (stubMode) {
      logger.info("Precision bet stub recorded", { ...input, idempotencyKey });
    } else {
      logger.info("Placing Precision bet on-chain", { ...input, idempotencyKey });
    }

    const bet = await betStore.addPrecisionBet(
      roundId ?? "",
      input.address,
      input.amount,
      input.predictedPrice,
      stubMode ? "STUB" : "SUBMITTED"
    );

    let result: BetResult;

    if (stubMode) {
      result = { state: "stub", betId: bet.id, status: "STUB" };
    } else {
      try {
        const chainResult = await sorobanService.placePrecisionBet(
          input.address,
          input.amount,
          input.predictedPrice
        );
        const settled = await this.settleOnChainBet(bet.id, chainResult.txHash);
        result = {
          ...chainResult,
          betId: bet.id,
          status: settled?.status ?? "SUBMITTED",
        };
      } catch (error) {
        await this.failOnChainBet(bet.id, error, {
          address: input.address,
          amount: input.amount,
          mode: "PRECISION",
        });
        throw error;
      }
    }

    // Only reached on success — Soroban failures throw before this point.
    betAuditService.emitBetAccepted({
      betId: bet.id,
      address: input.address,
      amount: input.amount,
      mode: "PRECISION",
      result: result.state,
      status: result.status,
      txHash: result.txHash,
    });

    websocketService.emitBetAccepted({
      roundId,
      address: input.address,
      amount: serializeMoney(input.amount),
      mode: "PRECISION",
      state: result.state,
      txHash: result.txHash,
    });

    return result;
  }

  /**
   * Attach an on-chain transaction hash to an existing bet record.
   *
   * Primary use is upgrading a bet that was recorded while BET_STUB_MODE was
   * enabled: once the corresponding transaction is identified, the original
   * record is reconciled to CONFIRMED instead of a new one being created.
   */
  async reconcileBet(betId: string, txHash: string): Promise<StoredBet | undefined> {
    const bet = await betStore.markConfirmed(betId, txHash);

    if (!bet) {
      logger.warn("Cannot reconcile unknown bet", { betId, txHash });
      return undefined;
    }

    logger.info("Bet reconciled with on-chain transaction", {
      betId,
      txHash,
      status: bet.status,
    });

    betAuditService.emitBetReconciled({
      betId: bet.id,
      address: bet.address,
      amount: bet.amount,
      side: bet.side,
      mode: bet.mode === "updown" ? "UP_DOWN" : "PRECISION",
      result: "reconciled",
      status: bet.status,
      txHash,
    });

    return bet;
  }

  getBet(betId: string): Promise<StoredBet | undefined> {
    return betStore.getBet(betId);
  }

  getBets(query: BetQuery = {}): Promise<StoredBet[]> {
    return betStore.getBets(query);
  }

  getReconciliationSummary(): Promise<Record<BetStatus, number>> {
    return betStore.getReconciliationSummary();
  }

  /**
   * A Soroban call that resolves without a transaction hash leaves the record
   * SUBMITTED rather than CONFIRMED — there is nothing to reconcile against
   * yet, and claiming confirmation would defeat the audit trail.
   */
  private async settleOnChainBet(
    betId: string,
    txHash?: string,
  ): Promise<StoredBet | undefined> {
    if (txHash) {
      return betStore.markConfirmed(betId, txHash);
    }
    return betStore.markSubmitted(betId);
  }

  private async failOnChainBet(
    betId: string,
    error: unknown,
    context: {
      address: string;
      amount: number;
      side?: "UP" | "DOWN";
      mode: "UP_DOWN" | "PRECISION";
    }
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);

    await betStore.markFailed(betId, reason);

    logger.error("On-chain bet submission failed", {
      betId,
      mode: context.mode,
      address: context.address,
      error: reason,
    });

    betAuditService.emitBetFailed({
      betId,
      address: context.address,
      amount: context.amount,
      side: context.side,
      mode: context.mode,
      result: "on-chain-failure",
      status: "FAILED",
      failureReason: reason,
    });
  }

  /**
   * Claims pending on-chain winnings for the authenticated wallet.
   * Stub mode records a no-op claim for local/hackathon flows.
   */
  async claimWinnings(
    address: string,
    idempotencyKey?: string
  ): Promise<{ state: string; amount: number; txHash?: string }> {
    let result: { state: string; amount: number; txHash?: string };

    if (process.env.BET_STUB_MODE === "true") {
      logger.info("Claim winnings stub recorded", { address, idempotencyKey });
      result = { state: "stub", amount: 0 };
    } else {
      logger.info("Claiming winnings on-chain", { address, idempotencyKey });
      result = await sorobanService.claimWinnings(address);
    }

    betAuditService.emitClaimAccepted({
      address,
      amount: result.amount,
      result: result.state,
      txHash: result.txHash,
    });

    return result;
  }
}

export default new BetService();

import { betStore } from "../data/bet-store";
import logger from "../utils/logger";
import sorobanService from "./soroban.service";
import betAuditService from "./bet-audit.service";

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

/**
 * Records bet intent or submits on-chain depending on BET_STUB_MODE.
 */
export class BetService {
  async recordUpDownBet(
    input: UpDownBetInput,
    idempotencyKey?: string
  ): Promise<{ state: string; txHash?: string }> {
    let result: { state: string; txHash?: string };

    if (process.env.BET_STUB_MODE === "true") {
      logger.info("UP/DOWN bet stub recorded", { ...input, idempotencyKey });
      const activeRound = betStore.getActiveRound("updown");
      if (activeRound) {
        betStore.addUpDownBet(activeRound.id, input.address, input.amount, input.side);
      }
      result = { state: "stub" };
    } else {
      logger.info("Placing UP/DOWN bet on-chain", { ...input, idempotencyKey });
      result = await sorobanService.placeBet(input.address, input.amount, input.side);
    }

    betAuditService.emitBetAccepted({
      address: input.address,
      amount: input.amount,
      side: input.side,
      mode: "UP_DOWN",
      result: result.state,
      txHash: result.txHash,
    });

    return result;
  }

  async recordPrecisionBet(
    input: PrecisionBetInput,
    idempotencyKey?: string
  ): Promise<{ state: string; txHash?: string }> {
    let result: { state: string; txHash?: string };

    if (process.env.BET_STUB_MODE === "true") {
      logger.info("Precision bet stub recorded", { ...input, idempotencyKey });
      const activeRound = betStore.getActiveRound("precision");
      if (activeRound) {
        betStore.addPrecisionBet(activeRound.id, input.address, input.amount, input.predictedPrice);
      }
      result = { state: "stub" };
    } else {
      logger.info("Placing Precision bet on-chain", { ...input, idempotencyKey });
      result = await sorobanService.placePrecisionBet(input.address, input.amount, input.predictedPrice);
    }

    betAuditService.emitBetAccepted({
      address: input.address,
      amount: input.amount,
      mode: "PRECISION",
      result: result.state,
      txHash: result.txHash,
    });

    return result;
  }
}

export default new BetService();

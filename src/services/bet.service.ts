import logger from "../utils/logger";
import sorobanService from "./soroban.service";

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
    if (process.env.BET_STUB_MODE === "true") {
      logger.info("UP/DOWN bet stub recorded", { ...input, idempotencyKey });
      return { state: "stub" };
    }
    
    logger.info("Placing UP/DOWN bet on-chain", { ...input, idempotencyKey });
    return await sorobanService.placeBet(input.address, input.amount, input.side);
  }

  async recordPrecisionBet(
    input: PrecisionBetInput,
    idempotencyKey?: string
  ): Promise<{ state: string; txHash?: string }> {
    if (process.env.BET_STUB_MODE === "true") {
      logger.info("Precision bet stub recorded", { ...input, idempotencyKey });
      return { state: "stub" };
    }
    
    logger.info("Placing Precision bet on-chain", { ...input, idempotencyKey });
    return await sorobanService.placePrecisionBet(input.address, input.amount, input.predictedPrice);
  }
}

export default new BetService();

import logger from "../utils/logger";

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
 * Hackathon stub — records bet intent for frontend integration.
 * TODO: Call contract via Xelma TypeScript bindings — bets must go on-chain;
 * this endpoint is logging/analytics only for now.
 */
export class BetService {
  recordUpDownBet(input: UpDownBetInput): void {
    // TODO: Call contract via Xelma TypeScript bindings — bets must go on-chain;
    // this endpoint is logging/analytics only for now
    logger.info("UP/DOWN bet stub recorded", input);
  }

  recordPrecisionBet(input: PrecisionBetInput): void {
    // TODO: Call contract via Xelma TypeScript bindings — bets must go on-chain;
    // this endpoint is logging/analytics only for now
    logger.info("Precision bet stub recorded", input);
  }
}

export default new BetService();

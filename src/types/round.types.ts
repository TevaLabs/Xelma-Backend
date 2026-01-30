import { Request } from 'express';

export enum GameMode {
  UP_DOWN = 0,
  LEGENDS = 1,
}

export enum RoundStatus {
  ACTIVE = 'ACTIVE',
  RESOLVED = 'RESOLVED',
  CANCELLED = 'CANCELLED',
}

export enum BetSide {
  UP = 'up',
  DOWN = 'down',
}

export interface StartRoundRequestBody {
  startPrice: string;
  durationLedgers: number;
  mode: GameMode;
}

export interface StartRoundResponse {
  roundId: string;
  startPrice: bigint;
  endLedger: number;
  mode: GameMode;
  createdAt: string;
}

export interface SubmitPredictionRequestBody {
  roundId: string;
  side: BetSide;
  amount: number;
  mode: GameMode;
}

export interface SubmitPredictionResponse {
  predictionId: string;
  roundId: string;
  side: BetSide;
  amount: number;
  txHash: string;
}

export interface ResolveRoundRequestBody {
  roundId: string;
  finalPrice: string;
  mode: GameMode;
}

export interface ResolveRoundResponse {
  roundId: string;
  outcome: BetSide | null;
  winnersCount: number;
  losersCount: number;
  txHash: string;
}

export interface ActiveRoundResponse {
  roundId: string;
  startPrice: bigint;
  poolUp: bigint;
  poolDown: bigint;
  endLedger: number;
  mode: GameMode;
}

export interface RoundRequest extends Request {
  user?: {
    userId: string;
    walletAddress: string;
  };
}

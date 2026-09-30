import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../lib/prisma';
import {
  toDecimal,
  toNumber,
  decAdd,
  decEq,
} from '../utils/decimal.util';
import { calculatePayout } from '../utils/payout.util';
import { parseRoundPriceRanges } from '../utils/price-range.util';
import { UserPriceRange } from '../types/round.types';

export interface SimulationPredictionResult {
  won: boolean | null;
  payout: number;
  amount: number;
  side?: 'UP' | 'DOWN' | null;
}

export interface SimulationResult {
  roundId: string;
  simulatedPrice: number;
  mode: string;
  startPrice: number;
  winningSide: 'UP' | 'DOWN' | null;
  winningRange: { min: number; max: number } | null;
  predictions: SimulationPredictionResult[];
  summary: {
    totalPredictions: number;
    winners: number;
    losers: number;
    refunded: number;
    totalPayout: number;
  };
}

class SimulationService {
  async simulateRound(roundId: string, finalPrice: number): Promise<SimulationResult | null> {
    const round = await prisma.round.findUnique({
      where: { id: roundId },
      include: { predictions: true },
    });
    if (!round) return null;
    return this.simulate(round, finalPrice);
  }

  simulate(
    round: {
      id: string;
      mode: string;
      startPrice: Decimal | number;
      poolUp: Decimal | number;
      poolDown: Decimal | number;
      priceRanges?: unknown;
      predictions: Array<{
        side?: string | null;
        amount: Decimal | number;
        priceRange?: unknown;
      }>;
    },
    finalPrice: number,
  ): SimulationResult {
    const finalPriceDec = toDecimal(finalPrice);
    const startPriceDec = toDecimal(round.startPrice);

    if (round.mode === 'UP_DOWN') {
      return this.simulateUpDown(round, finalPriceDec, startPriceDec, finalPrice);
    }

    return this.simulateLegends(round, finalPriceDec, startPriceDec, finalPrice);
  }

  private simulateUpDown(
    round: {
      id: string;
      startPrice: Decimal | number;
      poolUp: Decimal | number;
      poolDown: Decimal | number;
      predictions: Array<{
        side?: string | null;
        amount: Decimal | number;
      }>;
    },
    finalPriceDec: Decimal,
    startPriceDec: Decimal,
    finalPriceNum: number,
  ): SimulationResult {
    const priceWentUp = finalPriceDec.gt(startPriceDec);
    const priceWentDown = finalPriceDec.lt(startPriceDec);
    const priceUnchanged = finalPriceDec.eq(startPriceDec);

    const winningSide: 'UP' | 'DOWN' | null = priceWentUp ? 'UP' : priceWentDown ? 'DOWN' : null;

    if (priceUnchanged) {
      const predictions: SimulationPredictionResult[] = round.predictions.map(p => ({
        won: null,
        payout: toNumber(p.amount),
        amount: toNumber(p.amount),
        side: (p.side ?? null) as 'UP' | 'DOWN' | null,
      }));

      return {
        roundId: round.id,
        simulatedPrice: finalPriceNum,
        mode: 'UP_DOWN',
        startPrice: toNumber(round.startPrice),
        winningSide: null,
        winningRange: null,
        predictions,
        summary: {
          totalPredictions: predictions.length,
          winners: 0,
          losers: 0,
          refunded: predictions.length,
          totalPayout: predictions.reduce((s, p) => s + p.payout, 0),
        },
      };
    }

    const winningPool = toDecimal(winningSide === 'UP' ? round.poolUp : round.poolDown);
    const losingPool = toDecimal(winningSide === 'UP' ? round.poolDown : round.poolUp);

    if (decEq(winningPool, 0)) {
      const predictions: SimulationPredictionResult[] = round.predictions.map(p => ({
        won: false,
        payout: 0,
        amount: toNumber(p.amount),
        side: (p.side ?? null) as 'UP' | 'DOWN' | null,
      }));

      return {
        roundId: round.id,
        simulatedPrice: finalPriceNum,
        mode: 'UP_DOWN',
        startPrice: toNumber(round.startPrice),
        winningSide,
        winningRange: null,
        predictions,
        summary: {
          totalPredictions: predictions.length,
          winners: 0,
          losers: predictions.length,
          refunded: 0,
          totalPayout: 0,
        },
      };
    }

    let totalPayout = 0;
    let winners = 0;
    let losers = 0;

    const predictions: SimulationPredictionResult[] = round.predictions.map(p => {
      if (p.side === winningSide) {
        winners++;
        const payout = calculatePayout(toDecimal(p.amount), winningPool, losingPool);
        const payoutNum = toNumber(payout);
        totalPayout += payoutNum;
        return { won: true, payout: payoutNum, amount: toNumber(p.amount), side: p.side ?? null };
      }
      losers++;
      return { won: false, payout: 0, amount: toNumber(p.amount), side: (p.side ?? null) as 'UP' | 'DOWN' | null };
    });

    return {
      roundId: round.id,
      simulatedPrice: finalPriceNum,
      mode: 'UP_DOWN',
      startPrice: toNumber(round.startPrice),
      winningSide,
      winningRange: null,
      predictions,
      summary: {
        totalPredictions: predictions.length,
        winners,
        losers,
        refunded: 0,
        totalPayout,
      },
    };
  }

  private simulateLegends(
    round: {
      id: string;
      startPrice: Decimal | number;
      poolUp: Decimal | number;
      poolDown: Decimal | number;
      priceRanges?: unknown;
      predictions: Array<{
        side?: string | null;
        amount: Decimal | number;
        priceRange?: unknown;
      }>;
    },
    finalPriceDec: Decimal,
    _startPriceDec: Decimal,
    finalPriceNum: number,
  ): SimulationResult {
    const priceRanges = parseRoundPriceRanges(round.priceRanges);
    const sortedRanges = [...priceRanges].sort((a, b) => a.min - b.min);

    const winningRange = sortedRanges.find((range, index) => {
      const isLast = index === sortedRanges.length - 1;
      const min = toDecimal(range.min);
      const max = toDecimal(range.max);
      return isLast
        ? finalPriceDec.gte(min) && finalPriceDec.lte(max)
        : finalPriceDec.gte(min) && finalPriceDec.lt(max);
    });

    if (!winningRange) {
      const predictions: SimulationPredictionResult[] = round.predictions.map(p => ({
        won: null,
        payout: toNumber(p.amount),
        amount: toNumber(p.amount),
        side: (p.side ?? null) as 'UP' | 'DOWN' | null,
      }));

      return {
        roundId: round.id,
        simulatedPrice: finalPriceNum,
        mode: 'LEGENDS',
        startPrice: toNumber(round.startPrice),
        winningSide: null,
        winningRange: null,
        predictions,
        summary: {
          totalPredictions: predictions.length,
          winners: 0,
          losers: 0,
          refunded: predictions.length,
          totalPayout: predictions.reduce((s, p) => s + p.payout, 0),
        },
      };
    }

    const totalPool = sortedRanges.reduce((sum, r) => decAdd(sum, r.pool), toDecimal(0));
    const decWinningPool = toDecimal(winningRange.pool);
    const decLosingPool = totalPool.sub(decWinningPool);

    if (decEq(decWinningPool, 0)) {
      const predictions: SimulationPredictionResult[] = round.predictions.map(p => ({
        won: false,
        payout: 0,
        amount: toNumber(p.amount),
        side: (p.side ?? null) as 'UP' | 'DOWN' | null,
      }));

      return {
        roundId: round.id,
        simulatedPrice: finalPriceNum,
        mode: 'LEGENDS',
        startPrice: toNumber(round.startPrice),
        winningSide: null,
        winningRange: { min: winningRange.min, max: winningRange.max },
        predictions,
        summary: {
          totalPredictions: predictions.length,
          winners: 0,
          losers: predictions.length,
          refunded: 0,
          totalPayout: 0,
        },
      };
    }

    let totalPayout = 0;
    let winners = 0;
    let losers = 0;

    const predictions: SimulationPredictionResult[] = round.predictions.map(p => {
      const predictionRange = p.priceRange as UserPriceRange | undefined;
      if (
        predictionRange &&
        toDecimal(predictionRange.min).eq(toDecimal(winningRange.min)) &&
        toDecimal(predictionRange.max).eq(toDecimal(winningRange.max))
      ) {
        winners++;
        const payout = calculatePayout(toDecimal(p.amount), decWinningPool, decLosingPool);
        const payoutNum = toNumber(payout);
        totalPayout += payoutNum;
        return { won: true, payout: payoutNum, amount: toNumber(p.amount), side: (p.side ?? null) as 'UP' | 'DOWN' | null };
      }
      losers++;
      return { won: false, payout: 0, amount: toNumber(p.amount), side: (p.side ?? null) as 'UP' | 'DOWN' | null };
    });

    return {
      roundId: round.id,
      simulatedPrice: finalPriceNum,
      mode: 'LEGENDS',
      startPrice: toNumber(round.startPrice),
      winningSide: null,
      winningRange: { min: winningRange.min, max: winningRange.max },
      predictions,
      summary: {
        totalPredictions: predictions.length,
        winners,
        losers,
        refunded: 0,
        totalPayout,
      },
    };
  }
}

export default new SimulationService();

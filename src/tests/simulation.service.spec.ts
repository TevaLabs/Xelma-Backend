import { describe, it, expect, jest } from '@jest/globals';
import { Decimal } from '@prisma/client/runtime/library';

jest.mock('../lib/prisma', () => ({
  prisma: {
    round: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  },
}));

import simulationService from '../services/simulation.service';
import { calculatePayout } from '../utils/payout.util';
import { toDecimal, toNumber } from '../utils/decimal.util';

function makeRound(overrides: Record<string, unknown> = {}) {
  return {
    id: 'round-1',
    mode: 'UP_DOWN',
    startPrice: 50000,
    poolUp: 1000,
    poolDown: 500,
    predictions: [
      { side: 'UP', amount: 100 },
      { side: 'UP', amount: 200 },
      { side: 'DOWN', amount: 150 },
    ],
    ...overrides,
  };
}

function makeLegendsRound(overrides: Record<string, unknown> = {}) {
  return {
    id: 'legends-round-1',
    mode: 'LEGENDS',
    startPrice: 100,
    poolUp: 0,
    poolDown: 0,
    priceRanges: [
      { min: 0, max: 50, pool: 200 },
      { min: 50, max: 100, pool: 300 },
      { min: 100, max: 150, pool: 500 },
    ],
    predictions: [
      { amount: 100, priceRange: { min: 0, max: 50 } },
      { amount: 200, priceRange: { min: 50, max: 100 } },
      { amount: 150, priceRange: { min: 100, max: 150 } },
    ],
    ...overrides,
  };
}

describe('SimulationService', () => {
  describe('UP_DOWN mode', () => {
    it('declares UP winners when finalPrice > startPrice', () => {
      const result = simulationService.simulate(makeRound(), 55000);
      expect(result.mode).toBe('UP_DOWN');
      expect(result.winningSide).toBe('UP');
      expect(result.winningRange).toBeNull();

      const winners = result.predictions.filter(p => p.won === true);
      const losers = result.predictions.filter(p => p.won === false);
      expect(winners.length).toBe(2);
      expect(losers.length).toBe(1);
      expect(winners.every(p => p.side === 'UP')).toBe(true);
      expect(losers.every(p => p.side === 'DOWN')).toBe(true);
    });

    it('declares DOWN winners when finalPrice < startPrice', () => {
      const result = simulationService.simulate(makeRound(), 45000);
      expect(result.winningSide).toBe('DOWN');

      const winners = result.predictions.filter(p => p.won === true);
      const losers = result.predictions.filter(p => p.won === false);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(2);
      expect(winners.every(p => p.side === 'DOWN')).toBe(true);
      expect(losers.every(p => p.side === 'UP')).toBe(true);
    });

    it('refunds all when finalPrice === startPrice', () => {
      const result = simulationService.simulate(makeRound(), 50000);
      expect(result.winningSide).toBeNull();
      expect(result.predictions.every(p => p.won === null)).toBe(true);

      const totalRefund = result.predictions.reduce((s, p) => s + p.payout, 0);
      expect(totalRefund).toBe(100 + 200 + 150);
      expect(result.summary.refunded).toBe(3);
      expect(result.summary.winners).toBe(0);
      expect(result.summary.losers).toBe(0);
    });

    it('marks everyone as losers when winning pool is zero', () => {
      const round = makeRound({ poolUp: 0, poolDown: 500 });
      const result = simulationService.simulate(round, 55000);
      expect(result.winningSide).toBe('UP');
      expect(result.predictions.every(p => p.won === false)).toBe(true);
      expect(result.predictions.every(p => p.payout === 0)).toBe(true);
      expect(result.summary.losers).toBe(3);
    });

    it('computes correct payout amounts for winners', () => {
      const round = makeRound({ poolUp: 1000, poolDown: 500 });
      const result = simulationService.simulate(round, 55000);

      const winner = result.predictions.find(p => p.side === 'UP' && p.won === true)!;
      const expectedPayout = calculatePayout(
        toDecimal(100), toDecimal(1000), toDecimal(500),
      );
      expect(winner.payout).toBe(toNumber(expectedPayout));
    });

    it('handles a single prediction on UP side winning', () => {
      const round = makeRound({
        poolUp: 300,
        poolDown: 0,
        predictions: [{ side: 'UP', amount: 300 }],
      });
      const result = simulationService.simulate(round, 60000);
      expect(result.winningSide).toBe('UP');
      expect(result.predictions[0].won).toBe(true);
      expect(result.summary.totalPredictions).toBe(1);
      expect(result.summary.winners).toBe(1);
    });

    it('handles a single prediction on DOWN side winning', () => {
      const round = makeRound({
        poolUp: 0,
        poolDown: 300,
        predictions: [{ side: 'DOWN', amount: 300 }],
      });
      const result = simulationService.simulate(round, 40000);
      expect(result.winningSide).toBe('DOWN');
      expect(result.predictions[0].won).toBe(true);
      expect(result.summary.winners).toBe(1);
    });
  });

  describe('LEGENDS mode', () => {
    it('declares winners in the matching price range', () => {
      const result = simulationService.simulate(makeLegendsRound(), 75);
      expect(result.mode).toBe('LEGENDS');
      expect(result.winningSide).toBeNull();
      expect(result.winningRange).toEqual({ min: 50, max: 100 });

      expect(result.predictions[0].won).toBe(false);
      expect(result.predictions[1].won).toBe(true);
      expect(result.predictions[2].won).toBe(false);
      expect(result.summary.winners).toBe(1);
      expect(result.summary.losers).toBe(2);
    });

    it('uses inclusive upper bound for the last range', () => {
      const result = simulationService.simulate(makeLegendsRound(), 150);
      expect(result.winningRange).toEqual({ min: 100, max: 150 });
      expect(result.predictions[2].won).toBe(true);
    });

    it('refunds all when price is outside all ranges', () => {
      const result = simulationService.simulate(makeLegendsRound(), 200);
      expect(result.winningRange).toBeNull();
      expect(result.predictions.every(p => p.won === null)).toBe(true);
      expect(result.summary.refunded).toBe(3);
    });

    it('marks everyone as losers when winning pool is zero', () => {
      const round = makeLegendsRound({
        priceRanges: [
          { min: 0, max: 50, pool: 0 },
          { min: 50, max: 100, pool: 300 },
          { min: 100, max: 150, pool: 500 },
        ],
      });
      const result = simulationService.simulate(round, 25);
      expect(result.winningRange).toEqual({ min: 0, max: 50 });
      expect(result.predictions.every(p => p.won === false)).toBe(true);
      expect(result.predictions.every(p => p.payout === 0)).toBe(true);
      expect(result.summary.losers).toBe(3);
    });

    it('computes correct payout for LEGENDS winners', () => {
      const result = simulationService.simulate(makeLegendsRound(), 75);
      const winner = result.predictions[1];
      const expectedPayout = calculatePayout(
        toDecimal(200), toDecimal(300), toDecimal(700),
      );
      expect(winner.payout).toBe(toNumber(expectedPayout));
    });
  });

  describe('round metadata in result', () => {
    it('includes roundId, simulatedPrice, startPrice, and summary', () => {
      const result = simulationService.simulate(makeRound(), 55000);
      expect(result.roundId).toBe('round-1');
      expect(result.simulatedPrice).toBe(55000);
      expect(result.startPrice).toBe(50000);
      expect(result.summary).toEqual({
        totalPredictions: 3,
        winners: 2,
        losers: 1,
        refunded: 0,
        totalPayout: expect.any(Number),
      });
    });

    it('summarizes refund scenario correctly', () => {
      const result = simulationService.simulate(makeRound(), 50000);
      expect(result.summary).toEqual({
        totalPredictions: 3,
        winners: 0,
        losers: 0,
        refunded: 3,
        totalPayout: 450,
      });
    });
  });

  describe('decimal precision safety', () => {
    it('uses Decimal math for payout calculations', () => {
      const round = makeRound({
        startPrice: 50000.12345678,
        poolUp: 1000.0001,
        poolDown: 0.00000001,
        predictions: [
          { side: 'UP', amount: 999.99999999 },
        ],
      });
      const result = simulationService.simulate(round, 60000.12345678);
      expect(result.winningSide).toBe('UP');
      expect(result.predictions[0].won).toBe(true);
      expect(result.predictions[0].payout).toBeGreaterThan(0);
      expect(Number.isFinite(result.predictions[0].payout)).toBe(true);
    });

    it('returns numeric values safe for JSON serialization', () => {
      const result = simulationService.simulate(
        makeRound({ poolUp: 1 / 3, poolDown: 2 / 3 }),
        60000,
      );
      const raw = JSON.stringify(result);
      const parsed = JSON.parse(raw);
      expect(parsed.summary.totalPayout).toBeDefined();
      expect(typeof parsed.summary.totalPayout).toBe('number');
      expect(parsed.predictions.every((p: any) => typeof p.payout === 'number')).toBe(true);
    });
  });

  describe('simulateRound (DB lookup)', () => {
    it('returns null for non-existent round', async () => {
      const result = await simulationService.simulateRound('nonexistent-id', 50000);
      expect(result).toBeNull();
    });
  });
});

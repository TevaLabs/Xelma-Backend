/**
 * Prisma-only hackathon bet path (issue #620).
 *
 * These tests pin the contract that `HackathonService.placeBet` (the address /
 * round id signature used by the hackathon bet routes) writes a *single* store:
 * `MockLeaderboard` (balance), `MockRound` (pool) and `MockBet` (the bet row).
 *
 * `src/lib/prisma` is replaced with a small stateful fake whose `$transaction`
 * snapshots the store and restores it when the callback throws — the same
 * all-or-nothing semantics Postgres gives the real client. That lets us assert
 * rollback behaviour without a live database.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('../lib/prisma', () => {
  interface RoundRow {
    id: string;
    mode: string;
    poolUp: number;
    poolDown: number;
    totalPool: number;
    predictionCount: number;
  }
  interface UserRow {
    address: string;
    balance: number;
  }
  interface BetRow {
    roundId: string;
    address: string;
    amount: number;
    side?: string | null;
    predictedPrice?: number | null;
  }

  const state: {
    rounds: Map<string, RoundRow>;
    users: Map<string, UserRow>;
    bets: BetRow[];
    failPoolUpdate: boolean;
  } = {
    rounds: new Map(),
    users: new Map(),
    bets: [],
    failPoolUpdate: false,
  };

  // Deep-ish copy: the row objects are mutated in place by `applyUpdate`, so a
  // shallow `new Map(...)` would share (and leak) those mutations into the
  // snapshot and defeat the rollback simulation below.
  const snapshot = () => ({
    rounds: new Map(
      Array.from(state.rounds, ([id, row]) => [id, { ...row }] as const),
    ),
    users: new Map(
      Array.from(state.users, ([address, row]) => [address, { ...row }] as const),
    ),
    bets: state.bets.map((bet) => ({ ...bet })),
  });

  const restore = (snap: ReturnType<typeof snapshot>) => {
    state.rounds = snap.rounds;
    state.users = snap.users;
    state.bets = snap.bets;
  };

  /** Apply a Prisma update payload the way the database would. */
  const applyUpdate = (row: Record<string, any>, data: Record<string, any>) => {
    for (const [field, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) {
        row[field] = (row[field] ?? 0) + (value as any).increment;
      } else if (value && typeof value === 'object' && 'decrement' in value) {
        row[field] = (row[field] ?? 0) - (value as any).decrement;
      } else {
        row[field] = value;
      }
    }
    return row;
  };

  const tx = {
    mockRound: {
      findUnique: async ({ where }: any) => state.rounds.get(where.id) ?? null,
      update: async ({ where, data }: any) => {
        if (state.failPoolUpdate) {
          throw new Error('Simulated pool update failure');
        }
        const row = state.rounds.get(where.id);
        if (!row) return null;
        return applyUpdate(row, data);
      },
    },
    mockLeaderboard: {
      findUnique: async ({ where }: any) => state.users.get(where.address) ?? null,
      create: async ({ data }: any) => {
        state.users.set(data.address, { ...data });
        return { ...data };
      },
      update: async ({ where, data }: any) => {
        const row = state.users.get(where.address);
        if (!row) return null;
        return applyUpdate(row, data);
      },
    },
    mockBet: {
      create: async ({ data }: any) => {
        state.bets.push({ ...data });
        return { id: state.bets.length, ...data };
      },
    },
  };

  const prisma = {
    ...tx,
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
      const snap = snapshot();
      try {
        return await fn(tx);
      } catch (error) {
        restore(snap);
        throw error;
      }
    },
    __state: state,
  };

  return { __esModule: true, prisma };
});

import hackathonService from '../services/hackathon.service';
import { prisma } from '../lib/prisma';

const state = (prisma as any).__state as {
  rounds: Map<string, any>;
  users: Map<string, any>;
  bets: any[];
  failPoolUpdate: boolean;
};

const ADDRESS = 'GPRISMAONLYTESTADDRESS0000000000000000000000000000000000000';
const ROUND_ID = 'btc-updown-live';

const seed = (balance = 1000) => {
  state.rounds = new Map([
    [
      ROUND_ID,
      {
        id: ROUND_ID,
        mode: 'updown',
        poolUp: 0,
        poolDown: 0,
        totalPool: 0,
        predictionCount: 0,
      },
    ],
  ]);
  state.users = new Map([[ADDRESS, { address: ADDRESS, balance }]]);
  state.bets = [];
  state.failPoolUpdate = false;
};

describe('HackathonService.placeBet — Prisma-only store', () => {
  beforeEach(() => {
    seed();
  });

  describe('happy path', () => {
    it('keeps balance, pool and bet row consistent', async () => {
      const poolUpBefore = state.rounds.get(ROUND_ID)!.poolUp;
      const balanceBefore = state.users.get(ADDRESS)!.balance;

      await hackathonService.placeBet(ROUND_ID, ADDRESS, 120, 'UP');

      const poolUpAfter = state.rounds.get(ROUND_ID)!.poolUp;
      const balanceAfter = state.users.get(ADDRESS)!.balance;

      // One bet row, one debit, one pool move — and they agree.
      expect(state.bets).toHaveLength(1);
      expect(state.bets[0]).toMatchObject({
        roundId: ROUND_ID,
        address: ADDRESS,
        amount: 120,
        side: 'UP',
      });
      expect(balanceBefore - balanceAfter).toBe(120);
      expect(poolUpAfter - poolUpBefore).toBe(120);
      expect(balanceBefore - balanceAfter).toBe(poolUpAfter - poolUpBefore);
    });

    it('moves the precision pool and prediction count together', async () => {
      state.rounds.set('eth-precision-live', {
        id: 'eth-precision-live',
        mode: 'precision',
        poolUp: 0,
        poolDown: 0,
        totalPool: 0,
        predictionCount: 0,
      });

      await hackathonService.placeBet('eth-precision-live', ADDRESS, 50, undefined, 3250);

      const round = state.rounds.get('eth-precision-live')!;
      expect(round.totalPool).toBe(50);
      expect(round.predictionCount).toBe(1);
      expect(state.bets[0].predictedPrice).toBe(3250);
    });
  });

  describe('rollback', () => {
    it('rejects an overdraft without debiting or moving the pool', async () => {
      seed(50);

      await expect(
        hackathonService.placeBet(ROUND_ID, ADDRESS, 100, 'UP')
      ).rejects.toThrow('Insufficient balance');

      expect(state.users.get(ADDRESS)!.balance).toBe(50);
      expect(state.rounds.get(ROUND_ID)!.poolUp).toBe(0);
      expect(state.bets).toHaveLength(0);
    });

    it('rolls the debit and bet row back when the pool update fails', async () => {
      state.failPoolUpdate = true;

      await expect(
        hackathonService.placeBet(ROUND_ID, ADDRESS, 100, 'UP')
      ).rejects.toThrow('Simulated pool update failure');

      expect(state.users.get(ADDRESS)!.balance).toBe(1000);
      expect(state.rounds.get(ROUND_ID)!.poolUp).toBe(0);
      expect(state.bets).toHaveLength(0);
    });

    it('rejects an unknown round without writing anything', async () => {
      await expect(
        hackathonService.placeBet('does-not-exist', ADDRESS, 10, 'UP')
      ).rejects.toThrow('Round not found');

      expect(state.users.get(ADDRESS)!.balance).toBe(1000);
      expect(state.bets).toHaveLength(0);
    });
  });
});

/**
 * Backend selection and the two bet-store implementations (issue #624).
 *
 * DB-free: the Postgres backend is exercised against a mocked
 * `prisma.betRecord`, which is enough to prove that bets live outside the store
 * instance (a new instance still reads them back) without requiring Postgres.
 * The real-database restart test lives in bet-store-persistence.spec.ts.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../lib/prisma', () => {
  const rows = new Map<string, any>();
  let sequence = 0;

  const matches = (row: any, where: any = {}) =>
    Object.entries(where).every(
      ([key, value]) => value === undefined || row[key] === value,
    );

  const prisma = {
    betRecord: {
      create: async ({ data }: any) => {
        const row = {
          id: data.id ?? `row-${++sequence}`,
          side: null,
          predictedPrice: null,
          roundId: null,
          txHash: null,
          submittedAt: null,
          confirmedAt: null,
          failedAt: null,
          failureReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: any) => rows.get(where.id) ?? null,
      findMany: async ({ where }: any = {}) =>
        Array.from(rows.values()).filter((row) => matches(row, where)),
      update: async ({ where, data }: any) => {
        const existing = rows.get(where.id);
        if (!existing) return null;
        const updated = { ...existing, ...data, updatedAt: new Date() };
        rows.set(where.id, updated);
        return updated;
      },
      count: async () => rows.size,
      groupBy: async ({ by }: any) => {
        const groups = new Map<string, number>();
        for (const row of rows.values()) {
          groups.set(row[by[0]], (groups.get(row[by[0]]) ?? 0) + 1);
        }
        return Array.from(groups.entries()).map(([status, count]) => ({
          status,
          _count: { status: count },
        }));
      },
      deleteMany: async () => {
        const count = rows.size;
        rows.clear();
        return { count };
      },
    },
  };

  return { prisma, __esModule: true };
});

import { prisma } from '../lib/prisma';
import {
  createBetStore,
  MemoryBetStore,
  PostgresBetStore,
  resolveBetStoreBackend,
} from '../data/bet-store';

const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OTHER_ADDRESS = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF';

describe('bet-store backend selection', () => {
  it('prefers an explicit BET_STORE', () => {
    expect(resolveBetStoreBackend({ BET_STORE: 'memory' } as NodeJS.ProcessEnv)).toBe('memory');
    expect(resolveBetStoreBackend({ BET_STORE: 'postgres' } as NodeJS.ProcessEnv)).toBe('postgres');
    // "prisma" is accepted as a friendlier alias for the Postgres backend.
    expect(resolveBetStoreBackend({ BET_STORE: 'prisma' } as NodeJS.ProcessEnv)).toBe('postgres');
  });

  it('falls back to DATA_STORE when BET_STORE is unset', () => {
    expect(resolveBetStoreBackend({ DATA_STORE: 'memory' } as NodeJS.ProcessEnv)).toBe('memory');
    expect(resolveBetStoreBackend({ DATA_STORE: 'postgres' } as NodeJS.ProcessEnv)).toBe('postgres');
  });

  it('treats DATA_MODE=mock as memory when DATA_STORE is unset', () => {
    expect(resolveBetStoreBackend({ DATA_MODE: 'mock' } as NodeJS.ProcessEnv)).toBe('memory');
    expect(
      resolveBetStoreBackend({ DATA_MODE: 'live', DATA_STORE: 'postgres' } as NodeJS.ProcessEnv),
    ).toBe('postgres');
  });

  it('instantiates the requested backend', () => {
    expect(createBetStore('memory')).toBeInstanceOf(MemoryBetStore);
    expect(createBetStore('postgres')).toBeInstanceOf(PostgresBetStore);
  });
});

describe('MemoryBetStore (DATA_MODE=mock)', () => {
  it('records, reconciles and summarizes bets', async () => {
    const store = new MemoryBetStore();

    const bet = await store.addUpDownBet('btc-updown-live', ADDRESS, '0.00000001', 'UP', 'STUB');
    expect(bet.amount).toBe(0.00000001);
    expect(bet.status).toBe('STUB');

    await store.markConfirmed(bet.id, '0xmemory');
    const confirmed = await store.getBet(bet.id);
    expect(confirmed?.status).toBe('CONFIRMED');
    expect(confirmed?.txHash).toBe('0xmemory');

    const summary = await store.getReconciliationSummary();
    expect(summary.CONFIRMED).toBe(1);
    expect(summary.STUB).toBe(0);
    expect(await store.getTotalBetsCount()).toBe(1);
    expect(await store.getBets({ address: OTHER_ADDRESS })).toHaveLength(0);
  });

  it('does not share bets between instances (process-local by design)', async () => {
    const beforeRestart = new MemoryBetStore();
    const bet = await beforeRestart.addUpDownBet('btc-updown-live', ADDRESS, 5, 'UP');

    const afterRestart = new MemoryBetStore();
    expect(await afterRestart.getBet(bet.id)).toBeUndefined();
    expect(await afterRestart.getTotalBetsCount()).toBe(0);
  });
});

describe('PostgresBetStore', () => {
  beforeEach(async () => {
    await prisma.betRecord.deleteMany();
  });

  it('reads bets back from the database after a simulated restart', async () => {
    const beforeRestart = new PostgresBetStore();
    const written = await beforeRestart.addUpDownBet(
      'btc-updown-live',
      ADDRESS,
      '12.5',
      'UP',
      'SUBMITTED',
    );

    // A brand-new instance bound to the same database is the in-process
    // stand-in for a restarted process / a second replica.
    const afterRestart = new PostgresBetStore();
    const readBack = await afterRestart.getBet(written.id);

    expect(readBack).toMatchObject({
      id: written.id,
      address: ADDRESS,
      amount: 12.5,
      side: 'UP',
      mode: 'updown',
      roundId: 'btc-updown-live',
      status: 'SUBMITTED',
    });
    expect(await afterRestart.getBets({ address: ADDRESS })).toHaveLength(1);
    expect(await afterRestart.getTotalBetsCount()).toBe(1);
  });

  it('carries status transitions across instances', async () => {
    const first = new PostgresBetStore();
    const bet = await first.addPrecisionBet('eth-precision-live', ADDRESS, 3, 3250, 'SUBMITTED');

    const second = new PostgresBetStore();
    const confirmed = await second.markConfirmed(bet.id, '0xrestart');
    expect(confirmed?.status).toBe('CONFIRMED');
    expect(confirmed?.txHash).toBe('0xrestart');

    const third = new PostgresBetStore();
    expect((await third.getBet(bet.id))?.status).toBe('CONFIRMED');

    const summary = await third.getReconciliationSummary();
    expect(summary.CONFIRMED).toBe(1);
    expect(summary.SUBMITTED).toBe(0);

    await third.markFailed(bet.id, 'on-chain reorg');
    expect((await third.getBet(bet.id))?.status).toBe('FAILED');
  });

  it('filters by status without consulting process memory', async () => {
    const store = new PostgresBetStore();
    await store.addUpDownBet('btc-updown-live', ADDRESS, 1, 'UP', 'STUB');
    await store.addUpDownBet('btc-updown-live', ADDRESS, 2, 'DOWN', 'FAILED');
    await store.addUpDownBet('btc-updown-live', OTHER_ADDRESS, 3, 'UP', 'STUB');

    expect(await store.getBets({ address: ADDRESS, status: 'STUB' })).toHaveLength(1);
    expect(await store.getBets({ status: 'FAILED' })).toHaveLength(1);
    expect(await store.getTotalBetsCount()).toBe(3);
  });
});

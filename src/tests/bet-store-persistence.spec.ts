/**
 * Restart continuity for the durable bet-store backend (issue #624).
 *
 * Integration suite: needs a real PostgreSQL because it proves the contract the
 * issue cares about — a bet written by one process is readable by the next one.
 * CI applies the `add_bet_record` migration before running this project.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PostgresBetStore } from '../data/bet-store';
import { prisma } from '../lib/prisma';

const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('bet-store postgres backend survives a restart (#624)', () => {
  beforeAll(async () => {
    await prisma.betRecord.deleteMany({ where: { address: ADDRESS } });
  });

  afterAll(async () => {
    await prisma.betRecord.deleteMany({ where: { address: ADDRESS } });
  });

  it('reads back a bet written by the previous process', async () => {
    const beforeRestart = new PostgresBetStore();
    const written = await beforeRestart.addUpDownBet(
      'btc-updown-live',
      ADDRESS,
      12.5,
      'UP',
      'SUBMITTED',
    );

    // "Restart": a fresh store instance bound to the same database.
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
  });

  it('keeps reconciliation transitions visible to the next process', async () => {
    const beforeRestart = new PostgresBetStore();
    const written = await beforeRestart.addPrecisionBet(
      'eth-precision-live',
      ADDRESS,
      3,
      3250,
      'SUBMITTED',
    );

    const afterRestart = new PostgresBetStore();
    const confirmed = await afterRestart.markConfirmed(written.id, '0xrestart-continuity');
    expect(confirmed?.status).toBe('CONFIRMED');

    // A third instance — i.e. yet another restart — sees the transition.
    const thirdProcess = new PostgresBetStore();
    const readBack = await thirdProcess.getBet(written.id);
    expect(readBack?.status).toBe('CONFIRMED');
    expect(readBack?.txHash).toBe('0xrestart-continuity');
    expect(readBack?.predictedPrice).toBe(3250);
  });

  it('builds the audit summary from the database, not process memory', async () => {
    const store = new PostgresBetStore();

    const confirmed = await store.getBets({ address: ADDRESS, status: 'CONFIRMED' });
    expect(confirmed).toHaveLength(1);

    const summary = await store.getReconciliationSummary();
    // Other suites share the table; assert on this suite's rows only.
    expect(summary.CONFIRMED).toBeGreaterThanOrEqual(1);
    expect(await store.getTotalBetsCount()).toBeGreaterThanOrEqual(2);
  });
});

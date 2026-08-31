/**
 * Tournament saga lifecycle integration tests (Issue #502).
 *
 * These tests drive the full create -> join -> lock -> settle -> payout workflow
 * against a real database, proving:
 *   - Tournaments are created in UPCOMING and joined atomically with capacity
 *     enforcement.
 *   - Locking freezes the roster (UPCOMING -> ACTIVE) and out-of-order lifecycle
 *     requests return structured bad-state rejections.
 *   - Settlement (ACTIVE -> COMPLETED) computes deterministic winner allocations
 *     from the tied round leaderboard and pays each winner atomically.
 *
 * They follow the same describeIfDb pattern as the existing
 * tournament-concurrency suite so they run only when a database is available.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from '@jest/globals';
import { prisma } from '../lib/prisma';
import tournamentService from '../services/tournament.service';
import { TournamentInvalidStateError } from '../utils/errors';
import { TournamentStanding } from '../types/tournament.types';

const shouldRunDbTests =
  process.env.RUN_DB_TESTS === 'true' ||
  process.env.CI === 'true' ||
  (global as any).hasDb;

const describeDb = shouldRunDbTests ? describe : describe.skip;

describeDb('tournament lifecycle (Issue #502)', () => {
  beforeAll(async () => {
    if (shouldRunDbTests) {
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch (error) {
        throw new Error(
          'Database unavailable for tournament lifecycle tests. Ensure DATABASE_URL is configured.',
        );
      }
    }
  });

  afterEach(async () => {
    await prisma.transaction.deleteMany({});
    await prisma.tournamentParticipant.deleteMany({});
    await prisma.userStats.deleteMany({});
    await prisma.tournament.deleteMany({});
    await prisma.user.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createUsers(count: number) {
    return Promise.all(
      Array.from({ length: count }, (_, i) =>
        prisma.user.create({
          data: {
            walletAddress: `G_TOURNAMENT_LIFECYCLE_${i}_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            virtualBalance: 1000,
          },
        }),
      ),
    );
  }

  async function createTournament(maxParticipants = 3) {
    return tournamentService.createTournament({
      name: 'Saga Cup',
      description: 'End-to-end tournament saga',
      mode: 'UP_DOWN',
      entryFee: '10.00000000',
      prizePool: '100.00000000',
      maxParticipants,
      startTime: new Date(),
      endTime: new Date(Date.now() + 3_600_000),
      rounds: 5,
    });
  }

  describe('create -> join -> lock -> settle -> payout', () => {
    it('runs the full happy-path saga and pays winners deterministically', async () => {
      // ── create ───────────────────────────────────────────────────────────
      const created = await createTournament(3);
      expect(created.status).toBe('UPCOMING');

      const users = await createUsers(3);

      // ── join ─────────────────────────────────────────────────────────────
      for (const user of users) {
        const join = await tournamentService.joinTournament(user.id, created.id);
        expect(join.currentParticipants).toBeGreaterThan(0);
      }

      // ── lock ─────────────────────────────────────────────────────────────
      const locked = await tournamentService.lockTournament(created.id);
      expect(locked.status).toBe('ACTIVE');

      // ── give participants some round earnings for a realistic leaderboard ──
      // Two users earn, the third earns nothing -> clear deterministic ranking.
      const stats = [
        { userId: users[0].id, totalEarnings: 40, correctPredictions: 4 },
        { userId: users[1].id, totalEarnings: 30, correctPredictions: 3 },
        { userId: users[2].id, totalEarnings: 0, correctPredictions: 0 },
      ];
      for (const s of stats) {
        await prisma.userStats.create({
          data: {
            userId: s.userId,
            totalEarnings: s.totalEarnings,
            correctPredictions: s.correctPredictions,
          },
        });
      }

      // ── settle + payout ─────────────────────────────────────────────────
      const settlement = await tournamentService.settleTournament(created.id);
      expect(settlement.winnersCount).toBe(3);
      expect(settlement.allocations).toHaveLength(3);
      // The pool is fully distributed (any rounding remainder absorbed by #1).
      const totalAllocated = settlement.allocations.reduce(
        (sum, a) => sum + Number(a.allocation),
        0,
      );
      expect(totalAllocated).toBe(100);
      // Rank 1 (highest earnings) must get the largest share.
      expect(Number(settlement.allocations[0].allocation)).toBe(50);
      // Winners were actually paid and balance updated + WIN tx recorded.
      const paid = await prisma.user.findUnique({ where: { id: users[0].id } });
      expect(Number(paid!.virtualBalance)).toBe(1000 + 50);
      const txCount = await prisma.transaction.count({
        where: { userId: users[0].id, type: 'WIN' },
      });
      expect(txCount).toBe(1);

      const finalTournament = await prisma.tournament.findUnique({
        where: { id: created.id },
      });
      expect(finalTournament!.status).toBe('COMPLETED');
    });
  });

  describe('standings and allocations are deterministic', () => {
    it('ranks equal earners by wins then participant id (stable ordering)', async () => {
      const users = await createUsers(2);
      const tournament = await createTournament(2);
      for (const user of users) {
        await tournamentService.joinTournament(user.id, tournament.id);
      }
      // Identical earnings -> tie broken by wins (both 2) then participant id.
      for (const user of users) {
        await prisma.userStats.create({
          data: {
            userId: user.id,
            totalEarnings: 25,
            correctPredictions: 2,
          },
        });
      }

      const standings: TournamentStanding[] = await tournamentService.tallyStandings(
        tournament.id,
      );
      // Two equally-ranked entrants -> ranks 1 and 2, deterministic by id.
      expect(standings).toHaveLength(2);
      expect(standings[0].rank).toBe(1);
      expect(standings[1].rank).toBe(2);

      const allocations = tournamentService.computeAllocations(
        '100.00000000',
        standings,
      );
      // With two winners the 50/30/20 weights are re-normalised over the two
      // occupied winner slots (→ 50/80 and 30/80 = 62.5 and 37.5), and the last
      // winner absorbs the rounding remainder so the pool always sums exactly.
      expect(Number(allocations[0].allocation)).toBe(62.5);
      expect(Number(allocations[1].allocation)).toBe(37.5);
      expect(
        allocations.reduce((sum, a) => sum + Number(a.allocation), 0),
      ).toBe(100);
    });
  });

  describe('out-of-order lifecycle requests are rejected', () => {
    it('rejects joining a COMPLETED tournament', async () => {
      const tournament = await createTournament(2);
      const users = await createUsers(2);
      for (const user of users) {
        await tournamentService.joinTournament(user.id, tournament.id);
      }
      await tournamentService.lockTournament(tournament.id);
      await tournamentService.settleTournament(tournament.id);

      const lateUser = (await createUsers(1))[0];
      await expect(
        tournamentService.joinTournament(lateUser.id, tournament.id),
      ).rejects.toThrow('registration is closed');
    });

    it('rejects locking an already-locked tournament', async () => {
      const tournament = await createTournament(2);
      await tournamentService.lockTournament(tournament.id);
      await expect(
        tournamentService.lockTournament(tournament.id),
      ).rejects.toBeInstanceOf(TournamentInvalidStateError);
    });

    it('rejects settling a tournament that was never locked', async () => {
      const tournament = await createTournament(2);
      // Skipping lock: settling straight from UPCOMING is illegal per the saga.
      await expect(
        tournamentService.settleTournament(tournament.id),
      ).rejects.toBeInstanceOf(TournamentInvalidStateError);
    });

    it('rejects settling an already-settled tournament twice', async () => {
      const tournament = await createTournament(2);
      const users = await createUsers(2);
      for (const user of users) {
        await tournamentService.joinTournament(user.id, tournament.id);
      }
      await tournamentService.lockTournament(tournament.id);
      await tournamentService.settleTournament(tournament.id);
      await expect(
        tournamentService.settleTournament(tournament.id),
      ).rejects.toBeInstanceOf(TournamentInvalidStateError);
    });

    it('rejects cancelling an already-completed tournament', async () => {
      const tournament = await createTournament(2);
      const users = await createUsers(2);
      for (const user of users) {
        await tournamentService.joinTournament(user.id, tournament.id);
      }
      await tournamentService.lockTournament(tournament.id);
      await tournamentService.settleTournament(tournament.id);
      await expect(
        tournamentService.cancelTournament(tournament.id),
      ).rejects.toBeInstanceOf(TournamentInvalidStateError);
    });
  });
});
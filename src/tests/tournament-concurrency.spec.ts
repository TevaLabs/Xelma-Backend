import { describe, it, expect, beforeAll, afterEach, afterAll, jest } from '@jest/globals';
import { prisma } from '../lib/prisma';
import tournamentService from '../services/tournament.service';

const shouldRunDbTests =
  process.env.RUN_DB_TESTS === 'true' ||
  process.env.CI === 'true' ||
  (global as any).hasDb;

const describeDb = shouldRunDbTests ? describe : describe.skip;

// Tracked test entities — reassigned each beforeEach, cleaned up each afterEach
let tournament: any;
let users: any[] = [];

// Ids of the rows this suite created — used to clean up without touching the
// rows of the other tournament suites, which share the same database.
let createdUserIds: string[] = [];
let createdTournamentIds: string[] = [];

describeDb('TournamentService - Concurrent Join Race Safety (Issue #410)', () => {
  beforeAll(async () => {
    // Verify database connectivity before running tests
    if (shouldRunDbTests) {
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch (error) {
        console.error(
          'Database connectivity check failed:',
          error instanceof Error ? error.message : error,
        );
        throw new Error(
          'Database unavailable for integration tests. Ensure DATABASE_URL is configured and database is running.',
        );
      }
    }
  });

  afterEach(async () => {
    // Scoped cleanup: only the rows this suite created are removed. A blanket
    // `deleteMany({})` would wipe the rows of the other tournament suites,
    // which run in parallel against the same database.
    const tournamentIds = createdTournamentIds;
    const userIds = createdUserIds;
    createdTournamentIds = [];
    createdUserIds = [];

    if (tournamentIds.length > 0) {
      await prisma.tournamentWaitlist.deleteMany({
        where: { tournamentId: { in: tournamentIds } },
      });
      await prisma.tournamentParticipant.deleteMany({
        where: { tournamentId: { in: tournamentIds } },
      });
      await prisma.tournament.deleteMany({ where: { id: { in: tournamentIds } } });
    }

    if (userIds.length > 0) {
      await prisma.userStats.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createTournament(maxParticipants = 3) {
    const created = await prisma.tournament.create({
      data: {
        name: 'Concurrency Test Tournament',
        description: 'Temporary tournament for concurrent join testing',
        mode: 'UP_DOWN',
        status: 'ACTIVE',
        entryFee: 10,
        prizePool: 100,
        maxParticipants,
        currentParticipants: 0,
        startTime: new Date(),
        endTime: new Date(Date.now() + 3600000),
        rounds: 5,
      },
    });
    createdTournamentIds.push(created.id);
    return created;
  }

  async function createUsers(count: number, tag: string) {
    const created = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        prisma.user.create({
          data: {
            walletAddress: `G_TOURNEY_${tag}_${i}_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            virtualBalance: 1000,
          },
        }),
      ),
    );
    createdUserIds.push(...created.map((user) => user.id));
    return created;
  }

  it('concurrent joins cannot overfill the tournament', async () => {
    // Create a tournament with capacity for 3 participants
    tournament = await createTournament(3);

    // Create 5 test users
    users = await createUsers(5, 'CONCURRENCY');

    // Launch 5 concurrent join attempts on a tournament with capacity of 3.
    // Each user is unique so the @@unique constraint won't prevent the overfill —
    // the interactive transaction must be the one enforcing capacity.
    const results = await Promise.allSettled(
      users.map((user) => tournamentService.joinTournament(user.id, tournament.id)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = results.filter(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult[];

    // Exactly 3 should get a seat (one per capacity slot)
    const confirmed = fulfilled.filter((r) => r.value.status === 'CONFIRMED');
    expect(confirmed.length).toBe(3);
    // The remaining 2 are queued on the waitlist instead of being rejected
    // (Issue #874) — a full tournament is not a dead end.
    const waitlisted = fulfilled.filter((r) => r.value.status === 'WAITLISTED');
    expect(waitlisted.length).toBe(2);
    expect(rejected.length).toBe(0);

    // The waitlist is ordered deterministically: first come, first served.
    const waitlist = await tournamentService.getWaitlist(tournament.id);
    expect(waitlist.map((entry) => entry.userId)).toEqual(
      waitlisted
        .map((r) => r.value.waitlistPosition)
        .sort((a, b) => a - b)
        .map((position) => waitlist.find((entry) => entry.position === position)!.userId),
    );
    expect(waitlist.map((entry) => entry.position)).toEqual([1, 2]);

    // Verify the database state reflects exactly 3 participants
    const participantCount = await prisma.tournamentParticipant.count({
      where: { tournamentId: tournament.id },
    });
    expect(participantCount).toBe(3);

    // Verify currentParticipants was incremented exactly to maxParticipants
    const updatedTournament = await prisma.tournament.findUnique({
      where: { id: tournament.id },
    });
    expect(updatedTournament!.currentParticipants).toBe(3);
  });

  it('rejects duplicate join from the same user under concurrency', async () => {
    // Create a tournament with capacity for 3 participants
    tournament = await createTournament(3);

    // Create one test user
    users = await createUsers(1, 'DUP');

    const user = users[0];

    // Launch 5 simultaneous join attempts from the same user
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        tournamentService.joinTournament(user.id, tournament.id),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult[];

    // Only 1 should succeed due to the @@unique constraint + duplicate check
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(4);

    // All rejections should be "Already joined this tournament"
    for (const rejection of rejected) {
      expect(rejection.reason).toBeDefined();
      expect(rejection.reason.constructor.name).toBe('ConflictError');
      expect(rejection.reason.message).toBe('Already joined this tournament');
    }

    // Verify only 1 participant in DB
    const dbCount = await prisma.tournamentParticipant.count({
      where: { tournamentId: tournament.id },
    });
    expect(dbCount).toBe(1);
  });

  it('combined stress: 10 concurrent joiners on capacity 3', async () => {
    // Create a tournament with capacity for 3 participants
    tournament = await createTournament(3);

    // Create 10 test users
    users = await createUsers(10, 'STRESS');

    const results = await Promise.allSettled(
      users.map((user) =>
        tournamentService.joinTournament(user.id, tournament.id),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly 3 should get a seat (capacity = 3)
    expect(fulfilled.filter((r) => r.value.status === 'CONFIRMED').length).toBe(3);
    // All 7 others are queued — nobody is turned away
    expect(fulfilled.filter((r) => r.value.status === 'WAITLISTED').length).toBe(7);
    expect(rejected.length).toBe(0);

    // Verify DB state
    const dbCount = await prisma.tournamentParticipant.count({
      where: { tournamentId: tournament.id },
    });
    expect(dbCount).toBe(3);

    const waitlistCount = await prisma.tournamentWaitlist.count({
      where: { tournamentId: tournament.id, status: 'WAITING' },
    });
    expect(waitlistCount).toBe(7);
  });

  it('queues a new join when the tournament is already full before any join', async () => {
    // Create a tournament with capacity for 3 participants
    tournament = await createTournament(3);

    // Pre-fill the tournament to capacity
    const fillUsers = await createUsers(tournament.maxParticipants, 'FILL');

    for (const fillUser of fillUsers) {
      await tournamentService.joinTournament(fillUser.id, tournament.id);
    }

    // The tournament is full — the new join is queued instead of rejected
    const freshUser = (await createUsers(1, 'FRESH'))[0];

    const result = await tournamentService.joinTournament(freshUser.id, tournament.id);

    expect(result.status).toBe('WAITLISTED');
    expect(result.waitlistPosition).toBe(1);
    expect(result.currentParticipants).toBe(tournament.maxParticipants);

    // Verify participant count did not change
    const dbCount = await prisma.tournamentParticipant.count({
      where: { tournamentId: tournament.id },
    });
    expect(dbCount).toBe(tournament.maxParticipants);
  });

  it('promotes the first user in line when a participant leaves', async () => {
    tournament = await createTournament(3);

    const [first, second, third] = await createUsers(3, 'PROMOTE');
    const waiting = (await createUsers(2, 'WAITING'))[0];

    await tournamentService.joinTournament(first.id, tournament.id);
    await tournamentService.joinTournament(second.id, tournament.id);
    await tournamentService.joinTournament(third.id, tournament.id);

    // The tournament is full → the next user is queued
    const queued = await tournamentService.joinTournament(waiting.id, tournament.id);
    expect(queued.status).toBe('WAITLISTED');
    expect(queued.waitlistPosition).toBe(1);

    // A participant leaves → the queued user takes the free seat
    const leaveResult = await tournamentService.leaveTournament(second.id, tournament.id);
    expect(leaveResult.promotedUserId).toBe(waiting.id);
    expect(leaveResult.currentParticipants).toBe(3);

    const participants = await prisma.tournamentParticipant.findMany({
      where: { tournamentId: tournament.id },
    });
    expect(participants.map((p) => p.userId).sort()).toEqual(
      [first.id, third.id, waiting.id].sort(),
    );

    const waitlist = await tournamentService.getWaitlist(tournament.id);
    expect(waitlist).toHaveLength(0);
  });
});

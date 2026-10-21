import { describe, it, expect, afterEach } from '@jest/globals';
import { NotFoundError, ConflictError, ValidationError } from '../utils/errors';

const mockTournamentFindUnique = jest.fn();
const mockTournamentUpdate = jest.fn();
const mockParticipantFindUnique = jest.fn();
const mockParticipantCreate = jest.fn();
const mockParticipantDelete = jest.fn();
const mockWaitlistFindUnique = jest.fn();
const mockWaitlistFindFirst = jest.fn();
const mockWaitlistFindMany = jest.fn();
const mockWaitlistCount = jest.fn();
const mockWaitlistCreate = jest.fn();
const mockWaitlistUpdate = jest.fn();
const mockTransaction = jest.fn();

// Mock tx object that mirrors the Prisma transaction client shape.
// Delegates to the same mock fns so assertions remain straightforward.
const mockQueryRaw = jest.fn().mockResolvedValue([{ id: 't-001' }]);

const mockTx = {
  $queryRaw: (...args: any[]) => mockQueryRaw(...args),
  tournament: {
    findUnique: (...args: any[]) => mockTournamentFindUnique(...args),
    update: (...args: any[]) => mockTournamentUpdate(...args),
  },
  tournamentParticipant: {
    findUnique: (...args: any[]) => mockParticipantFindUnique(...args),
    create: (...args: any[]) => mockParticipantCreate(...args),
    delete: (...args: any[]) => mockParticipantDelete(...args),
  },
  tournamentWaitlist: {
    findUnique: (...args: any[]) => mockWaitlistFindUnique(...args),
    findFirst: (...args: any[]) => mockWaitlistFindFirst(...args),
    findMany: (...args: any[]) => mockWaitlistFindMany(...args),
    count: (...args: any[]) => mockWaitlistCount(...args),
    create: (...args: any[]) => mockWaitlistCreate(...args),
    update: (...args: any[]) => mockWaitlistUpdate(...args),
  },
};

jest.mock('../lib/prisma', () => ({
  prisma: {
    tournament: {
      findUnique: (...args: any[]) => mockTournamentFindUnique(...args),
      update: (...args: any[]) => mockTournamentUpdate(...args),
    },
    tournamentParticipant: {
      findUnique: (...args: any[]) => mockParticipantFindUnique(...args),
      create: (...args: any[]) => mockParticipantCreate(...args),
      delete: (...args: any[]) => mockParticipantDelete(...args),
    },
    tournamentWaitlist: {
      findUnique: (...args: any[]) => mockWaitlistFindUnique(...args),
      findFirst: (...args: any[]) => mockWaitlistFindFirst(...args),
      findMany: (...args: any[]) => mockWaitlistFindMany(...args),
      count: (...args: any[]) => mockWaitlistCount(...args),
      create: (...args: any[]) => mockWaitlistCreate(...args),
      update: (...args: any[]) => mockWaitlistUpdate(...args),
    },
    $transaction: (...args: any[]) => mockTransaction(...args),
  },
}));

// Imported after the mock so the service picks up the mocked prisma client.
import tournamentService from '../services/tournament.service';

const baseTournament = {
  id: 't-001',
  status: 'ACTIVE',
  currentParticipants: 5,
  maxParticipants: 10,
};

describe('TournamentService.joinTournament (Issue #412)', () => {
  afterEach(() => {
    // resetAllMocks (not clearAllMocks) so an implementation set in one test —
    // e.g. the capacity-consuming tournament update — cannot leak into the next.
    jest.resetAllMocks();
  });

  it('throws NotFoundError when the tournament does not exist', async () => {
    mockTournamentFindUnique.mockResolvedValueOnce(null);

    await expect(
      tournamentService.joinTournament('user-1', 't-missing'),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('throws ValidationError when the tournament is cancelled', async () => {
    mockTournamentFindUnique.mockResolvedValueOnce({ ...baseTournament, status: 'CANCELLED' });

    await expect(
      tournamentService.joinTournament('user-1', 't-001'),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('throws ConflictError when the user already joined', async () => {
    // Outer findUnique (exists + not cancelled check)
    mockTournamentFindUnique.mockResolvedValueOnce(baseTournament);
    // Inner findUnique (inside transaction — re-fetch)
    mockTournamentFindUnique.mockResolvedValueOnce(baseTournament);
    mockParticipantFindUnique.mockResolvedValueOnce({
      tournamentId: 't-001',
      userId: 'user-1',
    });
    mockTransaction.mockImplementation(async (cb: any) => {
      if (typeof cb === 'function') return await cb(mockTx);
      return [];
    });

    await expect(
      tournamentService.joinTournament('user-1', 't-001'),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // No seat and no queue slot is handed out for a duplicate join.
    expect(mockParticipantCreate).not.toHaveBeenCalled();
    expect(mockWaitlistCreate).not.toHaveBeenCalled();
  });

  it('joins successfully and returns the updated participant count', async () => {
    // Outer findUnique (exists + not cancelled check)
    mockTournamentFindUnique.mockResolvedValueOnce(baseTournament);
    // Inner findUnique (inside transaction — re-fetch)
    mockTournamentFindUnique.mockResolvedValueOnce(baseTournament);
    mockParticipantFindUnique.mockResolvedValueOnce(null);
    mockWaitlistFindUnique.mockResolvedValueOnce(null);
    mockTournamentUpdate.mockResolvedValueOnce({ ...baseTournament, currentParticipants: 6 });
    mockTransaction.mockImplementation(async (cb: any) => {
      if (typeof cb === 'function') return await cb(mockTx);
      return [];
    });

    const result = await tournamentService.joinTournament('user-1', 't-001');

    expect(result).toEqual({ currentParticipants: 6, status: 'CONFIRMED' });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockParticipantCreate).toHaveBeenCalledTimes(1);
    expect(mockWaitlistCreate).not.toHaveBeenCalled();
  });

  describe('waitlist (Issue #874)', () => {
    it('queues the user instead of rejecting a join to a full tournament', async () => {
      // Outer findUnique (exists + not cancelled check)
      mockTournamentFindUnique.mockResolvedValueOnce(baseTournament);
      // Inner findUnique (inside transaction — full tournament)
      mockTournamentFindUnique.mockResolvedValueOnce({
        ...baseTournament,
        currentParticipants: 10,
        maxParticipants: 10,
      });
      mockParticipantFindUnique.mockResolvedValueOnce(null);
      mockWaitlistFindUnique.mockResolvedValueOnce(null);
      mockWaitlistFindFirst.mockResolvedValueOnce(null);
      mockWaitlistCount.mockResolvedValueOnce(0);
      mockTransaction.mockImplementation(async (cb: any) => {
        if (typeof cb === 'function') return await cb(mockTx);
        return [];
      });

      const result = await tournamentService.joinTournament('user-1', 't-001');

      expect(result).toEqual({
        currentParticipants: 10,
        status: 'WAITLISTED',
        waitlistPosition: 1,
      });
      // The user gets a queue ticket, not a seat.
      expect(mockParticipantCreate).not.toHaveBeenCalled();
      expect(mockWaitlistCreate).toHaveBeenCalledWith({
        data: { tournamentId: 't-001', userId: 'user-1', position: 1, status: 'WAITING' },
      });
    });

    it('reports the queue rank, not the raw ticket', async () => {
      mockTournamentFindUnique.mockResolvedValueOnce(baseTournament);
      mockTournamentFindUnique.mockResolvedValueOnce({
        ...baseTournament,
        currentParticipants: 10,
        maxParticipants: 10,
      });
      mockParticipantFindUnique.mockResolvedValueOnce(null);
      mockWaitlistFindUnique.mockResolvedValueOnce(null);
      // The last ticket is 7 …
      mockWaitlistFindFirst.mockResolvedValueOnce({ position: 7 });
      // … and three users are still waiting ahead of the newcomer.
      mockWaitlistCount.mockResolvedValueOnce(3);
      mockTransaction.mockImplementation(async (cb: any) => {
        if (typeof cb === 'function') return await cb(mockTx);
        return [];
      });

      const result = await tournamentService.joinTournament('user-1', 't-001');

      expect(result.waitlistPosition).toBe(4);
      expect(mockWaitlistCreate).toHaveBeenCalledWith({
        data: { tournamentId: 't-001', userId: 'user-1', position: 8, status: 'WAITING' },
      });
    });

    it('throws ConflictError when the user is already queued', async () => {
      mockTournamentFindUnique.mockResolvedValueOnce(baseTournament);
      mockTournamentFindUnique.mockResolvedValueOnce({
        ...baseTournament,
        currentParticipants: 10,
        maxParticipants: 10,
      });
      mockParticipantFindUnique.mockResolvedValueOnce(null);
      mockWaitlistFindUnique.mockResolvedValueOnce({
        id: 'w-1',
        tournamentId: 't-001',
        userId: 'user-1',
        position: 1,
        status: 'WAITING',
      });
      mockTransaction.mockImplementation(async (cb: any) => {
        if (typeof cb === 'function') return await cb(mockTx);
        return [];
      });

      await expect(
        tournamentService.joinTournament('user-1', 't-001'),
      ).rejects.toBeInstanceOf(ConflictError);

      expect(mockWaitlistCreate).not.toHaveBeenCalled();
    });

    it('re-queues a user who left the waitlist before', async () => {
      mockTournamentFindUnique.mockResolvedValueOnce(baseTournament);
      mockTournamentFindUnique.mockResolvedValueOnce({
        ...baseTournament,
        currentParticipants: 10,
        maxParticipants: 10,
      });
      mockParticipantFindUnique.mockResolvedValueOnce(null);
      mockWaitlistFindUnique.mockResolvedValueOnce({
        id: 'w-1',
        tournamentId: 't-001',
        userId: 'user-1',
        position: 3,
        status: 'CANCELLED',
      });
      mockWaitlistFindFirst.mockResolvedValueOnce({ position: 3 });
      mockWaitlistCount.mockResolvedValueOnce(0);
      mockTransaction.mockImplementation(async (cb: any) => {
        if (typeof cb === 'function') return await cb(mockTx);
        return [];
      });

      const result = await tournamentService.joinTournament('user-1', 't-001');

      expect(result.status).toBe('WAITLISTED');
      // The existing row is reused — the (tournamentId, userId) pair is unique.
      expect(mockWaitlistCreate).not.toHaveBeenCalled();
      expect(mockWaitlistUpdate).toHaveBeenCalledWith({
        where: { id: 'w-1' },
        data: { status: 'WAITING', position: 4 },
      });
    });
  });

  describe('concurrent race safety', () => {
    it('never hands out more seats than the tournament has', async () => {
      // Simulate 5 concurrent join attempts on a tournament with capacity for 3 more.
      // The interactive transaction serialises capacity checks so only 3 should
      // get a seat; the rest are queued on the waitlist (Issue #874) instead of
      // being rejected.
      // We're testing the service logic, not Prisma internals, so we model the
      // transaction's serialised behaviour by having each callback invocation
      // consume a "capacity slot" from a shared counter.
      let capacity = 3;

      // Each outer call returns the tournament (exists + not cancelled)
      mockTournamentFindUnique.mockResolvedValue(baseTournament);

      // The interactive transaction holds a row lock on the tournament, so the
      // transactions are serialised here as well: each one sees the participant
      // count left behind by the previous one.
      let chain: Promise<unknown> = Promise.resolve();
      mockTransaction.mockImplementation(async (cb: any) => {
        if (typeof cb === 'function') {
          const run = chain.then(() => {
            // Inner re-fetch: return the current tournament state, i.e. what
            // the previous (already serialised) transaction left behind.
            mockTournamentFindUnique.mockResolvedValueOnce({
              ...baseTournament,
              currentParticipants: baseTournament.maxParticipants - capacity,
              maxParticipants: baseTournament.maxParticipants,
            });
            return cb(mockTx);
          });
          chain = run.catch(() => undefined);
          return run;
        }
        return [];
      });

      // Each successful join consumes one capacity slot
      mockParticipantFindUnique.mockResolvedValue(null);
      mockWaitlistFindUnique.mockResolvedValue(null);
      mockWaitlistFindFirst.mockResolvedValue(null);
      mockWaitlistCount.mockResolvedValue(0);
      mockTournamentUpdate.mockImplementation(() => {
        if (capacity <= 0) throw new Error('should not reach here');
        capacity--;
        return Promise.resolve({
          ...baseTournament,
          currentParticipants: baseTournament.maxParticipants - capacity,
        });
      });

      const promises = Array.from({ length: 5 }, (_, i) =>
        tournamentService.joinTournament(`user-${i}`, 't-001').catch((e) => e),
      );

      const results = await Promise.all(promises);
      const confirmed = results.filter((r) => (r as any)?.status === 'CONFIRMED');
      const waitlisted = results.filter((r) => (r as any)?.status === 'WAITLISTED');

      // Exactly 3 get a seat …
      expect(confirmed.length).toBe(3);
      // … and the other 2 are queued instead of being rejected.
      expect(waitlisted.length).toBe(2);
      expect(results.filter((r) => r instanceof Error)).toHaveLength(0);
      expect(mockTransaction).toHaveBeenCalledTimes(5);
    });
  });
});

describe('TournamentService.leaveTournament (Issue #874)', () => {
  afterEach(() => {
    // resetAllMocks (not clearAllMocks) so an implementation set in one test —
    // e.g. the capacity-consuming tournament update — cannot leak into the next.
    jest.resetAllMocks();
  });

  it('frees the seat and promotes the first user in line', async () => {
    mockTournamentFindUnique.mockResolvedValue({
      ...baseTournament,
      currentParticipants: 10,
      maxParticipants: 10,
    });
    mockParticipantFindUnique.mockResolvedValueOnce({ id: 'p-1', tournamentId: 't-001', userId: 'user-1' });
    mockWaitlistFindMany.mockResolvedValueOnce([
      { id: 'w-1', tournamentId: 't-001', userId: 'user-2', position: 1, status: 'WAITING' },
    ]);
    mockTransaction.mockImplementation(async (cb: any) => {
      if (typeof cb === 'function') return await cb(mockTx);
      return [];
    });

    const result = await tournamentService.leaveTournament('user-1', 't-001');

    expect(result).toEqual({ currentParticipants: 10, promotedUserId: 'user-2' });
    expect(mockParticipantDelete).toHaveBeenCalledWith({ where: { id: 'p-1' } });
    expect(mockParticipantCreate).toHaveBeenCalledWith({
      data: { tournamentId: 't-001', userId: 'user-2' },
    });
    expect(mockWaitlistUpdate).toHaveBeenCalledWith({
      where: { id: 'w-1' },
      data: { status: 'PROMOTED' },
    });
  });

  it('closes the queue entry when a waiting user leaves', async () => {
    mockTournamentFindUnique.mockResolvedValue({
      ...baseTournament,
      currentParticipants: 10,
      maxParticipants: 10,
    });
    mockParticipantFindUnique.mockResolvedValueOnce(null);
    mockWaitlistFindUnique.mockResolvedValueOnce({
      id: 'w-1',
      tournamentId: 't-001',
      userId: 'user-1',
      position: 1,
      status: 'WAITING',
    });
    mockTransaction.mockImplementation(async (cb: any) => {
      if (typeof cb === 'function') return await cb(mockTx);
      return [];
    });

    const result = await tournamentService.leaveTournament('user-1', 't-001');

    expect(result).toEqual({ currentParticipants: 10 });
    expect(mockWaitlistUpdate).toHaveBeenCalledWith({
      where: { id: 'w-1' },
      data: { status: 'CANCELLED' },
    });
    expect(mockParticipantDelete).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the user is not part of the tournament', async () => {
    mockTournamentFindUnique.mockResolvedValue(baseTournament);
    mockParticipantFindUnique.mockResolvedValueOnce(null);
    mockWaitlistFindUnique.mockResolvedValueOnce(null);
    mockTransaction.mockImplementation(async (cb: any) => {
      if (typeof cb === 'function') return await cb(mockTx);
      return [];
    });

    await expect(
      tournamentService.leaveTournament('user-1', 't-001'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('TournamentService.getWaitlist (Issue #874)', () => {
  afterEach(() => {
    // resetAllMocks (not clearAllMocks) so an implementation set in one test —
    // e.g. the capacity-consuming tournament update — cannot leak into the next.
    jest.resetAllMocks();
  });

  it('returns the waiting users in queue order with contiguous ranks', async () => {
    mockWaitlistFindMany.mockResolvedValueOnce([
      {
        id: 'w-1',
        tournamentId: 't-001',
        userId: 'user-1',
        position: 4,
        status: 'WAITING',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 'w-2',
        tournamentId: 't-001',
        userId: 'user-2',
        position: 9,
        status: 'WAITING',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);

    const waitlist = await tournamentService.getWaitlist('t-001');

    expect(waitlist).toEqual([
      {
        tournamentId: 't-001',
        userId: 'user-1',
        position: 1,
        status: 'WAITING',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        tournamentId: 't-001',
        userId: 'user-2',
        position: 2,
        status: 'WAITING',
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
  });
});

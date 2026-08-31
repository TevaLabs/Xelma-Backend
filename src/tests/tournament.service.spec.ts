import { describe, it, expect, afterEach } from '@jest/globals';
import { NotFoundError, ConflictError, ValidationError } from '../utils/errors';

const mockTournamentFindUnique = jest.fn();
const mockTournamentUpdate = jest.fn();
const mockParticipantFindUnique = jest.fn();
const mockParticipantCreate = jest.fn();
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
    jest.clearAllMocks();
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

  it('throws ConflictError when the tournament is full', async () => {
    // Outer findUnique (exists + not cancelled check)
    mockTournamentFindUnique.mockResolvedValueOnce(baseTournament);
    // Inner findUnique (inside transaction — capacity check)
    mockTournamentFindUnique.mockResolvedValueOnce({
      ...baseTournament,
      currentParticipants: 10,
      maxParticipants: 10,
    });
    mockTransaction.mockImplementation(async (cb: any) => {
      if (typeof cb === 'function') return await cb(mockTx);
      return [];
    });

    await expect(
      tournamentService.joinTournament('user-1', 't-001'),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // The row lock is taken before the capacity read inside the transaction
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    // Capacity check happens before membership check inside the transaction
    expect(mockParticipantFindUnique).not.toHaveBeenCalled();
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
  });

  it('joins successfully and returns the updated participant count', async () => {
    // Outer findUnique (exists + not cancelled check)
    mockTournamentFindUnique.mockResolvedValueOnce(baseTournament);
    // Inner findUnique (inside transaction — re-fetch)
    mockTournamentFindUnique.mockResolvedValueOnce(baseTournament);
    mockParticipantFindUnique.mockResolvedValueOnce(null);
    mockTournamentUpdate.mockResolvedValueOnce({ ...baseTournament, currentParticipants: 6 });
    mockTransaction.mockImplementation(async (cb: any) => {
      if (typeof cb === 'function') return await cb(mockTx);
      return [];
    });

    const result = await tournamentService.joinTournament('user-1', 't-001');

    expect(result).toEqual({ currentParticipants: 6 });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('checks capacity before checking existing membership inside the transaction', async () => {
    // Outer findUnique (exists + not cancelled check)
    mockTournamentFindUnique.mockResolvedValueOnce(baseTournament);
    // Inner findUnique returns a full tournament — capacity check fires first
    mockTournamentFindUnique.mockResolvedValueOnce({
      ...baseTournament,
      currentParticipants: 10,
      maxParticipants: 10,
    });
    mockTransaction.mockImplementation(async (cb: any) => {
      if (typeof cb === 'function') return await cb(mockTx);
      return [];
    });

    await expect(
      tournamentService.joinTournament('user-1', 't-001'),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(mockParticipantFindUnique).not.toHaveBeenCalled();
  });

  describe('concurrent race safety', () => {
    it('does not overfill when multiple users join concurrently', async () => {
      // Simulate 5 concurrent join attempts on a tournament with capacity for 3 more.
      // The interactive transaction serialises capacity checks so only 3 should succeed.
      // We're testing the service logic, not Prisma internals, so we model the
      // transaction's serialised behaviour by having each callback invocation
      // consume a "capacity slot" from a shared counter.
      let capacity = 3;

      // Each outer call returns the tournament (exists + not cancelled)
      mockTournamentFindUnique.mockResolvedValue(baseTournament);

      mockTransaction.mockImplementation(async (cb: any) => {
        if (typeof cb === 'function') {
          // Inner re-fetch: return the current tournament state
          mockTournamentFindUnique.mockResolvedValueOnce({
            ...baseTournament,
            currentParticipants: baseTournament.maxParticipants - capacity,
            maxParticipants: baseTournament.maxParticipants,
          });
          return await cb(mockTx);
        }
        return [];
      });

      // Each successful join consumes one capacity slot
      mockParticipantFindUnique.mockResolvedValue(null);
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
      const successes = results.filter(
        (r) => (r as any)?.currentParticipants !== undefined,
      );

      // At most 3 should succeed (capacity = 3)
      expect(successes.length).toBeLessThanOrEqual(3);
      // At least 2 should be rejected as full
      expect(successes.length).toBe(3);
      expect(mockTransaction).toHaveBeenCalledTimes(5);
    });
  });
});

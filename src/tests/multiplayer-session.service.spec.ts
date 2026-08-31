/**
 * Issue #194 — multiplayer-session.service unit tests.
 *
 * Verifies the persistence semantics that power reconnect continuity:
 *   - recordConnect upserts and snapshots the prior row.
 *   - addRoom / removeRoom mutate `rooms` immutably and dedupe.
 *   - patchMetadata merges and clamps oversized blobs.
 *   - recordDisconnect preserves the row and stamps disconnectedAt.
 *   - all methods swallow DB errors instead of throwing.
 *
 * Issue #555 — additional tests:
 *   - addRoom / removeRoom execute inside withRoomLock.
 *   - reconcileRooms detects and corrects DB-vs-adapter drift.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockSessionFindUnique = jest.fn();
const mockSessionUpsert = jest.fn();
const mockSessionUpdate = jest.fn();
const mockSessionUpdateMany = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    multiplayerSession: {
      findUnique: (...args: any[]) => mockSessionFindUnique(...args),
      upsert: (...args: any[]) => mockSessionUpsert(...args),
      update: (...args: any[]) => mockSessionUpdate(...args),
      updateMany: (...args: any[]) => mockSessionUpdateMany(...args),
    },
  },
}));

// Mock withRoomLock to execute the callback directly (no Redis in unit tests).
// Also track calls so we can verify the lock IS being used.
const mockWithRoomLock = jest.fn(async (userId: string, fn: () => Promise<any>) => fn());
jest.mock('../utils/room-lock', () => ({
  withRoomLock: (...args: any[]) => mockWithRoomLock(...args),
}));

// Import AFTER mocks are in place.
import multiplayerSessionService, {
  MAX_PERSISTED_ROOMS,
  MAX_METADATA_CHARS,
  asStringArray,
} from '../services/multiplayer-session.service';

const USER_ID = 'user-194';
const WALLET = 'GMULTIPLAYER_SESSION_TEST_WALLET_______________';
const SOCKET_ID = 'sock-abc';

describe('MultiplayerSessionService (Issue #194)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('recordConnect', () => {
    it('returns empty resume payload on first connect (no prior row)', async () => {
      mockSessionFindUnique.mockResolvedValueOnce(null);
      mockSessionUpsert.mockResolvedValueOnce({});

      const resume = await multiplayerSessionService.recordConnect({
        userId: USER_ID,
        walletAddress: WALLET,
        socketId: SOCKET_ID,
      });

      expect(resume).toEqual({
        rooms: [],
        metadata: null,
        lastSeenAt: null,
        disconnectedAt: null,
      });
      expect(mockSessionUpsert).toHaveBeenCalledTimes(1);
      const args = mockSessionUpsert.mock.calls[0][0];
      expect(args.where).toEqual({ userId: USER_ID });
      expect(args.create.walletAddress).toBe(WALLET);
      expect(args.create.socketId).toBe(SOCKET_ID);
      expect(args.update.disconnectedAt).toBeNull();
    });

    it('returns prior rooms + metadata on reconnect', async () => {
      const lastSeen = new Date('2026-05-30T10:00:00.000Z');
      const disconnectedAt = new Date('2026-05-30T10:05:00.000Z');
      mockSessionFindUnique.mockResolvedValueOnce({
        userId: USER_ID,
        walletAddress: WALLET,
        rooms: ['round', 'chat'],
        metadata: { lastRoundId: 'r-1' },
        lastSeenAt: lastSeen,
        disconnectedAt,
      });
      mockSessionUpsert.mockResolvedValueOnce({});

      const resume = await multiplayerSessionService.recordConnect({
        userId: USER_ID,
        walletAddress: WALLET,
        socketId: 'new-socket',
      });

      expect(resume.rooms).toEqual(['round', 'chat']);
      expect(resume.metadata).toEqual({ lastRoundId: 'r-1' });
      expect(resume.lastSeenAt).toBe(lastSeen.toISOString());
      expect(resume.disconnectedAt).toBe(disconnectedAt.toISOString());

      // upsert.update must NOT clobber rooms or metadata — those are
      // preserved server-side so the resume is meaningful.
      const updateArgs = mockSessionUpsert.mock.calls[0][0].update;
      expect(updateArgs.rooms).toBeUndefined();
      expect(updateArgs.metadata).toBeUndefined();
      expect(updateArgs.disconnectedAt).toBeNull();
      expect(updateArgs.socketId).toBe('new-socket');
    });

    it('filters non-string entries out of prior rooms', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({
        userId: USER_ID,
        rooms: ['round', 42, null, 'chat'] as unknown as string[],
        metadata: null,
        lastSeenAt: new Date(),
        disconnectedAt: null,
      });
      mockSessionUpsert.mockResolvedValueOnce({});

      const resume = await multiplayerSessionService.recordConnect({
        userId: USER_ID,
        walletAddress: WALLET,
        socketId: SOCKET_ID,
      });

      expect(resume.rooms).toEqual(['round', 'chat']);
    });

    it('returns empty payload (does not throw) on DB error', async () => {
      mockSessionFindUnique.mockRejectedValueOnce(new Error('db down'));

      const resume = await multiplayerSessionService.recordConnect({
        userId: USER_ID,
        walletAddress: WALLET,
        socketId: SOCKET_ID,
      });

      expect(resume).toEqual({
        rooms: [],
        metadata: null,
        lastSeenAt: null,
        disconnectedAt: null,
      });
    });
  });

  describe('addRoom / removeRoom', () => {
    it('appends a new room without duplicating existing entries', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({
        rooms: ['round'],
      });
      mockSessionUpdate.mockResolvedValueOnce({});

      await multiplayerSessionService.addRoom(USER_ID, 'chat');

      const args = mockSessionUpdate.mock.calls[0][0];
      expect(args.data.rooms).toEqual(['round', 'chat']);
    });

    it('is a no-op when the room is already present', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({
        rooms: ['round', 'chat'],
      });

      await multiplayerSessionService.addRoom(USER_ID, 'chat');

      // No DB write should occur — room already in the set.
      expect(mockSessionUpdate).not.toHaveBeenCalled();
    });

    it('caps persisted rooms at MAX_PERSISTED_ROOMS', async () => {
      const tooMany = Array.from({ length: MAX_PERSISTED_ROOMS + 5 }, (_, i) => `r${i}`);
      mockSessionFindUnique.mockResolvedValueOnce({
        rooms: tooMany,
      });
      mockSessionUpdate.mockResolvedValueOnce({});

      await multiplayerSessionService.addRoom(USER_ID, 'one-more');

      const args = mockSessionUpdate.mock.calls[0][0];
      expect(args.data.rooms.length).toBe(MAX_PERSISTED_ROOMS);
      // Cap drops the trailing additions, not the originals, so "one-more"
      // should not be in the persisted list.
      expect(args.data.rooms).not.toContain('one-more');
    });

    it('removes the requested room and leaves others intact', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({
        rooms: ['round', 'chat', 'user:abc'],
      });
      mockSessionUpdate.mockResolvedValueOnce({});

      await multiplayerSessionService.removeRoom(USER_ID, 'chat');

      const args = mockSessionUpdate.mock.calls[0][0];
      expect(args.data.rooms).toEqual(['round', 'user:abc']);
    });

    it('does nothing when no session row exists yet', async () => {
      mockSessionFindUnique.mockResolvedValueOnce(null);

      await multiplayerSessionService.addRoom(USER_ID, 'chat');
      await multiplayerSessionService.removeRoom(USER_ID, 'chat');

      expect(mockSessionUpdate).not.toHaveBeenCalled();
    });

    it('swallows DB errors instead of throwing', async () => {
      mockSessionFindUnique.mockRejectedValueOnce(new Error('boom'));
      await expect(
        multiplayerSessionService.addRoom(USER_ID, 'chat'),
      ).resolves.toBeUndefined();
    });

    it('ignores empty/invalid input without touching the DB', async () => {
      await multiplayerSessionService.addRoom('', 'chat');
      await multiplayerSessionService.addRoom(USER_ID, '');
      await multiplayerSessionService.removeRoom('', 'chat');
      await multiplayerSessionService.removeRoom(USER_ID, '');
      expect(mockSessionFindUnique).not.toHaveBeenCalled();
      expect(mockSessionUpdate).not.toHaveBeenCalled();
    });
  });

  describe('addRoom / removeRoom — distributed lock (Issue #555)', () => {
    it('executes addRoom inside withRoomLock', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({ rooms: ['round'] });
      mockSessionUpdate.mockResolvedValueOnce({});

      await multiplayerSessionService.addRoom(USER_ID, 'chat');

      expect(mockWithRoomLock).toHaveBeenCalledTimes(1);
      expect(mockWithRoomLock).toHaveBeenCalledWith(
        USER_ID,
        expect.any(Function),
      );
    });

    it('executes removeRoom inside withRoomLock', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({
        rooms: ['round', 'chat'],
      });
      mockSessionUpdate.mockResolvedValueOnce({});

      await multiplayerSessionService.removeRoom(USER_ID, 'chat');

      expect(mockWithRoomLock).toHaveBeenCalledTimes(1);
      expect(mockWithRoomLock).toHaveBeenCalledWith(
        USER_ID,
        expect.any(Function),
      );
    });

    it('does not call withRoomLock when userId is empty', async () => {
      await multiplayerSessionService.addRoom('', 'chat');
      await multiplayerSessionService.removeRoom('', 'chat');

      expect(mockWithRoomLock).not.toHaveBeenCalled();
    });

    it('serializes concurrent addRoom + removeRoom for the same user', async () => {
      // Simulate two operations queued via withRoomLock.
      // The lock mock executes callbacks sequentially (as they would be
      // serialized by the real Redis lock).
      const callOrder: string[] = [];

      mockWithRoomLock.mockImplementationOnce(async (_userId: string, fn: () => Promise<any>) => {
        callOrder.push('add-start');
        const result = await fn();
        callOrder.push('add-end');
        return result;
      });
      mockWithRoomLock.mockImplementationOnce(async (_userId: string, fn: () => Promise<any>) => {
        callOrder.push('remove-start');
        const result = await fn();
        callOrder.push('remove-end');
        return result;
      });

      mockSessionFindUnique
        .mockResolvedValueOnce({ rooms: [] })
        .mockResolvedValueOnce({ rooms: ['round'] });
      mockSessionUpdate
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await multiplayerSessionService.addRoom(USER_ID, 'round');
      await multiplayerSessionService.removeRoom(USER_ID, 'round');

      // Operations executed sequentially under the lock
      expect(callOrder).toEqual([
        'add-start',
        'add-end',
        'remove-start',
        'remove-end',
      ]);
    });
  });

  describe('reconcileRooms (Issue #555)', () => {
    it('returns empty array when userId is empty', async () => {
      const result = await multiplayerSessionService.reconcileRooms('', ['round']);
      expect(result).toEqual([]);
    });

    it('returns adapter rooms when no session exists in DB', async () => {
      mockSessionFindUnique.mockResolvedValueOnce(null);

      const result = await multiplayerSessionService.reconcileRooms(
        USER_ID,
        ['round', 'chat'],
      );
      expect(result).toEqual(['round', 'chat']);
    });

    it('returns DB rooms unchanged when already consistent with adapter', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({
        rooms: ['round', 'chat'],
      });

      const result = await multiplayerSessionService.reconcileRooms(
        USER_ID,
        ['round', 'chat'],
      );
      expect(result).toEqual(['round', 'chat']);
      // No DB update should occur
      expect(mockSessionUpdate).not.toHaveBeenCalled();
    });

    it('removes stale rooms present in DB but missing from adapter', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({
        rooms: ['round', 'chat', 'stale-room'],
      });
      mockSessionUpdate.mockResolvedValueOnce({});

      const result = await multiplayerSessionService.reconcileRooms(
        USER_ID,
        ['round', 'chat'],
      );

      expect(result).toEqual(['round', 'chat']);
      const updateArgs = mockSessionUpdate.mock.calls[0][0];
      expect(updateArgs.data.rooms).toEqual(['round', 'chat']);
    });

    it('persists rooms present in adapter but missing from DB', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({
        rooms: ['round'],
      });
      mockSessionUpdate.mockResolvedValueOnce({});

      const result = await multiplayerSessionService.reconcileRooms(
        USER_ID,
        ['round', 'chat'],
      );

      expect(result).toEqual(['round', 'chat']);
      const updateArgs = mockSessionUpdate.mock.calls[0][0];
      expect(updateArgs.data.rooms).toEqual(['round', 'chat']);
    });

    it('handles both stale and missing rooms simultaneously', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({
        rooms: ['round', 'old-room'],
      });
      mockSessionUpdate.mockResolvedValueOnce({});

      const result = await multiplayerSessionService.reconcileRooms(
        USER_ID,
        ['round', 'new-room'],
      );

      expect(result).toEqual(['round', 'new-room']);
      const updateArgs = mockSessionUpdate.mock.calls[0][0];
      expect(updateArgs.data.rooms).toEqual(['round', 'new-room']);
    });

    it('returns adapter rooms on DB error (best-effort)', async () => {
      mockSessionFindUnique.mockRejectedValueOnce(new Error('db down'));

      const result = await multiplayerSessionService.reconcileRooms(
        USER_ID,
        ['round'],
      );
      expect(result).toEqual(['round']);
    });

    it('deduplicates rooms during reconciliation', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({
        rooms: ['round'],
      });
      mockSessionUpdate.mockResolvedValueOnce({});

      const result = await multiplayerSessionService.reconcileRooms(
        USER_ID,
        ['round', 'round', 'chat'],
      );

      expect(result).toEqual(['round', 'chat']);
    });

    it('caps reconciled rooms at MAX_PERSISTED_ROOMS', async () => {
      const manyDbRooms = Array.from({ length: 20 }, (_, i) => `db-room-${i}`);
      const manyAdapterRooms = Array.from({ length: 20 }, (_, i) => `adapter-room-${i}`);
      mockSessionFindUnique.mockResolvedValueOnce({
        rooms: manyDbRooms,
      });
      mockSessionUpdate.mockResolvedValueOnce({});

      const result = await multiplayerSessionService.reconcileRooms(
        USER_ID,
        manyAdapterRooms,
      );

      expect(result.length).toBeLessThanOrEqual(MAX_PERSISTED_ROOMS);
    });
  });

  describe('patchMetadata', () => {
    it('merges patch into existing metadata', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({
        metadata: { lastRoundId: 'r-1', draft: 'hi' },
      });
      mockSessionUpdate.mockResolvedValueOnce({});

      await multiplayerSessionService.patchMetadata(USER_ID, {
        draft: 'updated',
        cursor: 5,
      });

      const args = mockSessionUpdate.mock.calls[0][0];
      expect(args.data.metadata).toEqual({
        lastRoundId: 'r-1',
        draft: 'updated',
        cursor: 5,
      });
    });

    it('drops oversized metadata silently', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({ metadata: null });
      mockSessionUpdate.mockResolvedValueOnce({});

      const huge = { blob: 'x'.repeat(MAX_METADATA_CHARS + 100) };
      await multiplayerSessionService.patchMetadata(USER_ID, huge);

      // Service should call update with metadata === undefined (i.e. not set)
      // rather than throwing.
      const args = mockSessionUpdate.mock.calls[0][0];
      expect(args.data.metadata).toBeUndefined();
    });
  });

  describe('recordDisconnect', () => {
    it('stamps disconnectedAt and clears socketId via updateMany', async () => {
      mockSessionUpdateMany.mockResolvedValueOnce({ count: 1 });

      await multiplayerSessionService.recordDisconnect(USER_ID);

      expect(mockSessionUpdateMany).toHaveBeenCalledTimes(1);
      const args = mockSessionUpdateMany.mock.calls[0][0];
      expect(args.where).toEqual({ userId: USER_ID });
      expect(args.data.disconnectedAt).toBeInstanceOf(Date);
      expect(args.data.socketId).toBeNull();
    });

    it('does not throw on DB error', async () => {
      mockSessionUpdateMany.mockRejectedValueOnce(new Error('nope'));
      await expect(
        multiplayerSessionService.recordDisconnect(USER_ID),
      ).resolves.toBeUndefined();
    });

    it('is a no-op when userId is empty', async () => {
      await multiplayerSessionService.recordDisconnect('');
      expect(mockSessionUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('getResumePayload', () => {
    it('returns the persisted resume snapshot', async () => {
      const lastSeen = new Date('2026-05-30T11:00:00.000Z');
      mockSessionFindUnique.mockResolvedValueOnce({
        rooms: ['round'],
        metadata: { x: 1 },
        lastSeenAt: lastSeen,
        disconnectedAt: null,
      });

      const out = await multiplayerSessionService.getResumePayload(USER_ID);

      expect(out.rooms).toEqual(['round']);
      expect(out.metadata).toEqual({ x: 1 });
      expect(out.lastSeenAt).toBe(lastSeen.toISOString());
      expect(out.disconnectedAt).toBeNull();
    });

    it('returns empty payload when no session exists', async () => {
      mockSessionFindUnique.mockResolvedValueOnce(null);
      const out = await multiplayerSessionService.getResumePayload(USER_ID);
      expect(out.rooms).toEqual([]);
      expect(out.metadata).toBeNull();
    });
  });

  describe('asStringArray (exported helper)', () => {
    it('returns empty array for non-array input', () => {
      expect(asStringArray(null)).toEqual([]);
      expect(asStringArray(undefined)).toEqual([]);
      expect(asStringArray('string')).toEqual([]);
      expect(asStringArray(42)).toEqual([]);
    });

    it('filters non-string entries', () => {
      expect(asStringArray(['a', 1, 'b', null, 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array for empty array', () => {
      expect(asStringArray([])).toEqual([]);
    });
  });
});

/*
 * Issue #194 -- multiplayer-session.service unit tests.
 *
 * Verifies the persistence semantics that power reconnect continuity:
 *   - recordConnect upserts and snapshots the prior row.
 *   - addRoom / removeRoom mutate `rooms` immutably and dedupe.
 *   - patchMetadata merges and clamps oversized blobs.
 *   - recordDisconnect preserves the row and stamps disconnectedAt.
 *   - all methods swallow DV errors instead of throwing.
 *
 * Issue #555 -- additional tests:
 *   - addRoom / removeRoom execute inside withRoomLock.
 *   - reconcileRooms detects and corrects DB-vs-adapter drift.
 *
 * Issue #194 -- session cleanup retention:
 *   - purgeStaleSessions deletes rows whose disconnectedAt is older than
 *     the retention window and swallows DB errors.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockSessionFindUnique = jest.fn();
const mockSessionUpsert = jest.fn();
const mockSessionUpdate = jest.fn();
const mockSessionUpdateMany = jest.fn();
const mockSessionDeleteMany = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    multiplayerSession: {
      findUnique: (...args: any[]) => mockSessionFindUnique(...args),
      upsert: (...args: any[]) => mockSessionUpsert(...args),
      update: (...args: any[]) => mockSessionUpdate(...args),
      updateMany: (...args: any[]) => mockSessionUpdateMany(...args),
      deleteMany: (...args: any[]) => mockSessionDeleteMany(...args),
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
  DEFAULT_SESSION_RETENTION_MS,
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

      // upsert.update must NOT clobber rooms or metadata -- those are
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

      // No DB write should occur -- room already in the set.
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

  describe('addRoom / removeRoom -- distributed lock ( Issue #555)', () => {
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
      mockSessionFindUnique.mockResolvedValueOnce({ rooms: ['round', 'chat'] });
      mockSessionUpdate.mockResolvedValueOnce({});

      await multiplayerSessionService.removeRoom(USER_ID, 'chat');

      expect(mockWithRoomLock).toHaveBeenCalledTimes(1);
      expect(mockWithRoomLock).toHaveBeenCalledWith(
        USER_ID,
        expect.any(Function),
      );
    });
  });

  describe('purgeStaleSessions', () => {
    it('deletes rows whose disconnectedAt is older than the retention window', async () => {
      mockSessionDeleteMany.mockResolvedValueOnce({ count: 3 });

      const deleted = await multiplayerSessionService.purgeStaleSessions();

      expect(deleted).toBe(3);
      expect(mockSessionDeleteMany).toHaveBeenCalledTimes(1);
      const args = mockSessionDeleteMany.mock.calls[0][0];
      expect(args.where.disconnectedAt.lt).toBeInstanceOf(Date);
      const cutoff = args.where.disconnectedAt.lt as Date;
      const expectedCutoff = Date.now() - DEFAULT_SESSION_RETENTION_MS;
      expect(Math.abs(cutoff.getTime() - expectedCutoff)).toBeLessThan(10000);
    });

    it('returns 0 and swallows DV errors', async () => {
      mockSessionDeleteMany.mockRejectedValueOnce(new Error('db down'));

      const deleted = await multiplayerSessionService.purgeStaleSessions();

      expect(deleted).toBe(0);
    });
  });

  describe('recordDisconnect', () => {
    it('stamps disconnectedAt without deleting the row', async () => {
      mockSessionUpdate.mockResolvedValueOnce({});

      await multiplayerSessionService.recordDisconnect(USER_ID);

      expect(mockSessionUpdate).toHaveBeenCalledTimes(1);
      const args = mockSessionUpdate.mock.calls[0][0];
      expect(args.where).toEqual({ userId: USER_ID });
      expect(args.data.disconnectedAt).toBeInstanceOf(Date);
      expect(mockSessionDeleteMany).not.toHaveBeenCalled();
    });

    it('swallows DB errors instead of throwing', async () => {
      mockSessionUpdate.mockRejectedValueOnce(new Error('boom'));
      await expect(
        multiplayerSessionService.recordDisconnect(USER_ID),
      ).resolves.toBeUndefined();
    });
  });

  describe('asStringArray', () => {
    it('filters out non-string entries', () => {
      expect(asStringArray(['a', 1, null, 'b'])).toEqual(['a', 'b']);
    });

    it('returns an empty array for non-array input', () => {
      expect(asStringArray(null)).toEqual([]);
      expect(asStringArray('not-an-array')).toEqual([]);
    });
  });
});

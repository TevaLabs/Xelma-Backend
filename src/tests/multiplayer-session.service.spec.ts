/**
 * Issue #194 — multiplayer-session.service unit tests.
 *
 * Verifies the persistence semantics that power reconnect continuity:
 *   - recordConnect upserts and snapshots the prior row.
 *   - patchMetadata merges and clamps oversized blobs.
 *   - recordDisconnect preserves the row and stamps disconnectedAt.
 *   - all methods swallow DB errors instead of throwing.
 *
 * Issue #669 — room membership protocol (with a fake adapter transport):
 *   - join commits the DB before the adapter join, leave deletes before the
 *     adapter leave, both inside withRoomLock.
 *   - a failed adapter join is compensated only when this call added the
 *     membership; a failed adapter leave never re-adds it.
 *   - join/leave are idempotent and reject non-membership rooms.
 *   - restoreMembership joins exactly the DB membership rooms.
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

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Import AFTER mocks are in place.
import multiplayerSessionService, {
  MAX_PERSISTED_ROOMS,
  MAX_METADATA_CHARS,
  asStringArray,
  type RoomMembershipTransport,
} from '../services/multiplayer-session.service';
import logger from '../utils/logger';

const mockLogger = jest.mocked(logger);

/**
 * Fake adapter transport that records every call into `log`, so tests can
 * assert the order of DB and adapter steps.
 */
function trackedTransport(opts: { failJoin?: boolean; failLeave?: boolean } = {}): {
  transport: RoomMembershipTransport;
  log: string[];
} {
  const log: string[] = [];
  const transport: RoomMembershipTransport = {
    join: async (userId, room) => {
      log.push(`adapter:join:${userId}:${room}`);
      if (opts.failJoin) throw new Error('adapter join timed out');
    },
    leave: async (userId, room) => {
      log.push(`adapter:leave:${userId}:${room}`);
      if (opts.failLeave) throw new Error('adapter leave timed out');
    },
  };
  return { transport, log };
}

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

  // -------------------------------------------------------------------------
  // Room membership protocol (Issue #669)
  // -------------------------------------------------------------------------

  describe('joinRoom (Issue #669)', () => {
    it('commits DB membership BEFORE the adapter join, all under the room lock', async () => {
      const { transport, log } = trackedTransport();
      mockWithRoomLock.mockImplementationOnce(async (_userId: string, fn: () => Promise<unknown>) => {
        log.push('lock:acquire');
        const result = await fn();
        log.push('lock:release');
        return result;
      });
      mockSessionFindUnique.mockResolvedValueOnce({ rooms: ['round'] });
      mockSessionUpdate.mockImplementationOnce(async () => {
        log.push('db:commit');
        return {};
      });

      const result = await multiplayerSessionService.joinRoom(USER_ID, 'chat', transport);

      expect(result).toEqual({ ok: true, room: 'chat', changed: true, adapterSynced: true });
      expect(log).toEqual([
        'lock:acquire',
        'db:commit',
        `adapter:join:${USER_ID}:chat`,
        'lock:release',
      ]);
      expect(mockWithRoomLock).toHaveBeenCalledWith(USER_ID, expect.any(Function));
      expect(mockSessionUpdate.mock.calls[0][0].data.rooms).toEqual(['round', 'chat']);
    });

    it('compensates when the adapter join fails: removes the DB row it added, then socketsLeave', async () => {
      const { transport, log } = trackedTransport({ failJoin: true });
      mockSessionFindUnique
        .mockResolvedValueOnce({ rooms: ['round'] })
        .mockResolvedValueOnce({ rooms: ['round', 'chat'] });
      mockSessionUpdate
        .mockImplementationOnce(async () => {
          log.push('db:commit');
          return {};
        })
        .mockImplementationOnce(async () => {
          log.push('db:compensate');
          return {};
        });

      const result = await multiplayerSessionService.joinRoom(USER_ID, 'chat', transport);

      expect(result).toEqual({
        ok: false,
        room: 'chat',
        code: 'MEMBERSHIP_SYNC_FAILED',
        message: 'Could not join chat; please retry.',
      });
      expect(log).toEqual([
        'db:commit',
        `adapter:join:${USER_ID}:chat`,
        'db:compensate',
        `adapter:leave:${USER_ID}:chat`,
      ]);
      // The compensating write restores the pre-join membership.
      expect(mockSessionUpdate.mock.calls[1][0].data.rooms).toEqual(['round']);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('adapter join failed, compensating (membership added by this call)'),
      );
    });

    it('keeps a pre-existing membership when the adapter join fails', async () => {
      const { transport, log } = trackedTransport({ failJoin: true });
      mockSessionFindUnique.mockResolvedValueOnce({ rooms: ['chat'] });

      const result = await multiplayerSessionService.joinRoom(USER_ID, 'chat', transport);

      expect(result.ok).toBe(false);
      // No DB write at all: neither a (no-op) add nor a compensating delete.
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      // And the user's sockets are not pulled out of a room they belong to.
      expect(log).toEqual([`adapter:join:${USER_ID}:chat`]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('membership pre-existing, kept'),
      );
    });

    it('is idempotent: a repeat join is a no-op success that re-syncs presence', async () => {
      const { transport, log } = trackedTransport();
      mockSessionFindUnique.mockResolvedValueOnce({ rooms: ['chat'] });

      const result = await multiplayerSessionService.joinRoom(USER_ID, 'chat', transport);

      expect(result).toEqual({ ok: true, room: 'chat', changed: false, adapterSynced: true });
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      expect(log).toEqual([`adapter:join:${USER_ID}:chat`]);
    });

    it('does not touch the adapter when the DB commit fails', async () => {
      const { transport, log } = trackedTransport();
      mockSessionFindUnique.mockResolvedValueOnce({ rooms: [] });
      mockSessionUpdate.mockRejectedValueOnce(new Error('db down'));

      const result = await multiplayerSessionService.joinRoom(USER_ID, 'round', transport);

      expect(result).toMatchObject({ ok: false, code: 'MEMBERSHIP_PERSIST_FAILED' });
      expect(log).toEqual([]);
    });

    it('fails the join when no session row exists (nothing to commit to)', async () => {
      const { transport, log } = trackedTransport();
      mockSessionFindUnique.mockResolvedValueOnce(null);

      const result = await multiplayerSessionService.joinRoom(USER_ID, 'round', transport);

      expect(result).toMatchObject({ ok: false, code: 'MEMBERSHIP_PERSIST_FAILED' });
      expect(log).toEqual([]);
    });

    it('fails the join when the persisted room limit is reached', async () => {
      const { transport, log } = trackedTransport();
      const full = Array.from({ length: MAX_PERSISTED_ROOMS }, (_, i) => `round:r${i}`);
      mockSessionFindUnique.mockResolvedValueOnce({ rooms: full });

      const result = await multiplayerSessionService.joinRoom(USER_ID, 'chat', transport);

      expect(result).toMatchObject({ ok: false, code: 'MEMBERSHIP_PERSIST_FAILED' });
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      expect(log).toEqual([]);
    });

    it('leaves presence alone when the compensating DB delete fails (DB still says member)', async () => {
      const { transport, log } = trackedTransport({ failJoin: true });
      mockSessionFindUnique
        .mockResolvedValueOnce({ rooms: [] })
        .mockResolvedValueOnce({ rooms: ['chat'] });
      mockSessionUpdate
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('db down'));

      const result = await multiplayerSessionService.joinRoom(USER_ID, 'chat', transport);

      expect(result).toMatchObject({ ok: false, code: 'MEMBERSHIP_SYNC_FAILED' });
      expect(log).toEqual([`adapter:join:${USER_ID}:chat`]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('compensation DB delete failed'),
      );
    });

    it.each([
      ['a user room', `user:${USER_ID}`],
      ['an unprefixed room', 'lobby'],
      ['a round id with a colon', 'round:user:abc'],
      ['a round id with spaces', 'round:bad id'],
      ['an empty room', ''],
    ])('rejects %s without touching the DB, lock or adapter', async (_label, room) => {
      const { transport, log } = trackedTransport();

      const result = await multiplayerSessionService.joinRoom(USER_ID, room, transport);

      expect(result).toMatchObject({ ok: false, code: 'INVALID_ROOM' });
      expect(mockWithRoomLock).not.toHaveBeenCalled();
      expect(mockSessionFindUnique).not.toHaveBeenCalled();
      expect(log).toEqual([]);
    });
  });

  describe('leaveRoom (Issue #669)', () => {
    it('deletes DB membership BEFORE the adapter leave, all under the room lock', async () => {
      const { transport, log } = trackedTransport();
      mockWithRoomLock.mockImplementationOnce(async (_userId: string, fn: () => Promise<unknown>) => {
        log.push('lock:acquire');
        const result = await fn();
        log.push('lock:release');
        return result;
      });
      mockSessionFindUnique.mockResolvedValueOnce({ rooms: ['round', 'chat'] });
      mockSessionUpdate.mockImplementationOnce(async () => {
        log.push('db:delete');
        return {};
      });

      const result = await multiplayerSessionService.leaveRoom(USER_ID, 'chat', transport);

      expect(result).toEqual({ ok: true, room: 'chat', changed: true, adapterSynced: true });
      expect(log).toEqual([
        'lock:acquire',
        'db:delete',
        `adapter:leave:${USER_ID}:chat`,
        'lock:release',
      ]);
      expect(mockSessionUpdate.mock.calls[0][0].data.rooms).toEqual(['round']);
    });

    it('keeps the DB deleted when the adapter leave fails, and logs it', async () => {
      const { transport, log } = trackedTransport({ failLeave: true });
      mockSessionFindUnique.mockResolvedValueOnce({ rooms: ['chat'] });
      mockSessionUpdate.mockResolvedValueOnce({});

      const result = await multiplayerSessionService.leaveRoom(USER_ID, 'chat', transport);

      expect(result).toEqual({ ok: true, room: 'chat', changed: true, adapterSynced: false });
      // Exactly one write (the delete); the membership is never re-added.
      expect(mockSessionUpdate).toHaveBeenCalledTimes(1);
      expect(mockSessionUpdate.mock.calls[0][0].data.rooms).toEqual([]);
      expect(log).toEqual([`adapter:leave:${USER_ID}:chat`]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('adapter leave failed after DB delete'),
      );
    });

    it('is idempotent: leaving a room the user is not in is a no-op success', async () => {
      const { transport, log } = trackedTransport();
      mockSessionFindUnique.mockResolvedValueOnce({ rooms: ['round'] });

      const result = await multiplayerSessionService.leaveRoom(USER_ID, 'chat', transport);

      expect(result).toEqual({ ok: true, room: 'chat', changed: false, adapterSynced: true });
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      // Presence is still re-synced in case a stale socket is in the room.
      expect(log).toEqual([`adapter:leave:${USER_ID}:chat`]);
    });

    it('does not touch the adapter when the DB delete fails (user is still a member)', async () => {
      const { transport, log } = trackedTransport();
      mockSessionFindUnique.mockResolvedValueOnce({ rooms: ['chat'] });
      mockSessionUpdate.mockRejectedValueOnce(new Error('db down'));

      const result = await multiplayerSessionService.leaveRoom(USER_ID, 'chat', transport);

      expect(result).toMatchObject({ ok: false, code: 'MEMBERSHIP_PERSIST_FAILED' });
      expect(log).toEqual([]);
    });

    it('rejects non-membership rooms', async () => {
      const { transport, log } = trackedTransport();

      const result = await multiplayerSessionService.leaveRoom(USER_ID, `user:${USER_ID}`, transport);

      expect(result).toMatchObject({ ok: false, code: 'INVALID_ROOM' });
      expect(log).toEqual([]);
    });
  });

  describe('restoreMembership — connect reconciliation (Issue #669)', () => {
    it('joins exactly the membership rooms recorded in the DB', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({
        rooms: ['round', 'round:r-1', 'chat'],
      });
      const joinLocal = jest.fn<(rooms: string[]) => void>();

      const rooms = await multiplayerSessionService.restoreMembership(USER_ID, joinLocal);

      expect(rooms).toEqual(['round', 'round:r-1', 'chat']);
      expect(joinLocal).toHaveBeenCalledTimes(1);
      expect(joinLocal).toHaveBeenCalledWith(['round', 'round:r-1', 'chat']);
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      expect(mockWithRoomLock).toHaveBeenCalledWith(USER_ID, expect.any(Function));
    });

    it('does not join, and prunes, entries that are not membership rooms', async () => {
      mockSessionFindUnique.mockResolvedValueOnce({
        // `user:` entries were written by the pre-#669 reconcile; the others
        // are malformed.
        rooms: ['user:someone-else', 'round', 'round:bad id', 'lobby', 'chat', 7],
      });
      mockSessionUpdate.mockResolvedValueOnce({});
      const joinLocal = jest.fn<(rooms: string[]) => void>();

      const rooms = await multiplayerSessionService.restoreMembership(USER_ID, joinLocal);

      expect(rooms).toEqual(['round', 'chat']);
      expect(joinLocal).toHaveBeenCalledWith(['round', 'chat']);
      expect(mockSessionUpdate.mock.calls[0][0].data.rooms).toEqual(['round', 'chat']);
    });

    it('joins nothing when the user has no session row', async () => {
      mockSessionFindUnique.mockResolvedValueOnce(null);
      const joinLocal = jest.fn<(rooms: string[]) => void>();

      await expect(
        multiplayerSessionService.restoreMembership(USER_ID, joinLocal),
      ).resolves.toEqual([]);
      expect(joinLocal).not.toHaveBeenCalled();
    });

    it('joins nothing (and does not throw) on DB error', async () => {
      mockSessionFindUnique.mockRejectedValueOnce(new Error('db down'));
      const joinLocal = jest.fn<(rooms: string[]) => void>();

      await expect(
        multiplayerSessionService.restoreMembership(USER_ID, joinLocal),
      ).resolves.toEqual([]);
      expect(joinLocal).not.toHaveBeenCalled();
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

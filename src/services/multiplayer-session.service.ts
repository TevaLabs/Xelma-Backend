/**
 * Multiplayer session persistence (Issue #194).
 *
 * Powers reconnect continuity for authenticated socket clients. Every method
 * is best-effort with respect to the caller — `socket.ts` calls these from
 * connection/disconnect handlers, and a DB hiccup must never tear down a
 * live socket. All public methods therefore:
 *
 *   - swallow errors internally and log them at WARN level;
 *   - return `null` (or an empty resume payload) instead of throwing;
 *   - hold no in-memory state between calls — the DB is the source of truth.
 *
 * Schema is `MultiplayerSession` (see prisma/schema.prisma) with a UNIQUE
 * constraint on `userId`, so one row per authenticated user. A fresh login
 * upserts; reconnects update the same row.
 *
 * The exception to "never throws, best-effort" is the room-membership
 * protocol below (`joinRoom` / `leaveRoom` / `restoreMembership`), which
 * reports failures to the caller as a `MembershipResult`.
 *
 * ---------------------------------------------------------------------------
 * Room membership protocol (Issue #669)
 * ---------------------------------------------------------------------------
 *
 * Membership vs presence:
 *   - Membership is the DB: `MultiplayerSession.rooms` lists the membership
 *     rooms (`round`, `round:<id>`, `chat`; see utils/socket-rooms.ts) a user
 *     belongs to. It is per user, survives disconnects, and is the source of
 *     truth.
 *   - Presence is Socket.IO: which connected sockets are currently in which
 *     rooms, spread across instances via the Redis adapter. It is derived from
 *     membership and may briefly lag behind it, never the other way round.
 *   Every authenticated socket is in `user:<userId>`, so `io.in(userRoom)`
 *   reaches all of a user's sockets on every instance.
 *
 * All three operations run under `withRoomLock(userId)` (in-process queue +
 * Redis lock), so a join, a leave and a reconnect for the same user never
 * interleave.
 *
 * JOIN (`joinRoom`):
 *   1. Validate: only membership rooms are accepted.
 *   2. Commit DB membership. Idempotent: a room already present is a no-op
 *      success; remember whether *this* call added it.
 *   3. Adapter join, cluster-wide: every socket in `user:<userId>` joins the
 *      room on every instance, confirmed by a round trip (see
 *      `createRoomMembershipTransport` in utils/socket-adapter.ts).
 *   4. If step 3 fails, compensate: if this call added the DB entry, remove
 *      it, then make the user's sockets leave the room again. If the user was
 *      already a member, the DB entry is kept (it predates this call) and the
 *      sockets are not removed. Log and return an error either way.
 *   DB first means a failure can never leave a socket in a room with no DB
 *   row behind it.
 *
 * LEAVE (`leaveRoom`):
 *   1. Delete DB membership (idempotent). If this fails, stop: the user is
 *      still a member, and presence is left matching that.
 *   2. Adapter leave, cluster-wide, confirmed as for join.
 *   3. If step 2 fails, the leave still succeeds and the DB entry is NOT
 *      re-added. The user asked to leave; resurrecting the membership would
 *      override that and would be restored to every socket on the next
 *      reconnect. A socket that missed the leave is only left receiving
 *      broadcasts for a room it no longer belongs to; the safety nets bound
 *      that.
 *
 * Safety nets (cluster-wide adapter operations are fire-and-forget pub/sub,
 * so a node may miss one):
 *   - Connect/reconnect reconciliation (`restoreMembership`): a new socket
 *     joins exactly the membership rooms in the DB, nothing else, and legacy
 *     or invalid entries are pruned. socket.ts joins `user:<userId>` *before*
 *     this read, so a join committed concurrently either is read here or
 *     reaches the socket through its user room.
 *   - Room-scoped actions: the membership rooms are broadcast-only (public
 *     round, price and chat events). No socket handler acts on behalf of a
 *     room, so a stale adapter membership cannot act in one; it can only
 *     receive a public broadcast until the socket reconnects. Any future
 *     room-scoped handler must check DB membership (`MultiplayerSession.rooms`)
 *     rather than `socket.rooms`.
 *
 * Disconnect: unchanged. Presence (the socket's rooms) disappears with the
 * socket; membership (DB rooms) is kept so a reconnect restores it.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import { withRoomLock } from '../utils/room-lock';
import { isMembershipRoom } from '../utils/socket-rooms';

/** Maximum number of rooms we will persist in `rooms` per session. */
export const MAX_PERSISTED_ROOMS = 32;

/** Maximum serialized size (chars) of the opaque `metadata` blob. */
export const MAX_METADATA_CHARS = 4_096;

/** Payload returned on resume. Empty arrays / nulls mean "nothing to restore". */
export interface ResumePayload {
  rooms: string[];
  metadata: Record<string, unknown> | null;
  lastSeenAt: string | null;
  disconnectedAt: string | null;
}

/**
 * Adapter half of the membership protocol: make every socket of `userId`, on
 * every instance, join/leave `room`. Resolves once confirmed and rejects
 * otherwise. Implemented by `createRoomMembershipTransport` in
 * utils/socket-adapter.ts; injectable so tests can fake it.
 */
export interface RoomMembershipTransport {
  join(userId: string, room: string): Promise<void>;
  leave(userId: string, room: string): Promise<void>;
}

export type MembershipErrorCode =
  | 'INVALID_ROOM'
  | 'MEMBERSHIP_PERSIST_FAILED'
  | 'MEMBERSHIP_SYNC_FAILED';

export type MembershipResult =
  | {
      ok: true;
      room: string;
      /** False when the call was a no-op (already joined / already left). */
      changed: boolean;
      /** False when a leave was committed but the adapter step failed. */
      adapterSynced: boolean;
    }
  | { ok: false; room: string; code: MembershipErrorCode; message: string };

/** No `MultiplayerSession` row exists for the user (recordConnect failed). */
class MissingSessionError extends Error {
  constructor(userId: string) {
    super(`no multiplayer session row for user ${userId}`);
    this.name = 'MissingSessionError';
  }
}

const EMPTY_RESUME: ResumePayload = {
  rooms: [],
  metadata: null,
  lastSeenAt: null,
  disconnectedAt: null,
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function clampRooms(rooms: string[]): string[] {
  // Dedupe while preserving order (first-seen wins) and cap length.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rooms) {
    if (typeof r !== 'string' || r.length === 0) continue;
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
    if (out.length >= MAX_PERSISTED_ROOMS) break;
  }
  return out;
}

function invalidRoom(room: string): MembershipResult {
  return failure(room, 'INVALID_ROOM', 'Invalid room');
}

function failure(
  room: string,
  code: MembershipErrorCode,
  message: string,
): MembershipResult {
  return { ok: false, room, code, message };
}

function clampMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const serialized = JSON.stringify(metadata);
    if (serialized.length > MAX_METADATA_CHARS) {
      logger.warn(
        `[multiplayer-session] metadata exceeds ${MAX_METADATA_CHARS} chars; dropping`,
      );
      return null;
    }
    return metadata;
  } catch {
    return null;
  }
}

class MultiplayerSessionService {
  /**
   * Mark a user as connected on the given socket. Idempotent: re-running
   * with the same userId updates the existing row (recording the new
   * socketId and clearing `disconnectedAt`).
   *
   * Returns the prior session's resume payload so the caller can replay
   * room membership to the client.
   */
  async recordConnect(params: {
    userId: string;
    walletAddress: string;
    socketId: string;
  }): Promise<ResumePayload> {
    const { userId, walletAddress, socketId } = params;
    try {
      const now = new Date();
      // Snapshot the prior row (if any) BEFORE upserting so the caller can
      // resume from the last known good state.
      const prior = await prisma.multiplayerSession.findUnique({
        where: { userId },
      });

      await prisma.multiplayerSession.upsert({
        where: { userId },
        create: {
          userId,
          walletAddress,
          socketId,
          rooms: [],
          connectedAt: now,
          lastSeenAt: now,
          disconnectedAt: null,
        },
        update: {
          walletAddress,
          socketId,
          lastSeenAt: now,
          disconnectedAt: null,
          // Preserve prior `rooms` and `metadata` so reconnect can resume.
        },
      });

      if (!prior) return EMPTY_RESUME;
      return {
        rooms: asStringArray(prior.rooms),
        metadata: asJsonObject(prior.metadata),
        lastSeenAt: prior.lastSeenAt ? prior.lastSeenAt.toISOString() : null,
        disconnectedAt: prior.disconnectedAt
          ? prior.disconnectedAt.toISOString()
          : null,
      };
    } catch (error) {
      logger.warn(
        `[multiplayer-session] recordConnect failed for user ${userId}: ${(error as Error).message}`,
      );
      return EMPTY_RESUME;
    }
  }

  /**
   * JOIN half of the membership protocol (see the header comment).
   * Never throws; failures are returned as `{ ok: false }`.
   */
  async joinRoom(
    userId: string,
    room: string,
    transport: RoomMembershipTransport,
  ): Promise<MembershipResult> {
    if (!userId || !isMembershipRoom(room)) {
      return invalidRoom(room);
    }
    return withRoomLock(userId, async () => {
      let added: boolean;
      try {
        added = await this.persistRoom(userId, room);
      } catch (error) {
        logger.warn(
          `[multiplayer-session] join ${room} for user ${userId}: DB commit failed: ${(error as Error).message}`,
        );
        return failure(
          room,
          'MEMBERSHIP_PERSIST_FAILED',
          `Could not join ${room}; please retry.`,
        );
      }

      try {
        await transport.join(userId, room);
      } catch (error) {
        logger.warn(
          `[multiplayer-session] join ${room} for user ${userId}: adapter join failed, compensating ` +
            `(membership ${added ? 'added by this call' : 'pre-existing, kept'}): ${(error as Error).message}`,
        );
        if (added) await this.compensateJoin(userId, room, transport);
        return failure(
          room,
          'MEMBERSHIP_SYNC_FAILED',
          `Could not join ${room}; please retry.`,
        );
      }

      return { ok: true, room, changed: added, adapterSynced: true };
    });
  }

  /**
   * LEAVE half of the membership protocol (see the header comment).
   * Never throws; failures are returned as `{ ok: false }`.
   */
  async leaveRoom(
    userId: string,
    room: string,
    transport: RoomMembershipTransport,
  ): Promise<MembershipResult> {
    if (!userId || !isMembershipRoom(room)) {
      return invalidRoom(room);
    }
    return withRoomLock(userId, async () => {
      let removed: boolean;
      try {
        removed = await this.unpersistRoom(userId, room);
      } catch (error) {
        logger.warn(
          `[multiplayer-session] leave ${room} for user ${userId}: DB delete failed: ${(error as Error).message}`,
        );
        return failure(
          room,
          'MEMBERSHIP_PERSIST_FAILED',
          `Could not leave ${room}; please retry.`,
        );
      }

      try {
        await transport.leave(userId, room);
      } catch (error) {
        // The DB is the truth and the user has left; do not re-add it.
        logger.warn(
          `[multiplayer-session] leave ${room} for user ${userId}: adapter leave failed after DB delete; ` +
            `membership stays removed, stale sockets resync on reconnect: ${(error as Error).message}`,
        );
        return { ok: true, room, changed: removed, adapterSynced: false };
      }

      return { ok: true, room, changed: removed, adapterSynced: true };
    });
  }

  /**
   * Connect/reconnect reconciliation. Reads the user's DB membership under
   * the room lock, prunes entries that are not membership rooms (legacy
   * `user:` entries, invalid names), and hands exactly the remaining rooms to
   * `joinLocal` so the new socket joins them. Returns the rooms joined.
   * Never throws; on DB error nothing is joined.
   */
  async restoreMembership(
    userId: string,
    joinLocal: (rooms: string[]) => void,
  ): Promise<string[]> {
    if (!userId) return [];
    try {
      return await withRoomLock(userId, async () => {
        const session = await prisma.multiplayerSession.findUnique({
          where: { userId },
        });
        if (!session) return [];
        const stored = asStringArray(session.rooms);
        const rooms = clampRooms(stored.filter(isMembershipRoom));
        if (rooms.length !== stored.length) {
          await prisma.multiplayerSession.update({
            where: { userId },
            data: { rooms },
          });
          logger.info(
            `[multiplayer-session] pruned ${stored.length - rooms.length} non-membership room(s) for user ${userId}`,
          );
        }
        if (rooms.length > 0) joinLocal(rooms);
        return rooms;
      });
    } catch (error) {
      logger.warn(
        `[multiplayer-session] restoreMembership failed for user ${userId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /** Undo a join this call committed: DB first, then presence. */
  private async compensateJoin(
    userId: string,
    room: string,
    transport: RoomMembershipTransport,
  ): Promise<void> {
    try {
      await this.unpersistRoom(userId, room);
    } catch (error) {
      // The DB still says "member", so leave presence alone to match it; the
      // next reconnect restores the room from the DB.
      logger.error(
        `[multiplayer-session] join ${room} for user ${userId}: compensation DB delete failed; ` +
          `membership remains: ${(error as Error).message}`,
      );
      return;
    }
    try {
      await transport.leave(userId, room);
    } catch (error) {
      logger.warn(
        `[multiplayer-session] join ${room} for user ${userId}: compensation adapter leave failed; ` +
          `stale sockets resync on reconnect: ${(error as Error).message}`,
      );
    }
  }

  /** Add `room` to the DB membership. Returns false if already present. Throws on DB error. */
  private async persistRoom(userId: string, room: string): Promise<boolean> {
    const session = await prisma.multiplayerSession.findUnique({
      where: { userId },
    });
    if (!session) throw new MissingSessionError(userId);
    const current = asStringArray(session.rooms);
    if (current.includes(room)) return false;
    const next = clampRooms([...current, room]);
    if (!next.includes(room)) {
      throw new Error(`room limit (${MAX_PERSISTED_ROOMS}) reached`);
    }
    await prisma.multiplayerSession.update({
      where: { userId },
      data: { rooms: next, lastSeenAt: new Date() },
    });
    return true;
  }

  /** Remove `room` from the DB membership. Returns false if absent. Throws on DB error. */
  private async unpersistRoom(userId: string, room: string): Promise<boolean> {
    const session = await prisma.multiplayerSession.findUnique({
      where: { userId },
    });
    if (!session) return false;
    const current = asStringArray(session.rooms);
    if (!current.includes(room)) return false;
    await prisma.multiplayerSession.update({
      where: { userId },
      data: { rooms: current.filter(r => r !== room), lastSeenAt: new Date() },
    });
    return true;
  }

  /**
   * Merge opaque metadata into the persisted session. Callers should keep
   * metadata small (last round id, draft message, etc.). Oversized blobs
   * are dropped silently — see `MAX_METADATA_CHARS`.
   */
  async patchMetadata(
    userId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    if (!userId) return;
    try {
      const session = await prisma.multiplayerSession.findUnique({
        where: { userId },
      });
      if (!session) return;
      const current = asJsonObject(session.metadata) ?? {};
      const merged = clampMetadata({ ...current, ...patch });
      await prisma.multiplayerSession.update({
        where: { userId },
        data: {
          metadata:
            merged !== null ? (merged as Prisma.InputJsonValue) : undefined,
          lastSeenAt: new Date(),
        },
      });
    } catch (error) {
      logger.warn(
        `[multiplayer-session] patchMetadata failed for user ${userId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Mark the session as disconnected. The row is preserved (not deleted)
   * so a future reconnect can restore rooms; retention/cleanup is the
   * responsibility of a separate sweeper if/when one is added.
   */
  async recordDisconnect(userId: string): Promise<void> {
    if (!userId) return;
    try {
      const now = new Date();
      await prisma.multiplayerSession.updateMany({
        where: { userId },
        data: { disconnectedAt: now, lastSeenAt: now, socketId: null },
      });
    } catch (error) {
      logger.warn(
        `[multiplayer-session] recordDisconnect failed for user ${userId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Read the resume payload without mutating the row. Used by clients that
   * want to query state ahead of joining (e.g. for a custom UI flow).
   */
  async getResumePayload(userId: string): Promise<ResumePayload> {
    if (!userId) return EMPTY_RESUME;
    try {
      const session = await prisma.multiplayerSession.findUnique({
        where: { userId },
      });
      if (!session) return EMPTY_RESUME;
      return {
        rooms: asStringArray(session.rooms),
        metadata: asJsonObject(session.metadata),
        lastSeenAt: session.lastSeenAt
          ? session.lastSeenAt.toISOString()
          : null,
        disconnectedAt: session.disconnectedAt
          ? session.disconnectedAt.toISOString()
          : null,
      };
    } catch (error) {
      logger.warn(
        `[multiplayer-session] getResumePayload failed for user ${userId}: ${(error as Error).message}`,
      );
      return EMPTY_RESUME;
    }
  }
}

// Exported for testing purposes.
export { asStringArray };

export default new MultiplayerSessionService();

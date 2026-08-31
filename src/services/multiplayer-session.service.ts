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
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import { withRoomLock } from '../utils/room-lock';

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
   * Add a room to the persisted set (no-op if already present).
   *
   * Protected by a per-user Redis distributed lock so concurrent
   * addRoom / removeRoom calls across instances are serialized and
   * cannot produce lost updates (Issue #555).
   */
  async addRoom(userId: string, room: string): Promise<void> {
    if (!userId || !room) return;
    await withRoomLock(userId, async () => {
      try {
        const session = await prisma.multiplayerSession.findUnique({
          where: { userId },
        });
        if (!session) return;
        const currentRooms = asStringArray(session.rooms);
        if (currentRooms.includes(room)) return;
        const next = clampRooms([...currentRooms, room]);
        await prisma.multiplayerSession.update({
          where: { userId },
          data: { rooms: next, lastSeenAt: new Date() },
        });
      } catch (error) {
        logger.warn(
          `[multiplayer-session] addRoom(${room}) failed for user ${userId}: ${(error as Error).message}`,
        );
      }
    });
  }

  /**
   * Remove a room from the persisted set (no-op if absent).
   *
   * Protected by a per-user Redis distributed lock (Issue #555).
   */
  async removeRoom(userId: string, room: string): Promise<void> {
    if (!userId || !room) return;
    await withRoomLock(userId, async () => {
      try {
        const session = await prisma.multiplayerSession.findUnique({
          where: { userId },
        });
        if (!session) return;
        const next = asStringArray(session.rooms).filter(r => r !== room);
        await prisma.multiplayerSession.update({
          where: { userId },
          data: { rooms: next, lastSeenAt: new Date() },
        });
      } catch (error) {
        logger.warn(
          `[multiplayer-session] removeRoom(${room}) failed for user ${userId}: ${(error as Error).message}`,
        );
      }
    });
  }

  /**
   * Reconcile DB room membership against the actual adapter rooms.
   *
   * When an instance crashes between a DB write and an adapter room
   * propagation (or vice versa), the two sources of truth can diverge.
   * This method detects and corrects the drift:
   *
   *   - Rooms in the DB but NOT in the adapter are stale (removed).
   *   - Rooms in the adapter but NOT in the DB are persisted.
   *
   * @param userId        The user whose rooms to reconcile.
   * @param adapterRooms  The rooms the user is actually in per the adapter.
   * @returns             The reconciled room list (written to DB).
   */
  async reconcileRooms(
    userId: string,
    adapterRooms: string[],
  ): Promise<string[]> {
    if (!userId) return [];
    try {
      const session = await prisma.multiplayerSession.findUnique({
        where: { userId },
      });
      if (!session) return adapterRooms;

      const dbRooms = asStringArray(session.rooms);
      const adapterSet = new Set(adapterRooms);

      // Rooms in DB but not in adapter → stale entries from a crashed instance
      const staleRooms = dbRooms.filter(r => !adapterSet.has(r));
      // Rooms in adapter but not in DB → need to be persisted
      const missingRooms = adapterRooms.filter(r => !dbRooms.includes(r));

      if (staleRooms.length === 0 && missingRooms.length === 0) {
        // Already consistent — nothing to do.
        return dbRooms;
      }

      // Merge: keep only rooms that exist in the adapter, plus any new ones
      const reconciled = clampRooms(
        [...dbRooms.filter(r => adapterSet.has(r)), ...adapterRooms],
      );

      await prisma.multiplayerSession.update({
        where: { userId },
        data: { rooms: reconciled, lastSeenAt: new Date() },
      });

      logger.info(
        `[multiplayer-session] reconciled rooms for user ${userId}: ` +
          `removed ${staleRooms.length} stale, added ${missingRooms.length} missing`,
      );

      return reconciled;
    } catch (error) {
      logger.warn(
        `[multiplayer-session] reconcileRooms failed for user ${userId}: ${(error as Error).message}`,
      );
      return adapterRooms;
    }
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

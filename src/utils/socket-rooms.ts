/**
 * Socket.IO room names (Issue #669).
 *
 * Every room the server joins sockets to or emits into is built here so the
 * join side and the emit side can never drift apart, and so a client-supplied
 * id can never be used to address a room in another namespace.
 *
 * Namespaces:
 *
 *   user:<userId>   Identity room. Every authenticated socket joins its own
 *                   user room on connect. Because the Redis adapter makes room
 *                   operations cluster-wide, `io.in(userRoom(id))` addresses
 *                   all of a user's sockets on every API instance.
 *   round           Lobby room for round/price broadcasts.
 *   round:<roundId> Per-round room.
 *   chat            Global chat room.
 *
 * `round`, `round:<id>` and `chat` are *membership rooms*: joining one is
 * persisted in `MultiplayerSession.rooms` and goes through the membership
 * protocol in `multiplayer-session.service.ts`. The user room is derived from
 * the JWT on every connect and is never persisted.
 *
 * Ids are restricted to `[A-Za-z0-9_-]{1,64}`. That covers uuid, cuid and
 * legacy slug ids (e.g. `btc-updown-live`) while excluding `:`, so a prefixed
 * name can never alias a room in another namespace (`round:user:x` cannot be
 * built) and can never collide with a Socket.IO socket-id room.
 */

export const USER_ROOM_PREFIX = 'user:';
export const ROUND_ROOM_PREFIX = 'round:';
export const ROUND_LOBBY_ROOM = 'round';
export const CHAT_ROOM = 'chat';

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class InvalidRoomIdError extends Error {
  constructor(kind: string, id: unknown) {
    super(`Invalid ${kind} id for socket room: ${JSON.stringify(id)}`);
    this.name = 'InvalidRoomIdError';
  }
}

/** True when `id` can be embedded in a namespaced room name. */
export function isValidRoomId(id: unknown): id is string {
  return typeof id === 'string' && ROOM_ID_PATTERN.test(id);
}

/** `user:<userId>` — the identity room of every socket owned by `userId`. */
export function userRoom(userId: string): string {
  if (!isValidRoomId(userId)) throw new InvalidRoomIdError('user', userId);
  return `${USER_ROOM_PREFIX}${userId}`;
}

/** `round:<roundId>`, or the `round` lobby when no id is given. */
export function roundRoom(roundId?: string | null): string {
  if (roundId === undefined || roundId === null) return ROUND_LOBBY_ROOM;
  if (!isValidRoomId(roundId)) throw new InvalidRoomIdError('round', roundId);
  return `${ROUND_ROOM_PREFIX}${roundId}`;
}

/**
 * True for the rooms whose membership is persisted in the DB and managed by
 * the membership protocol: `round`, `round:<validId>` and `chat`.
 */
export function isMembershipRoom(room: unknown): room is string {
  if (typeof room !== 'string') return false;
  if (room === ROUND_LOBBY_ROOM || room === CHAT_ROOM) return true;
  return (
    room.startsWith(ROUND_ROOM_PREFIX) &&
    isValidRoomId(room.slice(ROUND_ROOM_PREFIX.length))
  );
}

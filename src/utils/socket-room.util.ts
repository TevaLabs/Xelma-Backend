/**
 * Socket room-name validation and namespacing (Issue #730).
 *
 * Room names are built from client-supplied identifiers, so without
 * validation a client can ask to join `round:*`, a multi-kilobyte string, or
 * a name that collides with a reserved namespace such as `user:`. A room join
 * is a cheap way to subscribe to broadcasts you were never meant to see, and
 * with the Redis adapter an unbounded name is also cheap memory pressure.
 *
 * Two rules keep room names trustworthy:
 *
 *   1. Every id embedded in a room name must be validated. Round/user ids may
 *      be any bounded slug (they are backfilled from legacy data such as
 *      `btc-updown-live`); multiplayer **session** ids must be a cuid or uuid.
 *   2. Every room name must carry one of the server-managed prefixes, so a
 *      client can never mint a name outside the namespaces we broadcast on.
 *
 * Session rooms are namespaced under `session:` so they can never alias a
 * `user:` room — see {@link sessionRoom}.
 */

/** Prefixes the server controls. Nothing outside this list may be joined. */
export const ROOM_PREFIXES = ['round', 'user', 'session'] as const;

/** Namespaced room prefix for multiplayer sessions. */
export const SESSION_ROOM_PREFIX = 'session:';

/** Rooms that carry no id segment. */
export const SINGLETON_ROOMS = ['round', 'chat'] as const;

/** Maximum length of the id segment of a room name. */
export const MAX_ROOM_ID_LENGTH = 64;

/** Maximum length of an entire room name. */
export const MAX_ROOM_NAME_LENGTH = 128;

/** Bounded slug: letters, digits, `_` and `-` only. */
const SAFE_ID_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** RFC 4122 uuid (any version). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** cuid / cuid2: `c` followed by 20–31 lowercase alphanumerics. */
const CUID_RE = /^c[a-z0-9]{20,31}$/i;

/**
 * True when `id` is safe to embed in a room name.
 *
 * Deliberately permissive about *format* (legacy round ids are slugs) but
 * strict about *shape*: bounded length, no separators, no wildcards.
 */
export function isValidIdSegment(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID_SEGMENT_RE.test(id);
}

/**
 * True when `id` is a cuid or uuid.
 *
 * Session ids are opaque client-supplied values used to build a room name,
 * so they get the stricter format check rather than the slug fallback.
 */
export function isValidSessionId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > MAX_ROOM_ID_LENGTH) return false;
  return UUID_RE.test(id) || CUID_RE.test(id);
}

/**
 * Build the namespaced room name for a multiplayer session.
 *
 * Callers must validate with {@link isValidSessionId} first — this function
 * only namespaces, it does not sanitize.
 */
export function sessionRoom(sessionId: string): string {
  return `${SESSION_ROOM_PREFIX}${sessionId}`;
}

/**
 * True when `room` is a name the server is willing to join.
 *
 * Accepts the singleton rooms (`round`, `chat`) and `<prefix>:<id>` names
 * where the prefix is server-managed and the id is well-formed.
 */
export function isSafeRoomName(room: unknown): room is string {
  if (typeof room !== 'string') return false;
  if (room.length === 0 || room.length > MAX_ROOM_NAME_LENGTH) return false;
  if ((SINGLETON_ROOMS as readonly string[]).includes(room)) return true;

  const separator = room.indexOf(':');
  if (separator <= 0 || separator === room.length - 1) return false;

  const prefix = room.slice(0, separator);
  const id = room.slice(separator + 1);

  if (!(ROOM_PREFIXES as readonly string[]).includes(prefix)) return false;

  return prefix === 'session'
    ? isValidSessionId(id)
    : isValidIdSegment(id);
}

import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import type { DefaultEventsMap } from 'socket.io/dist/typed-events';
import { verifyToken, verifyTokenDetailed } from './utils/jwt.util';
import { prisma } from './lib/prisma';
import websocketService from './services/websocket.service';
import chatService from './services/chat.service';
import multiplayerSessionService from './services/multiplayer-session.service';
import logger from './utils/logger';
import {
   initializeSocketAdapter,
   closeSocketAdapter,
   createRoomMembershipTransport,
} from './utils/socket-adapter';
import {
   CHAT_ROOM,
   USER_ROOM_PREFIX,
   isMembershipRoom,
   isValidRoomId,
   roundRoom,
   userRoom,
} from './utils/socket-rooms';
import config from './config';
import {
   setSocketConnectionsActive,
   websocketConnectionEventsTotal,
} from './metrics/application.metrics';
import type {
   TypedServer,
   TypedSocket,
   ServerToClientEvents,
   ClientToServerEvents,
   ServerHelloPayload,
   AuthErrorPayload,
   RoomEventPayload,
   GenericErrorPayload,
   ResumePayload,
   ChatSendPayload,
   ChatAckPayload,
   SessionCheckpointPayload,
} from './types/socket-events';

/**
 * Servers created by `initializeSocket` and their timers, so `closeWebSocket`
 * can tear all of them down (tests start more than one to simulate a
 * multi-instance deployment).
 */
const activeServers: Array<{ io: SocketIOServer; timers: NodeJS.Timeout[] }> =
   [];

export { getCorsOrigins } from './utils/cors';
import { getCorsOrigins } from './utils/cors';

function isAuthorizedPrivateRoomJoin(
   socket: AuthenticatedSocket,
   room: string,
): boolean {
   if (!room.startsWith(USER_ROOM_PREFIX)) return true;
   if (!socket.userId || !isValidRoomId(socket.userId)) return false;
   return room === userRoom(socket.userId);
}

/** Extract the round id from a `join:round` / `leave:round` payload. */
function parseRoundId(
   data: { roundId?: string } | string | undefined,
): string | undefined {
   if (typeof data === 'string') return data;
   if (data && typeof data === 'object') return data.roundId;
   return undefined;
}

// Extended socket with walletAddress attached directly alongside SocketData
interface AuthenticatedSocket extends TypedSocket {
   userId?: string;
   walletAddress?: string;
   /** Unix epoch (ms) at which the JWT expires. */
   tokenExpiresAt?: number;
}

/**
 * In-memory sliding-window rate limiter for WebSocket events.
 * Keyed by userId so each user has an independent quota.
 */
export class SocketRateLimiter {
   private windows = new Map<string, number[]>();

   constructor(
      private readonly max: number,
      private readonly windowMs: number
   ) {}

   isAllowed(key: string): boolean {
      const now = Date.now();
      const timestamps = (this.windows.get(key) ?? []).filter(
         t => now - t < this.windowMs
      );
      if (timestamps.length >= this.max) {
         this.windows.set(key, timestamps);
         return false;
      }
      timestamps.push(now);
      this.windows.set(key, timestamps);
      return true;
   }

   /** Reset state for a specific key (or all keys if omitted). Used in tests. */
   reset(key?: string): void {
      if (key !== undefined) {
         this.windows.delete(key);
      } else {
         this.windows.clear();
      }
   }
}

// 5 messages per 60 seconds per user — mirrors HTTP chatMessageRateLimiter
export const chatRateLimiter = new SocketRateLimiter(5, 60_000);

// ---------------------------------------------------------------------------
// Heartbeat / connection-lifecycle constants
// ---------------------------------------------------------------------------

/** How often (ms) the server sends a ping to each connected client. */
export const PING_INTERVAL = 25_000;

// ---------------------------------------------------------------------------
// Token refresh / reconnect contract
// ---------------------------------------------------------------------------

/**
 * Socket error code emitted when the token supplied at connect-time has
 * expired.  Clients must:
 *   1. Obtain a fresh access token via the HTTP auth refresh endpoint.
 *   2. Disconnect the current socket.
 *   3. Reconnect with the new token in socket.handshake.auth.token.
 *
 * Clients MUST NOT attempt to reuse the same expired token on reconnect.
 */
export const AUTH_TOKEN_EXPIRED = 'AUTH_TOKEN_EXPIRED';

/**
 * Socket error code emitted when the supplied token is structurally invalid
 * (bad signature, wrong format, unknown issuer). Refreshing is unlikely to
 * help — the client should re-authenticate from scratch.
 */
export const AUTH_TOKEN_INVALID = 'AUTH_TOKEN_INVALID';

/**
 * How long (ms) the server waits for a pong before treating the socket as
 * dead and forcibly disconnecting it.
 */
export const PING_TIMEOUT = 10_000;

/**
 * How often (ms) the application-level stale-connection checker runs.
 * Belt-and-suspenders on top of Socket.IO's built-in ping/pong: catches
 * connections whose application-level activity has stopped even if the
 * transport-level ping has not yet expired.
 */
const STALE_CHECK_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Connection registry
// ---------------------------------------------------------------------------

export interface ConnectionRecord {
   userId?: string;
   walletAddress?: string;
   connectedAt: number;
   /** Updated on every incoming application event and on engine-level pong. */
   lastSeenAt: number;
   /**
    * Unix epoch (ms) at which the JWT expires. Present only for authenticated
    * sockets. Used by the token-expiry checker to proactively notify clients
    * before the expiry actually occurs.
    */
   tokenExpiresAt?: number;
}

/**
 * Live map of socketId → ConnectionRecord for every currently-connected
 * socket. Exported so tests and monitoring tools can inspect it directly.
 */
export const connectionRegistry = new Map<string, ConnectionRecord>();

/**
 * Scan the registry for sockets that have been silent longer than
 * `staleThresholdMs` and force-disconnect them.
 *
 * Clients that have already closed their transport but whose `disconnect`
 * event never fired are cleaned up from the registry without attempting to
 * disconnect.
 *
 * @param io               The Socket.IO server instance.
 * @param staleThresholdMs Default: PING_INTERVAL + PING_TIMEOUT + 5 s buffer.
 * @returns Number of stale entries removed.
 */
export function checkStaleConnections(
   io: SocketIOServer,
   staleThresholdMs = PING_INTERVAL + PING_TIMEOUT + 5_000
): number {
   const now = Date.now();
   let removed = 0;

   for (const [socketId, record] of connectionRegistry) {
      if (now - record.lastSeenAt <= staleThresholdMs) continue;

      const idleSeconds = Math.round((now - record.lastSeenAt) / 1000);
      logger.warn(
         `Stale connection detected: ${socketId}` +
            ` (user: ${record.userId ?? 'unauthenticated'}, idle ${idleSeconds}s)`
      );

      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
         // disconnect(true) closes the underlying transport; the `disconnect`
         // event will fire and clean up the registry entry.
         socket.disconnect(true);
      } else {
         // Socket already gone but disconnect event never fired — clean up now.
         connectionRegistry.delete(socketId);
         setSocketConnectionsActive(connectionRegistry.size);
      }
      removed++;
   }

   if (removed > 0) {
      logger.info(`Stale connection check removed ${removed} connection(s)`);
   }

   return removed;
}

/**
 * Scan the registry for authenticated sockets whose JWT has expired and
 * emit AUTH_TOKEN_EXPIRED so clients can refresh and reconnect cleanly.
 *
 * @param io              The Socket.IO server instance.
 * @param nowMs           Current time in ms (injectable for tests).
 * @returns Number of sockets notified.
 */
export function checkExpiredTokenSockets(
   io: SocketIOServer,
   nowMs = Date.now()
): number {
   let notified = 0;

   for (const [socketId, record] of connectionRegistry) {
      if (!record.tokenExpiresAt) continue;
      if (record.tokenExpiresAt > nowMs) continue;

      logger.warn(
         `JWT expired for socket ${socketId} (user: ${record.userId ?? 'unknown'})`
      );

      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
         const authErrorPayload: AuthErrorPayload = {
            code: AUTH_TOKEN_EXPIRED,
            message:
               'Your session token has expired. ' +
               'Refresh your access token and reconnect.',
         };
         socket.emit('auth:error', authErrorPayload);
         socket.disconnect(false);
      } else {
         connectionRegistry.delete(socketId);
         setSocketConnectionsActive(connectionRegistry.size);
      }
      notified++;
   }

   return notified;
}

/**
 * Initialize Socket.IO with JWT authentication, heartbeat tracking, and
 * per-user chat rate limiting.
 *
 * ### Reconnection contract
 * Each connection receives a `server:hello` event immediately after connecting
 * that advertises `pingInterval` and `pingTimeout`. Clients should reconnect
 * if they have not received a server ping within `pingInterval + pingTimeout`
 * milliseconds. On reconnect the server treats the new socket as a completely
 * fresh connection — clients are responsible for re-joining any rooms they
 * previously occupied.
 *
 * ### Token expiry & reconnect flow
 * When a JWT expires, the server emits an `auth:error` event with
 * `{ code: "AUTH_TOKEN_EXPIRED" }` and then gracefully disconnects the socket.
 * Clients MUST:
 *   1. Listen for `auth:error` events on every authenticated socket.
 *   2. On `code === "AUTH_TOKEN_EXPIRED"`: call the HTTP token-refresh endpoint
 *      to obtain a new access token.
 *   3. Re-create the socket connection supplying the new token in
 *      `socket.handshake.auth.token`.
 *   4. Re-join any rooms (e.g. `join:round`, `join:chat`) after reconnect.
 *
 * The server also proactively checks for expired tokens every
 * `PING_INTERVAL` ms so clients receive the notification even if they are
 * idle and not sending events.
 *
 * ### Multi-instance deployment
 * When REDIS_URL is configured, Socket.IO uses a Redis adapter for room
 * broadcasts. This ensures that when multiple backend instances are running,
 * a broadcast to a room reaches all clients in that room regardless of which
 * instance they are connected to. If Redis is unavailable, Socket.IO falls
 * back to in-memory adapter (broadcasts only reach clients on the same instance).
 * The adapter is attached before this function resolves, i.e. before the
 * caller starts listening, so no socket's rooms are lost to an adapter swap.
 *
 * ### Room membership (Issue #669)
 * Authenticated joins/leaves of the membership rooms (`round`, `round:<id>`,
 * `chat`) follow the DB-first protocol documented in
 * services/multiplayer-session.service.ts: they apply to all of the user's
 * sockets on every instance, and on (re)connect a socket joins exactly the
 * rooms recorded in the DB. Unauthenticated sockets (and socket demo mode)
 * have no DB membership and join/leave rooms for the current socket only.
 */
export async function initializeSocket(
   httpServer: HTTPServer
): Promise<TypedServer> {
   const corsOrigins = getCorsOrigins();

   const io = new SocketIOServer<
      ClientToServerEvents,
      ServerToClientEvents,
      DefaultEventsMap,
      import('./types/socket-events').SocketData
   >(httpServer, {
      pingInterval: PING_INTERVAL,
      pingTimeout: PING_TIMEOUT,
      cors: {
         origin: corsOrigins,
         methods: ['GET', 'POST'],
         credentials: true,
      },
   });

   // Adapter half of the room-membership protocol (Issue #669).
   const roomTransport = createRoomMembershipTransport(io);

   // Periodic stale connection cleanup.
   // unref() ensures this timer does not keep the Node.js process alive.
   const staleInterval = setInterval(
      () => checkStaleConnections(io),
      STALE_CHECK_INTERVAL_MS
   );
   staleInterval.unref();

   // Periodic token-expiry check — proactively notify clients whose JWT has
   // expired so they can refresh and reconnect without waiting for an auth
   // failure on their next application event.
   const tokenExpiryInterval = setInterval(
      () => checkExpiredTokenSockets(io),
      PING_INTERVAL
   );
   tokenExpiryInterval.unref();

   activeServers.push({ io, timers: [staleInterval, tokenExpiryInterval] });

   // JWT Authentication middleware
   io.use(async (socket: AuthenticatedSocket, next) => {
      try {
         const token =
            socket.handshake.auth.token ||
            socket.handshake.headers.authorization?.replace('Bearer ', '');

         if (!token) {
            // Allow connection without auth for public events (price updates)
            logger.info(`Unauthenticated socket connected: ${socket.id}`);
            return next();
         }

         const verifyResult = verifyTokenDetailed(token);
         if (!verifyResult.valid) {
            if (verifyResult.expired) {
               logger.warn(`Expired token for socket ${socket.id}`);
               // AUTH_TOKEN_EXPIRED signals clients to refresh and reconnect.
               return next(new Error('AUTH_TOKEN_EXPIRED'));
            }
            logger.warn(`Invalid token for socket ${socket.id}`);
            return next(new Error('AUTH_TOKEN_INVALID'));
         }
         const decoded = verifyResult.payload;

         if (config.app.socketDemoMode) {
            socket.userId = decoded.userId;
            socket.walletAddress = decoded.walletAddress;
            if ((decoded as any).exp) {
               socket.tokenExpiresAt = (decoded as any).exp * 1000;
            }
            logger.info(
               `Authenticated socket connected (demo mode): ${socket.id}, user: ${decoded.userId}`,
            );
            return next();
         }

         // Verify user exists
         const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: { id: true, walletAddress: true },
         });

         if (!user) {
            return next(new Error('User not found'));
         }

         // Attach user info to socket
         socket.userId = user.id;
         socket.walletAddress = user.walletAddress;
         // Store expiry so the token-expiry checker can proactively disconnect.
         if ((decoded as any).exp) {
            socket.tokenExpiresAt = (decoded as any).exp * 1000; // exp is seconds
         }

         logger.info(
            `Authenticated socket connected: ${socket.id}, user: ${user.id}`
         );
         next();
      } catch (error) {
         logger.error('Socket authentication error:', error);
         next(new Error('Authentication error'));
      }
   });

   // Initialize websocket service
   websocketService.initialize(io);

   // Connection handler
   io.on('connection', (socket: AuthenticatedSocket) => {
      logger.info(
         `Client connected: ${socket.id}${socket.userId ? ` (user: ${socket.userId})` : ' (unauthenticated)'}`
      );

      // -----------------------------------------------------------------------
      // Registry & heartbeat tracking
      // -----------------------------------------------------------------------

      connectionRegistry.set(socket.id, {
         userId: socket.userId,
         walletAddress: socket.walletAddress,
         connectedAt: Date.now(),
         lastSeenAt: Date.now(),
         tokenExpiresAt: socket.tokenExpiresAt,
      });
      setSocketConnectionsActive(connectionRegistry.size);
      websocketConnectionEventsTotal.inc({
         event: 'connect',
         authenticated: String(Boolean(socket.userId)),
      });

      // Announce the heartbeat contract so clients can tune their reconnect
      // logic. On reconnect, clients must re-join rooms explicitly.
      const helloPayload: ServerHelloPayload = {
         socketId: socket.id,
         pingInterval: PING_INTERVAL,
         pingTimeout: PING_TIMEOUT,
         authenticated: !!socket.userId,
         userId: socket.userId,
      };
      socket.emit('server:hello', helloPayload);

      // Refresh lastSeenAt on any incoming application-level event.
      socket.onAny(() => {
         const record = connectionRegistry.get(socket.id);
         if (record) record.lastSeenAt = Date.now();
      });

      // Also refresh on engine-level pong responses (heartbeat replies).
      (socket.conn as any).on('packet', (packet: { type: string }) => {
         if (packet.type === 'pong') {
            const record = connectionRegistry.get(socket.id);
            if (record) record.lastSeenAt = Date.now();
         }
      });

      // -----------------------------------------------------------------------
      // Auto-join authenticated user to their personal notification room
      // -----------------------------------------------------------------------

      // Sockets whose user has DB membership (authenticated, valid id, not
      // demo mode). Everyone else joins/leaves rooms for this socket only.
      const membershipUserId =
         socket.userId &&
         isValidRoomId(socket.userId) &&
         !config.app.socketDemoMode
            ? socket.userId
            : undefined;

      // Resolves once this socket has joined its DB rooms. Join/leave
      // handlers wait for it so they apply on top of the restored state.
      let membershipReady: Promise<void> = Promise.resolve();

      if (socket.userId) {
         if (isValidRoomId(socket.userId)) {
            // Must happen before the DB read in restoreMembership: a join
            // committed concurrently then either shows up in that read or
            // reaches this socket through its user room.
            socket.join(userRoom(socket.userId));
            logger.info(
               `Socket ${socket.id} auto-joined ${userRoom(socket.userId)}`
            );
         } else {
            logger.warn(
               `Socket ${socket.id}: user id is not a valid room id; skipping user room`
            );
         }
      }

      if (membershipUserId) {
         // Issue #194: persist session metadata for reconnect continuity.
         // Issue #669: then join exactly the rooms the DB says this user is a
         // member of. A DB failure must never tear down a live socket.
         const walletSnapshot = socket.walletAddress ?? '';
         membershipReady = (async () => {
            const resume = await multiplayerSessionService.recordConnect({
               userId: membershipUserId,
               walletAddress: walletSnapshot,
               socketId: socket.id,
            });
            const rooms = await multiplayerSessionService.restoreMembership(
               membershipUserId,
               restored => socket.join(restored),
            );
            // The client also receives the resume payload so it can update
            // local UI state without a round-trip.
            const resumePayload: ResumePayload = { ...resume, rooms };
            socket.emit('session:resume', resumePayload);
         })().catch(err => {
            logger.warn(
               `Session restore failed for socket ${socket.id}: ${(err as Error).message}`
            );
         });
      }

      const joinRoomForSocket = async (room: string): Promise<void> => {
         if (membershipUserId) {
            await membershipReady;
            const result = await multiplayerSessionService.joinRoom(
               membershipUserId,
               room,
               roomTransport,
            );
            if (!result.ok) {
               const errPayload: GenericErrorPayload = {
                  message: result.message,
                  code: result.code,
               };
               socket.emit('error', errPayload);
               return;
            }
         } else {
            socket.join(room);
         }
         logger.info(`Socket ${socket.id} joined room: ${room}`);
         const joinedPayload: RoomEventPayload = { room };
         socket.emit('room:joined', joinedPayload);
      };

      const leaveRoomForSocket = async (room: string): Promise<void> => {
         if (membershipUserId) {
            await membershipReady;
            const result = await multiplayerSessionService.leaveRoom(
               membershipUserId,
               room,
               roomTransport,
            );
            if (!result.ok) {
               const errPayload: GenericErrorPayload = {
                  message: result.message,
                  code: result.code,
               };
               socket.emit('error', errPayload);
               return;
            }
         } else {
            socket.leave(room);
         }
         logger.info(`Socket ${socket.id} left room: ${room}`);
         const leftPayload: RoomEventPayload = { room };
         socket.emit('room:left', leftPayload);
      };

      const roundRoomFromPayload = (
         data: { roundId?: string } | string | undefined,
      ): string | null => {
         const roundId = parseRoundId(data);
         if (roundId === undefined || roundId === '') return roundRoom();
         if (!isValidRoomId(roundId)) {
            const errPayload: GenericErrorPayload = {
               message: 'Invalid round id',
               code: 'INVALID_ROOM',
            };
            socket.emit('error', errPayload);
            return null;
         }
         return roundRoom(roundId);
      };

      // Join round room for price updates and round events
      socket.on('join:round', async (data?: { roundId?: string } | string) => {
         const room = roundRoomFromPayload(data);
         if (room) await joinRoomForSocket(room);
      });

      // Leave round room
      socket.on('leave:round', async (data?: { roundId?: string } | string) => {
         const room = roundRoomFromPayload(data);
         if (room) await leaveRoomForSocket(room);
      });

      // Join chat room (requires authentication)
      socket.on('join:chat', async () => {
         if (config.app.socketDemoMode) {
            socket.emit('error', {
               message: 'Chat is unavailable in socket demo mode',
            });
            return;
         }
         if (!socket.userId) {
            const errPayload: GenericErrorPayload = {
               message: 'Authentication required to join chat',
            };
            socket.emit('error', errPayload);
            return;
         }
         await joinRoomForSocket(CHAT_ROOM);
      });

      // Leave chat room
      socket.on('leave:chat', async () => {
         await leaveRoomForSocket(CHAT_ROOM);
      });

      // Handle chat message (requires authentication, rate limited, ack-based)
      socket.on(
         'chat:send',
         async (
            data: ChatSendPayload,
            callback?: (ack: ChatAckPayload) => void
         ) => {
            const ack = (payload: ChatAckPayload): void => {
               if (typeof callback === 'function') callback(payload);
            };

            if (config.app.socketDemoMode) {
               ack({
                  ok: false,
                  error: 'Chat is unavailable in socket demo mode',
                  code: 'SEND_FAILED',
               });
               return;
            }

            if (!socket.userId || !socket.walletAddress) {
               ack({
                  ok: false,
                  error: 'Authentication required to send messages',
                  code: 'AUTH_REQUIRED',
               });
               return;
            }

            if (!chatRateLimiter.isAllowed(socket.userId)) {
               logger.warn(
                  `Chat rate limit exceeded for user ${socket.userId}`
               );
               ack({
                  ok: false,
                  error: 'Too many messages. Please wait before sending another.',
                  code: 'RATE_LIMITED',
               });
               return;
            }

            if (!data?.content || data.content.trim().length === 0) {
               ack({
                  ok: false,
                  error: 'Message content is required',
                  code: 'INVALID_CONTENT',
               });
               return;
            }

            if (data.content.length > 500) {
               ack({
                  ok: false,
                  error: 'Message too long (max 500 characters)',
                  code: 'INVALID_CONTENT',
               });
               return;
            }

            try {
               const message = await chatService.sendMessage(
                  socket.userId,
                  socket.walletAddress,
                  data.content
               );
               logger.info(
                  `Chat message sent by user ${socket.userId}: ${message.id}`
               );
               ack({ ok: true, message });
            } catch (error) {
               logger.error('Error sending chat message:', error);
               ack({
                  ok: false,
                  error: 'Failed to send message',
                  code: 'SEND_FAILED',
               });
            }
         }
      );

      // Join user notification room (for authenticated users)
      socket.on('join:notifications', async (room?: string) => {
         if (!socket.userId) {
            const errPayload: GenericErrorPayload = {
               message: 'Authentication required for notifications',
            };
            socket.emit('error', errPayload);
            return;
         }

         const ownRoom = isValidRoomId(socket.userId)
            ? userRoom(socket.userId)
            : undefined;
         const targetRoom =
            typeof room === 'string' && room.trim().length > 0
               ? room.trim()
               : ownRoom;
         if (!targetRoom) {
            const errPayload: GenericErrorPayload = {
               message: 'Notifications are unavailable for this account',
            };
            socket.emit('error', errPayload);
            return;
         }

         if (!isAuthorizedPrivateRoomJoin(socket, targetRoom)) {
            const errPayload: GenericErrorPayload = {
               message: `Unauthorized room join: ${targetRoom}. You can only join your own private room.`,
            };
            socket.emit('error', errPayload);
            logger.warn(
               `Blocked unauthorized room join for socket ${socket.id}: ${targetRoom} (user: ${socket.userId})`,
            );
            return;
         }

         // Membership rooms always go through the DB-first protocol, whichever
         // event asked for them (Issue #669).
         if (isMembershipRoom(targetRoom)) {
            await joinRoomForSocket(targetRoom);
            return;
         }

         // The user room is identity, not membership: it is re-derived from the
         // JWT on every connect, so it is joined for this socket and not persisted.
         socket.join(targetRoom);
         // Ack with generic 'notifications' for backwards-compat when joining own room;
         // if caller explicitly asked for a room name, echo that room so tests and
         // multi-room clients can correlate.
         const ackRoom = targetRoom === ownRoom ? 'notifications' : targetRoom;
         const joinedNotif: RoomEventPayload = { room: ackRoom };
         // Also emit the concrete room for clients that track exact rooms (useful for testing ACL denial)
         // To keep backwards-compat, we emit 'notifications' for the default case but the socket is
         // actually in `user:${userId}`; multi-node emit via websocket.service still targets `user:${userId}`.
         socket.emit('room:joined', joinedNotif);
      });

      // Issue #194: clients can checkpoint opaque session metadata
      // (e.g. last-viewed round, draft message) so it survives a reconnect.
      socket.on('session:checkpoint', (patch: SessionCheckpointPayload) => {
         if (!socket.userId) return;
         if (!patch || typeof patch !== 'object' || Array.isArray(patch))
            return;
         void multiplayerSessionService.patchMetadata(socket.userId, patch);
      });

      // -----------------------------------------------------------------------
      // Disconnect — remove from registry
      // -----------------------------------------------------------------------

      socket.on('disconnect', reason => {
         connectionRegistry.delete(socket.id);
         setSocketConnectionsActive(connectionRegistry.size);
         websocketConnectionEventsTotal.inc({
            event: 'disconnect',
            authenticated: String(Boolean(socket.userId)),
         });
         logger.info(`Client disconnected: ${socket.id}, reason: ${reason}`);
         if (socket.userId && !config.app.socketDemoMode) {
            void multiplayerSessionService.recordDisconnect(socket.userId);
         }
      });

      // Handle errors
      socket.on('error', error => {
         logger.error(`Socket error for ${socket.id}:`, error);
      });
   });

   // Attach the Redis adapter for multi-instance fanout before the caller
   // starts listening: swapping adapters later would drop the rooms of
   // sockets that already connected. Never throws; without Redis, Socket.IO
   // stays on the in-memory adapter (single instance only).
   await initializeSocketAdapter(io);

   logger.info(
      config.app.socketDemoMode
         ? 'Socket.IO initialized in demo mode (no Prisma chat/session)'
         : 'Socket.IO initialized with JWT authentication',
   );
   return io;
}

export async function initWebSocket(httpServer: HTTPServer): Promise<void> {
   await initializeSocket(httpServer);
}

export function closeWebSocket(): void {
   for (const { io, timers } of activeServers.splice(0)) {
      for (const timer of timers) clearInterval(timer);
      // Disconnect all socket clients forcefully to allow HTTP server to close
      io.disconnectSockets(true);
      void closeSocketAdapter(io);
   }
}

export default { initializeSocket, closeWebSocket };

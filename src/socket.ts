import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { verifyToken } from './utils/jwt.util';
import { prisma } from './lib/prisma';
import websocketService from './services/websocket.service';
import chatService from './services/chat.service';
import { ChatMessage } from './types/chat.types';
import logger from './utils/logger';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export function getCorsOrigins(): string | string[] {
  const clientUrl = process.env.CLIENT_URL;

  if (IS_PRODUCTION) {
    if (!clientUrl) {
      throw new Error(
        'CLIENT_URL environment variable is required in production. ' +
        'Socket.IO CORS cannot use wildcard origin (*) with credentials enabled.',
      );
    }
    const additionalOrigins = process.env.ALLOWED_ORIGINS;
    if (additionalOrigins) {
      return [clientUrl, ...additionalOrigins.split(',').map((o) => o.trim())];
    }
    return clientUrl;
  }

  if (!clientUrl) {
    logger.warn(
      'CLIENT_URL not set; allowing all origins for development. ' +
      'Set CLIENT_URL to restrict origins.',
    );
    return '*';
  }

  const additionalOrigins = process.env.ALLOWED_ORIGINS;
  if (additionalOrigins) {
    return [clientUrl, ...additionalOrigins.split(',').map((o) => o.trim())];
  }
  return clientUrl;
}

// Extended socket interface with user data
interface AuthenticatedSocket extends Socket {
  userId?: string;
  walletAddress?: string;
}

// Standardized ack payloads for chat:send
type ChatAck =
  | { ok: true; message: ChatMessage }
  | { ok: false; error: string; code: 'AUTH_REQUIRED' | 'INVALID_CONTENT' | 'RATE_LIMITED' | 'SEND_FAILED' };

/**
 * In-memory sliding-window rate limiter for WebSocket events.
 * Keyed by userId so each user has an independent quota.
 */
export class SocketRateLimiter {
  private windows = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  isAllowed(key: string): boolean {
    const now = Date.now();
    const timestamps = (this.windows.get(key) ?? []).filter(t => now - t < this.windowMs);
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
  staleThresholdMs = PING_INTERVAL + PING_TIMEOUT + 5_000,
): number {
  const now = Date.now();
  let removed = 0;

  for (const [socketId, record] of connectionRegistry) {
    if (now - record.lastSeenAt <= staleThresholdMs) continue;

    const idleSeconds = Math.round((now - record.lastSeenAt) / 1000);
    logger.warn(
      `Stale connection detected: ${socketId}` +
      ` (user: ${record.userId ?? 'unauthenticated'}, idle ${idleSeconds}s)`,
    );

    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      // disconnect(true) closes the underlying transport; the `disconnect`
      // event will fire and clean up the registry entry.
      socket.disconnect(true);
    } else {
      // Socket already gone but disconnect event never fired — clean up now.
      connectionRegistry.delete(socketId);
    }
    removed++;
  }

  if (removed > 0) {
    logger.info(`Stale connection check removed ${removed} connection(s)`);
  }

  return removed;
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
 */
export function initializeSocket(httpServer: HTTPServer): SocketIOServer {
  const corsOrigins = getCorsOrigins();

  const io = new SocketIOServer(httpServer, {
    pingInterval: PING_INTERVAL,
    pingTimeout: PING_TIMEOUT,
    cors: {
      origin: corsOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Periodic stale connection cleanup.
  // unref() ensures this timer does not keep the Node.js process alive.
  const staleInterval = setInterval(
    () => checkStaleConnections(io),
    STALE_CHECK_INTERVAL_MS,
  );
  staleInterval.unref();

  // JWT Authentication middleware
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        // Allow connection without auth for public events (price updates)
        logger.info(`Unauthenticated socket connected: ${socket.id}`);
        return next();
      }

      const decoded = verifyToken(token);
      if (!decoded) {
        logger.warn(`Invalid token for socket ${socket.id}`);
        return next(new Error('Invalid token'));
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

      logger.info(`Authenticated socket connected: ${socket.id}, user: ${user.id}`);
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
    logger.info(`Client connected: ${socket.id}${socket.userId ? ` (user: ${socket.userId})` : ' (unauthenticated)'}`);

    // -----------------------------------------------------------------------
    // Registry & heartbeat tracking
    // -----------------------------------------------------------------------

    connectionRegistry.set(socket.id, {
      userId: socket.userId,
      walletAddress: socket.walletAddress,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    // Announce the heartbeat contract so clients can tune their reconnect
    // logic. On reconnect, clients must re-join rooms explicitly.
    socket.emit('server:hello', {
      socketId: socket.id,
      pingInterval: PING_INTERVAL,
      pingTimeout: PING_TIMEOUT,
      authenticated: !!socket.userId,
      userId: socket.userId,
    });

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

    if (socket.userId) {
      socket.join(`user:${socket.userId}`);
      logger.info(`Socket ${socket.id} auto-joined user:${socket.userId}`);
    }

    // Join round room for price updates and round events
    socket.on('join:round', () => {
      socket.join('round');
      logger.info(`Socket ${socket.id} joined room: round`);
      socket.emit('room:joined', { room: 'round' });
    });

    // Leave round room
    socket.on('leave:round', () => {
      socket.leave('round');
      logger.info(`Socket ${socket.id} left room: round`);
      socket.emit('room:left', { room: 'round' });
    });

    // Join chat room (requires authentication)
    socket.on('join:chat', () => {
      if (!socket.userId) {
        socket.emit('error', { message: 'Authentication required to join chat' });
        return;
      }
      socket.join('chat');
      logger.info(`Socket ${socket.id} joined room: chat`);
      socket.emit('room:joined', { room: 'chat' });
    });

    // Leave chat room
    socket.on('leave:chat', () => {
      socket.leave('chat');
      logger.info(`Socket ${socket.id} left room: chat`);
      socket.emit('room:left', { room: 'chat' });
    });

    // Handle chat message (requires authentication, rate limited, ack-based)
    socket.on('chat:send', async (data: { content: string }, callback?: (ack: ChatAck) => void) => {
      const ack = (payload: ChatAck): void => {
        if (typeof callback === 'function') callback(payload);
      };

      if (!socket.userId || !socket.walletAddress) {
        ack({ ok: false, error: 'Authentication required to send messages', code: 'AUTH_REQUIRED' });
        return;
      }

      if (!chatRateLimiter.isAllowed(socket.userId)) {
        logger.warn(`Chat rate limit exceeded for user ${socket.userId}`);
        ack({ ok: false, error: 'Too many messages. Please wait before sending another.', code: 'RATE_LIMITED' });
        return;
      }

      if (!data?.content || data.content.trim().length === 0) {
        ack({ ok: false, error: 'Message content is required', code: 'INVALID_CONTENT' });
        return;
      }

      if (data.content.length > 500) {
        ack({ ok: false, error: 'Message too long (max 500 characters)', code: 'INVALID_CONTENT' });
        return;
      }

      try {
        const message = await chatService.sendMessage(socket.userId, socket.walletAddress, data.content);
        logger.info(`Chat message sent by user ${socket.userId}: ${message.id}`);
        ack({ ok: true, message });
      } catch (error) {
        logger.error('Error sending chat message:', error);
        ack({ ok: false, error: 'Failed to send message', code: 'SEND_FAILED' });
      }
    });

    // Join user notification room (for authenticated users)
    socket.on('join:notifications', () => {
      if (!socket.userId) {
        socket.emit('error', { message: 'Authentication required for notifications' });
        return;
      }
      socket.join(`user:${socket.userId}`);
      socket.emit('room:joined', { room: 'notifications' });
    });

    // -----------------------------------------------------------------------
    // Disconnect — remove from registry
    // -----------------------------------------------------------------------

    socket.on('disconnect', (reason) => {
      connectionRegistry.delete(socket.id);
      logger.info(`Client disconnected: ${socket.id}, reason: ${reason}`);
    });

    // Handle errors
    socket.on('error', (error) => {
      logger.error(`Socket error for ${socket.id}:`, error);
    });
  });

  logger.info('Socket.IO initialized with JWT authentication');
  return io;
}

export default { initializeSocket };

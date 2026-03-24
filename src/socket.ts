import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { verifyToken } from './utils/jwt.util';
import { prisma } from './lib/prisma';
import websocketService from './services/websocket.service';
import chatService from './services/chat.service';
import { ChatMessage } from './types/chat.types';
import logger from './utils/logger';

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

/**
 * Initialize Socket.IO with JWT authentication
 */
export function initializeSocket(httpServer: HTTPServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

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

    // Auto-join user to their personal room if authenticated
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

    // Handle disconnect
    socket.on('disconnect', (reason) => {
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

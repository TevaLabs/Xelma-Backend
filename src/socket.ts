import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { verifyToken } from './utils/jwt.util';
import { PrismaClient } from '@prisma/client';
import websocketService from './services/websocket.service';
import logger from './utils/logger';

const prisma = new PrismaClient();

// Extended socket interface with user data
interface AuthenticatedSocket extends Socket {
  userId?: string;
  walletAddress?: string;
}

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

    // Handle chat message (requires authentication)
    socket.on('chat:send', async (data: { content: string }) => {
      if (!socket.userId) {
        socket.emit('error', { message: 'Authentication required to send messages' });
        return;
      }

      if (!data.content || data.content.trim().length === 0) {
        socket.emit('error', { message: 'Message content is required' });
        return;
      }

      if (data.content.length > 500) {
        socket.emit('error', { message: 'Message too long (max 500 characters)' });
        return;
      }

      try {
        // Get user info for the message
        const user = await prisma.user.findUnique({
          where: { id: socket.userId },
          select: { id: true, walletAddress: true, nickname: true, avatarUrl: true },
        });

        if (!user) {
          socket.emit('error', { message: 'User not found' });
          return;
        }

        // Create message in database
        const message = await prisma.message.create({
          data: {
            userId: socket.userId,
            content: data.content.trim(),
          },
        });

        // Broadcast to chat room
        const chatMessage = {
          id: message.id,
          userId: user.id,
          walletAddress: user.walletAddress,
          nickname: user.nickname,
          avatarUrl: user.avatarUrl,
          content: message.content,
          createdAt: message.createdAt.toISOString(),
        };

        io.to('chat').emit('chat:message', chatMessage);
        logger.info(`Chat message sent by user ${socket.userId}: ${message.id}`);
      } catch (error) {
        logger.error('Error sending chat message:', error);
        socket.emit('error', { message: 'Failed to send message' });
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

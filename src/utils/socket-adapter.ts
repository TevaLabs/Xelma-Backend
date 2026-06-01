import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import logger from './logger';

/**
 * Socket.IO Redis adapter configuration
 */
export interface SocketAdapterConfig {
   redisUrl?: string;
   keyPrefix?: string;
   connectTimeout?: number;
}

/**
 * Initialize Socket.IO Redis adapter for multi-instance fanout
 * Ensures websocket room broadcasts work correctly across multiple backend instances
 *
 * When Redis is unavailable, Socket.IO continues to work with in-memory adapter
 * (broadcasts only reach clients on the same instance). This is safe for development
 * but should be monitored in production.
 *
 * @param io - Socket.IO server instance
 * @param config - Adapter configuration
 * @returns true if adapter was successfully initialized, false if Redis unavailable
 *
 * @example
 * const io = new SocketIOServer(httpServer);
 * await initializeSocketAdapter(io);
 */
export async function initializeSocketAdapter(
   io: SocketIOServer,
   config: SocketAdapterConfig = {}
): Promise<boolean> {
   const redisUrl = config.redisUrl || process.env.REDIS_URL;
   const keyPrefix = config.keyPrefix || 'xelma:socket.io';
   const connectTimeout = config.connectTimeout || 2000;

   // If Redis is not configured, skip adapter initialization
   if (!redisUrl || !redisUrl.trim()) {
      logger.info(
         'Redis not configured; Socket.IO using in-memory adapter (single-instance only)'
      );
      return false;
   }

   try {
      // Create two Redis clients: one for publishing, one for subscribing
      // Socket.IO requires separate clients for pub/sub
      const pubClient = createClient({
         url: redisUrl,
         socket: {
            connectTimeout,
            reconnectStrategy: retries => {
               if (retries > 10) {
                  logger.error(
                     'Redis pub client: max reconnection attempts reached'
                  );
                  return new Error('Max reconnection attempts');
               }
               return Math.min(retries * 50, 500);
            },
         },
      });

      const subClient = pubClient.duplicate();

      // Handle connection errors
      pubClient.on('error', err => {
         logger.warn('Socket.IO Redis pub client error', {
            message: err instanceof Error ? err.message : String(err),
         });
      });

      subClient.on('error', err => {
         logger.warn('Socket.IO Redis sub client error', {
            message: err instanceof Error ? err.message : String(err),
         });
      });

      // Connect both clients
      await Promise.all([pubClient.connect(), subClient.connect()]);

      // Verify connectivity with a ping
      await pubClient.ping();
      await subClient.ping();

      // Attach the Redis adapter to Socket.IO
      io.adapter(
         createAdapter(pubClient, subClient, {
            key: keyPrefix,
         })
      );

      logger.info('Socket.IO Redis adapter initialized', {
         keyPrefix,
         redisUrl: redisUrl.replace(/:[^@]*@/, ':***@'), // mask password
      });

      return true;
   } catch (error) {
      logger.warn(
         'Failed to initialize Socket.IO Redis adapter; using in-memory adapter',
         {
            error: error instanceof Error ? error.message : String(error),
         }
      );
      return false;
   }
}

/**
 * Check if Socket.IO is using Redis adapter
 * Useful for monitoring and debugging multi-instance deployments
 *
 * @param io - Socket.IO server instance
 * @returns true if using Redis adapter, false if using in-memory adapter
 */
export function isUsingRedisAdapter(io: SocketIOServer): boolean {
   const adapter = io.of('/').adapter;
   // Redis adapter has a 'pubClient' property; in-memory adapter does not
   return adapter && 'pubClient' in adapter;
}

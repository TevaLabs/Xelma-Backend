import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import logger from './logger';

/**
 * Socket.IO Redis adapter configuration.
 *
 * All fields are optional; unset fields fall back to the defaults documented
 * below (and to `process.env.REDIS_URL` for `redisUrl`).
 */
export interface SocketAdapterConfig {
   /**
   * Redis connection URL (e.g. `redis://localhost:6379`).
   * Falls back to `process.env.REDIS_URL`. When unset or blank the adapter is
   * skipped entirely and Socket.IO stays on its in-memory adapter.
   */
   redisUrl?: string;
   /**
   * Redis key namespace (prefix) for all adapter pub/sub channels.
   * Default: `xelma:socket.io`.
   *
   * Every replica that should share broadcasts MUST use the same prefix, and
   * any two deployments sharing one Redis instance MUST use different
   * prefixes — otherwise events leak between environments (e.g. staging
   * clients receiving production round broadcasts).
   */
   keyPrefix?: string;
   /**
   * Per-connection TCP connect timeout in milliseconds. Default: `2000`.
   * Startup fails over to the in-memory adapter if either client cannot
   * connect and ping within this budget.
   */
   connectTimeout?: number;
}

/**
 * Defaults for {@link SocketAdapterConfig} — kept here so docs and tests can
 * reference a single source of truth.
 */
export const SOCKET_ADAPTER_DEFAULTS = {
   keyPrefix: 'xelma:socket.io',
   connectTimeout: 2000,
   /** Maximum reconnect attempts before the pub client gives up. */
   maxReconnectAttempts: 10,
   /** Backoff ceiling in ms: delay = min(retries * 50, 500). */
   reconnectBackoffMs: 500,
} as const;

/**
 * Initialize Socket.IO Redis adapter for multi-instance fanout
 * Ensures websocket room broadcasts work correctly across multiple backend instances
 *
 * ### Connection pool & tuning
 *
 * The adapter owns exactly **two** Redis connections per process:
 *
 * | Client | Role | Tuning |
 * |---|---|---|
 * | `pubClient` | `PUBLISH` for room broadcasts | `connectTimeout` (default 2000 ms), custom `reconnectStrategy` |
 * | `subClient` | `SUBSCRIBE` for inbound fanout (`pubClient.duplicate()`) | inherits the pub client's options |
 *
 * Reconnect strategy for both connections: linear backoff
 * `min(retries * 50, 500)` ms, giving up with
 * `Max reconnection attempts` after 11 failed retries (≈ 5 s of backoff).
 * Connection errors are logged as warnings and never crash the process.
 *
 * ### Failure modes
 *
 * When Redis is unavailable, Socket.IO continues to work with in-memory adapter
 * (broadcasts only reach clients on the same instance). This is safe for development
 * but should be monitored in production.
 *
 * See [`src/docs/websocket.md`](../docs/websocket.md) for the client-facing
 * reconnect contract and key-prefix isolation rules.
 *
 * @param io - Socket.IO server instance
 * @param config - Adapter configuration
 * @returns true if adapter was successfully initialized, false if Redis unavailable
 *
 * @example
 * const io = new SocketIOServer(httpServer);
 * await initializeSocketAdapter(io);
 *
 * @example
 * // Two deployments sharing one Redis must use distinct prefixes
 * await initializeSocketAdapter(io, { keyPrefix: 'xelma:staging:socket.io' });
 */
export async function initializeSocketAdapter(
   io: SocketIOServer,
   config: SocketAdapterConfig = {}
): Promise<boolean> {
   const redisUrl = config.redisUrl || process.env.REDIS_URL;
   const keyPrefix = config.keyPrefix || SOCKET_ADAPTER_DEFAULTS.keyPrefix;
   const connectTimeout =
      config.connectTimeout || SOCKET_ADAPTER_DEFAULTS.connectTimeout;

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
               if (retries > SOCKET_ADAPTER_DEFAULTS.maxReconnectAttempts) {
                  logger.error(
                     'Redis pub client: max reconnection attempts reached'
                  );
                  return new Error('Max reconnection attempts');
               }
               return Math.min(
                  retries * 50,
                  SOCKET_ADAPTER_DEFAULTS.reconnectBackoffMs
               );
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

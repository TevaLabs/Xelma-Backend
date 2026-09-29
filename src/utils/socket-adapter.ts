import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import logger from './logger';
import { userRoom } from './socket-rooms';
import type { RoomMembershipTransport } from '../services/multiplayer-session.service';

/**
 * Socket.IO Redis adapter configuration
 */
export interface SocketAdapterConfig {
   redisUrl?: string;
   keyPrefix?: string;
   connectTimeout?: number;
}

/** The part of a node-redis client needed to shut it down. */
interface ClosableRedisClient {
   readonly isOpen: boolean;
   close(): Promise<unknown>;
   destroy(): void;
}

/** Pub/sub clients created for each server, so they can be closed on shutdown. */
const adapterClients = new WeakMap<object, ClosableRedisClient[]>();

/**
 * Initialize Socket.IO Redis adapter for multi-instance fanout
 * Ensures websocket room broadcasts work correctly across multiple backend instances
 *
 * Redis is REQUIRED to run more than one API instance: room broadcasts,
 * multiplayer room membership (Issue #669) and every other social feature
 * rely on the adapter to reach sockets connected to other instances. Without
 * REDIS_URL, Socket.IO falls back to the in-memory adapter, which is correct
 * for a single instance only.
 *
 * Call this before the HTTP server starts accepting connections: swapping
 * the adapter re-creates it and drops the rooms of already-connected sockets.
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
      logger.warn(
         'REDIS_URL is not set: Socket.IO is using the in-memory adapter (single-instance only). ' +
            'Multiplayer rooms and social features require Redis to run more than one API instance.'
      );
      return false;
   }

   let clients: ClosableRedisClient[] = [];
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
      clients = [pubClient, subClient];

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
      adapterClients.set(io, clients);

      logger.info('Socket.IO Redis adapter initialized', {
         keyPrefix,
         redisUrl: redisUrl.replace(/:[^@]*@/, ':***@'), // mask password
      });

      return true;
   } catch (error) {
      // Stop the half-open clients so their reconnect loops don't outlive
      // the failed initialization.
      for (const client of clients) {
         try {
            if (client.isOpen) client.destroy();
         } catch {
            // Already closed.
         }
      }
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
 * Close the Redis pub/sub clients created by `initializeSocketAdapter` for
 * this server. Safe to call when no Redis adapter was attached.
 */
export async function closeSocketAdapter(io: SocketIOServer): Promise<void> {
   const clients = adapterClients.get(io);
   if (!clients) return;
   adapterClients.delete(io);
   await Promise.all(
      clients.map(async client => {
         try {
            if (client.isOpen) await client.close();
         } catch (error) {
            logger.warn('Failed to close Socket.IO Redis adapter client', {
               error: error instanceof Error ? error.message : String(error),
            });
         }
      })
   );
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

// ---------------------------------------------------------------------------
// Room membership transport (Issue #669)
// ---------------------------------------------------------------------------

/** Default bound on the cluster-wide confirmation round trip. */
export const DEFAULT_MEMBERSHIP_CONFIRM_TIMEOUT_MS = 2_000;

interface RoomOperator {
   socketsJoin(room: string): void;
   socketsLeave(room: string): void;
}

/**
 * The subset of a Socket.IO server the membership transport uses. A real
 * `Server` satisfies it; tests can pass a hand-rolled fake.
 */
export interface MembershipIo {
   in(room: string): RoomOperator & {
      fetchSockets(): Promise<
         ReadonlyArray<{ readonly id: string; readonly rooms: Set<string> }>
      >;
   };
   readonly local: { in(room: string): RoomOperator };
}

/** The adapter did not confirm that every socket of the user was updated. */
export class RoomSyncError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'RoomSyncError';
   }
}

export interface RoomMembershipTransportOptions {
   confirmTimeoutMs?: number;
}

/**
 * Build the adapter half of the membership protocol for `io`.
 *
 * `join(userId, room)` / `leave(userId, room)` apply the change to every
 * socket of the user on every instance, then wait for confirmation:
 *
 *   1. Apply locally (`io.local`): immediate for sockets on this instance.
 *   2. Apply cluster-wide (`io.in(userRoom).socketsJoin`). With the Redis
 *      adapter this only *publishes* a request; it returns before any
 *      instance, including this one, has applied it, and never reports
 *      failure.
 *   3. Confirm with `io.in(userRoom).fetchSockets()`. The Redis adapter
 *      publishes the fetch on the same channel after the join/leave, and each
 *      instance handles requests in order, so every reply reflects the change.
 *      The promise rejects if an instance does not answer in time, or if a
 *      returned socket is not in the expected state.
 *
 * A rejected promise is the "adapter step failed" signal the protocol
 * compensates for. With the in-memory adapter all three steps are local and
 * synchronous.
 */
export function createRoomMembershipTransport(
   io: MembershipIo,
   options: RoomMembershipTransportOptions = {}
): RoomMembershipTransport {
   const confirmTimeoutMs =
      options.confirmTimeoutMs ?? DEFAULT_MEMBERSHIP_CONFIRM_TIMEOUT_MS;

   const apply = async (
      userId: string,
      room: string,
      action: 'join' | 'leave'
   ): Promise<void> => {
      const target = userRoom(userId);
      if (action === 'join') {
         io.local.in(target).socketsJoin(room);
         io.in(target).socketsJoin(room);
      } else {
         io.local.in(target).socketsLeave(room);
         io.in(target).socketsLeave(room);
      }

      const sockets = await withDeadline(
         io.in(target).fetchSockets(),
         confirmTimeoutMs,
         `confirming ${action} of ${room}`
      );
      const shouldBeInRoom = action === 'join';
      const unsynced = sockets.filter(s => s.rooms.has(room) !== shouldBeInRoom);
      if (unsynced.length > 0) {
         throw new RoomSyncError(
            `${unsynced.length} of ${sockets.length} socket(s) did not ${action} ${room}`
         );
      }
   };

   return {
      join: (userId, room) => apply(userId, room, 'join'),
      leave: (userId, room) => apply(userId, room, 'leave'),
   };
}

function withDeadline<T>(
   promise: Promise<T>,
   timeoutMs: number,
   what: string
): Promise<T> {
   return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
         reject(new RoomSyncError(`Timed out after ${timeoutMs}ms ${what}`));
      }, timeoutMs);
      promise.then(
         value => {
            clearTimeout(timer);
            resolve(value);
         },
         (error: unknown) => {
            clearTimeout(timer);
            reject(
               error instanceof Error
                  ? new RoomSyncError(`${what}: ${error.message}`)
                  : new RoomSyncError(`${what}: ${String(error)}`)
            );
         }
      );
   });
}

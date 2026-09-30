/**
 * Redis Socket.IO adapter integration test (Issue #418).
 *
 * Proves that room broadcasts fan out across two independent Socket.IO
 * server instances via the Redis adapter, simulating a multi-instance
 * deployment. Skips cleanly when REDIS_URL is not configured (e.g. no
 * local Redis running) so the default unit test run is never blocked.
 *
 * To run locally:
 *   docker compose --profile full up -d redis
 *   REDIS_URL=redis://localhost:6379 npx jest --testPathPattern=redis-adapter
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createServer, Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket } from 'socket.io-client';
import { initializeSocketAdapter, isUsingRedisAdapter } from '../utils/socket-adapter';

const REDIS_URL = process.env.REDIS_URL;
const maybeDescribe = REDIS_URL ? describe : describe.skip;

function waitForConnect(socket: Socket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timeout waiting for connect')), timeoutMs);
    if (socket.connected) {
      clearTimeout(t);
      return resolve();
    }
    socket.once('connect', () => {
      clearTimeout(t);
      resolve();
    });
    socket.once('connect_error', err => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function waitFor(socket: Socket, event: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data: any) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

async function startServer(): Promise<{ httpServer: HttpServer; io: SocketIOServer; baseURL: string }> {
  const httpServer = createServer();
  const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });
  await new Promise<void>(resolve => {
    httpServer.listen(0, () => resolve());
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { httpServer, io, baseURL: `http://127.0.0.1:${port}` };
}

maybeDescribe('Redis Socket.IO adapter - cross-node fanout (Issue #418)', () => {
  let serverA: { httpServer: HttpServer; io: SocketIOServer; baseURL: string };
  let serverB: { httpServer: HttpServer; io: SocketIOServer; baseURL: string };

  beforeAll(async () => {
    serverA = await startServer();
    serverB = await startServer();

    const [initedA, initedB] = await Promise.all([
      initializeSocketAdapter(serverA.io, { redisUrl: REDIS_URL, keyPrefix: 'xelma:test:socket.io' }),
      initializeSocketAdapter(serverB.io, { redisUrl: REDIS_URL, keyPrefix: 'xelma:test:socket.io' }),
    ]);

    if (!initedA || !initedB) {
      throw new Error(
        'Redis adapter failed to initialize even though REDIS_URL is set - check that Redis is reachable.'
      );
    }
  }, 15000);

  afterAll(async () => {
    // Quit the Redis pub/sub clients the adapter created internally so Jest
    // doesn't hang on open handles after the test run finishes.
    for (const s of [serverA, serverB]) {
      const adapter = s.io.of('/').adapter as any;
      await Promise.all(
        [adapter?.pubClient, adapter?.subClient]
          .filter(Boolean)
          .map((client: any) => client.quit().catch(() => undefined))
      );
    }

    await Promise.all(
      [serverA, serverB].map(
        s =>
          new Promise<void>(resolve => {
            s.httpServer.closeAllConnections?.();
            s.io.close();
            s.httpServer.close(() => resolve());
          })
      )
    );
  }, 15000);

  it('reports the Redis adapter as active on both instances', () => {
    expect(isUsingRedisAdapter(serverA.io)).toBe(true);
    expect(isUsingRedisAdapter(serverB.io)).toBe(true);
  });

  it('delivers a room broadcast from server B to a client connected on server A', async () => {
    const room = `cross-node-room-${Date.now()}`;

    const client = ioClient(serverA.baseURL, {
      transports: ['websocket'],
      autoConnect: false,
    });

    client.connect();
    await waitForConnect(client);

    // Join via the server-side socket instance directly (deterministic,
    // no dependency on any application-level join handler). By the time the
    // client's 'connect' event fired, the server has already registered the
    // socket in io.sockets.sockets.
    const socketOnA = serverA.io.sockets.sockets.get(client.id!);
    await socketOnA?.join(room);

    const received = waitFor(client, 'cross-node-event');

    // Emit from server B - only reaches the room via the shared Redis adapter.
    serverB.io.to(room).emit('cross-node-event', { msg: 'hello-from-b' });

    const payload = await received;
    expect(payload).toEqual({ msg: 'hello-from-b' });

    client.disconnect();
  });
});

// Guard so CI output makes it obvious *why* this suite was skipped.
if (!REDIS_URL) {
  console.warn(
    '[redis-adapter.spec.ts] REDIS_URL not set - skipping Redis adapter integration test. ' +
      'Run `docker compose --profile full up -d redis` and set REDIS_URL to enable it.'
  );
}
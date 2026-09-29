/**
 * Issue #669 — multiplayer room membership across two API instances.
 *
 * Starts TWO real Socket.IO servers in this process (the production
 * `initializeSocket`, different ports), both on the Redis adapter against the
 * same Redis, backed by the same Postgres. Clients connect to one node while
 * membership changes go through the other, which is what happens behind a
 * load balancer.
 *
 * Proves:
 *   - a join performed on node B puts the user's socket on node A in the room
 *     (an emit from node B reaches it), and a leave on node B takes it out;
 *   - a `join:round` sent to one node moves the same user's other tab, on the
 *     other node, into the room too; a `leave:round` on that other node takes
 *     both out;
 *   - after reconnecting to the other node, a socket is back in exactly its
 *     DB rooms;
 *   - partial failure (an instance that never confirms) is compensated: the
 *     DB membership is removed and no socket is left in the room.
 *
 * Requires Postgres (DATABASE_URL) and Redis (REDIS_URL). Skips cleanly when
 * REDIS_URL is not set. To run locally:
 *
 *   docker run -d --name xelma-redis -p 6379:6379 redis:7-alpine
 *   REDIS_URL=redis://127.0.0.1:6379 npx jest --selectProjects integration \
 *     --testPathPattern=multiplayer-room-multinode
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { createServer, Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { createClient } from 'redis';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { closeRedisClient } from '../lib/redis';
import { initializeSocket, closeWebSocket } from '../socket';
import multiplayerSessionService from '../services/multiplayer-session.service';
import {
  createRoomMembershipTransport,
  isUsingRedisAdapter,
} from '../utils/socket-adapter';
import { roundRoom, userRoom } from '../utils/socket-rooms';
import { generateToken } from '../utils/jwt.util';
import type { TypedServer, PriceUpdatePayload } from '../types/socket-events';

const REDIS_URL = process.env.REDIS_URL;
const maybeDescribe = REDIS_URL ? describe : describe.skip;

/** The Redis adapter's request channel for the default namespace. */
const REQUEST_CHANNEL = 'xelma:socket.io-request#/#';

type Node = { httpServer: HttpServer; io: TypedServer; url: string };

async function startNode(): Promise<Node> {
  const httpServer = createServer();
  const io = await initializeSocket(httpServer);
  await new Promise<void>(resolve => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  return { httpServer, io, url: `http://127.0.0.1:${port}` };
}

function waitFor<T>(socket: ClientSocket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function price(tag: string): PriceUpdatePayload {
  return { asset: tag, price: '0.12345678', timestamp: new Date().toISOString() };
}

maybeDescribe('multiplayer room membership across two instances (Issue #669)', () => {
  let nodeA: Node;
  let nodeB: Node;
  let userId: string;
  let token: string;
  const clients: ClientSocket[] = [];

  /** Connect a client for the test user and wait until its DB rooms are restored. */
  async function connect(node: Node): Promise<{ client: ClientSocket; rooms: string[] }> {
    const client = ioClient(node.url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    clients.push(client);
    const resume = await waitFor<{ rooms: string[] }>(client, 'session:resume');
    return { client, rooms: resume.rooms };
  }

  /**
   * Emit `price:update` to `room` from `from`, then a sentinel to the user's
   * own room. Both travel over the same Redis channel in order, so once the
   * sentinel has arrived, the room emit has arrived too if it was going to.
   */
  async function receivesRoomEmit(
    client: ClientSocket,
    from: Node,
    room: string,
  ): Promise<boolean> {
    const tag = `probe-${Math.random().toString(36).slice(2)}`;
    let received = false;
    const onPrice = (payload: PriceUpdatePayload) => {
      if (payload.asset === tag) received = true;
    };
    client.on('price:update', onPrice);
    const sentinel = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sentinel not delivered')), 5000);
      const onSentinel = (payload: PriceUpdatePayload) => {
        if (payload.asset !== `${tag}-sentinel`) return;
        clearTimeout(timer);
        client.off('price_update', onSentinel);
        resolve();
      };
      client.on('price_update', onSentinel);
    });
    from.io.to(room).emit('price:update', price(tag));
    from.io.to(userRoom(userId)).emit('price_update', price(`${tag}-sentinel`));
    await sentinel;
    client.off('price:update', onPrice);
    return received;
  }

  async function dbRooms(): Promise<string[]> {
    const row = await prisma.multiplayerSession.findUnique({ where: { userId } });
    return (row?.rooms as string[] | undefined) ?? [];
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { walletAddress: `GMULTINODE669${Date.now()}${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    token = generateToken(user.id, user.walletAddress, UserRole.USER);

    nodeA = await startNode();
    nodeB = await startNode();
    if (!isUsingRedisAdapter(nodeA.io) || !isUsingRedisAdapter(nodeB.io)) {
      throw new Error('Redis adapter did not initialize although REDIS_URL is set; is Redis reachable?');
    }
  }, 20000);

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    await prisma.multiplayerSession.updateMany({ where: { userId }, data: { rooms: [] } });
  });

  afterAll(async () => {
    closeWebSocket();
    await Promise.all(
      [nodeA, nodeB].filter(Boolean).map(
        node =>
          new Promise<void>(resolve => {
            node.io.close();
            node.httpServer.close(() => resolve());
          }),
      ),
    );
    await closeRedisClient();
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
  }, 20000);

  it('joins through node B reach a socket on node A; leaves through node B remove it', async () => {
    const room = roundRoom(`mn-join-${Date.now()}`);
    const { client } = await connect(nodeA);
    const transportB = createRoomMembershipTransport(nodeB.io);

    const joined = await multiplayerSessionService.joinRoom(userId, room, transportB);

    expect(joined).toEqual({ ok: true, room, changed: true, adapterSynced: true });
    expect(await dbRooms()).toEqual([room]);
    expect(await receivesRoomEmit(client, nodeB, room)).toBe(true);

    const left = await multiplayerSessionService.leaveRoom(userId, room, transportB);

    expect(left).toEqual({ ok: true, room, changed: true, adapterSynced: true });
    expect(await dbRooms()).toEqual([]);
    expect(await receivesRoomEmit(client, nodeB, room)).toBe(false);
  });

  it('a join:round on one node moves the same user\'s tab on the other node too', async () => {
    const roundId = `mn-tabs-${Date.now()}`;
    const room = roundRoom(roundId);
    const { client: tabOnA } = await connect(nodeA);
    const { client: tabOnB } = await connect(nodeB);

    const ack = waitFor<{ room: string }>(tabOnA, 'room:joined');
    tabOnA.emit('join:round', { roundId });
    expect(await ack).toEqual({ room });

    expect(await dbRooms()).toEqual([room]);
    expect(await receivesRoomEmit(tabOnB, nodeA, room)).toBe(true);
    expect(await receivesRoomEmit(tabOnA, nodeB, room)).toBe(true);

    const leftAck = waitFor<{ room: string }>(tabOnB, 'room:left');
    tabOnB.emit('leave:round', { roundId });
    expect(await leftAck).toEqual({ room });

    expect(await dbRooms()).toEqual([]);
    expect(await receivesRoomEmit(tabOnA, nodeB, room)).toBe(false);
    expect(await receivesRoomEmit(tabOnB, nodeA, room)).toBe(false);
  });

  it('after reconnecting to the other node, a socket is back in exactly its DB rooms', async () => {
    const roundId = `mn-reconnect-${Date.now()}`;
    const room = roundRoom(roundId);
    const { client: first } = await connect(nodeA);
    const ack = waitFor(first, 'room:joined');
    first.emit('join:round', { roundId });
    await ack;
    first.disconnect();

    const { client: second, rooms } = await connect(nodeB);

    expect(rooms).toEqual([room]);
    expect(await receivesRoomEmit(second, nodeA, room)).toBe(true);
    // Not in rooms it was never a member of.
    expect(await receivesRoomEmit(second, nodeA, 'chat')).toBe(false);
  });

  it('compensates when an instance never confirms: no DB membership, no socket left in the room', async () => {
    const room = roundRoom(`mn-ghost-${Date.now()}`);
    const { client } = await connect(nodeA);

    // A third "instance" subscribed to the adapter's request channel that
    // never answers, so the cluster-wide confirmation cannot complete.
    const ghost = createClient({ url: REDIS_URL });
    await ghost.connect();
    await ghost.subscribe(REQUEST_CHANNEL, () => undefined);
    try {
      const transportB = createRoomMembershipTransport(nodeB.io, { confirmTimeoutMs: 500 });

      const result = await multiplayerSessionService.joinRoom(userId, room, transportB);

      expect(result).toMatchObject({ ok: false, code: 'MEMBERSHIP_SYNC_FAILED' });
      expect(await dbRooms()).toEqual([]);
    } finally {
      await ghost.unsubscribe(REQUEST_CHANNEL);
      await ghost.close();
    }
    expect(await receivesRoomEmit(client, nodeB, room)).toBe(false);
  }, 20000);
});

// Make it obvious in test output *why* this suite did not run.
if (!REDIS_URL) {
  describe('multiplayer room membership across two instances (Issue #669)', () => {
    it.skip('skipped: set REDIS_URL (and DATABASE_URL) to run the multi-node test', () => undefined);
  });
}

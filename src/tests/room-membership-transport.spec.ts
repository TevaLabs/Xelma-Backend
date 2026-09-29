/**
 * Issue #669 — adapter half of the room-membership protocol
 * (`createRoomMembershipTransport` in utils/socket-adapter.ts).
 *
 *   - With a real (in-memory adapter) Socket.IO server: join/leave apply to
 *     every socket of the user, and only to that user's sockets.
 *   - With a fake server: the step order (local apply → cluster apply →
 *     confirmation round trip) and every failure mode that must make the
 *     protocol compensate — timeout, adapter error, unconfirmed socket.
 *
 * The same transport over the Redis adapter, across two servers, is covered
 * by multiplayer-room-multinode.spec.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createServer, Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import {
  createRoomMembershipTransport,
  RoomSyncError,
  type MembershipIo,
} from '../utils/socket-adapter';
import { userRoom } from '../utils/socket-rooms';

const ALICE = 'alice-669';
const BOB = 'bob-669';

type FakeSocket = { id: string; rooms: Set<string> };

/** Fake server recording calls; `fetchSockets` is scripted per test. */
function fakeIo(fetchSockets: () => Promise<FakeSocket[]>): {
  io: MembershipIo;
  calls: string[];
} {
  const calls: string[] = [];
  const operator = (scope: 'local' | 'cluster', target: string) => ({
    socketsJoin: (room: string) => {
      calls.push(`${scope}:join:${target}->${room}`);
    },
    socketsLeave: (room: string) => {
      calls.push(`${scope}:leave:${target}->${room}`);
    },
  });
  const io: MembershipIo = {
    in: (target: string) => ({
      ...operator('cluster', target),
      fetchSockets: () => {
        calls.push(`cluster:fetch:${target}`);
        return fetchSockets();
      },
    }),
    local: { in: (target: string) => operator('local', target) },
  };
  return { io, calls };
}

describe('room membership transport (Issue #669)', () => {
  describe('step order and failure detection (fake server)', () => {
    it('applies locally, then cluster-wide to the user room, then confirms', async () => {
      const { io, calls } = fakeIo(async () => [
        { id: 's1', rooms: new Set(['s1', userRoom(ALICE), 'chat']) },
      ]);

      await createRoomMembershipTransport(io).join(ALICE, 'chat');

      expect(calls).toEqual([
        `local:join:${userRoom(ALICE)}->chat`,
        `cluster:join:${userRoom(ALICE)}->chat`,
        `cluster:fetch:${userRoom(ALICE)}`,
      ]);
    });

    it('confirms a leave only when no socket of the user is still in the room', async () => {
      const { io, calls } = fakeIo(async () => [
        { id: 's1', rooms: new Set(['s1', userRoom(ALICE)]) },
      ]);

      await createRoomMembershipTransport(io).leave(ALICE, 'chat');

      expect(calls).toEqual([
        `local:leave:${userRoom(ALICE)}->chat`,
        `cluster:leave:${userRoom(ALICE)}->chat`,
        `cluster:fetch:${userRoom(ALICE)}`,
      ]);
    });

    it('fails when a socket did not apply the join', async () => {
      const { io } = fakeIo(async () => [
        { id: 's1', rooms: new Set(['s1', userRoom(ALICE), 'chat']) },
        { id: 's2', rooms: new Set(['s2', userRoom(ALICE)]) },
      ]);

      await expect(createRoomMembershipTransport(io).join(ALICE, 'chat')).rejects.toThrow(
        new RoomSyncError('1 of 2 socket(s) did not join chat'),
      );
    });

    it('fails when a socket is still in the room after a leave', async () => {
      const { io } = fakeIo(async () => [
        { id: 's1', rooms: new Set(['s1', userRoom(ALICE), 'chat']) },
      ]);

      await expect(createRoomMembershipTransport(io).leave(ALICE, 'chat')).rejects.toBeInstanceOf(
        RoomSyncError,
      );
    });

    it('fails when the adapter cannot reach every instance', async () => {
      const { io } = fakeIo(async () => {
        throw new Error('timeout reached while waiting for fetchSockets response');
      });

      await expect(createRoomMembershipTransport(io).join(ALICE, 'chat')).rejects.toThrow(
        /confirming join of chat: timeout reached/,
      );
    });

    it('fails, without an unhandled rejection, when confirmation exceeds its deadline', async () => {
      let rejectLate: (error: Error) => void = () => undefined;
      const { io } = fakeIo(
        () =>
          new Promise<FakeSocket[]>((_resolve, reject) => {
            rejectLate = reject;
          }),
      );

      await expect(
        createRoomMembershipTransport(io, { confirmTimeoutMs: 20 }).join(ALICE, 'chat'),
      ).rejects.toThrow('Timed out after 20ms confirming join of chat');

      // The adapter's own request timeout firing later must be swallowed.
      rejectLate(new Error('late adapter timeout'));
      await new Promise(resolve => setImmediate(resolve));
    });

    it('succeeds trivially when the user has no connected sockets', async () => {
      const { io } = fakeIo(async () => []);
      await expect(createRoomMembershipTransport(io).join(ALICE, 'chat')).resolves.toBeUndefined();
    });

    it('rejects an invalid user id before touching the adapter', async () => {
      const { io, calls } = fakeIo(async () => []);
      await expect(createRoomMembershipTransport(io).join('bad:id', 'chat')).rejects.toThrow(
        'Invalid user id',
      );
      expect(calls).toEqual([]);
    });
  });

  describe('against a real Socket.IO server (in-memory adapter)', () => {
    let httpServer: HttpServer;
    let io: SocketIOServer;
    let url: string;
    const clients: ClientSocket[] = [];

    function connectAs(userId: string): Promise<ClientSocket> {
      const client = ioClient(url, {
        transports: ['websocket'],
        auth: { userId },
        forceNew: true,
      });
      clients.push(client);
      return new Promise((resolve, reject) => {
        client.once('ready', () => resolve(client));
        client.once('connect_error', reject);
      });
    }

    function roomsOf(client: ClientSocket): Set<string> {
      const socket = io.sockets.sockets.get(client.id ?? '');
      if (!socket) throw new Error('server socket not found');
      return socket.rooms;
    }

    beforeAll(async () => {
      httpServer = createServer();
      io = new SocketIOServer(httpServer);
      io.on('connection', socket => {
        const userId: unknown = socket.handshake.auth.userId;
        if (typeof userId === 'string') socket.join(userRoom(userId));
        socket.emit('ready');
      });
      await new Promise<void>(resolve => httpServer.listen(0, resolve));
      url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      for (const client of clients) client.disconnect();
      io.close();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    });

    it('moves every socket of the user, and only that user, into and out of the room', async () => {
      const aliceTab1 = await connectAs(ALICE);
      const aliceTab2 = await connectAs(ALICE);
      const bob = await connectAs(BOB);
      const transport = createRoomMembershipTransport(io);

      await transport.join(ALICE, 'round:r-669');

      expect(roomsOf(aliceTab1).has('round:r-669')).toBe(true);
      expect(roomsOf(aliceTab2).has('round:r-669')).toBe(true);
      expect(roomsOf(bob).has('round:r-669')).toBe(false);

      await transport.leave(ALICE, 'round:r-669');

      expect(roomsOf(aliceTab1).has('round:r-669')).toBe(false);
      expect(roomsOf(aliceTab2).has('round:r-669')).toBe(false);
      // Identity rooms are untouched.
      expect(roomsOf(aliceTab1).has(userRoom(ALICE))).toBe(true);
    });
  });
});

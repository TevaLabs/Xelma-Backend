/**
 * Notification room join authorization (Issue #850).
 *
 * A socket may only join the `user:<id>` notification room that belongs to
 * the userId in its own verified JWT. Runs a real Socket.IO server with
 * mocked Prisma / session persistence, so no DATABASE_URL is required.
 *
 * Run:  npx jest src/tests/socket-notification-auth.spec.ts
 */
import {
   describe,
   it,
   expect,
   jest,
   beforeAll,
   afterAll,
   beforeEach,
   afterEach,
} from '@jest/globals';
import { createServer, Server as HttpServer } from 'http';
import { io as ioClient, Socket } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import {
   initializeSocket,
   closeWebSocket,
   parseNotificationTarget,
   userRoom,
} from '../socket';
import websocketService from '../services/websocket.service';
import { generateToken } from '../utils/jwt.util';
import type { TypedServer } from '../types/socket-events';

const KNOWN_USERS: Record<string, string> = {
   'owner-user-id': 'GOWNER______________________________',
   'attacker-user-id': 'GATTACKER___________________________',
   '42': 'GNUMERIC____________________________',
};

const mockRecordConnect = jest.fn<(...args: any[]) => Promise<any>>();

jest.mock('../lib/prisma', () => ({
   prisma: {
      user: {
         findUnique: jest.fn(async ({ where }: any) =>
            KNOWN_USERS[where.id]
               ? { id: where.id, walletAddress: KNOWN_USERS[where.id] }
               : null,
         ),
      },
      round: { findMany: jest.fn(async () => []) },
      $disconnect: jest.fn(),
   },
}));

jest.mock('../services/multiplayer-session.service', () => ({
   __esModule: true,
   default: {
      recordConnect: (...args: any[]) => mockRecordConnect(...args),
      recordDisconnect: jest.fn(async () => undefined),
      addRoom: jest.fn(async () => undefined),
      removeRoom: jest.fn(async () => undefined),
      reconcileRooms: jest.fn(async () => undefined),
      patchMetadata: jest.fn(async () => undefined),
   },
}));

jest.mock('../services/chat.service', () => ({
   __esModule: true,
   default: { sendMessage: jest.fn(), getHistory: jest.fn() },
}));

const EMPTY_RESUME = {
   resumed: false,
   rooms: [],
   metadata: null,
   lastConnectedAt: null,
   lastDisconnectedAt: null,
};

function tokenFor(userId: string): string {
   return generateToken(userId, KNOWN_USERS[userId], UserRole.USER);
}

function waitFor(socket: Socket, event: string, timeoutMs = 3000): Promise<any> {
   return new Promise((resolve, reject) => {
      const t = setTimeout(
         () => reject(new Error(`Timeout waiting for ${event}`)),
         timeoutMs,
      );
      socket.once(event, (data: any) => {
         clearTimeout(t);
         resolve(data);
      });
   });
}

/** Resolve true if `event` arrives within `ms`, false otherwise. */
function receivesWithin(socket: Socket, event: string, ms = 300): Promise<boolean> {
   return new Promise(resolve => {
      const onEvent = () => {
         clearTimeout(t);
         resolve(true);
      };
      const t = setTimeout(() => {
         socket.off(event, onEvent);
         resolve(false);
      }, ms);
      socket.once(event, onEvent);
   });
}

/** Emit join:notifications with the given args and resolve with the ack. */
function joinNotifications(socket: Socket, ...args: unknown[]): Promise<any> {
   return new Promise((resolve, reject) => {
      const t = setTimeout(
         () => reject(new Error('Timeout waiting for join:notifications ack')),
         3000,
      );
      (socket.emit as any)('join:notifications', ...args, (ack: any) => {
         clearTimeout(t);
         resolve(ack);
      });
   });
}

describe('parseNotificationTarget', () => {
   it.each<[unknown, string | null | undefined]>([
      [undefined, undefined],
      [null, undefined],
      [{}, undefined],
      ['owner-user-id', 'owner-user-id'],
      ['user:owner-user-id', 'owner-user-id'],
      ['  user:owner-user-id  ', 'owner-user-id'],
      [42, '42'],
      ['42', '42'],
      ['user:42', '42'],
      [{ userId: 42 }, '42'],
      [{ userId: 'owner-user-id' }, 'owner-user-id'],
      [{ room: 'user:owner-user-id' }, 'owner-user-id'],
      ['user:user:victim', 'user:victim'],
      ['', null],
      ['   ', null],
      ['user:', null],
      [{ userId: '' }, null],
      [{ room: 42 }, null],
      [4.2, null],
      [Number.NaN, null],
      [true, null],
      [['user:42'], null],
   ])('parses %p as %p', (input, expected) => {
      expect(parseNotificationTarget(input)).toBe(expected);
   });
});

describe('Socket.IO notification room authorization (Issue #850)', () => {
   let httpServer: HttpServer;
   let io: TypedServer;
   let baseURL: string;
   const clients: Socket[] = [];

   function connectClient(token?: string): Socket {
      const client = ioClient(baseURL, {
         ...(token ? { auth: { token } } : {}),
         transports: ['websocket'],
         reconnection: false,
         forceNew: true,
      });
      clients.push(client);
      return client;
   }

   /** Connect and wait for `server:hello` so server-side setup has finished. */
   async function connected(token?: string): Promise<Socket> {
      const client = connectClient(token);
      await waitFor(client, 'server:hello');
      return client;
   }

   function serverRooms(client: Socket): Set<string> {
      const socket = io.sockets.sockets.get(client.id!);
      return new Set(socket ? socket.rooms : []);
   }

   beforeAll(async () => {
      httpServer = createServer();
      io = await initializeSocket(httpServer);
      await new Promise<void>(resolve => {
         httpServer.listen(0, () => {
            const addr = httpServer.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            baseURL = `http://127.0.0.1:${port}`;
            resolve();
         });
      });
   });

   beforeEach(() => {
      mockRecordConnect.mockReset();
      mockRecordConnect.mockResolvedValue(EMPTY_RESUME);
   });

   afterEach(() => {
      while (clients.length) clients.pop()!.disconnect();
   });

   afterAll(async () => {
      closeWebSocket();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
   });

   describe('own room', () => {
      it('joins its own room and receives notifications emitted to it', async () => {
         const owner = await connected(tokenFor('owner-user-id'));

         const joined = waitFor(owner, 'room:joined');
         const ack = await joinNotifications(owner);

         expect(ack).toEqual({ ok: true, room: 'notifications' });
         expect(await joined).toEqual({ room: 'notifications' });
         expect(serverRooms(owner).has(userRoom('owner-user-id'))).toBe(true);

         const received = waitFor(owner, 'notification:new');
         websocketService.emitNotification('owner-user-id', {
            id: 'n-1',
            type: 'ROUND_RESOLVED',
            title: 'Round resolved',
            message: 'You won',
         });
         expect(await received).toMatchObject({ id: 'n-1' });
      });

      it.each<[string, unknown]>([
         ['no payload (legacy, without ack)', undefined],
         ['own room name', 'user:owner-user-id'],
         ['own bare id', 'owner-user-id'],
         ['own id object', { userId: 'owner-user-id' }],
      ])('accepts %s', async (_label, payload) => {
         const owner = await connected(tokenFor('owner-user-id'));

         const joined = waitFor(owner, 'room:joined');
         if (payload === undefined) {
            owner.emit('join:notifications');
         } else {
            const ack = await joinNotifications(owner, payload);
            expect(ack).toEqual({ ok: true, room: 'notifications' });
         }

         expect(await joined).toEqual({ room: 'notifications' });
      });

      it('accepts the ack as the only argument', async () => {
         const owner = await connected(tokenFor('owner-user-id'));
         const ack = await joinNotifications(owner);
         expect(ack).toEqual({ ok: true, room: 'notifications' });
      });
   });

   describe("another user's room", () => {
      it.each<[string, unknown]>([
         ['room name', 'user:owner-user-id'],
         ['bare id', 'owner-user-id'],
         ['id object', { userId: 'owner-user-id' }],
         ['room object', { room: 'user:owner-user-id' }],
         ['padded room name', '  user:owner-user-id  '],
      ])('is FORBIDDEN by %s and never receives its notifications', async (_label, payload) => {
         const owner = await connected(tokenFor('owner-user-id'));
         const attacker = await connected(tokenFor('attacker-user-id'));

         const errorEvent = waitFor(attacker, 'error');
         const ack = await joinNotifications(attacker, payload);

         expect(ack).toEqual({
            ok: false,
            code: 'FORBIDDEN',
            error: expect.stringContaining('Unauthorized'),
         });
         expect(await errorEvent).toEqual({
            code: 'FORBIDDEN',
            message: expect.stringContaining('Unauthorized'),
         });
         expect(serverRooms(attacker).has(userRoom('owner-user-id'))).toBe(false);

         const ownerGets = receivesWithin(owner, 'notification:new');
         const attackerGets = receivesWithin(attacker, 'notification:new');
         websocketService.emitNotification('owner-user-id', { id: 'private' });

         expect(await ownerGets).toBe(true);
         expect(await attackerGets).toBe(false);
      });

      it('does not join any room when the target is rejected', async () => {
         const attacker = await connected(tokenFor('attacker-user-id'));
         const before = serverRooms(attacker);

         await joinNotifications(attacker, 'user:owner-user-id');

         expect(serverRooms(attacker)).toEqual(before);
      });
   });

   describe('unauthenticated and bad tokens', () => {
      it('rejects a socket with no token with AUTH_REQUIRED', async () => {
         await connected(tokenFor('owner-user-id'));
         const anon = await connected();

         const errorEvent = waitFor(anon, 'error');
         const ack = await joinNotifications(anon, 'user:owner-user-id');

         expect(ack).toEqual({
            ok: false,
            code: 'AUTH_REQUIRED',
            error: expect.stringContaining('Authentication required'),
         });
         expect(await errorEvent).toMatchObject({ code: 'AUTH_REQUIRED' });

         const rooms = serverRooms(anon);
         expect([...rooms].some(r => r.startsWith('user:'))).toBe(false);

         const anonGets = receivesWithin(anon, 'notification:new');
         websocketService.emitNotification('owner-user-id', { id: 'private' });
         expect(await anonGets).toBe(false);
      });

      it('rejects the no-payload join for an unauthenticated socket', async () => {
         const anon = await connected();
         const ack = await joinNotifications(anon);
         expect(ack).toMatchObject({ ok: false, code: 'AUTH_REQUIRED' });
      });

      it('refuses the connection for an invalid token', async () => {
         const client = connectClient('not.a.jwt');
         const err = await waitFor(client, 'connect_error');
         expect(err.message).toBe('AUTH_TOKEN_INVALID');
         expect(client.connected).toBe(false);
      });

      it('refuses the connection for a token signed with another secret', async () => {
         const forged = jwt.sign(
            { userId: 'owner-user-id', walletAddress: KNOWN_USERS['owner-user-id'] },
            'attacker-controlled-secret-value',
         );
         const client = connectClient(forged);
         const err = await waitFor(client, 'connect_error');
         expect(err.message).toBe('AUTH_TOKEN_INVALID');
      });

      it('refuses the connection for an expired token', async () => {
         const expired = jwt.sign(
            {
               userId: 'owner-user-id',
               walletAddress: KNOWN_USERS['owner-user-id'],
               role: UserRole.USER,
            },
            process.env.JWT_SECRET!,
            { expiresIn: -60 },
         );
         const client = connectClient(expired);
         const err = await waitFor(client, 'connect_error');
         expect(err.message).toBe('AUTH_TOKEN_EXPIRED');
         expect(client.connected).toBe(false);
      });
   });

   describe('type edge cases', () => {
      it.each<[string, unknown]>([
         ['number', 42],
         ['numeric string', '42'],
         ['numeric room name', 'user:42'],
         ['numeric id object', { userId: 42 }],
      ])('matches a numeric id given as %s', async (_label, payload) => {
         const client = await connected(tokenFor('42'));
         const ack = await joinNotifications(client, payload);
         expect(ack).toEqual({ ok: true, room: 'notifications' });
         expect(serverRooms(client).has('user:42')).toBe(true);
      });

      it.each<[string, unknown]>([
         ['different number', 43],
         ['zero-padded string', '042'],
         ['float', 42.0001],
         ['empty string', ''],
         ['whitespace', '   '],
         ['empty room id', 'user:'],
         ['empty id object', { userId: '' }],
         ['nested prefix', 'user:user:42'],
         ['suffixed room name', 'user:42:admin'],
         ['other-case prefix', 'USER:42'],
         ['public room name', 'chat'],
         ['round room name', 'round:1'],
         ['array', ['user:42']],
         ['boolean', true],
      ])('rejects %s', async (_label, payload) => {
         const client = await connected(tokenFor('42'));
         const before = serverRooms(client);

         const ack = await joinNotifications(client, payload);

         expect(ack).toMatchObject({ ok: false, code: 'FORBIDDEN' });
         expect(serverRooms(client)).toEqual(before);
      });
   });

   describe('session resume', () => {
      it("does not rejoin another user's room from persisted session state", async () => {
         mockRecordConnect.mockResolvedValue({
            ...EMPTY_RESUME,
            resumed: true,
            rooms: ['round:abc', 'user:owner-user-id'],
         });

         const client = connectClient(tokenFor('attacker-user-id'));
         const resume = await waitFor(client, 'session:resume');

         expect(resume.rooms).toEqual(['round:abc']);
         const rooms = serverRooms(client);
         expect(rooms.has('round:abc')).toBe(true);
         expect(rooms.has('user:owner-user-id')).toBe(false);
         expect(rooms.has('user:attacker-user-id')).toBe(true);
      });
   });

   describe('public rooms are unchanged', () => {
      it('lets an unauthenticated socket join a round room and receive its events', async () => {
         const anon = await connected();

         const joined = waitFor(anon, 'room:joined');
         anon.emit('join:round', { roundId: 'abc' });
         expect(await joined).toEqual({ room: 'round:abc' });

         const update = waitFor(anon, 'round:started');
         io.to('round:abc').emit('round:started', { id: 'abc' } as any);
         expect(await update).toMatchObject({ id: 'abc' });
      });

      it('lets an authenticated socket join and leave the general round room', async () => {
         const client = await connected(tokenFor('owner-user-id'));

         const joined = waitFor(client, 'room:joined');
         client.emit('join:round');
         expect(await joined).toEqual({ room: 'round' });

         const left = waitFor(client, 'room:left');
         client.emit('leave:round');
         expect(await left).toEqual({ room: 'round' });
      });
   });
});

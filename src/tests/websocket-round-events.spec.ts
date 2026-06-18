/**
 * Unit tests for WebSocket #226 additions:
 *   - round_update event (round start, lock, resolve)
 *   - pool_update event (after prediction placed)
 *   - join:round:id / leave:round:id per-round room handlers
 *
 * Uses mocked Prisma, websocketService, and chat/session services so tests
 * run without DATABASE_URL or a live Redis instance.
 */
import {
   describe,
   it,
   expect,
   beforeAll,
   afterAll,
   beforeEach,
} from '@jest/globals';
import { createServer, Server as HttpServer } from 'http';
import { io as ioClient, Socket } from 'socket.io-client';
import { Server as SocketIOServer } from 'socket.io';
import { createApp } from '../index';
import { initializeSocket } from '../socket';
import { generateToken } from '../utils/jwt.util';
import { UserRole } from '@prisma/client';
import websocketService, { WebSocketEvents } from '../services/websocket.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = 'ws226-test-user-id';
const TEST_WALLET  = 'GWS226TESTUSER__________________________';
const FAKE_ROUND_ID = 'round-226-test-uuid';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUserFindUnique   = jest.fn();
const mockRoundFindUnique  = jest.fn();
const mockChatSendMessage  = jest.fn();

jest.mock('../lib/prisma', () => ({
   prisma: {
      user: {
         findUnique: (...args: any[]) => mockUserFindUnique(...args),
      },
      $disconnect: jest.fn().mockResolvedValue(undefined),
   },
}));

jest.mock('../services/chat.service', () => ({
   __esModule: true,
   default: {
      sendMessage: (...args: any[]) => mockChatSendMessage(...args),
      getHistory: jest.fn().mockResolvedValue([]),
   },
}));

jest.mock('../services/multiplayer-session.service', () => ({
   __esModule: true,
   default: {
      recordConnect:    jest.fn().mockResolvedValue({ rooms: [], metadata: {} }),
      recordDisconnect: jest.fn().mockResolvedValue(undefined),
      addRoom:          jest.fn().mockResolvedValue(undefined),
      removeRoom:       jest.fn().mockResolvedValue(undefined),
      patchMetadata:    jest.fn().mockResolvedValue(undefined),
   },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitFor(socket: Socket, event: string, timeoutMs = 3000): Promise<any> {
   return new Promise((resolve, reject) => {
      const t = setTimeout(
         () => reject(new Error(`Timeout waiting for "${event}"`)),
         timeoutMs
      );
      socket.once(event, (data: any) => {
         clearTimeout(t);
         resolve(data);
      });
   });
}

function waitForConnect(socket: Socket, timeoutMs = 3000): Promise<void> {
   return new Promise((resolve, reject) => {
      const t = setTimeout(
         () => reject(new Error('Timeout waiting for connect')),
         timeoutMs
      );
      if (socket.connected) { clearTimeout(t); return resolve(); }
      socket.once('connect', () => { clearTimeout(t); resolve(); });
      socket.once('connect_error', err => { clearTimeout(t); reject(err); });
   });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WebSocket #226 — round_update, pool_update, per-round rooms', () => {
   let httpServer: HttpServer;
   let io: SocketIOServer;
   let baseURL: string;
   let validToken: string;

   beforeAll(async () => {
      validToken = generateToken(TEST_USER_ID, TEST_WALLET, UserRole.USER);

      mockUserFindUnique.mockResolvedValue({
         id: TEST_USER_ID,
         walletAddress: TEST_WALLET,
         role: UserRole.USER,
      });

      const app = createApp();
      httpServer = createServer(app);
      io = await initializeSocket(httpServer);

      await new Promise<void>(resolve => {
         httpServer.listen(0, () => {
            const addr = httpServer.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            baseURL = `http://127.0.0.1:${port}`;
            resolve();
         });
      });
   }, 15_000);

   afterAll(async () => {
      if (httpServer) {
         await new Promise<void>(resolve => {
            httpServer.closeAllConnections?.();
            httpServer.close(() => resolve());
         });
      }
      jest.clearAllMocks();
   }, 15_000);

   // -------------------------------------------------------------------------
   // WebSocketEvents registry
   // -------------------------------------------------------------------------

   describe('WebSocketEvents catalog', () => {
      it('should include round_update event name', () => {
         expect(WebSocketEvents.RoundUpdate).toBe('round_update');
      });

      it('should include pool_update event name', () => {
         expect(WebSocketEvents.PoolUpdate).toBe('pool_update');
      });

      it('should preserve backward-compat event names', () => {
         expect(WebSocketEvents.RoundStarted).toBe('round:started');
         expect(WebSocketEvents.RoundResolved).toBe('round:resolved');
         expect(WebSocketEvents.PredictionPlaced).toBe('prediction:placed');
         expect(WebSocketEvents.PriceUpdate).toBe('price:update');
      });
   });

   // -------------------------------------------------------------------------
   // emitRoundUpdate
   // -------------------------------------------------------------------------

   describe('emitRoundUpdate()', () => {
      it('broadcasts round_update to the generic round room', done => {
         const client = ioClient(baseURL, {
            transports: ['websocket'],
            autoConnect: false,
         });

         client.connect();
         waitForConnect(client).then(() => {
            client.emit('join:round');

            client.once('room:joined', () => {
               // Listen before emitting so we don't miss it
               client.once(WebSocketEvents.RoundUpdate, (payload: any) => {
                  expect(payload.id).toBe(FAKE_ROUND_ID);
                  expect(payload.status).toBe('ACTIVE');
                  expect(payload.mode).toBe('UP_DOWN');
                  expect(payload.poolUp).toBe(0);
                  expect(payload.poolDown).toBe(0);
                  client.disconnect();
                  done();
               });

               websocketService.emitRoundUpdate({
                  id: FAKE_ROUND_ID,
                  mode: 'UP_DOWN',
                  status: 'ACTIVE',
                  startTime: new Date(),
                  endTime: new Date(),
                  startPrice: 0.12,
                  endPrice: null,
                  resolvedAt: null,
                  poolUp: 0,
                  poolDown: 0,
                  priceRanges: null,
                  updatedAt: new Date(),
               });
            });
         });
      });

      it('broadcasts round_update to the per-round room', done => {
         const client = ioClient(baseURL, {
            transports: ['websocket'],
            autoConnect: false,
         });

         client.connect();
         waitForConnect(client).then(() => {
            client.emit('join:round:id', { roundId: FAKE_ROUND_ID });

            client.once('room:joined', ({ room }: any) => {
               expect(room).toBe(`round:${FAKE_ROUND_ID}`);

               client.once(WebSocketEvents.RoundUpdate, (payload: any) => {
                  expect(payload.id).toBe(FAKE_ROUND_ID);
                  expect(payload.status).toBe('LOCKED');
                  client.disconnect();
                  done();
               });

               websocketService.emitRoundUpdate({
                  id: FAKE_ROUND_ID,
                  mode: 'UP_DOWN',
                  status: 'LOCKED',
                  startTime: new Date(),
                  endTime: new Date(),
                  startPrice: 0.12,
                  endPrice: null,
                  resolvedAt: null,
                  poolUp: 10,
                  poolDown: 5,
                  priceRanges: null,
                  updatedAt: new Date(),
               });
            });
         });
      });

      it('includes endPrice and resolvedAt when round is RESOLVED', done => {
         const client = ioClient(baseURL, {
            transports: ['websocket'],
            autoConnect: false,
         });

         const resolvedAt = new Date().toISOString();

         client.connect();
         waitForConnect(client).then(() => {
            client.emit('join:round');

            client.once('room:joined', () => {
               client.once(WebSocketEvents.RoundUpdate, (payload: any) => {
                  expect(payload.status).toBe('RESOLVED');
                  expect(payload.endPrice).toBe(0.135);
                  expect(payload.resolvedAt).toBeTruthy();
                  client.disconnect();
                  done();
               });

               websocketService.emitRoundUpdate({
                  id: FAKE_ROUND_ID,
                  mode: 'UP_DOWN',
                  status: 'RESOLVED',
                  startTime: new Date(),
                  endTime: new Date(),
                  startPrice: 0.12,
                  endPrice: 0.135,
                  resolvedAt: new Date(resolvedAt),
                  poolUp: 50,
                  poolDown: 30,
                  priceRanges: null,
                  updatedAt: new Date(),
               });
            });
         });
      });
   });

   // -------------------------------------------------------------------------
   // emitPoolUpdate
   // -------------------------------------------------------------------------

   describe('emitPoolUpdate()', () => {
      it('broadcasts pool_update to the generic round room', done => {
         const client = ioClient(baseURL, {
            transports: ['websocket'],
            autoConnect: false,
         });

         client.connect();
         waitForConnect(client).then(() => {
            client.emit('join:round');

            client.once('room:joined', () => {
               client.once(WebSocketEvents.PoolUpdate, (payload: any) => {
                  expect(payload.roundId).toBe(FAKE_ROUND_ID);
                  expect(payload.mode).toBe('UP_DOWN');
                  expect(payload.poolUp).toBe(100);
                  expect(payload.poolDown).toBe(50);
                  expect(payload.timestamp).toBeTruthy();
                  client.disconnect();
                  done();
               });

               websocketService.emitPoolUpdate(FAKE_ROUND_ID, {
                  mode: 'UP_DOWN',
                  poolUp: 100,
                  poolDown: 50,
                  priceRanges: null,
               });
            });
         });
      });

      it('broadcasts pool_update with priceRanges for LEGENDS mode', done => {
         const client = ioClient(baseURL, {
            transports: ['websocket'],
            autoConnect: false,
         });

         const ranges = [
            { min: 0.10, max: 0.11, pool: 25 },
            { min: 0.11, max: 0.12, pool: 75 },
         ];

         client.connect();
         waitForConnect(client).then(() => {
            client.emit('join:round:id', { roundId: FAKE_ROUND_ID });

            client.once('room:joined', () => {
               client.once(WebSocketEvents.PoolUpdate, (payload: any) => {
                  expect(payload.mode).toBe('LEGENDS');
                  expect(payload.priceRanges).toHaveLength(2);
                  expect(payload.priceRanges[0].pool).toBe(25);
                  client.disconnect();
                  done();
               });

               websocketService.emitPoolUpdate(FAKE_ROUND_ID, {
                  mode: 'LEGENDS',
                  poolUp: null,
                  poolDown: null,
                  priceRanges: ranges,
               });
            });
         });
      });
   });

   // -------------------------------------------------------------------------
   // Per-round room handlers
   // -------------------------------------------------------------------------

   describe('join:round:id / leave:round:id', () => {
      it('joins the correct per-round room and receives room:joined ack', async () => {
         const client = ioClient(baseURL, {
            transports: ['websocket'],
            autoConnect: false,
         });
         client.connect();
         await waitForConnect(client);

         const joinedPromise = waitFor(client, 'room:joined');
         client.emit('join:round:id', { roundId: FAKE_ROUND_ID });
         const joined = await joinedPromise;

         expect(joined.room).toBe(`round:${FAKE_ROUND_ID}`);
         expect(joined.roundId).toBe(FAKE_ROUND_ID);
         client.disconnect();
      });

      it('emits error when roundId is missing', async () => {
         const client = ioClient(baseURL, {
            transports: ['websocket'],
            autoConnect: false,
         });
         client.connect();
         await waitForConnect(client);

         const errorPromise = waitFor(client, 'error');
         client.emit('join:round:id', {});
         const err = await errorPromise;

         expect(err.message).toMatch(/roundId/i);
         client.disconnect();
      });

      it('leaves the per-round room and receives room:left ack', async () => {
         const client = ioClient(baseURL, {
            transports: ['websocket'],
            autoConnect: false,
         });
         client.connect();
         await waitForConnect(client);

         // First join
         const joinedP = waitFor(client, 'room:joined');
         client.emit('join:round:id', { roundId: FAKE_ROUND_ID });
         await joinedP;

         // Now leave
         const leftP = waitFor(client, 'room:left');
         client.emit('leave:round:id', { roundId: FAKE_ROUND_ID });
         const left = await leftP;

         expect(left.room).toBe(`round:${FAKE_ROUND_ID}`);
         expect(left.roundId).toBe(FAKE_ROUND_ID);
         client.disconnect();
      });

      it('unauthenticated client can join per-round room', async () => {
         const client = ioClient(baseURL, {
            transports: ['websocket'],
            autoConnect: false,
            // No auth token
         });
         client.connect();
         await waitForConnect(client);

         const joinedP = waitFor(client, 'room:joined');
         client.emit('join:round:id', { roundId: FAKE_ROUND_ID });
         const joined = await joinedP;

         expect(joined.room).toBe(`round:${FAKE_ROUND_ID}`);
         client.disconnect();
      });

      it('unauthenticated client receives round_update on per-round room', done => {
         const client = ioClient(baseURL, {
            transports: ['websocket'],
            autoConnect: false,
         });

         client.connect();
         waitForConnect(client).then(() => {
            client.emit('join:round:id', { roundId: FAKE_ROUND_ID });

            client.once('room:joined', () => {
               client.once(WebSocketEvents.RoundUpdate, (payload: any) => {
                  expect(payload.id).toBe(FAKE_ROUND_ID);
                  client.disconnect();
                  done();
               });

               websocketService.emitRoundUpdate({
                  id: FAKE_ROUND_ID,
                  mode: 'UP_DOWN',
                  status: 'ACTIVE',
                  startTime: new Date(),
                  endTime: new Date(),
                  startPrice: 0.12,
                  endPrice: null,
                  resolvedAt: null,
                  poolUp: 0,
                  poolDown: 0,
                  priceRanges: null,
                  updatedAt: new Date(),
               });
            });
         });
      });
   });

   // -------------------------------------------------------------------------
   // price:update (existing, verify still works with room)
   // -------------------------------------------------------------------------

   describe('price:update', () => {
      it('unauthenticated client receives price:update after join:round', done => {
         const client = ioClient(baseURL, {
            transports: ['websocket'],
            autoConnect: false,
         });

         client.connect();
         waitForConnect(client).then(() => {
            client.emit('join:round');

            client.once('room:joined', () => {
               client.once(WebSocketEvents.PriceUpdate, (payload: any) => {
                  expect(payload.asset).toBe('XLM');
                  expect(typeof payload.price).toBe('string');
                  client.disconnect();
                  done();
               });

               websocketService.emitPriceUpdate('XLM', '0.12345678');
            });
         });
      });
   });
});

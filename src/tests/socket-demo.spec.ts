/**
 * Issue #427 — Prisma-less hackathon socket demo mode.
 */
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { createServer, Server as HttpServer } from 'http';
import { io as ioClient, Socket } from 'socket.io-client';
import { Server as SocketIOServer } from 'socket.io';

const mockUserFindUnique = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => mockUserFindUnique(...args) },
    round: { findMany: jest.fn() },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../config', () => ({
  __esModule: true,
  default: {
    app: {
      socketDemoMode: true,
      enableMultiplayerSocial: true,
    },
  },
}));

jest.mock('../services/multiplayer-session.service', () => ({
  __esModule: true,
  default: {
    recordConnect: jest.fn(),
    recordDisconnect: jest.fn(),
    addRoom: jest.fn(),
    removeRoom: jest.fn(),
    patchMetadata: jest.fn(),
  },
}));

import { initializeSocket } from '../socket';
import { generateToken } from '../utils/jwt.util';
import { UserRole } from '@prisma/client';
import websocketService from '../services/websocket.service';

function waitForConnect(socket: Socket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error('Timeout waiting for connect')),
      timeoutMs,
    );
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

function waitFor(socket: Socket, event: string, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Timeout waiting for ${event}`)),
      timeoutMs,
    );
    socket.once(event, (data: unknown) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

describe('Socket demo mode (#427)', () => {
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let client: Socket;
  let port: number;

  beforeAll(async () => {
    httpServer = createServer();
    io = await initializeSocket(httpServer);
    await new Promise<void>(resolve => {
      httpServer.listen(0, () => {
        port = (httpServer.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    client?.disconnect();
    io?.close();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
  });

  it('authenticates via JWT without Prisma user lookup', async () => {
    const token = generateToken('demo-user-id', 'G_DEMO_WALLET___________________________', UserRole.USER);
    client = ioClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      auth: { token },
    });
    // Attach the hello listener BEFORE connecting so the event emitted on
    // connection is never missed (events are dropped if no listener is ready).
    const helloPromise = waitFor(client, 'server:hello');
    await waitForConnect(client);
    const hello = await helloPromise;
    expect(hello).toMatchObject({ authenticated: true, userId: 'demo-user-id' });
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it('delivers price updates on round rooms without Prisma', async () => {
    const joinedPromise = waitFor(client, 'room:joined');
    client.emit('join:round', { roundId: 'btc-updown-live' });
    await joinedPromise;

    const pricePromise = waitFor(client, 'price_update');
    await websocketService.emitPriceUpdate('BTC', 70000);
    const payload = await pricePromise;
    expect(payload).toMatchObject({ asset: 'BTC', price: 70000 });
  });
});

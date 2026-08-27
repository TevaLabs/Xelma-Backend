import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Application } from 'express';

jest.mock('@prisma/client', () => ({
  UserRole: { USER: 'USER', ADMIN: 'ADMIN', ORACLE: 'ORACLE' },
  Prisma: {},
}));

jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (address: string) =>
    !!address && address.startsWith('G') && address.length === 56,
  verifySignature: jest.fn().mockResolvedValue(true),
}));

jest.mock('../services/soroban.service', () => ({
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getHealth: jest.fn(),
}));

jest.mock('../services/oracle', () => ({
  __esModule: true,
  default: {
    getPriceString: jest.fn(() => '0.1'),
    getLastUpdatedAt: jest.fn(() => new Date()),
    isStale: jest.fn(() => false),
    getLastProvider: jest.fn(() => 'mock'),
    getActiveSource: jest.fn(() => 'mock'),
  },
}));

jest.mock('../services/priceService', () => ({
  getPrices: jest.fn(async () => ({ btc: 1, eth: 2, xlm: 0.1, stale: false })),
}));

jest.mock('../routes/bets.routes', () => {
  const { Router } = require('express');
  const router = Router();
  router.post('/up-down', (_req: unknown, res: { json: (b: unknown) => void }) =>
    res.json({ ok: true }),
  );
  router.post('/precision', (_req: unknown, res: { json: (b: unknown) => void }) =>
    res.json({ ok: true }),
  );
  return { __esModule: true, default: router };
});

jest.mock('../middleware/rateLimiter.middleware', () => ({
  // The app factory mounts the global /api limiters in hackathon mode; the
  // mock must provide them or createApp throws (pre-existing breakage fixed
  // alongside #519).
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  writeRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  challengeRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  connectRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  authRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  chatMessageRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  predictionRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  adminRoundRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  oracleResolveRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  betRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  batchPredictionRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  batchLeaderboardRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockAuthChallengeCreate = jest.fn();
const mockAuthChallengeFindMany = jest.fn();
const mockAuthChallengeFindUnique = jest.fn();
const mockAuthChallengeUpdateMany = jest.fn();
const mockAuthChallengeDeleteMany = jest.fn();
const mockUserFindUnique = jest.fn();
const mockUserCreate = jest.fn();
const mockUserUpdate = jest.fn();
const mockTransactionCreate = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
      create: (...args: unknown[]) => mockUserCreate(...args),
      update: (...args: unknown[]) => mockUserUpdate(...args),
    },
    authChallenge: {
      findMany: (...args: unknown[]) => mockAuthChallengeFindMany(...args),
      findUnique: (...args: unknown[]) => mockAuthChallengeFindUnique(...args),
      create: (...args: unknown[]) => mockAuthChallengeCreate(...args),
      updateMany: (...args: unknown[]) => mockAuthChallengeUpdateMany(...args),
      deleteMany: (...args: unknown[]) => mockAuthChallengeDeleteMany(...args),
    },
    transaction: {
      create: (...args: unknown[]) => mockTransactionCreate(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

import { createApp } from '../app';
import { extractRoutes, routeKey } from '../security/route-parity.registry';

const VALID_WALLET = 'GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX';

async function postJson(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/**
 * Smoke coverage for issue #400: wallet auth challenge/connect must be
 * reachable on the hackathon entrypoint so clients can obtain JWTs without
 * switching servers.
 */
describe('Hackathon wallet auth mount (issue #400)', () => {
  let app: Application;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthChallengeFindMany.mockResolvedValue([]);
    mockAuthChallengeDeleteMany.mockResolvedValue({ count: 0 });
    mockAuthChallengeCreate.mockResolvedValue({});
    mockAuthChallengeUpdateMany.mockResolvedValue({ count: 1 });
    mockAuthChallengeFindUnique.mockResolvedValue(null);
    mockUserFindUnique.mockResolvedValue({
      id: 'smoke-user',
      walletAddress: VALID_WALLET,
      createdAt: new Date(),
      lastLoginAt: new Date(),
      streak: 1,
      virtualBalance: 1000,
      role: 'USER',
    });
    mockUserUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'smoke-user',
      walletAddress: VALID_WALLET,
      createdAt: new Date(),
      lastLoginAt: (data.lastLoginAt as Date) || new Date(),
      streak: (data.streak as number) || 1,
      virtualBalance: 1000,
      role: 'USER',
    }));
    mockTransactionCreate.mockResolvedValue({});
  });

  it('registers challenge/connect/verify on the hackathon route inventory', () => {
    const keys = extractRoutes(app).map(routeKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        'POST /api/auth/challenge',
        'POST /api/auth/connect',
        'POST /api/auth/verify',
      ]),
    );
  });

  it('exposes POST /api/auth/challenge (not 404)', async () => {
    const res = await postJson(baseUrl, '/api/auth/challenge', {
      walletAddress: VALID_WALLET,
    });

    expect(res.status).toBe(200);
    expect(res.body.challenge).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();
  });

  it('exposes POST /api/auth/connect and returns a JWT', async () => {
    const res = await postJson(baseUrl, '/api/auth/connect', {
      walletAddress: VALID_WALLET,
      challenge: 'smoke-challenge',
      signature: 'smoke-signature',
    });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(10);
    expect(res.body.user?.walletAddress).toBe(VALID_WALLET);
  });

  it('returns validation error instead of 404 for empty challenge body', async () => {
    const res = await postJson(baseUrl, '/api/auth/challenge', {});
    expect(res.status).not.toBe(404);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

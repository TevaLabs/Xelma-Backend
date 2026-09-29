/**
 * Issue #664 — auth challenge lifecycle under memory/mock mode.
 *
 * `src/lib/prisma.ts` ships a dependency-free fallback mock for unit tests
 * (NODE_ENV=test, TEST_TYPE=unit, no DATA_STORE=memory). It previously had no
 * `authChallenge` model, so any auth-flow exercise crashed instead of
 * enforcing the one-time/TTL/atomic-consume semantics the real Prisma client
 * (and the `memory-prisma` store used by the hackathon demo) provide.
 *
 * These tests drive the real `connectHandler` over HTTP against that fallback
 * stub and assert:
 *   1. First use of a challenge succeeds (200 + JWT).
 *   2. Replay of a consumed challenge is rejected with 401.
 *   3. An expired challenge is rejected with 401.
 *   4. Parallel replays of the same challenge yield exactly one 200.
 *
 * Full Prisma mode is untouched: this stub is only reachable in the unit-mock
 * path, and the integration coverage in `auth-race.spec.ts` still exercises
 * the real database.
 */
process.env.NODE_ENV = 'test';
process.env.TEST_TYPE = 'unit';
process.env.DATA_STORE = 'postgres';
process.env.DATA_MODE = 'live';
delete process.env.REDIS_URL;

import { describe, it, expect, beforeAll, afterAll, jest, beforeEach } from '@jest/globals';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';

const mockVerifySignature = jest.fn();

jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (address: string) =>
    Boolean(address) && address.startsWith('G') && address.length === 56,
  verifySignature: (address: string, challenge: string, signature: string) =>
    mockVerifySignature(address, challenge, signature),
}));

jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    placeBet: jest.fn(),
    placePrecisionBet: jest.fn(),
    claimWinnings: jest.fn(),
    getTransactionStatus: jest.fn(),
    getUserPosition: jest.fn(),
  },
}));

jest.mock('../middleware/rateLimiter.middleware', () => {
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    challengeRateLimiter: passthrough,
    connectRateLimiter: passthrough,
    authRateLimiter: passthrough,
    apiRateLimiter: passthrough,
    writeRateLimiter: passthrough,
    betRateLimiter: passthrough,
    adminRoundRateLimiter: passthrough,
    oracleResolveRateLimiter: passthrough,
    chatMessageRateLimiter: passthrough,
    predictionRateLimiter: passthrough,
    batchPredictionRateLimiter: passthrough,
    batchLeaderboardRateLimiter: passthrough,
  };
});

describe('Auth challenge lifecycle on the fallback prisma mock (Issue #664)', () => {
  let app: import('express').Application;
  let prisma: typeof import('../lib/prisma').prisma;
  let challengeStub: Record<string, any>;

  const WALLET = Keypair.random().publicKey();

  beforeAll(async () => {
    const { createApp } = await import('../app');
    app = createApp({ features: { globalApiRateLimit: false } } as any);

    ({ prisma } = await import('../lib/prisma'));
    challengeStub = (prisma as any).authChallenge;
  });

  beforeEach(() => {
    mockVerifySignature.mockReset();
    mockVerifySignature.mockReturnValue(true);
    challengeStub._clear();
  });

  afterAll(async () => {
    await challengeStub._clear();
  });

  it('exposes the authChallenge stub on the fallback mock', () => {
    expect(challengeStub).toBeDefined();
    expect(typeof challengeStub.create).toBe('function');
    expect(typeof challengeStub.updateMany).toBe('function');
    expect(typeof challengeStub.deleteMany).toBe('function');
  });

  it('authenticates on first use and mints a JWT', async () => {
    const challengeRes = await request(app)
      .post('/api/auth/challenge')
      .send({ walletAddress: WALLET });

    expect(challengeRes.status).toBe(200);
    const challenge = challengeRes.body.challenge;
    expect(challenge).toBeDefined();

    const connectRes = await request(app)
      .post('/api/auth/connect')
      .send({ walletAddress: WALLET, challenge, signature: 'sig-1' });

    expect(connectRes.status).toBe(200);
    expect(connectRes.body.token).toBeDefined();
  });

  it('rejects replay of a consumed challenge with 401', async () => {
    const challengeRes = await request(app)
      .post('/api/auth/challenge')
      .send({ walletAddress: WALLET });
    const challenge = challengeRes.body.challenge;

    const first = await request(app)
      .post('/api/auth/connect')
      .send({ walletAddress: WALLET, challenge, signature: 'sig-1' });
    expect(first.status).toBe(200);

    const replay = await request(app)
      .post('/api/auth/connect')
      .send({ walletAddress: WALLET, challenge, signature: 'sig-2' });

    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatch(/Authentication/i);
  });

  it('rejects an expired challenge with 401', async () => {
    await challengeStub.create({
      data: {
        challenge: 'expired-challenge-string',
        walletAddress: WALLET,
        expiresAt: new Date(Date.now() - 60_000),
        isUsed: false,
      },
    });

    const res = await request(app)
      .post('/api/auth/connect')
      .send({
        walletAddress: WALLET,
        challenge: 'expired-challenge-string',
        signature: 'sig-expired',
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Authentication/i);
  });

  it('rejects a challenge whose wallet does not match', async () => {
    await challengeStub.create({
      data: {
        challenge: 'wallet-mismatch-string',
        walletAddress: WALLET,
        expiresAt: new Date(Date.now() + 60_000),
        isUsed: false,
      },
    });

    const res = await request(app)
      .post('/api/auth/connect')
      .send({
        walletAddress: 'GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX',
        challenge: 'wallet-mismatch-string',
        signature: 'sig-other',
      });

    expect(res.status).toBe(401);
  });

  it('lets exactly one of several parallel replays win (atomic consume)', async () => {
    const challengeRes = await request(app)
      .post('/api/auth/challenge')
      .send({ walletAddress: WALLET });
    const challenge = challengeRes.body.challenge;

    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request(app)
          .post('/api/auth/connect')
          .send({ walletAddress: WALLET, challenge, signature: `sig-parallel-${i}` }),
      ),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length).toBe(1);
    expect(statuses.filter((s) => s === 401).length).toBe(5);
  });

  it('cleans up consumed challenges older than 24h via deleteMany', async () => {
    await challengeStub.create({
      data: {
        challenge: 'old-consumed',
        walletAddress: WALLET,
        expiresAt: new Date(Date.now() + 60_000),
        isUsed: false,
      },
    });
    // Consume it.
    await challengeStub.updateMany({
      where: { challenge: 'old-consumed', walletAddress: WALLET, isUsed: false },
      data: { isUsed: true },
    });

    // The route's housekeeping deletes consumed challenges older than 24h;
    // this one is fresh, so a route-shaped deleteMany must not remove it.
    const before = await challengeStub.findUnique({ where: { challenge: 'old-consumed' } });
    expect(before).not.toBeNull();

    const result = await challengeStub.deleteMany({
      where: {
        walletAddress: WALLET,
        isUsed: true,
        usedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    expect(result.count).toBe(0);
    expect(await challengeStub.findUnique({ where: { challenge: 'old-consumed' } })).not.toBeNull();

    // Backdate usedAt through updateMany (Prisma returns copies, so the
    // snapshot mutation above never touches the stored row), then confirm
    // the deleteMany removes it.
    await challengeStub.updateMany({
      where: { challenge: 'old-consumed', walletAddress: WALLET, isUsed: true },
      data: { usedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    const purged = await challengeStub.deleteMany({
      where: {
        walletAddress: WALLET,
        isUsed: true,
        usedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    expect(purged.count).toBe(1);
    expect(await challengeStub.findUnique({ where: { challenge: 'old-consumed' } })).toBeNull();
  });
});

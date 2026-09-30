import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import request from 'supertest';
import { UserRole } from '@prisma/client';

// The hackathon bet endpoints resolve their on-chain path through
// `bet.service.isStubMode()`, read at call time. CI runs without a Soroban
// RPC and with no contract configured, so bets must stay in stub mode —
// exactly like the hackathon demo deployment this spec mirrors.
process.env.BET_STUB_MODE = 'true';
process.env.SOROBAN_FAIL_CLOSED = 'false';

// `generateToken`/`prisma` are imported lazily via `require` so this module's
// env mutations above land before any config module is evaluated.
const { generateToken } = require('../utils/jwt.util') as typeof import('../utils/jwt.util');
const { prisma } = require('../lib/prisma') as typeof import('../lib/prisma');

// Mock Stellar and Soroban services to prevent loading @stellar/stellar-sdk (which contains ESM files that Jest fails to parse).
// The default export must carry every method the hackathon call surface uses
// (bets, user stats, round fallback, health); a missing method surfaces as
// `x is not a function` 500s rather than a clean stub response.
jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (address: string) => address && address.startsWith('G') && address.length === 56,
  verifySignature: jest.fn(),
}));

jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: {
    isReady: jest.fn(() => true),
    getUserStats: jest.fn(async () => null),
    getPendingWinnings: jest.fn(async () => BigInt(0)),
    getBalance: jest.fn(async () => 0),
    getHealth: jest.fn(async () => ({ initialized: false })),
    getActiveRound: jest.fn(async () => null),
    placeBet: jest.fn(async () => ({ state: 'on-chain-success', txHash: 'stub-tx-hash' })),
    placePrecisionBet: jest.fn(async () => ({ state: 'on-chain-success', txHash: 'stub-tx-hash' })),
    claimWinnings: jest.fn(async () => ({ txHash: 'stub-tx-hash' })),
    applyMoneyPathFailure: jest.fn(),
  },
}));

import { createApp } from '../app';

const app = createApp();

describe('Hackathon HTTP Endpoints (Integration)', () => {
  // Valid Stellar-format (G + 55 chars) used as authenticated betting wallet
  // for the hackathon bet smoke tests below.
  const hackerWallet = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const hackerToken = generateToken('hackathon-http-user', hackerWallet, UserRole.USER);

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: 'hackathon-http-user', walletAddress: hackerWallet },
    });

    // The bet endpoints resolve their target round through `prisma.round`
    // (`bet.service.resolveRoundId`) — the mockRound fixtures behind
    // GET /api/rounds are a separate store. Seed ACTIVE rounds under the same
    // ids the fixtures use so the bets below have a real, mode-matching target.
    await prisma.round.deleteMany({
      where: { id: { in: ['btc-updown-live', 'eth-precision-live'] } },
    });
    await prisma.round.createMany({
      data: [
        {
          id: 'btc-updown-live',
          mode: 'UP_DOWN',
          status: 'ACTIVE',
          startPrice: 67420,
          startTime: new Date(Date.now() - 60_000),
          endTime: new Date(Date.now() + 180_000),
        },
        {
          id: 'eth-precision-live',
          mode: 'LEGENDS',
          status: 'ACTIVE',
          startPrice: 3241,
          startTime: new Date(Date.now() - 60_000),
          endTime: new Date(Date.now() + 600_000),
        },
      ],
    });
  });

  afterAll(async () => {
    // Bet and prediction rows reference the seeded user and rounds, and the
    // mock bet/leaderboard rows reference the seeded wallet address — clear
    // them so a re-run (or a sibling spec) never trips unique/FK constraints.
    await prisma.bet.deleteMany({ where: { userId: 'hackathon-http-user' } }).catch(() => undefined);
    await prisma.prediction.deleteMany({ where: { userId: 'hackathon-http-user' } }).catch(() => undefined);
    await prisma.mockBet.deleteMany({ where: { address: hackerWallet } }).catch(() => undefined);
    await prisma.mockLeaderboard.deleteMany({ where: { address: hackerWallet } }).catch(() => undefined);
    await prisma.round.deleteMany({
      where: { id: { in: ['btc-updown-live', 'eth-precision-live'] } },
    });
    await prisma.user.deleteMany({ where: { walletAddress: hackerWallet } });
  });

  describe('GET /api/health', () => {
    it('returns ok status and timestamp when soroban is initialized', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('no-store');
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          status: 'ok',
          timestamp: expect.any(Number),
        })
      );
    });

    it('returns services block with price and soroban entries', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.data.services).toEqual(
        expect.objectContaining({
          price: expect.objectContaining({
            status: 'ok',
            source: expect.any(String),
            mockMode: expect.any(Boolean),
          }),
          soroban: expect.objectContaining({
            status: expect.any(String),
            initialized: expect.any(Boolean),
          }),
        })
      );
    });

    it('returns degraded status when soroban is not initialized', async () => {
      const sorobanMock = require('../services/soroban.service') as {
        default: { isReady: { mockReturnValueOnce: (v: boolean) => void } };
      };
      sorobanMock.default.isReady.mockReturnValueOnce(false);

      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          status: 'degraded',
          timestamp: expect.any(Number),
        })
      );
      expect(res.body.data.services.soroban.status).toBe('unavailable');
      expect(res.body.data.services.soroban.initialized).toBe(false);
    });
  });

  describe('X-Request-ID propagation', () => {
    it('generates and returns an X-Request-ID header when none is provided', async () => {
      const res = await request(app).get('/api/health');
      expect(res.header['x-request-id']).toBeDefined();
      expect(typeof res.header['x-request-id']).toBe('string');
      expect(res.header['x-request-id'].length).toBeGreaterThan(0);
    });

    it('echoes back a client-supplied X-Request-ID header', async () => {
      const customId = 'hackathon-trace-12345';
      const res = await request(app)
        .get('/api/health')
        .set('X-Request-ID', customId);

      expect(res.header['x-request-id']).toBe(customId);
    });

    it('assigns a unique X-Request-ID per request when none is provided', async () => {
      const [res1, res2] = await Promise.all([
        request(app).get('/api/health'),
        request(app).get('/api/health'),
      ]);

      expect(res1.header['x-request-id']).not.toBe(res2.header['x-request-id']);
    });
  });

  describe('GET /api/stats', () => {
    it('returns platform stats schema', async () => {
      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            totalRounds: expect.any(Number),
            totalUsers: expect.any(Number),
            totalBets: expect.any(Number),
          }),
        })
      );
    });
  });

  describe('GET /api/prices', () => {
    it('returns live or cached prices schema', async () => {
      const res = await request(app).get('/api/prices');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            BTC: expect.any(Number),
            ETH: expect.any(Number),
            XLM: expect.any(Number),
          }),
        })
      );
    });
  });

  describe('GET /api/leaderboard', () => {
    it('returns rankings schema', async () => {
      const res = await request(app).get('/api/leaderboard');
      expect(res.status).toBe(200);
      const leaderboard = res.body.data?.leaderboard;
      expect(Array.isArray(leaderboard)).toBe(true);
      if (leaderboard.length > 0) {
        expect(leaderboard[0]).toEqual(
          expect.objectContaining({
            rank: expect.any(Number),
            address: expect.any(String),
            totalWins: expect.any(Number),
            totalLosses: expect.any(Number),
            winStreak: expect.any(Number),
            xp: expect.any(Number),
            rankTitle: expect.any(String),
          })
        );
      }
    });
  });

  describe('GET /api/rounds', () => {
    it('returns active rounds schema', async () => {
      const res = await request(app).get('/api/rounds');
      expect(res.status).toBe(200);
      // Depending on config, it either returns an array directly or an object { source, rounds }
      const rounds = Array.isArray(res.body)
        ? res.body
        : res.body.data?.rounds ?? res.body.rounds;
      expect(Array.isArray(rounds)).toBe(true);
      if (rounds.length > 0) {
        expect(rounds[0]).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            mode: expect.any(String),
            status: expect.any(String),
            // startPrice may be a decimal string (DB source) or a number
            // (mock fixture) depending on which round source served the list.
            startPrice: expect.anything(),
          })
        );
      }
    });
  });

  describe('POST /api/rounds/hackathon/up-down/:id/bet (auth required)', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .post('/api/rounds/hackathon/up-down/btc-updown-live/bet')
        .send({ address: hackerWallet, amount: 100, side: 'UP' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('No token provided');
    });

    it('records an up-down bet and matches success schema', async () => {
      const payload = {
        address: hackerWallet,
        amount: 100,
        side: 'UP',
      };
      const res = await request(app)
        .post('/api/rounds/hackathon/up-down/btc-updown-live/bet')
        .set('Authorization', `Bearer ${hackerToken}`)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            message: expect.any(String),
          }),
        })
      );
    });
  });

  describe('POST /api/rounds/hackathon/precision/:id/bet (auth required)', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .post('/api/rounds/hackathon/precision/eth-precision-live/bet')
        .send({ address: hackerWallet, amount: 50, predictedPrice: 65000.5 });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('No token provided');
    });

    it('records a precision bet and matches success schema', async () => {
      const payload = {
        address: hackerWallet,
        amount: 50,
        predictedPrice: 65000.5,
      };
      const res = await request(app)
        .post('/api/rounds/hackathon/precision/eth-precision-live/bet')
        .set('Authorization', `Bearer ${hackerToken}`)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            message: expect.any(String),
          }),
        })
      );
    });
  });

  describe('GET /api/user/:address/stats', () => {
    it('returns user stats schema for valid or mock address', async () => {
      // Must use a valid-looking G-address for the validation to pass
      const validStellarAddress = 'GB3G3Z4XZW6Z2QZV4V6Z2QZV4V6Z2QZV4V6Z2QZV4V6Z2QZV4V6Z2QZV';
      const res = await request(app).get(`/api/user/${validStellarAddress}/stats`);
      
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          stats: expect.objectContaining({
            totalWins: expect.any(Number),
            totalLosses: expect.any(Number),
            pendingWinnings: expect.any(String),
          }),
          profile: expect.objectContaining({
            balance: expect.any(String),
            xp: expect.any(Number),
            rankTitle: expect.any(String),
          }),
        })
      );
    });

    it('returns 400 for invalid address format', async () => {
      const res = await request(app).get('/api/user/invalid-address/stats');
      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          message: 'Invalid Stellar wallet address format',
        })
      );
    });
  });
});

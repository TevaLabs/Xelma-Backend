import { describe, it, expect, beforeAll } from '@jest/globals';
import request from 'supertest';
import { UserRole } from '@prisma/client';
import { generateToken } from '../utils/jwt.util';

// Mock Stellar and Soroban services to prevent loading @stellar/stellar-sdk (which contains ESM files that Jest fails to parse)
jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (address: string) => address && address.startsWith('G') && address.length === 56,
  verifySignature: jest.fn(),
}));

// ── Shared mock controller ────────────────────────────────────────────────────
// Each test suite can reconfigure these mocks via jest.mocked().mockXxx()
// to test the live Soroban path vs the DB-fallback path.
const mockGetUserStats = jest.fn();
const mockGetPendingWinnings = jest.fn();
const mockGetBalance = jest.fn();

jest.mock('../services/soroban.service', () => ({
  getUserStats: (...args: unknown[]) => mockGetUserStats(...args),
  getPendingWinnings: (...args: unknown[]) => mockGetPendingWinnings(...args),
  getBalance: (...args: unknown[]) => mockGetBalance(...args),
  getHealth: jest.fn(),
}));

import { createApp } from '../app';
import hackathonService from '../services/hackathon.service';
import { prisma } from '../lib/prisma';



describe('Hackathon Endpoints & Middleware', () => {
  const app = createApp();

  const validAddress = 'GBZXF5Z5S5JQLYQR3P6F4N6M4E2O3K2N4M4H4K4K4K4K4K4K4K4K4K4K'; // Valid Stellar format
  const token = generateToken('hackathon-integration-user', validAddress, UserRole.USER);

  beforeAll(async () => {
    // Ensure database is seeded for tests
    await hackathonService.getUserStats(validAddress);
  });

  beforeEach(() => {
    // Default mocks: Soroban unavailable → the endpoint falls back to DB.
    // Individual tests override these to test the live Soroban path.
    mockGetUserStats.mockResolvedValue(null);
    mockGetPendingWinnings.mockResolvedValue(BigInt(0));
    mockGetBalance.mockResolvedValue(0);
  });

  afterAll(async () => {
    // no-op: Prisma test-mode client needs no explicit teardown

  });

  describe('GET /api/rounds', () => {
    it('returns rounds in success envelope', async () => {
      const res = await request(app).get('/api/rounds');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('rounds');
    });
  });

  describe('GET /api/leaderboard', () => {
    it('returns exactly 10 users sorted by xp desc with correct ranks', async () => {
      const res = await request(app).get('/api/leaderboard');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(expect.objectContaining({
        totalUsers: 10,
        pagination: expect.objectContaining({ limit: 100, offset: 0, total: 10 }),
      }));
      expect(res.body.data.leaderboard).toHaveLength(10);

      // Verify the normalized contract preserves rank order and values.
      let previousEarnings = Infinity;
      res.body.data.leaderboard.forEach((entry: any, idx: number) => {
        expect(entry.rank).toBe(idx + 1);
        expect(Number(entry.totalEarnings)).toBeLessThanOrEqual(previousEarnings);
        previousEarnings = Number(entry.totalEarnings);
        expect(entry.userId).toBeDefined();
      });
    });
  });

  describe('GET /api/user/:address/stats', () => {
    it('returns fallback DB/mock stats when Soroban is unavailable', async () => {
      mockGetUserStats.mockResolvedValue(null);
      mockGetPendingWinnings.mockResolvedValue(BigInt(0));
      mockGetBalance.mockResolvedValue(0);

      const res = await request(app).get(`/api/user/${validAddress}/stats`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
        stats: {
          totalWins: 0,
          totalLosses: 0,
          bestStreak: 0,
          currentStreak: 0,
          pendingWinnings: "0.00000000",
          isRegistered: false,
        },
        profile: {
          balance: "0.00000000",
          xp: 0,
          rankTitle: "Rookie",
        },
      });
    });

    it('returns on-chain stats from Soroban when contract returns data', async () => {
      mockGetUserStats.mockResolvedValue({
        total_wins: 10,
        total_losses: 2,
        best_streak: 5,
        current_streak: 3,
      });
      mockGetPendingWinnings.mockResolvedValue(BigInt(50_000_000)); // 5 XLM in stroops
      mockGetBalance.mockResolvedValue(1250);

      const res = await request(app).get(`/api/user/${validAddress}/stats`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
        stats: {
          totalWins: 10,
          totalLosses: 2,
          bestStreak: 5,
          currentStreak: 3,
          pendingWinnings: "50000000.00000000",
          isRegistered: true,
        },
        profile: {
          balance: "1250.00000000",
          xp: 1250, // 10*100 + 5*50 = 1250
          rankTitle: "Bronze",
        },
      });
    });

    it('returns on-chain stats with Diamond rank for high XP', async () => {
      mockGetUserStats.mockResolvedValue({
        total_wins: 100,
        total_losses: 20,
        best_streak: 50,
        current_streak: 12,
      });
      mockGetPendingWinnings.mockResolvedValue(BigInt(0));
      mockGetBalance.mockResolvedValue(5000);

      const res = await request(app).get(`/api/user/${validAddress}/stats`);
      expect(res.status).toBe(200);
      expect(res.body.data.profile.xp).toBe(12500); // 100*100 + 50*50 = 12500
      expect(res.body.data.profile.rankTitle).toBe('Diamond'); // xp >= 10000
    });

    it('returns 400 for an invalid address format', async () => {
      const res = await request(app).get('/api/user/invalid-address/stats');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Invalid Stellar wallet address format',
      });
    });
  });

  describe('POST /api/rounds/hackathon/up-down/:id/bet (auth required)', () => {
    it('returns 401 without an auth token', async () => {
      const res = await request(app)
        .post('/api/rounds/hackathon/up-down/btc-updown-live/bet')
        .send({ address: validAddress, amount: 200, side: 'UP' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('No token provided');
    });

    it('persists the bet, updates user balance, and updates the round pool', async () => {
      // Get round initial pools
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: 'btc-updown-live' } }) as any;
      const initialPoolUp = roundBefore.poolUp;

      // Place bet
      const res = await request(app)
        .post('/api/rounds/hackathon/up-down/btc-updown-live/bet')
        .set('Authorization', `Bearer ${token}`)
        .send({
          address: validAddress,
          amount: 200,
          side: 'UP',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: { message: 'Bet recorded (stub)' },
      });

      // Verify DB update
      const roundAfter = await prisma.mockRound.findUnique({ where: { id: 'btc-updown-live' } }) as any;
      expect(roundAfter.poolUp).toBe(initialPoolUp + 200);
    });
  });

  describe('POST /api/rounds/hackathon/precision/:id/bet (auth required)', () => {
    it('returns 401 without an auth token', async () => {
      const res = await request(app)
        .post('/api/rounds/hackathon/precision/eth-precision-live/bet')
        .send({ address: validAddress, amount: 150, predictedPrice: 3250 });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('No token provided');
    });

    it('persists the bet and updates round totalPool and predictionCount', async () => {
      // Get round initial pools
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: 'eth-precision-live' } }) as any;
      const initialPool = roundBefore.totalPool;
      const initialCount = roundBefore.predictionCount;

      // Place bet
      const res = await request(app)
        .post('/api/rounds/hackathon/precision/eth-precision-live/bet')
        .set('Authorization', `Bearer ${token}`)
        .send({
          address: validAddress,
          amount: 150,
          predictedPrice: 3250,
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: { message: 'Precision bet recorded (stub)' },
      });

      // Verify DB update
      const roundAfter = await prisma.mockRound.findUnique({ where: { id: 'eth-precision-live' } }) as any;
      expect(roundAfter.totalPool).toBe(initialPool + 150);
      expect(roundAfter.predictionCount).toBe(initialCount + 1);
    });
  });

  describe('Centralized Error and 404 Handlers', () => {
    it('returns 404 JSON for invalid paths', async () => {
      const res = await request(app).get('/api/invalid-url-path');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: 'Not Found',
        path: '/api/invalid-url-path',
      });
    });
  });
});

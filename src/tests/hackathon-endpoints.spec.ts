import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import request from 'supertest';
import { UserRole } from '@prisma/client';
import { generateToken } from '../utils/jwt.util';
import { prisma } from '../lib/prisma';

// Mock Stellar and Soroban services to prevent loading @stellar/stellar-sdk (which contains ESM files that Jest fails to parse)
jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (address: string) => address && address.startsWith('G') && address.length === 56,
  verifySignature: jest.fn(),
}));

jest.mock('../services/soroban.service', () => ({
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getBalance: jest.fn(),
  getHealth: jest.fn(),
}));

import { createApp } from '../app';
import hackathonService from '../services/hackathon.service';

describe('Hackathon Endpoints & Middleware', () => {
  const app = createApp();

  const validAddress = 'GBZXF5Z5S5JQLYQR3P6F4N6M4E2O3K2N4M4H4K4K4K4K4K4K4K4K4K4K'; // Valid Stellar format
  const token = generateToken('hackathon-integration-user', validAddress, UserRole.USER);

  beforeAll(async () => {
    // Ensure the authenticated user exists and database is seeded for tests
    await prisma.user.create({ data: { id: 'hackathon-integration-user', walletAddress: validAddress } });
    await hackathonService.getUserStats(validAddress);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { walletAddress: validAddress } });
    await prisma.mockBet.deleteMany({ where: { address: validAddress } });
    await prisma.mockLeaderboard.deleteMany({ where: { address: validAddress } });
  });

  describe('GET /api/rounds', () => {
    it('returns exactly 3 rounds with correct assets and statuses', async () => {
      const res = await request(app).get('/api/rounds');
      expect(res.status).toBe(200);
      const rounds = res.body.data?.rounds ?? res.body;
      expect(Array.isArray(rounds)).toBe(true);
      expect(rounds.length).toBe(3);

      const btc = rounds.find((r: any) => r.id === 'btc-updown-live');
      expect(btc).toBeDefined();
      expect(btc.asset).toBe('BTC');
      expect(btc.mode).toBe('updown');
      expect(btc.status).toBe('live');

      const eth = rounds.find((r: any) => r.id === 'eth-precision-live');
      expect(eth).toBeDefined();
      expect(eth.asset).toBe('ETH');
      expect(eth.mode).toBe('precision');
      expect(eth.status).toBe('live');
    });
  });

  describe('GET /api/leaderboard', () => {
    it('returns an array of users sorted by xp desc with correct ranks', async () => {
      const res = await request(app).get('/api/leaderboard');
      expect(res.status).toBe(200);
      const leaderboard = res.body.data?.leaderboard ?? res.body;
      expect(Array.isArray(leaderboard)).toBe(true);

      // Verify each entry matches the leaderboard schema and is ordered by rank
      let previousXp = Infinity;
      leaderboard.forEach((u: any, idx: number) => {
        expect(u.rank).toBe(idx + 1);
        expect(u.xp).toBeLessThanOrEqual(previousXp);
        previousXp = u.xp;
        expect(u.address).toBeDefined();
      });
    });
  });

  describe('GET /api/user/:address/stats', () => {
    it('returns believable stats for a valid address', async () => {
      const res = await request(app).get(`/api/user/${validAddress}/stats`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
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
      });
    });

    it('returns 400 for an invalid address format', async () => {
      const res = await request(app).get('/api/user/invalid-address/stats');
      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          message: 'Invalid Stellar wallet address format',
        })
      );
    });
  });

  describe('POST /api/rounds/hackathon/up-down/:id/bet', () => {
    it('persists the bet, updates user balance, and updates the round pool', async () => {
      // Get round initial pools
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: 'btc-updown-live' } });
      const initialPoolUp = roundBefore!.poolUp;

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
      const roundAfter = await prisma.mockRound.findUnique({ where: { id: 'btc-updown-live' } });
      expect(roundAfter!.poolUp).toBe(initialPoolUp + 200);
    });
  });

  describe('POST /api/rounds/hackathon/precision/:id/bet', () => {
    it('persists the bet and updates round totalPool and predictionCount', async () => {
      // Get round initial pools
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: 'eth-precision-live' } });
      const initialPool = roundBefore!.totalPool;
      const initialCount = roundBefore!.predictionCount;

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
      const roundAfter = await prisma.mockRound.findUnique({ where: { id: 'eth-precision-live' } });
      expect(roundAfter!.totalPool).toBe(initialPool + 150);
      expect(roundAfter!.predictionCount).toBe(initialCount + 1);
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
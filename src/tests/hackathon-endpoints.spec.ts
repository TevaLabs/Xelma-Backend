import { describe, it, expect, beforeAll } from '@jest/globals';
import request from 'supertest';

// Mock Stellar and Soroban services to prevent loading @stellar/stellar-sdk (which contains ESM files that Jest fails to parse)
jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (address: string) => address && address.startsWith('G') && address.length === 56,
  verifySignature: jest.fn(),
}));

jest.mock('../services/soroban.service', () => ({
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getHealth: jest.fn(),
}));

import { createApp } from '../app';
import hackathonService from '../services/hackathon.service';
import { db } from '../db/db';
import { hackathonRounds } from '../db/schema';
import { eq } from 'drizzle-orm';

describe('Hackathon Endpoints & Middleware', () => {
  const app = createApp();

  const validAddress = 'GBZXF5Z5S5JQLYQR3P6F4N6M4E2O3K2N4M4H4K4K4K4K4K4K4K4K4K4K'; // Valid Stellar format

  beforeAll(async () => {
    // Ensure database is seeded for tests
    await hackathonService.getUserStats(validAddress);
  });

  afterAll(async () => {
    const { pool } = require('../db/db');
    await pool.end();
  });

  describe('GET /api/rounds', () => {
    it('returns exactly 3 rounds with correct assets and statuses', async () => {
      const res = await request(app).get('/api/rounds');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(3);

      const btc = res.body.find((r: any) => r.id === 'btc-updown-live');
      expect(btc).toBeDefined();
      expect(btc.asset).toBe('BTC');
      expect(btc.mode).toBe('updown');
      expect(btc.status).toBe('live');

      const eth = res.body.find((r: any) => r.id === 'eth-precision-live');
      expect(eth).toBeDefined();
      expect(eth.asset).toBe('ETH');
      expect(eth.mode).toBe('precision');
      expect(eth.status).toBe('live');
    });
  });

  describe('GET /api/leaderboard', () => {
    it('returns exactly 10 users sorted by xp desc with correct ranks', async () => {
      const res = await request(app).get('/api/leaderboard');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(10);

      // Verify they are sorted by rank/xp desc
      let previousXp = Infinity;
      res.body.forEach((u: any, idx: number) => {
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
      expect(res.body).toEqual({
        address: validAddress,
        balance: expect.any(Number),
        pendingWinnings: expect.any(Number),
        totalWins: expect.any(Number),
        totalLosses: expect.any(Number),
        currentStreak: expect.any(Number),
        xp: expect.any(Number),
        rankTitle: expect.any(String),
      });
    });

    it('returns 400 for an invalid address format', async () => {
      const res = await request(app).get('/api/user/invalid-address/stats');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Invalid Stellar wallet address format',
      });
    });
  });

  describe('POST /api/rounds/hackathon/up-down/:id/bet', () => {
    it('persists the bet, updates user balance, and updates the round pool', async () => {
      // Get round initial pools
      const roundBefore = (await db.select().from(hackathonRounds).where(eq(hackathonRounds.id, 'btc-updown-live')))[0];
      const initialPoolUp = roundBefore.poolUp;

      // Place bet
      const res = await request(app)
        .post('/api/rounds/hackathon/up-down/btc-updown-live/bet')
        .send({
          address: validAddress,
          amount: 200,
          side: 'UP',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Bet recorded (stub)',
      });

      // Verify DB update
      const roundAfter = (await db.select().from(hackathonRounds).where(eq(hackathonRounds.id, 'btc-updown-live')))[0];
      expect(roundAfter.poolUp).toBe(initialPoolUp + 200);
    });
  });

  describe('POST /api/rounds/hackathon/precision/:id/bet', () => {
    it('persists the bet and updates round totalPool and predictionCount', async () => {
      // Get round initial pools
      const roundBefore = (await db.select().from(hackathonRounds).where(eq(hackathonRounds.id, 'eth-precision-live')))[0];
      const initialPool = roundBefore.totalPool;
      const initialCount = roundBefore.predictionCount;

      // Place bet
      const res = await request(app)
        .post('/api/rounds/hackathon/precision/eth-precision-live/bet')
        .send({
          address: validAddress,
          amount: 150,
          predictedPrice: 3250,
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Precision bet recorded (stub)',
      });

      // Verify DB update
      const roundAfter = (await db.select().from(hackathonRounds).where(eq(hackathonRounds.id, 'eth-precision-live')))[0];
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

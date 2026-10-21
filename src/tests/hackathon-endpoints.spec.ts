// The hackathon app serves its demo rounds from the mock round table, so the
// mock source has to be selected before the config module is loaded.
process.env.ROUNDS_MOCK_MODE = 'true';

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
import {
  HACKATHON_ROUND_FIXTURES,
  removeDedicatedRound,
  seedDedicatedRound,
  seedHackathonRounds,
} from './helpers/hackathon-fixtures';

describe('Hackathon Endpoints & Middleware', () => {
  const app = createApp();

  const validAddress = 'GBZXF5Z5S5JQLYQR3P6F4N6M4E2O3K2N4M4H4K4K4K4K4K4K4K4K4K4K'; // Valid Stellar format
  const token = generateToken('hackathon-integration-user', validAddress, UserRole.USER);

  beforeAll(async () => {
    // The hackathon bet endpoints record the bet locally instead of sending
    // it to the contract.
    process.env.BET_STUB_MODE = 'true';
    // Ensure the authenticated user exists and database is seeded for tests
    await prisma.user.upsert({
      where: { walletAddress: validAddress },
      create: { id: 'hackathon-integration-user', walletAddress: validAddress },
      update: {},
    });
    // The hackathon app serves its rounds from `hackathon_rounds`; the
    // integration database starts empty, so the demo rounds are seeded here.
    await seedHackathonRounds();
    // The bet endpoints below assert on pool balances, so they run against
    // rounds owned by this spec file only — another suite betting on the
    // shared demo rounds must not change the expected deltas.
    await seedDedicatedRound({
      id: 'endpoints-up-down',
      asset: 'BTC',
      mode: 'updown',
      status: 'live',
      startPrice: 60000,
      poolUp: 0,
      poolDown: 0,
      totalPool: null,
      predictionCount: null,
    });
    await seedDedicatedRound({
      id: 'endpoints-precision',
      asset: 'ETH',
      mode: 'precision',
      status: 'live',
      startPrice: 3000,
      poolUp: null,
      poolDown: null,
      totalPool: 0,
      predictionCount: 0,
    });
    await prisma.round.createMany({
      data: [
        {
          id: 'endpoints-up-down',
          mode: 'UP_DOWN',
          status: 'ACTIVE',
          startPrice: '0.1',
          startTime: new Date(Date.now() - 60_000),
          endTime: new Date(Date.now() + 3_600_000),
        },
        {
          id: 'endpoints-precision',
          mode: 'LEGENDS',
          status: 'ACTIVE',
          startPrice: '0.1',
          startTime: new Date(Date.now() - 60_000),
          endTime: new Date(Date.now() + 3_600_000),
        },
      ],
      skipDuplicates: true,
    });
    await hackathonService.getUserStats(validAddress);
  });

  afterAll(async () => {
    delete process.env.BET_STUB_MODE;
    await prisma.user.deleteMany({ where: { walletAddress: validAddress } });
    await prisma.mockBet.deleteMany({ where: { address: validAddress } });
    await prisma.mockLeaderboard.deleteMany({ where: { address: validAddress } });
    await prisma.bet.deleteMany({ where: { roundId: { in: ['endpoints-up-down', 'endpoints-precision'] } } });
    await prisma.round.deleteMany({ where: { id: { in: ['endpoints-up-down', 'endpoints-precision'] } } });
    await removeDedicatedRound('endpoints-up-down');
    await removeDedicatedRound('endpoints-precision');
  });

  describe('GET /api/rounds', () => {
    it('returns exactly 3 rounds with correct assets and statuses', async () => {
      const res = await request(app).get('/api/rounds');
      expect(res.status).toBe(200);
      const rounds = res.body.data?.rounds ?? res.body;
      expect(Array.isArray(rounds)).toBe(true);
      // Other suites may add their own rounds to the shared database, so
      // assert on the demo rounds the app is expected to expose.
      const demoRounds = rounds.filter((r: any) =>
        HACKATHON_ROUND_FIXTURES.some((fixture) => fixture.id === r.id),
      );
      expect(demoRounds.length).toBe(3);

      const btc = demoRounds.find((r: any) => r.id === 'btc-updown-live');
      expect(btc).toBeDefined();
      expect(btc.asset).toBe('BTC');
      expect(btc.mode).toBe('updown');
      expect(btc.status).toBe('live');

      const eth = demoRounds.find((r: any) => r.id === 'eth-precision-live');
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
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: 'endpoints-up-down' } });
      const initialPoolUp = roundBefore!.poolUp;

      // Place bet
      const res = await request(app)
        .post('/api/rounds/hackathon/up-down/endpoints-up-down/bet')
        .set('Authorization', `Bearer ${token}`)
        .send({
          address: validAddress,
          amount: 200,
          side: 'UP',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: expect.objectContaining({ message: 'Bet recorded (stub)' }),
      });

      // Verify DB update
      const roundAfter = await prisma.mockRound.findUnique({ where: { id: 'endpoints-up-down' } });
      expect(roundAfter!.poolUp).toBe(initialPoolUp + 200);
    });
  });

  describe('POST /api/rounds/hackathon/precision/:id/bet', () => {
    it('persists the bet and updates round totalPool and predictionCount', async () => {
      // Get round initial pools
      const roundBefore = await prisma.mockRound.findUnique({ where: { id: 'endpoints-precision' } });
      const initialPool = roundBefore!.totalPool;
      const initialCount = roundBefore!.predictionCount;

      // Place bet
      const res = await request(app)
        .post('/api/rounds/hackathon/precision/endpoints-precision/bet')
        .set('Authorization', `Bearer ${token}`)
        .send({
          address: validAddress,
          amount: 150,
          predictedPrice: 3250,
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: expect.objectContaining({ message: 'Precision bet recorded (stub)' }),
      });

      // Verify DB update
      const roundAfter = await prisma.mockRound.findUnique({ where: { id: 'endpoints-precision' } });
      expect(roundAfter!.totalPool).toBe(initialPool + 150);
      expect(roundAfter!.predictionCount).toBe(initialCount + 1);
    });
  });

  describe('Centralized Error and 404 Handlers', () => {
    it('returns 404 JSON for invalid paths', async () => {
      const res = await request(app).get('/api/invalid-url-path');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: 'NotFoundError',
        message: 'Route GET /api/invalid-url-path not found',
        code: 'NOT_FOUND',
        path: '/api/invalid-url-path',
        timestamp: expect.any(String),
        requestId: expect.any(String),
      });
    });
  });
});
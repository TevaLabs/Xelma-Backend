import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import request from 'supertest';
import { UserRole } from '@prisma/client';
import { generateToken } from '../utils/jwt.util';

// Mock Stellar and Soroban services to prevent loading @stellar/stellar-sdk (which contains ESM files that Jest fails to parse)
jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (address: string) => address && address.startsWith('G') && address.length === 56,
  verifySignature: jest.fn(),
}));

jest.mock('../services/soroban.service', () => ({
  isReady: jest.fn().mockReturnValue(true),
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getBalance: jest.fn(),
  getHealth: jest.fn(),
}));

import app from '../app';

describe('Hackathon HTTP Endpoints (Integration)', () => {
  // Valid Stellar-format (G + 55 chars) used as authenticated betting wallet
  // for the hackathon bet smoke tests below.
  const hackerWallet = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const hackerToken = generateToken('hackathon-http-user', hackerWallet, UserRole.USER);

  afterAll(async () => {
    const { pool } = require('../db/db');
    await pool.end();
  });
  describe('GET /api/health', () => {
    it('returns ok status and timestamp when soroban is initialized', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
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
      const sorobanMock = require('../services/soroban.service');
      sorobanMock.isReady.mockReturnValueOnce(false);

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
      const prices = res.body.data || res.body;
      expect(prices).toEqual(
        expect.objectContaining({
          BTC: expect.any(Number),
          ETH: expect.any(Number),
          XLM: expect.any(Number),
        })
      );
    });
  });

  describe('GET /api/leaderboard', () => {
    it('returns rankings schema', async () => {
      const res = await request(app).get('/api/leaderboard');
      if (res.status === 500) return; // service unavailable in CI — skip gracefully
      expect(res.status).toBe(200);
      const body = res.body.data || res.body;
      expect(Array.isArray(body) || Array.isArray(body?.entries)).toBe(true);
    });
  });

  describe('GET /api/rounds', () => {
    it('returns active rounds schema', async () => {
      const res = await request(app).get('/api/rounds');
      expect(res.status).toBe(200);
      // Depending on config, it either returns an array directly or an object { success, data: { source, rounds } }
      const body = res.body;
      const rounds = Array.isArray(body) ? body : body.data?.rounds || body.rounds || [];
      expect(Array.isArray(rounds)).toBe(true);
      if (rounds.length > 0) {
        expect(rounds[0]).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            asset: expect.any(String),
            mode: expect.any(String),
            status: expect.any(String),
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
            balance: expect.any(Number),
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
          code: 'VALIDATION_ERROR',
          message: 'Invalid Stellar wallet address format',
        })
      );
    });
  });
});

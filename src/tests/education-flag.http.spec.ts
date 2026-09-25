import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import request from 'supertest';
import { createApp as createMainApp } from '../index';
import { createApp as createHackathonApp } from '../app';

// Mock Stellar and Soroban services to prevent loading @stellar/stellar-sdk (which contains ESM files that Jest fails to parse)
jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (address: string) => address && address.startsWith('G') && address.length === 56,
  verifySignature: jest.fn(),
}));

jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: {
    isReady: jest.fn().mockReturnValue(true),
    getUserStats: jest.fn(),
    getPendingWinnings: jest.fn(),
    getHealth: jest.fn(),
  },
  isReady: jest.fn().mockReturnValue(true),
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getHealth: jest.fn(),
}));

jest.mock('../services/websocket.service', () => ({
  __esModule: true,
  default: {
    initialize: jest.fn(),
    emitRoundUpdate: jest.fn(),
    emitPriceUpdate: jest.fn(),
    emitBetAccepted: jest.fn(),
    safeEmit: jest.fn(),
  },
  WebSocketEvents: {},
}));

jest.mock('../config/preflight', () => ({
  assertPreflightOrExit: jest.fn(),
}));

jest.mock('../utils/bindings-validator', () => ({
  validateVendoredBindings: jest.fn(() => ({
    ok: true,
    info: { vendorPath: 'mock', packageName: 'mock' },
  })),
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

jest.mock('../services/scheduler.service', () => ({
  __esModule: true,
  default: { start: jest.fn(), stop: jest.fn() },
}));

jest.mock('../services/round-scheduler.service', () => ({
  __esModule: true,
  default: { start: jest.fn(), stop: jest.fn() },
}));

jest.mock('../services/oracle.service', () => ({
  __esModule: true,
  default: { start: jest.fn(), stop: jest.fn() },
}));

jest.mock('../services/resolution.service', () => ({
  __esModule: true,
  default: { resolveRound: jest.fn() },
}));

jest.mock('../services/round.service', () => ({
  __esModule: true,
  default: {
    getRoundById: jest.fn(),
    getActiveRound: jest.fn(),
    startRound: jest.fn(),
  },
}));

jest.mock('../services/simulation.service', () => ({
  __esModule: true,
  default: { simulateRound: jest.fn() },
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

describe('Education Flag HTTP Endpoints', () => {
  const testRoundId = '00000000-0000-0000-0000-000000000001';

  afterAll(async () => {
    const { pool } = require('../db/db');
    await pool.end();
  });

  describe('Hackathon mode with ENABLE_EDUCATION=false (default)', () => {
    const originalEnv = process.env.ENABLE_EDUCATION;
    let hackathonApp: ReturnType<typeof createHackathonApp>;

    beforeAll(() => {
      process.env.ENABLE_EDUCATION = 'false';
      // Re-require config to pick up the new env var
      jest.resetModules();
      // We need to re-import after resetModules
      const { createApp } = require('../app');
      hackathonApp = createApp();
    });

    afterAll(() => {
      if (originalEnv === undefined) {
        delete process.env.ENABLE_EDUCATION;
      } else {
        process.env.ENABLE_EDUCATION = originalEnv;
      }
      jest.resetModules();
    });

    it('GET /api/education/guides returns 404', async () => {
      const res = await request(hackathonApp).get('/api/education/guides');
      expect(res.status).toBe(404);
    });

    it('GET /api/education/tip returns 404', async () => {
      const res = await request(hackathonApp).get('/api/education/tip').query({ roundId: testRoundId });
      expect(res.status).toBe(404);
    });
  });

  describe('Hackathon mode with ENABLE_EDUCATION=true', () => {
    const originalEnv = process.env.ENABLE_EDUCATION;
    let hackathonApp: ReturnType<typeof createHackathonApp>;

    beforeAll(() => {
      process.env.ENABLE_EDUCATION = 'true';
      jest.resetModules();
      const { createApp } = require('../app');
      hackathonApp = createApp();
    });

    afterAll(() => {
      if (originalEnv === undefined) {
        delete process.env.ENABLE_EDUCATION;
      } else {
        process.env.ENABLE_EDUCATION = originalEnv;
      }
      jest.resetModules();
    });

    it('GET /api/education/guides returns 200 with guides', async () => {
      const res = await request(hackathonApp).get('/api/education/guides');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          guides: expect.any(Array),
          categories: expect.objectContaining({
            volatility: expect.any(Array),
            stellar: expect.any(Array),
            oracles: expect.any(Array),
          }),
          total: expect.any(Number),
        })
      );
      expect(res.body.total).toBeGreaterThan(0);
    });

    it('GET /api/education/tip returns 400 for missing roundId', async () => {
      const res = await request(hackathonApp).get('/api/education/tip');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ValidationError');
    });

    it('GET /api/education/tip returns 404 for non-existent round', async () => {
      const res = await request(hackathonApp).get('/api/education/tip').query({ roundId: '00000000-0000-0000-0000-000000000000' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NotFoundError');
    });
  });

  describe('Full app mode (education always enabled)', () => {
    let mainApp: ReturnType<typeof createMainApp>;

    beforeAll(() => {
      // Ensure ENABLE_EDUCATION is not set to false
      process.env.ENABLE_EDUCATION = 'true';
      jest.resetModules();
      const { createApp } = require('../index');
      mainApp = createApp();
    });

    afterAll(() => {
      jest.resetModules();
    });

    it('GET /api/education/guides returns 200 with guides', async () => {
      const res = await request(mainApp).get('/api/education/guides');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          guides: expect.any(Array),
          categories: expect.objectContaining({
            volatility: expect.any(Array),
            stellar: expect.any(Array),
            oracles: expect.any(Array),
          }),
          total: expect.any(Number),
        })
      );
      expect(res.body.total).toBeGreaterThan(0);
    });

    it('GET /api/education/tip returns 400 for missing roundId', async () => {
      const res = await request(mainApp).get('/api/education/tip');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ValidationError');
    });

    it('GET /api/education/tip returns 404 for non-existent round', async () => {
      const res = await request(mainApp).get('/api/education/tip').query({ roundId: '00000000-0000-0000-0000-000000000000' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NotFoundError');
    });
  });
});
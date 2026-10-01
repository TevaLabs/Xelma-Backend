import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import request from 'supertest';
import type { Application } from 'express';

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
    init: jest.fn(),
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

// src/index.ts runs checkVendoredBindings() at import time, which resolves the
// bindings policy first; the mock must expose every export it touches.
jest.mock('../utils/bindings-validator', () => ({
  resolveBindingsPolicy: jest.fn(() => 'warn'),
  formatBindingsReport: jest.fn(() => 'mock'),
  validateVendoredBindings: jest.fn(() => ({
    ok: true,
    errors: [],
    warnings: [],
    remediation: [],
    info: { vendorPath: 'mock', packageName: 'mock', specMethods: [] },
  })),
}));

// Education tips read rounds through Prisma; unit tests must not need a
// database, so the service is mocked and the route-level error mapping
// (service message -> typed HTTP error) is still exercised.
jest.mock('../services/education-tip.service', () => ({
  __esModule: true,
  default: {
    generateTip: jest.fn(),
  },
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

const UNKNOWN_ROUND_ID = '00000000-0000-0000-0000-000000000000';

function stubTipNotFound(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const educationTipService =
    require('../services/education-tip.service').default;
  (educationTipService.generateTip as jest.Mock).mockRejectedValue(
    new Error('Round not found'),
  );
}

describe('Education Flag HTTP Endpoints', () => {
  const originalEnv = process.env.ENABLE_EDUCATION;

  afterAll(() => {
    if (originalEnv === undefined) {
      delete process.env.ENABLE_EDUCATION;
    } else {
      process.env.ENABLE_EDUCATION = originalEnv;
    }
    jest.resetModules();
  });

  describe('Hackathon mode with ENABLE_EDUCATION=false (default)', () => {
    let hackathonApp: Application;

    beforeAll(() => {
      process.env.ENABLE_EDUCATION = 'false';
      // Re-require config + app-factory so the flag is picked up fresh.
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createApp } = require('../app');
      hackathonApp = createApp();
    });

    afterAll(() => {
      jest.resetModules();
    });

    it('GET /api/education/guides returns 404', async () => {
      const res = await request(hackathonApp).get('/api/education/guides');
      expect(res.status).toBe(404);
    });

    it('GET /api/education/tip returns 404', async () => {
      const res = await request(hackathonApp)
        .get('/api/education/tip')
        .query({ roundId: UNKNOWN_ROUND_ID });
      expect(res.status).toBe(404);
    });
  });

  describe('Hackathon mode with ENABLE_EDUCATION=true (opt-in)', () => {
    let hackathonApp: Application;

    beforeAll(() => {
      process.env.ENABLE_EDUCATION = 'true';
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createApp } = require('../app');
      hackathonApp = createApp();
      stubTipNotFound();
    });

    afterAll(() => {
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
      const res = await request(hackathonApp)
        .get('/api/education/tip')
        .query({ roundId: UNKNOWN_ROUND_ID });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NotFoundError');
    });
  });

  describe('Full app mode (education on by default, opt-out via flag)', () => {
    let mainApp: Application;

    beforeAll(() => {
      process.env.ENABLE_EDUCATION = 'true';
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createApp } = require('../index');
      mainApp = createApp();
      stubTipNotFound();
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
      // Full-app error handler exposes the machine code in `code`.
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('GET /api/education/tip returns 404 for non-existent round', async () => {
      const res = await request(mainApp)
        .get('/api/education/tip')
        .query({ roundId: UNKNOWN_ROUND_ID });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });
});

import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';

jest.mock('@prisma/client', () => ({
  UserRole: { USER: 'USER', ADMIN: 'ADMIN', ORACLE: 'ORACLE' },
  Prisma: {},
  PrismaClient: jest.fn().mockImplementation(() => ({
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  })),
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

jest.mock('../services/oracle', () => ({
  __esModule: true,
  default: {
    getPriceString: jest.fn(() => '0.28910000'),
    getLastUpdatedAt: jest.fn(() => new Date('2026-08-29T12:00:00Z')),
    isStale: jest.fn(() => false),
    getLastProvider: jest.fn(() => 'coingecko'),
    getActiveSource: jest.fn(() => 'live'),
  },
}));

jest.mock('../services/priceService', () => ({
  getPrices: jest.fn(async () => ({
    btc: 60000,
    eth: 3000,
    xlm: 0.2891,
    stale: false,
  })),
}));

import { createApp } from '../app-factory';
import config from '../config';

describe('Deprecation and Sunset Headers (Issue #899)', () => {
  const originalEnvSunset = process.env.API_SUNSET_DATE;
  const originalConfigSunset = config.app.apiSunsetDate;

  afterEach(() => {
    if (originalEnvSunset !== undefined) {
      process.env.API_SUNSET_DATE = originalEnvSunset;
    } else {
      delete process.env.API_SUNSET_DATE;
    }
    config.app.apiSunsetDate = originalConfigSunset;
  });

  it('sets default Sunset header on unversioned /api/* routes when API_SUNSET_DATE is unset', async () => {
    delete process.env.API_SUNSET_DATE;
    config.app.apiSunsetDate = '';

    const app = createApp({ mode: 'full', features: { deprecationHeaders: true } });
    const res = await request(app).get('/api/prices');

    expect(res.status).toBe(200);
    expect(res.headers['deprecation']).toBe('true');
    expect(res.headers['sunset']).toBe('Sat, 01 Jan 2027 00:00:00 GMT');
    expect(res.headers['link']).toContain('rel="successor-version"');
  });

  it('respects custom API_SUNSET_DATE configured in config / environment', async () => {
    const customSunset = 'Wed, 30 Jun 2027 12:00:00 GMT';
    config.app.apiSunsetDate = customSunset;

    const app = createApp({ mode: 'full', features: { deprecationHeaders: true } });
    const res = await request(app).get('/api/prices');

    expect(res.status).toBe(200);
    expect(res.headers['deprecation']).toBe('true');
    expect(res.headers['sunset']).toBe(customSunset);
  });

  it('omits deprecation and sunset headers for versioned /api/v1 routes', async () => {
    const app = createApp({ mode: 'full', features: { deprecationHeaders: true } });
    const res = await request(app).get('/api/v1/prices');

    expect(res.status).toBe(200);
    expect(res.headers['deprecation']).toBeUndefined();
    expect(res.headers['sunset']).toBeUndefined();
  });
});

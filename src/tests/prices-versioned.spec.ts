import { describe, expect, it, jest } from '@jest/globals';
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

describe('Versioned Price Routes (/api/prices, /api/v1/prices, /api/price, /api/v1/price)', () => {
  const app = createApp({ mode: 'full', features: { deprecationHeaders: true } });

  it('fetches multi-asset prices from /api/prices with deprecation headers', async () => {
    const res = await request(app).get('/api/prices');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.xlm).toBe(0.2891);
    expect(res.headers['deprecation']).toBe('true');
  });

  it('fetches multi-asset prices from /api/v1/prices mirror without deprecation headers', async () => {
    const res = await request(app).get('/api/v1/prices');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.xlm).toBe(0.2891);
    expect(res.headers['deprecation']).toBeUndefined();
  });

  it('fetches single-asset XLM oracle price from /api/price', async () => {
    const res = await request(app).get('/api/price');
    expect(res.status).toBe(200);
    expect(res.body.asset).toBe('XLM');
    expect(res.body.price_usd).toBe('0.28910000');
  });

  it('fetches single-asset XLM oracle price from /api/v1/price mirror', async () => {
    const res = await request(app).get('/api/v1/price');
    expect(res.status).toBe(200);
    expect(res.body.asset).toBe('XLM');
    expect(res.body.price_usd).toBe('0.28910000');
  });
});

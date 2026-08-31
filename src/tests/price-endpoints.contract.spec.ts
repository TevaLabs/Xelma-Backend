import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import axios from 'axios';
import { resetPriceCache } from '../services/priceService';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (address: string) =>
    Boolean(address && address.startsWith('G') && address.length === 56),
  verifySignature: jest.fn(),
}));

jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: {
    getUserStats: jest.fn(),
    getPendingWinnings: jest.fn(),
    getHealth: jest.fn(),
    init: jest.fn(),
  },
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getHealth: jest.fn(),
}));

jest.mock('../services/oracle', () => ({
  __esModule: true,
  default: {
    getPriceString: jest.fn().mockReturnValue('0.28910000'),
    getLastUpdatedAt: jest.fn().mockReturnValue(new Date('2026-07-29T12:00:00.000Z')),
    isStale: jest.fn().mockReturnValue(false),
    getLastProvider: jest.fn().mockReturnValue('coingecko'),
    getActiveSource: jest.fn().mockReturnValue('live'),
    start: jest.fn(),
    stop: jest.fn(),
  },
}));

import { createApp as createMainApp } from '../index';
import { createApp as createHackathonApp } from '../app';

const mockCoinGecko = {
  bitcoin: { usd: 67_420.12 },
  ethereum: { usd: 3_241.55 },
  stellar: { usd: 0.2891 },
};

/**
 * Contract tests for the two price paths.
 *
 * GET /api/price  → production XLM oracle (asset + price_usd string)
 * GET /api/prices → multi-asset ticker (BTC / ETH / XLM numbers)
 *
 * These are intentionally different contracts, not aliases.
 */
describe('Price endpoint contracts (/api/price vs /api/prices)', () => {
  beforeEach(() => {
    resetPriceCache();
    mockedAxios.get.mockReset();
    mockedAxios.get.mockResolvedValue({ data: mockCoinGecko });
  });

  describe('production app', () => {
    const app = createMainApp();

    it('GET /api/price returns the XLM oracle payload shape', async () => {
      const res = await request(app).get('/api/price');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          asset: 'XLM',
          price_usd: '0.28910000',
          stale: false,
          provider: 'coingecko',
          source: 'live',
        }),
      );
      expect(typeof res.body.price_usd === 'string' || res.body.price_usd === null).toBe(true);
      expect(res.body).not.toHaveProperty('BTC');
      expect(res.body).not.toHaveProperty('ETH');
      expect(res.body.success).toBeUndefined();
    });

    it('GET /api/prices returns the multi-asset ticker payload shape', async () => {
      const res = await request(app).get('/api/prices');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            BTC: 67_420.12,
            ETH: 3_241.55,
            XLM: 0.2891,
            stale: false,
          }),
        }),
      );
      expect(res.body).not.toHaveProperty('asset');
      expect(res.body).not.toHaveProperty('price_usd');
    });

    it('does not treat /api/price and /api/prices as interchangeable', async () => {
      const [oracle, multi] = await Promise.all([
        request(app).get('/api/price'),
        request(app).get('/api/prices'),
      ]);

      expect(oracle.body.asset).toBe('XLM');
      expect(multi.body.data.BTC).toEqual(expect.any(Number));
      expect(Object.keys(oracle.body).sort()).not.toEqual(Object.keys(multi.body).sort());
    });
  });

  describe('hackathon app', () => {
    const app = createHackathonApp();

    it('GET /api/prices returns multi-asset data in the success envelope', async () => {
      const res = await request(app).get('/api/prices');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(
        expect.objectContaining({
          BTC: expect.any(Number),
          ETH: expect.any(Number),
          XLM: expect.any(Number),
          stale: expect.any(Boolean),
        }),
      );
    });

    it('GET /api/price is not mounted (use /api/prices instead)', async () => {
      const res = await request(app).get('/api/price');

      expect(res.status).toBe(404);
    });
  });
});

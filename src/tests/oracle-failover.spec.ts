import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import axios from 'axios';
import { Decimal } from '@prisma/client/runtime/library';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Re-import oracle after mocks are set up to get the singleton
import priceOracle from '../services/oracle';

function resetOracle() {
  (priceOracle as any).price = null;
  (priceOracle as any).lastUpdatedAt = null;
  (priceOracle as any).lastProvider = null;
  for (const entry of (priceOracle as any).providerChain) {
    entry.breaker.reset();
  }
}

describe('PriceOracle — multi-provider failover', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    resetOracle();
  });

  describe('primary provider success', () => {
    it('fetches from CoinGecko when it responds correctly', async () => {
      mockedAxios.get.mockImplementation((url: string) => {
        if (String(url).includes('coingecko')) {
          return Promise.resolve({ data: { stellar: { usd: '0.12345678' } } });
        }
        return Promise.reject(new Error('unexpected url'));
      });

      await (priceOracle as any).fetchPrice();

      expect(priceOracle.getPrice()).toBeInstanceOf(Decimal);
      expect(priceOracle.getPriceString()).toBe('0.12345678');
      expect(priceOracle.getLastProvider()).toBe('coingecko');
    });

    it('records price as Decimal with exact precision', async () => {
      mockedAxios.get.mockResolvedValue({ data: { stellar: { usd: '0.09876543' } } });

      await (priceOracle as any).fetchPrice();

      expect(priceOracle.getPriceString()).toBe('0.09876543');
    });
  });

  describe('failover to secondary provider', () => {
    it('uses CoinCap when CoinGecko fails', async () => {
      mockedAxios.get.mockImplementation((url: string) => {
        if (String(url).includes('coingecko')) {
          return Promise.reject(new Error('CoinGecko connection refused'));
        }
        // CoinCap response shape
        return Promise.resolve({ data: { data: { priceUsd: '0.11111111' } } });
      });

      await (priceOracle as any).fetchPrice();

      expect(priceOracle.getPrice()).toBeInstanceOf(Decimal);
      expect(priceOracle.getPriceString()).toBe('0.11111111');
      expect(priceOracle.getLastProvider()).toBe('coincap');
    });

    it('retains last known price when all providers fail', async () => {
      // Seed an initial price
      mockedAxios.get.mockResolvedValueOnce({ data: { stellar: { usd: '0.10000000' } } });
      await (priceOracle as any).fetchPrice();
      expect(priceOracle.getPriceString()).toBe('0.10000000');

      // Now make all providers fail
      mockedAxios.get.mockRejectedValue(new Error('network outage'));
      await (priceOracle as any).fetchPrice();

      // Price should still be the last known value
      expect(priceOracle.getPriceString()).toBe('0.10000000');
      // But the oracle is now stale
      expect(priceOracle.getLastProvider()).toBe('coingecko');
    });

    it('returns null price when all providers fail from the start', async () => {
      mockedAxios.get.mockRejectedValue(new Error('total outage'));

      await (priceOracle as any).fetchPrice();

      expect(priceOracle.getPrice()).toBeNull();
      expect(priceOracle.getLastProvider()).toBeNull();
    });
  });

  describe('provider response validation', () => {
    it('fails over when CoinGecko returns malformed data', async () => {
      mockedAxios.get.mockImplementation((url: string) => {
        if (String(url).includes('coingecko')) {
          return Promise.resolve({ data: { totally: 'wrong' } });
        }
        return Promise.resolve({ data: { data: { priceUsd: '0.22222222' } } });
      });

      await (priceOracle as any).fetchPrice();

      expect(priceOracle.getPriceString()).toBe('0.22222222');
      expect(priceOracle.getLastProvider()).toBe('coincap');
    });

    it('fails over when CoinCap returns malformed data after CoinGecko fails', async () => {
      mockedAxios.get.mockImplementation((url: string) => {
        if (String(url).includes('coingecko')) {
          return Promise.reject(new Error('CoinGecko down'));
        }
        return Promise.resolve({ data: { unexpected: 'shape' } });
      });

      await (priceOracle as any).fetchPrice();

      expect(priceOracle.getPrice()).toBeNull();
      expect(priceOracle.getLastProvider()).toBeNull();
    });
  });

  describe('circuit breaker integration', () => {
    it('skips a provider with an open circuit breaker and falls through to the next', async () => {
      // Trip the CoinGecko circuit breaker (threshold = 3 failures)
      mockedAxios.get.mockRejectedValue(new Error('CoinGecko down'));
      await (priceOracle as any).fetchPrice();
      await (priceOracle as any).fetchPrice();
      await (priceOracle as any).fetchPrice();

      // The CoinGecko breaker should now be open; only CoinCap calls go out
      mockedAxios.get.mockReset();
      mockedAxios.get.mockImplementation((url: string) => {
        if (String(url).includes('coincap')) {
          return Promise.resolve({ data: { data: { priceUsd: '0.33333333' } } });
        }
        // CoinGecko should not be called at all; if it is, fail the test
        return Promise.reject(new Error('CoinGecko should be skipped'));
      });

      await (priceOracle as any).fetchPrice();

      expect(priceOracle.getPriceString()).toBe('0.33333333');
      expect(priceOracle.getLastProvider()).toBe('coincap');
    });
  });

  describe('provider metadata', () => {
    it('exposes the provider name after a successful fetch', async () => {
      mockedAxios.get.mockResolvedValue({ data: { stellar: { usd: '0.15000000' } } });

      await (priceOracle as any).fetchPrice();

      expect(priceOracle.getLastProvider()).toBe('coingecko');
    });

    it('provider metadata is null before any fetch', () => {
      expect(priceOracle.getLastProvider()).toBeNull();
    });

    it('updates provider when failover occurs on subsequent fetch', async () => {
      // First fetch: CoinGecko succeeds
      mockedAxios.get.mockResolvedValueOnce({ data: { stellar: { usd: '0.10000000' } } });
      await (priceOracle as any).fetchPrice();
      expect(priceOracle.getLastProvider()).toBe('coingecko');

      // Second fetch: CoinGecko fails, CoinCap succeeds
      mockedAxios.get.mockImplementation((url: string) => {
        if (String(url).includes('coingecko')) {
          return Promise.reject(new Error('CoinGecko temporarily down'));
        }
        return Promise.resolve({ data: { data: { priceUsd: '0.10100000' } } });
      });

      await (priceOracle as any).fetchPrice();

      expect(priceOracle.getLastProvider()).toBe('coincap');
      expect(priceOracle.getPriceString()).toBe('0.10100000');
    });
  });

  describe('staleness tracking', () => {
    it('is stale when no price has been fetched', () => {
      expect(priceOracle.isStale()).toBe(true);
    });

    it('is not stale immediately after a successful fetch', async () => {
      mockedAxios.get.mockResolvedValue({ data: { stellar: { usd: '0.12000000' } } });

      await (priceOracle as any).fetchPrice();

      expect(priceOracle.isStale()).toBe(false);
    });
  });
});

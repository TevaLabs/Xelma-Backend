import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import axios from 'axios';
import { Decimal } from '@prisma/client/runtime/library';
import priceOracle from '../services/oracle';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function resetOracle() {
  (priceOracle as any).price = null;
  (priceOracle as any).lastUpdatedAt = null;
  (priceOracle as any).lastProvider = null;
  for (const entry of (priceOracle as any).providerChain) {
    entry.breaker.reset();
  }
}

describe('PriceOracle', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    resetOracle();
  });

  it('stores fetched prices as Decimal and preserves exact string precision', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { stellar: { usd: '0.12345678' } },
    });

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getPrice()).toBeInstanceOf(Decimal);
    expect(priceOracle.getPriceString()).toBe('0.12345678');
    expect(priceOracle.getPriceNumber()).toBeCloseTo(0.12345678);
  });

  it('exposes null when all providers fail and does not set price', async () => {
    mockedAxios.get.mockRejectedValue(new Error('network error'));

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getPrice()).toBeNull();
    expect(priceOracle.getPriceString()).toBeNull();
  });

  it('falls back to CoinCap when CoinGecko fails', async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (String(url).includes('coingecko')) {
        return Promise.reject(new Error('CoinGecko unavailable'));
      }
      return Promise.resolve({ data: { data: { priceUsd: '0.11000000' } } });
    });

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getPrice()).toBeInstanceOf(Decimal);
    expect(priceOracle.getPriceString()).toBe('0.11000000');
    expect(priceOracle.getLastProvider()).toBe('coincap');
  });

  it('records the provider that last supplied a price', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { stellar: { usd: '0.20000000' } },
    });

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getLastProvider()).toBe('coingecko');
  });
});

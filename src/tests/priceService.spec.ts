import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import axios from 'axios';
import { getPrices, resetPriceCache, getPriceProviderHealth } from '../services/priceService';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockCoinGecko = {
  bitcoin: { usd: 67_420.12 },
  ethereum: { usd: 3_241.55 },
  stellar: { usd: 0.2891 },
};

describe('priceService', () => {
  beforeEach(() => {
    resetPriceCache();
    mockedAxios.get.mockReset();
    jest.useRealTimers();
  });

  it('fetches live prices from CoinGecko and maps to BTC/ETH/XLM', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });

    const prices = await getPrices();

    expect(prices.BTC).toBe(67_420.12);
    expect(prices.ETH).toBe(3_241.55);
    expect(prices.XLM).toBe(0.2891);
    expect(prices.stale).toBe(false);
    expect(prices.lastUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('serves cached prices within 30 seconds without calling CoinGecko again', async () => {
    mockedAxios.get.mockResolvedValue({ data: mockCoinGecko });

    await getPrices();
    await getPrices();

    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('returns stale cached prices when CoinGecko fails after a successful fetch', async () => {
    jest.useFakeTimers();
    mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });

    const fresh = await getPrices();
    jest.advanceTimersByTime(31_000);

    mockedAxios.get.mockRejectedValueOnce(new Error('upstream timeout'));
    const stale = await getPrices();

    expect(stale.BTC).toBe(fresh.BTC);
    expect(stale.ETH).toBe(fresh.ETH);
    expect(stale.XLM).toBe(fresh.XLM);
    expect(stale.stale).toBe(true);
  });

  it('returns static fallback prices when CoinGecko fails and no cache exists', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('network error'));

    const prices = await getPrices();

    expect(prices.BTC).toBe(60_000);
    expect(prices.ETH).toBe(3_000);
    expect(prices.XLM).toBe(0.2891);
    expect(prices.stale).toBe(true);
    expect(prices.lastUpdatedAt).toBeNull();
  });

  it('fails over to CoinCap when CoinGecko is down', async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (String(url).includes('coingecko')) {
        return Promise.reject(new Error('CoinGecko down'));
      }
      return Promise.resolve({
        data: {
          data: [
            { id: 'bitcoin', priceUsd: '67001' },
            { id: 'ethereum', priceUsd: '3202' },
            { id: 'stellar', priceUsd: '0.29' },
          ],
        },
      });
    });

    const prices = await getPrices();

    expect(prices.BTC).toBe(67_001);
    expect(prices.ETH).toBe(3_202);
    expect(prices.XLM).toBe(0.29);
    expect(prices.stale).toBe(false);
  });
});

describe('getPriceProviderHealth (#869)', () => {
  beforeEach(() => {
    resetPriceCache();
    mockedAxios.get.mockReset();
    jest.useRealTimers();
  });

  it('reports no activity and not degraded before any fetch', () => {
    const h = getPriceProviderHealth();
    expect(h.degraded).toBe(false);
    expect(h.activeProvider).toBeNull();
    expect(h.lastSuccessAt).toBeNull();
    expect(h.providers.map((p) => p.name)).toEqual(['coingecko', 'coincap']);
  });

  it('records last success for the provider that served prices', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });
    await getPrices();

    const h = getPriceProviderHealth();
    expect(h.degraded).toBe(false);
    expect(h.activeProvider).toBe('coingecko');
    expect(h.lastSuccessAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(h.providers[0].consecutiveFailures).toBe(0);
  });

  it('records the failing provider but stays healthy when the fallback succeeds', async () => {
    mockedAxios.get
      .mockRejectedValueOnce(new Error('coingecko down'))
      .mockResolvedValueOnce({
        data: {
          data: [
            { id: 'bitcoin', priceUsd: '67000' },
            { id: 'ethereum', priceUsd: '3200' },
            { id: 'stellar', priceUsd: '0.29' },
          ],
        },
      });
    await getPrices();

    const h = getPriceProviderHealth();
    const cg = h.providers.find((p) => p.name === 'coingecko')!;
    expect(cg.consecutiveFailures).toBe(1);
    expect(cg.lastError).toBe('coingecko down');
    expect(cg.lastFailureAt).not.toBeNull();
    expect(h.degraded).toBe(false);
    expect(h.activeProvider).toBe('coincap');
  });

  it('is degraded when every provider fails, and recovers on the next success', async () => {
    mockedAxios.get.mockRejectedValue(new Error('all down'));
    await getPrices();

    let h = getPriceProviderHealth();
    expect(h.degraded).toBe(true);
    expect(h.providers.every((p) => p.consecutiveFailures === 1)).toBe(true);

    resetPriceCache();
    mockedAxios.get.mockReset();
    mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });
    await getPrices();
    h = getPriceProviderHealth();
    expect(h.degraded).toBe(false);
  });
});

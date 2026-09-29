import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import axios from 'axios';
import { getPrices, resetPriceCache } from '../services/priceService';

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

  describe('cache stampede protection (single-flight)', () => {
    it('shares one upstream request across concurrent cache misses', async () => {
      mockedAxios.get.mockResolvedValue({ data: mockCoinGecko });

      const [a, b, c] = await Promise.all([getPrices(), getPrices(), getPrices()]);

      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
      expect(a.BTC).toBe(67_420.12);
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    });

    it('only fetches once even if misses arrive while a fetch is in flight', async () => {
      let resolveFetch: (value: unknown) => void = () => {};
      mockedAxios.get.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }) as any,
      );

      const first = getPrices();
      const second = getPrices();
      resolveFetch({ data: mockCoinGecko });

      await Promise.all([first, second]);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('CoinGecko 429 / Retry-After handling', () => {
    const rateLimited = () => ({
      response: { status: 429, headers: { 'retry-after': '120' } },
    });

    it('serves stale cache on 429 and does not retry immediately', async () => {
      jest.useFakeTimers();
      mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });
      const fresh = await getPrices();
      jest.advanceTimersByTime(31_000);

      mockedAxios.get.mockRejectedValueOnce(rateLimited());
      const stale = await getPrices();

      expect(stale.stale).toBe(true);
      expect(stale.BTC).toBe(fresh.BTC);
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);

      // Within the Retry-After window another call must be served from cache
      // without touching the network again.
      const stillStale = await getPrices();
      expect(stillStale.stale).toBe(true);
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('returns static fallback on 429 when no cache exists and never throws', async () => {
      mockedAxios.get.mockRejectedValueOnce(rateLimited());

      const prices = await getPrices();

      expect(prices.stale).toBe(true);
      expect(prices.lastUpdatedAt).toBeNull();
      expect(prices.BTC).toBe(60_000);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it('honors an HTTP-date Retry-After and clears the backoff on a later success', async () => {
      jest.useFakeTimers();
      mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });
      await getPrices();
      jest.advanceTimersByTime(31_000);

      const future = new Date(Date.now() + 60_000).toUTCString();
      mockedAxios.get.mockRejectedValueOnce({
        response: { status: 429, headers: { 'retry-after': future } },
      });
      const stale = await getPrices();
      expect(stale.stale).toBe(true);

      // Backoff still active one second later.
      jest.advanceTimersByTime(1_000);
      await getPrices();
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);

      // Once the window passes, a fresh fetch is attempted and clears backoff.
      jest.advanceTimersByTime(61_000);
      mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });
      const recovered = await getPrices();
      expect(recovered.stale).toBe(false);
      expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    });
  });
});

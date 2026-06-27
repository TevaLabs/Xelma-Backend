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

  it('throws when CoinGecko fails and no cache exists', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('network error'));

    await expect(getPrices()).rejects.toThrow('network error');
  });
});

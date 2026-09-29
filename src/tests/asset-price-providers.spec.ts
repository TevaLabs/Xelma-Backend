import { describe, it, expect, jest } from '@jest/globals';
import axios from 'axios';
import { Decimal } from '@prisma/client/runtime/library';
import { CoinGeckoProvider } from '../services/providers/coingecko.provider';
import { CoinCapProvider } from '../services/providers/coincap.provider';
import {
  PriceProviderRateLimitError,
  parseRetryAfterMs,
} from '../services/price-provider.interface';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('CoinGeckoProvider.fetchAssetPrices', () => {
  const provider = new CoinGeckoProvider('https://coingecko.example/ids=stellar', 5_000);

  it('maps BTC/ETH/XLM to Decimal with exact string precision', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        bitcoin: { usd: '67420.12345678' },
        ethereum: { usd: '3241.55' },
        stellar: { usd: '0.12345678' },
      },
    });

    const result = await provider.fetchAssetPrices();

    expect(result.BTC).toBeInstanceOf(Decimal);
    expect(result.BTC.toString()).toBe('67420.12345678');
    expect(result.ETH.toString()).toBe('3241.55');
    expect(result.XLM.toString()).toBe('0.12345678');
  });

  it('throws when a required asset price is missing', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { bitcoin: { usd: 1 }, ethereum: { usd: 2 } },
    });

    await expect(provider.fetchAssetPrices()).rejects.toThrow(/missing BTC, ETH, or XLM/);
  });

  it('converts an HTTP 429 into a typed rate-limit error carrying Retry-After', async () => {
    mockedAxios.get.mockRejectedValueOnce({
      response: { status: 429, headers: { 'retry-after': '90' } },
    });

    let caught: unknown;
    try {
      await provider.fetchAssetPrices();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PriceProviderRateLimitError);
    expect((caught as PriceProviderRateLimitError).provider).toBe('coingecko');
    expect((caught as PriceProviderRateLimitError).retryAfterMs).toBe(90_000);
  });

  it('rethrows a non-429 failure unchanged', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('connection reset'));
    await expect(provider.fetchAssetPrices()).rejects.toThrow('connection reset');
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
  });

  it('parses an HTTP-date into a positive delta', () => {
    const header = new Date(Date.now() + 30_000).toUTCString();
    const ms = parseRetryAfterMs(header);
    expect(ms).toBeGreaterThan(25_000);
    expect(ms).toBeLessThanOrEqual(30_000);
  });

  it('returns null for missing or unparseable values', () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
  });

  it('caps absurd Retry-After values', () => {
    expect(parseRetryAfterMs('999999')).toBe(5 * 60_000);
  });
});

describe('CoinCapProvider.fetchAssetPrices', () => {
  const provider = new CoinCapProvider('https://coincap.example/assets/stellar', 5_000);

  it('maps the assets array to Decimal BTC/ETH/XLM', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: [
          { id: 'bitcoin', priceUsd: '67000.00000001' },
          { id: 'ethereum', priceUsd: '3200.5' },
          { id: 'stellar', priceUsd: '0.28' },
        ],
      },
    });

    const result = await provider.fetchAssetPrices();

    expect(result.BTC.toString()).toBe('67000.00000001');
    expect(result.ETH.toString()).toBe('3200.5');
    expect(result.XLM.toString()).toBe('0.28');
  });

  it('throws when the assets array is missing an asset', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { data: [{ id: 'bitcoin', priceUsd: '1' }] },
    });

    await expect(provider.fetchAssetPrices()).rejects.toThrow(/missing BTC, ETH, or XLM/);
  });

  it('converts an HTTP 429 into a typed rate-limit error', async () => {
    mockedAxios.get.mockRejectedValueOnce({
      response: { status: 429, headers: {} },
    });

    await expect(provider.fetchAssetPrices()).rejects.toBeInstanceOf(
      PriceProviderRateLimitError,
    );
  });
});

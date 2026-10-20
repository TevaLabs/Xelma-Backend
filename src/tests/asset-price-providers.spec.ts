import { describe, it, expect, jest } from '@jest/globals';
import axios from 'axios';
import { Decimal } from '@prisma/client/runtime/library';
import { CoinGeckoProvider } from '../services/providers/coingecko.provider';
import { CoinCapProvider } from '../services/providers/coincap.provider';

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
});

describe('CoinCapProvider.fetchPrice', () => {
  const url = 'https://coincap.example/assets/stellar';
  const providerWithTimeout = new CoinCapProvider(url, 3_000);
  const defaultProvider = new CoinCapProvider(url);

  it('maps priceUsd to Decimal with exact precision and applies configured timeout', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: {
          priceUsd: '0.12345678',
        },
      },
    });

    const result = await providerWithTimeout.fetchPrice();

    expect(result).toBeInstanceOf(Decimal);
    expect(result.toString()).toBe('0.12345678');
    expect(mockedAxios.get).toHaveBeenCalledWith(url, { timeout: 3_000 });
  });

  it('uses default 5000ms timeout when timeout is omitted', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: {
          priceUsd: '0.25',
        },
      },
    });

    const result = await defaultProvider.fetchPrice();

    expect(result.toString()).toBe('0.25');
    expect(mockedAxios.get).toHaveBeenCalledWith(url, { timeout: 5_000 });
  });

  it('handles and rejects on axios timeout failure (ECONNABORTED)', async () => {
    const timeoutError = Object.assign(new Error('timeout of 3000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    mockedAxios.get.mockRejectedValueOnce(timeoutError);

    await expect(providerWithTimeout.fetchPrice()).rejects.toThrow('timeout of 3000ms exceeded');
  });

  it('handles and rejects on network connection failure', async () => {
    const networkError = Object.assign(new Error('Network Error: connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    mockedAxios.get.mockRejectedValueOnce(networkError);

    await expect(providerWithTimeout.fetchPrice()).rejects.toThrow('Network Error');
  });

  it('throws when priceUsd is missing in payload', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { data: {} },
    });

    await expect(providerWithTimeout.fetchPrice()).rejects.toThrow(
      'Invalid response from CoinCap: missing data.priceUsd',
    );
  });
});

describe('CoinCapProvider.fetchAssetPrices', () => {
  const provider = new CoinCapProvider('https://coincap.example/assets/stellar', 5_000);

  it('maps the assets array to Decimal BTC/ETH/XLM and applies aligned timeout', async () => {
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
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it('throws when the assets array is missing an asset', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { data: [{ id: 'bitcoin', priceUsd: '1' }] },
    });

    await expect(provider.fetchAssetPrices()).rejects.toThrow(/missing BTC, ETH, or XLM/);
  });

  it('handles and rejects on axios timeout failure for multi-asset prices', async () => {
    const timeoutError = Object.assign(new Error('timeout of 5000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    mockedAxios.get.mockRejectedValueOnce(timeoutError);

    await expect(provider.fetchAssetPrices()).rejects.toThrow('timeout of 5000ms exceeded');
  });

  it('handles and rejects on network outage for multi-asset prices', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('CoinCap multi-asset gateway timeout 504'));

    await expect(provider.fetchAssetPrices()).rejects.toThrow('504');
  });
});

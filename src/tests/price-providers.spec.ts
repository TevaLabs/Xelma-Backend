import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { fetchPricesWithFailover, resolvePriceProviders } from '../services/price-providers';
import { CoingeckoPriceProvider } from '../services/price-providers/coingecko.provider';
import { StaticPriceProvider } from '../services/price-providers/static.provider';

describe('price providers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves provider chain from env', () => {
    process.env.ORACLE_PROVIDER = 'coingecko';
    process.env.ORACLE_FALLBACK_PROVIDERS = 'static';
    const providers = resolvePriceProviders();
    expect(providers.map((provider) => provider.name)).toEqual(['coingecko', 'static']);
  });

  it('fails over to the next provider when the primary fails', async () => {
    const primary = {
      name: 'coingecko' as const,
      fetchPrices: jest.fn().mockRejectedValue(new Error('primary down')),
    };
    const fallback = new StaticPriceProvider();

    const result = await fetchPricesWithFailover([primary, fallback]);
    expect(result.source).toBe('static');
    expect(result.prices).toEqual({ BTC: 67000, ETH: 3200, XLM: 0.28 });
  });

  it('maps CoinGecko payloads to BTC/ETH/XLM', async () => {
    const provider = new CoingeckoPriceProvider();
    const originalFetch = global.fetch;

    global.fetch = (async () => ({
      ok: true,
      json: async () => ({
        bitcoin: { usd: 1 },
        ethereum: { usd: 2 },
        stellar: { usd: 3 },
      }),
    })) as typeof fetch;

    try {
      const result = await provider.fetchPrices();
      expect(result.prices).toEqual({ BTC: 1, ETH: 2, XLM: 3 });
    } finally {
      global.fetch = originalFetch;
    }
  });
});

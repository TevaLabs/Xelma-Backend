/**
 * oracle-unified-provider.spec.ts
 *
 * Comprehensive tests for the unified provider stack introduced in issue #495.
 * Covers:
 *  1. Provider registry consistency (same order for oracle + priceService)
 *  2. Single-asset failover  — oracle.ts (XLM/USD via CoinGecko → CoinCap)
 *  3. Multi-asset failover   — priceService.ts (BTC/ETH/XLM via CoinGecko → CoinCap)
 *  4. All-providers-down (multi-asset) → static fallback + stale:true
 *  5. Decimal precision end-to-end
 *  6. Staleness / fail-closed guard (isStale() as gate)
 *  7. CoinCap response parsing (data[].priceUsd array format)
 *  8. CoinGecko response parsing (nested {bitcoin:{usd:...}} format)
 *  9. Cache behaviour (30 s TTL, stale-on-failure)
 * 10. Oracle health snapshot consistency
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import axios from 'axios';
import { Decimal } from '@prisma/client/runtime/library';

// ─── Module mocks (must be hoisted before any imports of the modules under test) ───

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../config', () => {
  const actualConfig = jest.requireActual('../config') as any;
  return {
    __esModule: true,
    default: {
      ...actualConfig.default,
      app: { ...actualConfig.default.app, dataMode: 'live' },
      oracle: {
        ...actualConfig.default.oracle,
        maxRetries: 1,
        stalenessThresholdMs: 60_000,
      },
    },
  };
});

import { createDefaultProviders } from '../services/providers';
import { getPrices, resetPriceCache } from '../services/priceService';
import priceOracle from '../services/oracle';

// ─── Helper: reset oracle singleton between tests ────────────────────────────

function resetOracle() {
  (priceOracle as any).price = null;
  (priceOracle as any).lastUpdatedAt = null;
  (priceOracle as any).lastProvider = null;
  (priceOracle as any).activeSource = null;
  (priceOracle as any)._running = false;
  for (const entry of (priceOracle as any).providerChain) {
    entry.breaker.reset();
  }
}

// ─── Shared mock response fixtures ───────────────────────────────────────────

/** CoinGecko single-asset (XLM) response */
const COINGECKO_XLM_RESPONSE = { data: { stellar: { usd: '0.12345678' } } };

/** CoinCap single-asset (XLM) response — note data.data.priceUsd (object, not array) */
const COINCAP_XLM_RESPONSE = { data: { data: { priceUsd: '0.11111111' } } };

/** CoinGecko multi-asset response */
const COINGECKO_MULTI_RESPONSE = {
  data: {
    bitcoin: { usd: 67420.12 },
    ethereum: { usd: 3241.55 },
    stellar: { usd: 0.2891 },
  },
};

/** CoinCap multi-asset response — data.data is an array of {id, priceUsd} */
const COINCAP_MULTI_RESPONSE = {
  data: {
    data: [
      { id: 'bitcoin', priceUsd: '67001' },
      { id: 'ethereum', priceUsd: '3202' },
      { id: 'stellar', priceUsd: '0.29' },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. PROVIDER REGISTRY CONSISTENCY
// ─────────────────────────────────────────────────────────────────────────────

describe('Unified provider registry', () => {
  it('createDefaultProviders returns [coingecko, coincap] in priority order', () => {
    const providers = createDefaultProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0].name).toBe('coingecko');
    expect(providers[1].name).toBe('coincap');
  });

  it('both providers implement the PriceProvider interface (name, fetchPrice, fetchAssetPrices)', () => {
    const providers = createDefaultProviders();
    for (const provider of providers) {
      expect(typeof provider.name).toBe('string');
      expect(typeof provider.fetchPrice).toBe('function');
      expect(typeof provider.fetchAssetPrices).toBe('function');
    }
  });

  it('oracle uses the same provider order as priceService (registry consistency)', () => {
    const oracleChain: string[] = (priceOracle as any).providerChain.map(
      (e: any) => e.provider.name,
    );
    const serviceChain = createDefaultProviders().map((p) => p.name);
    expect(oracleChain).toEqual(serviceChain);
  });

  it('provider names are unique within the chain', () => {
    const providers = createDefaultProviders();
    const names = providers.map((p) => p.name);
    const uniqueNames = [...new Set(names)];
    expect(uniqueNames).toHaveLength(names.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SINGLE-ASSET ORACLE FAILOVER  (oracle.ts path, XLM/USD)
// ─────────────────────────────────────────────────────────────────────────────

describe('Single-asset oracle failover (oracle.ts path)', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    resetOracle();
  });

  it('uses CoinGecko as the primary provider for XLM price', async () => {
    mockedAxios.get.mockResolvedValue(COINGECKO_XLM_RESPONSE);

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getLastProvider()).toBe('coingecko');
    expect(priceOracle.getPrice()).toBeInstanceOf(Decimal);
    expect(priceOracle.getPriceString()).toBe('0.12345678');
  });

  it('fails over to CoinCap when CoinGecko fails for XLM', async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (String(url).includes('coingecko')) {
        return Promise.reject(new Error('CoinGecko down'));
      }
      return Promise.resolve(COINCAP_XLM_RESPONSE);
    });

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getLastProvider()).toBe('coincap');
    expect(priceOracle.getPriceString()).toBe('0.11111111');
  });

  it('retains last known price when all providers fail', async () => {
    // Seed a known price first
    mockedAxios.get.mockResolvedValueOnce(COINGECKO_XLM_RESPONSE);
    await (priceOracle as any).fetchPrice();
    const priceBeforeFailure = priceOracle.getPriceString();

    // Now make all providers fail
    mockedAxios.get.mockRejectedValue(new Error('network outage'));
    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getPriceString()).toBe(priceBeforeFailure);
  });

  it('returns null when all providers fail from the start (no cached price)', async () => {
    mockedAxios.get.mockRejectedValue(new Error('total outage'));

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getPrice()).toBeNull();
    expect(priceOracle.isStale()).toBe(true);
  });

  it('fails over when CoinGecko returns malformed data (missing stellar.usd)', async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (String(url).includes('coingecko')) {
        // Missing stellar key → CoinGeckoProvider throws
        return Promise.resolve({ data: { bitcoin: { usd: 67000 } } });
      }
      return Promise.resolve(COINCAP_XLM_RESPONSE);
    });

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getLastProvider()).toBe('coincap');
    expect(priceOracle.getPriceString()).toBe('0.11111111');
  });

  it('updates activeSource as well as lastProvider on successful fetch', async () => {
    mockedAxios.get.mockResolvedValue(COINGECKO_XLM_RESPONSE);

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getActiveSource()).toBe('coingecko');
    expect(priceOracle.getLastProvider()).toBe('coingecko');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 & 9. MULTI-ASSET PRICESERVICE FAILOVER + CACHE BEHAVIOUR
//        (priceService.ts path, BTC/ETH/XLM)
// ─────────────────────────────────────────────────────────────────────────────

describe('Multi-asset priceService failover and cache (priceService.ts path)', () => {
  beforeEach(() => {
    resetPriceCache();
    mockedAxios.get.mockReset();
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fetches BTC/ETH/XLM from CoinGecko as primary', async () => {
    mockedAxios.get.mockResolvedValue(COINGECKO_MULTI_RESPONSE);

    const prices = await getPrices();

    expect(prices.BTC).toBe(67420.12);
    expect(prices.ETH).toBe(3241.55);
    expect(prices.XLM).toBe(0.2891);
    expect(prices.stale).toBe(false);
    expect(prices.lastUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('fails over to CoinCap when CoinGecko is down for multi-asset', async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (String(url).includes('coingecko')) {
        return Promise.reject(new Error('CoinGecko unavailable'));
      }
      return Promise.resolve(COINCAP_MULTI_RESPONSE);
    });

    const prices = await getPrices();

    expect(prices.BTC).toBeCloseTo(67001, 0);
    expect(prices.ETH).toBeCloseTo(3202, 0);
    expect(prices.XLM).toBeCloseTo(0.29, 4);
    expect(prices.stale).toBe(false);
  });

  // ── 4. ALL-PROVIDERS-DOWN (multi-asset) ───────────────────────────────────

  it('returns static fallback with stale=true when all providers fail and no cache exists', async () => {
    mockedAxios.get.mockRejectedValue(new Error('total network failure'));

    const prices = await getPrices();

    expect(prices.BTC).toBe(60_000);
    expect(prices.ETH).toBe(3_000);
    expect(prices.XLM).toBe(0.2891);
    expect(prices.stale).toBe(true);
    expect(prices.lastUpdatedAt).toBeNull();
  });

  it('returns stale cached prices when all providers fail after a successful fetch', async () => {
    jest.useFakeTimers();
    mockedAxios.get.mockResolvedValueOnce(COINGECKO_MULTI_RESPONSE);
    const fresh = await getPrices();

    // Advance past the 30s cache TTL
    jest.advanceTimersByTime(31_000);

    mockedAxios.get.mockRejectedValue(new Error('all providers down'));
    const stale = await getPrices();

    expect(stale.BTC).toBe(fresh.BTC);
    expect(stale.ETH).toBe(fresh.ETH);
    expect(stale.XLM).toBe(fresh.XLM);
    expect(stale.stale).toBe(true);
  });

  // ── 9. CACHE BEHAVIOUR ────────────────────────────────────────────────────

  it('caches prices for 30 seconds without re-fetching upstream', async () => {
    mockedAxios.get.mockResolvedValue(COINGECKO_MULTI_RESPONSE);

    await getPrices();
    await getPrices();
    await getPrices();

    // Only one upstream call should have been made across all three calls
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the 30s cache window expires', async () => {
    jest.useFakeTimers();
    mockedAxios.get.mockResolvedValue(COINGECKO_MULTI_RESPONSE);

    await getPrices();
    jest.advanceTimersByTime(31_000);
    await getPrices();

    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('serves fresh data (stale:false) immediately after cache refresh', async () => {
    jest.useFakeTimers();
    mockedAxios.get.mockResolvedValue(COINGECKO_MULTI_RESPONSE);

    await getPrices();
    jest.advanceTimersByTime(31_000);
    const refreshed = await getPrices();

    expect(refreshed.stale).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DECIMAL PRECISION END-TO-END
// ─────────────────────────────────────────────────────────────────────────────

describe('Decimal precision end-to-end', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    resetOracle();
    resetPriceCache();
  });

  it('oracle stores XLM price as Decimal, not a plain JS number', async () => {
    mockedAxios.get.mockResolvedValue(COINGECKO_XLM_RESPONSE);

    await (priceOracle as any).fetchPrice();

    const price = priceOracle.getPrice();
    expect(price).toBeInstanceOf(Decimal);
    // getPriceNumber() converts via toNumber() — still the right value
    expect(priceOracle.getPriceNumber()).toBeCloseTo(0.12345678);
  });

  it('oracle preserves trailing zeros in string representation (Decimal-safe)', async () => {
    mockedAxios.get.mockResolvedValue({ data: { stellar: { usd: '0.28910000' } } });

    await (priceOracle as any).fetchPrice();

    // Decimal("0.28910000").toFixed(8) → "0.28910000"  (not "0.2891")
    expect(priceOracle.getPriceString()).toBe('0.28910000');
  });

  it('priceService returns numbers (via toNumber(Decimal)) — no floating-point drift for BTC', async () => {
    mockedAxios.get.mockResolvedValue(COINGECKO_MULTI_RESPONSE);

    const prices = await getPrices();

    expect(typeof prices.BTC).toBe('number');
    expect(prices.BTC).toBe(67420.12);
  });

  it('CoinCap string prices are correctly converted to numbers via Decimal', async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (String(url).includes('coingecko')) {
        return Promise.reject(new Error('CoinGecko down'));
      }
      return Promise.resolve(COINCAP_MULTI_RESPONSE);
    });

    const prices = await getPrices();

    expect(typeof prices.BTC).toBe('number');
    expect(prices.BTC).toBeCloseTo(67001, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 & 8. PROVIDER RESPONSE PARSING
// ─────────────────────────────────────────────────────────────────────────────

describe('Provider response parsing', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    resetPriceCache();
  });

  // ── 8. CoinGecko parsing ──────────────────────────────────────────────────

  it('CoinGecko single-asset: correctly parses {stellar:{usd:...}} format', async () => {
    const providers = createDefaultProviders();
    const coingecko = providers[0];

    mockedAxios.get.mockResolvedValue({ data: { stellar: { usd: '0.29' } } });

    const price = await coingecko.fetchPrice();
    expect(price).toBeInstanceOf(Decimal);
    expect(price.toString()).toBe('0.29');
  });

  it('CoinGecko single-asset: throws on missing stellar.usd', async () => {
    const providers = createDefaultProviders();
    const coingecko = providers[0];

    mockedAxios.get.mockResolvedValue({ data: { bitcoin: { usd: 67000 } } });

    await expect(coingecko.fetchPrice()).rejects.toThrow('Invalid response from CoinGecko');
  });

  it('CoinGecko multi-asset: correctly parses {bitcoin:{usd:...}, ethereum:{usd:...}, stellar:{usd:...}}', async () => {
    const providers = createDefaultProviders();
    const coingecko = providers[0];

    mockedAxios.get.mockResolvedValue(COINGECKO_MULTI_RESPONSE);

    const assets = await coingecko.fetchAssetPrices();
    expect(assets.BTC).toBeInstanceOf(Decimal);
    expect(assets.ETH).toBeInstanceOf(Decimal);
    expect(assets.XLM).toBeInstanceOf(Decimal);
    expect(Number(assets.BTC)).toBeCloseTo(67420.12);
  });

  it('CoinGecko multi-asset: throws when any required asset is missing', async () => {
    const providers = createDefaultProviders();
    const coingecko = providers[0];

    // Missing ethereum
    mockedAxios.get.mockResolvedValue({
      data: { bitcoin: { usd: 67000 }, stellar: { usd: 0.29 } },
    });

    await expect(coingecko.fetchAssetPrices()).rejects.toThrow('Invalid response from CoinGecko');
  });

  // ── 7. CoinCap parsing ────────────────────────────────────────────────────

  it('CoinCap single-asset: correctly parses {data:{priceUsd:...}} format', async () => {
    const providers = createDefaultProviders();
    const coincap = providers[1];

    mockedAxios.get.mockResolvedValue({ data: { data: { priceUsd: '0.11111111' } } });

    const price = await coincap.fetchPrice();
    expect(price).toBeInstanceOf(Decimal);
    expect(price.toString()).toBe('0.11111111');
  });

  it('CoinCap single-asset: throws on missing data.priceUsd', async () => {
    const providers = createDefaultProviders();
    const coincap = providers[1];

    mockedAxios.get.mockResolvedValue({ data: { data: { wrongField: '0.12' } } });

    await expect(coincap.fetchPrice()).rejects.toThrow('Invalid response from CoinCap');
  });

  it('CoinCap multi-asset: correctly parses data[].priceUsd array format', async () => {
    const providers = createDefaultProviders();
    const coincap = providers[1];

    mockedAxios.get.mockResolvedValue(COINCAP_MULTI_RESPONSE);

    const assets = await coincap.fetchAssetPrices();
    expect(assets.BTC).toBeInstanceOf(Decimal);
    expect(assets.ETH).toBeInstanceOf(Decimal);
    expect(assets.XLM).toBeInstanceOf(Decimal);
    expect(Number(assets.BTC)).toBeCloseTo(67001, 0);
  });

  it('CoinCap multi-asset: throws when any asset is missing from data array', async () => {
    const providers = createDefaultProviders();
    const coincap = providers[1];

    // Missing ethereum
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          { id: 'bitcoin', priceUsd: '67001' },
          { id: 'stellar', priceUsd: '0.29' },
        ],
      },
    });

    await expect(coincap.fetchAssetPrices()).rejects.toThrow('Invalid response from CoinCap');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. STALENESS / FAIL-CLOSED GUARD
// ─────────────────────────────────────────────────────────────────────────────

describe('Staleness and fail-closed guard', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    resetOracle();
  });

  it('oracle reports stale=true before any price is fetched', () => {
    expect(priceOracle.isStale()).toBe(true);
    expect(priceOracle.getPrice()).toBeNull();
  });

  it('oracle reports stale=false immediately after a successful fetch', async () => {
    mockedAxios.get.mockResolvedValue(COINGECKO_XLM_RESPONSE);

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.isStale()).toBe(false);
  });

  it('oracle reports stale=true after the price ages beyond the staleness threshold (60s)', async () => {
    mockedAxios.get.mockResolvedValue(COINGECKO_XLM_RESPONSE);
    await (priceOracle as any).fetchPrice();

    // Back-date the timestamp to simulate aging
    (priceOracle as any).lastUpdatedAt = new Date(Date.now() - 70_000);

    expect(priceOracle.isStale()).toBe(true);
  });

  it('stale price: value exists but isStale() acts as a fail-closed resolution guard', async () => {
    mockedAxios.get.mockResolvedValue(COINGECKO_XLM_RESPONSE);
    await (priceOracle as any).fetchPrice();

    (priceOracle as any).lastUpdatedAt = new Date(Date.now() - 70_000);

    // isStale() should block resolution — price is present but stale
    expect(priceOracle.isStale()).toBe(true);
    expect(priceOracle.getPrice()).toBeInstanceOf(Decimal); // price still cached
  });

  it('getStalenessMs returns null before any fetch', () => {
    expect(priceOracle.getStalenessMs()).toBeNull();
    expect(priceOracle.getStalenessSeconds()).toBeNull();
  });

  it('getStalenessSeconds returns 0 immediately after a successful fetch', async () => {
    mockedAxios.get.mockResolvedValue(COINGECKO_XLM_RESPONSE);

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getStalenessSeconds()).toBe(0);
  });

  it('getStalenessSeconds reflects age correctly after back-dating', async () => {
    mockedAxios.get.mockResolvedValue(COINGECKO_XLM_RESPONSE);
    await (priceOracle as any).fetchPrice();

    // Back-date by ~65 seconds
    (priceOracle as any).lastUpdatedAt = new Date(Date.now() - 65_000);

    const secs = priceOracle.getStalenessSeconds() as number;
    expect(secs).toBeGreaterThanOrEqual(65);
  });

  it('getStalenessThresholdMs returns the configured 60 000 ms', () => {
    expect(priceOracle.getStalenessThresholdMs()).toBe(60_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. ORACLE HEALTH SNAPSHOT
// ─────────────────────────────────────────────────────────────────────────────

describe('Oracle health snapshot', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    resetOracle();
  });

  it('reflects the no-price state correctly before any fetch', () => {
    const snap = priceOracle.getHealthSnapshot();

    expect(snap.running).toBe(false);
    expect(snap.hasPrice).toBe(false);
    expect(snap.stale).toBe(true);
    expect(snap.stalenessSeconds).toBeNull();
    expect(snap.lastUpdateUnixSeconds).toBeNull();
  });

  it('reflects a fresh price state correctly after a successful fetch', async () => {
    (priceOracle as any)._running = true;
    mockedAxios.get.mockResolvedValue(COINGECKO_XLM_RESPONSE);

    await (priceOracle as any).fetchPrice();

    const snap = priceOracle.getHealthSnapshot();
    expect(snap.running).toBe(true);
    expect(snap.hasPrice).toBe(true);
    expect(snap.stale).toBe(false);
    expect(snap.stalenessSeconds).toBe(0);
    expect(snap.lastUpdateUnixSeconds).toBeGreaterThan(0);
  });

  it('reflects stale state after price ages beyond threshold', async () => {
    mockedAxios.get.mockResolvedValue(COINGECKO_XLM_RESPONSE);
    await (priceOracle as any).fetchPrice();

    (priceOracle as any).lastUpdatedAt = new Date(Date.now() - 70_000);

    const snap = priceOracle.getHealthSnapshot();
    expect(snap.hasPrice).toBe(true);
    expect(snap.stale).toBe(true);
    expect(snap.stalenessSeconds as number).toBeGreaterThanOrEqual(70);
  });

  it('snapshot running flag mirrors _running state', () => {
    (priceOracle as any)._running = true;
    expect(priceOracle.getHealthSnapshot().running).toBe(true);

    (priceOracle as any)._running = false;
    expect(priceOracle.getHealthSnapshot().running).toBe(false);
  });
});

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import axios from 'axios';
import { Decimal } from '@prisma/client/runtime/library';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../config', () => {
  const actualConfig = jest.requireActual('../config') as any;
  return {
    __esModule: true,
    default: {
      ...actualConfig.default,
      oracle: {
        ...actualConfig.default.oracle,
        maxRetries: 1,
        stalenessThresholdMs: 60_000,
      },
    },
  };
});

// Re-import the singleton after mocks are wired up.
import priceOracle from '../services/oracle';

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

describe('PriceOracle — price capture and freshness', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    resetOracle();
  });

  it('stores fetched prices as Decimal and preserves exact string precision', async () => {
    mockedAxios.get.mockResolvedValue({ data: { stellar: { usd: '0.12345678' } } });

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getPrice()).toBeInstanceOf(Decimal);
    expect(priceOracle.getPriceString()).toBe('0.12345678');
    expect(priceOracle.getPriceNumber()).toBeCloseTo(0.12345678);
  });

  it('records the active source provider after a successful fetch', async () => {
    mockedAxios.get.mockResolvedValue({ data: { stellar: { usd: '0.20000000' } } });

    await (priceOracle as any).fetchPrice();

    // Regression: getActiveSource() previously always returned null.
    expect(priceOracle.getActiveSource()).toBe('coingecko');
    expect(priceOracle.getLastProvider()).toBe('coingecko');
  });

  it('exposes null and stays stale when all providers fail with no prior price', async () => {
    mockedAxios.get.mockRejectedValue(new Error('network error'));

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.getPrice()).toBeNull();
    expect(priceOracle.getPriceString()).toBeNull();
    expect(priceOracle.isStale()).toBe(true);
    expect(priceOracle.getStalenessMs()).toBeNull();
    expect(priceOracle.getStalenessSeconds()).toBeNull();
  });

  it('is fresh immediately after a successful fetch and reports a small staleness', async () => {
    mockedAxios.get.mockResolvedValue({ data: { stellar: { usd: '0.10000000' } } });

    await (priceOracle as any).fetchPrice();

    expect(priceOracle.isStale()).toBe(false);
    const stalenessMs = priceOracle.getStalenessMs();
    expect(stalenessMs).not.toBeNull();
    expect(stalenessMs as number).toBeLessThan(60_000);
    expect(priceOracle.getStalenessSeconds()).toBe(0);
  });

  it('classifies a price older than the threshold as stale', async () => {
    mockedAxios.get.mockResolvedValue({ data: { stellar: { usd: '0.10000000' } } });
    await (priceOracle as any).fetchPrice();

    // Backdate the last update beyond the 60s threshold.
    (priceOracle as any).lastUpdatedAt = new Date(Date.now() - 61_000);

    expect(priceOracle.isStale()).toBe(true);
    expect(priceOracle.getStalenessSeconds() as number).toBeGreaterThanOrEqual(60);
  });

  it('exposes the configured staleness threshold', () => {
    expect(priceOracle.getStalenessThresholdMs()).toBe(60_000);
  });
});

describe('PriceOracle — health snapshot', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    resetOracle();
  });

  it('reports an empty snapshot before any fetch', () => {
    const snap = priceOracle.getHealthSnapshot();
    expect(snap).toEqual({
      running: false,
      hasPrice: false,
      stale: true,
      stalenessSeconds: null,
      lastUpdateUnixSeconds: null,
    });
  });

  it('reports a fresh snapshot after a successful fetch', async () => {
    (priceOracle as any)._running = true;
    mockedAxios.get.mockResolvedValue({ data: { stellar: { usd: '0.15000000' } } });

    await (priceOracle as any).fetchPrice();

    const snap = priceOracle.getHealthSnapshot();
    expect(snap.running).toBe(true);
    expect(snap.hasPrice).toBe(true);
    expect(snap.stale).toBe(false);
    expect(snap.stalenessSeconds).toBe(0);
    expect(snap.lastUpdateUnixSeconds).toBeGreaterThan(0);
  });
});

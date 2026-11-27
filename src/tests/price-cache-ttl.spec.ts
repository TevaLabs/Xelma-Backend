import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {
  PRICES_CACHE_TTL_ENV,
  PRICE_ORACLE_CACHE_TTL_ENV,
  oraclePriceCacheTtlSeconds,
  pricesCacheTtlSeconds,
} from '../utils/http-cache';
import pricesRouter, { legacyXlmPriceRouter } from '../routes/prices';

jest.mock('../services/priceService', () => ({
  getPrices: async () => ({ BTC: 1, ETH: 2, XLM: 3, stale: false, lastUpdatedAt: null }),
}));

jest.mock('../services/oracle', () => ({
  __esModule: true,
  default: {
    getPriceString: () => '0.28910000',
    getLastUpdatedAt: () => null,
    isStale: () => false,
    getLastProvider: () => 'coingecko',
    getActiveSource: () => 'live',
  },
}));

function cacheHeader(seconds: number): string {
  return `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=${seconds}`;
}

function buildApp() {
  const app = express();
  app.use('/api', pricesRouter);
  app.use('/api', legacyXlmPriceRouter);
  return app;
}

describe('separate cache TTLs for /api/prices and /api/price (Issue #1026)', () => {
  beforeEach(() => {
    delete process.env[PRICES_CACHE_TTL_ENV];
    delete process.env[PRICE_ORACLE_CACHE_TTL_ENV];
  });

  afterEach(() => {
    delete process.env[PRICES_CACHE_TTL_ENV];
    delete process.env[PRICE_ORACLE_CACHE_TTL_ENV];
  });

  it('uses distinct env variables', () => {
    expect(PRICE_ORACLE_CACHE_TTL_ENV).not.toBe(PRICES_CACHE_TTL_ENV);
  });

  it('defaults both endpoints to the same 30 seconds', async () => {
    const app = buildApp();
    const prices = await request(app).get('/api/prices');
    const price = await request(app).get('/api/price');
    expect(prices.headers['cache-control']).toBe(cacheHeader(30));
    expect(price.headers['cache-control']).toBe(cacheHeader(30));
  });

  it('keeps /api/price following PRICES_CACHE_TTL_SECONDS when the oracle TTL is unset', async () => {
    process.env[PRICES_CACHE_TTL_ENV] = '90';
    const app = buildApp();
    const prices = await request(app).get('/api/prices');
    const price = await request(app).get('/api/price');
    expect(prices.headers['cache-control']).toBe(cacheHeader(90));
    expect(price.headers['cache-control']).toBe(cacheHeader(90));
  });

  it('lets the oracle TTL differ from the prices TTL', async () => {
    process.env[PRICES_CACHE_TTL_ENV] = '60';
    process.env[PRICE_ORACLE_CACHE_TTL_ENV] = '5';
    const app = buildApp();
    const prices = await request(app).get('/api/prices');
    const price = await request(app).get('/api/price');
    expect(prices.headers['cache-control']).toBe(cacheHeader(60));
    expect(price.headers['cache-control']).toBe(cacheHeader(5));
  });

  it('does not let the oracle TTL change /api/prices', async () => {
    process.env[PRICE_ORACLE_CACHE_TTL_ENV] = '1';
    const app = buildApp();
    const prices = await request(app).get('/api/prices');
    expect(prices.headers['cache-control']).toBe(cacheHeader(30));
  });

  it('falls back to the prices TTL when the oracle TTL is invalid', () => {
    process.env[PRICES_CACHE_TTL_ENV] = '45';
    for (const bad of ['soon', '-3', '   ']) {
      process.env[PRICE_ORACLE_CACHE_TTL_ENV] = bad;
      expect(oraclePriceCacheTtlSeconds()).toBe(45);
    }
  });

  it('accepts 0 to disable caching of /api/price only', async () => {
    process.env[PRICE_ORACLE_CACHE_TTL_ENV] = '0';
    expect(oraclePriceCacheTtlSeconds()).toBe(0);
    expect(pricesCacheTtlSeconds()).toBe(30);
    const app = buildApp();
    const price = await request(app).get('/api/price');
    expect(price.headers['cache-control']).toBe(cacheHeader(0));
  });
});

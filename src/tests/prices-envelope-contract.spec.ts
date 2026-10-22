import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import axios from 'axios';

jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (address: string) =>
    address && address.startsWith('G') && address.length === 56,
  verifySignature: jest.fn(),
}));

jest.mock('../services/soroban.service', () => ({
  isReady: jest.fn().mockReturnValue(true),
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getHealth: jest.fn(),
}));

import { createApp as createMainApp } from '../index';
import { createApp as createHackathonApp } from '../app';
import * as priceService from '../services/priceService';
import { resetPriceCache } from '../services/priceService';
import { pricesCacheTtlSeconds } from '../utils/http-cache';
import { swaggerSpec } from '../docs/openapi';
import { hackathonSwaggerSpec } from '../docs/hackathon-openapi';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockCoinGecko = {
  bitcoin: { usd: 67_420.12 },
  ethereum: { usd: 3_241.55 },
  stellar: { usd: 0.2891 },
};

describe('GET /api/prices contract — both apps return identical envelope', () => {
  beforeEach(() => {
    resetPriceCache();
    mockedAxios.get.mockReset();
    jest.useRealTimers();
  });

  it('main app returns { success, data } envelope', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });
    const app = createMainApp();

    const res = await request(app).get('/api/prices');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.BTC).toBe(67_420.12);
    expect(res.body.data.ETH).toBe(3_241.55);
    expect(res.body.data.XLM).toBe(0.2891);
    expect(res.body.data.stale).toBe(false);
    expect(typeof res.body.data.lastUpdatedAt).toBe('string');
  });

  it('hackathon app returns { success, data } envelope', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });
    const app = createHackathonApp();

    const res = await request(app).get('/api/prices');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.BTC).toBe(67_420.12);
    expect(res.body.data.ETH).toBe(3_241.55);
    expect(res.body.data.XLM).toBe(0.2891);
    expect(res.body.data.stale).toBe(false);
    expect(typeof res.body.data.lastUpdatedAt).toBe('string');
  });

  it('both apps return identical top-level keys', async () => {
    mockedAxios.get.mockResolvedValue({ data: mockCoinGecko });
    const mainApp = createMainApp();
    const hackathonApp = createHackathonApp();

    const mainRes = await request(mainApp).get('/api/prices');
    const hackRes = await request(hackathonApp).get('/api/prices');

    const mainKeys = Object.keys(mainRes.body).sort();
    const hackKeys = Object.keys(hackRes.body).sort();
    expect(mainKeys).toEqual(hackKeys);

    const mainDataKeys = Object.keys(mainRes.body.data).sort();
    const hackDataKeys = Object.keys(hackRes.body.data).sort();
    expect(mainDataKeys).toEqual(hackDataKeys);
  });
});

/**
 * The price endpoints own their cache TTL (Issue #871), so the expected header
 * is derived from the resolved TTL instead of a hardcoded literal.
 */
const publicCacheHeader = (ttl: number): string =>
  `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${ttl}`;

describe.each([
  ['main', createMainApp, swaggerSpec],
  ['hackathon', createHackathonApp, hackathonSwaggerSpec],
] as const)('GET /api/prices contract — %s app', (_name, buildApp, spec) => {
  beforeEach(() => {
    resetPriceCache();
    mockedAxios.get.mockReset();
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.PRICES_CACHE_TTL_SECONDS;
  });

  it('returns exactly { success, data } with the ticker fields and cache header', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });

    const res = await request(buildApp()).get('/api/prices');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        BTC: 67_420.12,
        ETH: 3_241.55,
        XLM: 0.2891,
        stale: false,
        lastUpdatedAt: expect.any(String),
      },
    });
    expect(res.headers['cache-control']).toBe(publicCacheHeader(pricesCacheTtlSeconds()));
  });

  it('honours PRICES_CACHE_TTL_SECONDS (Issue #871)', async () => {
    process.env.PRICES_CACHE_TTL_SECONDS = '120';
    mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });

    const res = await request(buildApp()).get('/api/prices');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(publicCacheHeader(120));
  });

  it('returns the same 503 failure envelope when no price data is available', async () => {
    jest
      .spyOn(priceService, 'getPrices')
      .mockRejectedValueOnce(new Error('Price data unavailable'));

    const res = await request(buildApp()).get('/api/prices');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: 'Price data unavailable' });
    expect(res.headers['cache-control']).toBe(publicCacheHeader(pricesCacheTtlSeconds()));
  });

  it('OpenAPI documents the envelope the route actually returns', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: mockCoinGecko });
    const res = await request(buildApp()).get('/api/prices');

    const doc = spec as any;
    const resolve = (schema: any): any =>
      schema?.$ref
        ? doc.components.schemas[schema.$ref.split('/').pop() as string]
        : schema;

    const responses = doc.paths['/api/prices'].get.responses;
    const okContent = responses['200'].content['application/json'];
    const envelope = resolve(okContent.schema);
    const data = resolve(envelope.properties.data);

    // One envelope, not an envelope nested inside `data`.
    expect(Object.keys(envelope.properties).sort()).toEqual(Object.keys(res.body).sort());
    expect(Object.keys(data.properties).sort()).toEqual(Object.keys(res.body.data).sort());
    expect(data.properties.success).toBeUndefined();

    expect(Object.keys(okContent.example).sort()).toEqual(Object.keys(res.body).sort());
    expect(Object.keys(okContent.example.data).sort()).toEqual(
      Object.keys(res.body.data).sort(),
    );

    const failure = resolve(responses['503'].content['application/json'].schema);
    expect(Object.keys(failure.properties).sort()).toEqual(['error', 'success']);
  });
});

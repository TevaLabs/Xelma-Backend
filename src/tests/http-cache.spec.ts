import { describe, it, expect, afterEach } from '@jest/globals';
import {
  PRICES_CACHE_TTL_DEFAULT_SECONDS,
  PRICES_CACHE_TTL_ENV,
  STATS_CACHE_TTL_DEFAULT_SECONDS,
  STATS_CACHE_TTL_ENV,
  pricesCacheTtlSeconds,
  resolveCacheTtlSeconds,
  setNoStore,
  setPublicCache,
  statsCacheTtlSeconds,
} from '../utils/http-cache';

function fakeResponse() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  } as any;
}

describe('resolveCacheTtlSeconds (Issue #871)', () => {
  afterEach(() => {
    delete process.env.PRICES_CACHE_TTL_SECONDS;
    delete process.env.STATS_CACHE_TTL_SECONDS;
  });

  it('falls back to the supplied default when the variable is unset', () => {
    expect(resolveCacheTtlSeconds('PRICES_CACHE_TTL_SECONDS', 30)).toBe(30);
  });

  it('falls back to the supplied default when the variable is empty', () => {
    process.env.PRICES_CACHE_TTL_SECONDS = '   ';
    expect(resolveCacheTtlSeconds('PRICES_CACHE_TTL_SECONDS', 30)).toBe(30);
  });

  it('falls back to the supplied default for a non-numeric value', () => {
    process.env.PRICES_CACHE_TTL_SECONDS = 'soon';
    expect(resolveCacheTtlSeconds('PRICES_CACHE_TTL_SECONDS', 30)).toBe(30);
  });

  it('falls back to the supplied default for a negative value', () => {
    process.env.PRICES_CACHE_TTL_SECONDS = '-5';
    expect(resolveCacheTtlSeconds('PRICES_CACHE_TTL_SECONDS', 30)).toBe(30);
  });

  it('accepts an explicit zero (caching disabled at the edge)', () => {
    process.env.PRICES_CACHE_TTL_SECONDS = '0';
    expect(resolveCacheTtlSeconds('PRICES_CACHE_TTL_SECONDS', 30)).toBe(0);
  });

  it('parses the configured value', () => {
    process.env.PRICES_CACHE_TTL_SECONDS = '120';
    expect(resolveCacheTtlSeconds('PRICES_CACHE_TTL_SECONDS', 30)).toBe(120);
  });
});

describe('per-endpoint TTL knobs (Issue #871)', () => {
  afterEach(() => {
    delete process.env.PRICES_CACHE_TTL_SECONDS;
    delete process.env.STATS_CACHE_TTL_SECONDS;
  });

  it('prices and stats do not share a TTL', () => {
    expect(PRICES_CACHE_TTL_DEFAULT_SECONDS).toBe(30);
    expect(STATS_CACHE_TTL_DEFAULT_SECONDS).toBe(5);
    expect(PRICES_CACHE_TTL_ENV).not.toBe(STATS_CACHE_TTL_ENV);
    expect(pricesCacheTtlSeconds()).toBe(PRICES_CACHE_TTL_DEFAULT_SECONDS);
    expect(statsCacheTtlSeconds()).toBe(STATS_CACHE_TTL_DEFAULT_SECONDS);
  });

  it('each knob moves independently', () => {
    process.env.PRICES_CACHE_TTL_SECONDS = '90';
    process.env.STATS_CACHE_TTL_SECONDS = '2';

    expect(pricesCacheTtlSeconds()).toBe(90);
    expect(statsCacheTtlSeconds()).toBe(2);
  });
});

describe('setPublicCache / setNoStore', () => {
  it('writes a public cache directive for the given ttl', () => {
    const res = fakeResponse();
    setPublicCache(res, 5);
    expect(res.headers['Cache-Control']).toBe(
      'public, max-age=5, s-maxage=5, stale-while-revalidate=5',
    );
  });

  it('clamps negative and fractional ttls', () => {
    const res = fakeResponse();
    setPublicCache(res, -3);
    expect(res.headers['Cache-Control']).toBe(
      'public, max-age=0, s-maxage=0, stale-while-revalidate=0',
    );

    const fractional = fakeResponse();
    setPublicCache(fractional, 2.9);
    expect(fractional.headers['Cache-Control']).toBe(
      'public, max-age=2, s-maxage=2, stale-while-revalidate=2',
    );
  });

  it('writes no-store directives', () => {
    const res = fakeResponse();
    setNoStore(res);
    expect(res.headers['Cache-Control']).toBe('no-store, no-cache, must-revalidate');
    expect(res.headers['Pragma']).toBe('no-cache');
    expect(res.headers['Expires']).toBe('0');
  });
});

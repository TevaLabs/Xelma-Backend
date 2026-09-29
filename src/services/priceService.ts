import { mockData } from '../data/mockData';
import config from '../config';
import logger from '../utils/logger';
import { toNumber } from '../utils/decimal.util';
import {
  AssetPriceSet,
  PriceProvider,
  PriceProviderRateLimitError,
  isPriceProviderRateLimitError,
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
  MAX_RATE_LIMIT_BACKOFF_MS,
} from './price-provider.interface';
import { createDefaultProviders } from './providers';
import { priceProviderRateLimitedTotal } from '../metrics/application.metrics';

const CACHE_TTL_MS = 30_000;

export interface PriceResponse {
  BTC: number;
  ETH: number;
  XLM: number;
  stale: boolean;
  lastUpdatedAt: string | null;
}

interface CacheEntry {
  data: PriceResponse;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
let providers: PriceProvider[] | null = null;

/**
 * Single-flight guard: while a fetch is in progress, concurrent callers share
 * the same promise instead of each firing their own upstream request. This is
 * what prevents a cache-miss stampede (e.g. hackathon traffic all arriving on
 * the same 30s boundary) from fanning out into N CoinGecko calls.
 */
let inFlight: Promise<PriceResponse> | null = null;

/**
 * Unix-epoch (ms) until which upstream fetches are suppressed because a
 * provider returned HTTP 429. While active we serve the last cached snapshot
 * (or the static fallback) with `stale: true` instead of retrying immediately.
 */
let rateLimitedUntil = 0;

/** Lazily built so config/env overrides are picked up at first use, not import time. */
function getProviders(): PriceProvider[] {
  if (!providers) {
    providers = createDefaultProviders();
  }
  return providers;
}

function getMockPrices(): PriceResponse {
  const btc = mockData.prices.find((p) => p.symbol === 'btc')?.price ?? 60_000;
  const eth = mockData.prices.find((p) => p.symbol === 'eth')?.price ?? 3_000;

  return {
    BTC: btc,
    ETH: eth,
    XLM: 0.2891,
    stale: false,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function toPriceResponse(assetPrices: AssetPriceSet): PriceResponse {
  return {
    BTC: toNumber(assetPrices.BTC),
    ETH: toNumber(assetPrices.ETH),
    XLM: toNumber(assetPrices.XLM),
    stale: false,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function withStaleFlag(data: PriceResponse): PriceResponse {
  return { ...data, stale: true };
}

/** Static values served only when every provider fails and no cache exists. */
function staticFallbackPrices(): PriceResponse {
  return {
    BTC: 60_000,
    ETH: 3_000,
    XLM: 0.2891,
    stale: true,
    lastUpdatedAt: null,
  };
}

/**
 * Fetch BTC/ETH/XLM using the same provider chain and failover order as the
 * settlement oracle (CoinGecko primary, CoinCap fallback), so both surfaces
 * share one Decimal-safe provider stack.
 *
 * A rate-limit (HTTP 429) is deliberately *not* treated like a generic
 * failure: it short-circuits the chain so we stop hammering a provider that
 * just asked us to back off. The typed error propagates to the caller, which
 * honors Retry-After by serving stale cache.
 */
async function fetchAssetPricesWithFailover(): Promise<AssetPriceSet> {
  let lastError: unknown;

  for (const provider of getProviders()) {
    try {
      return await provider.fetchAssetPrices();
    } catch (err) {
      lastError = err;
      if (isPriceProviderRateLimitError(err)) {
        throw err;
      }
      logger.warn(`Multi-asset price fetch failed for provider ${provider.name}, trying next`, {
        provider: provider.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error('All configured price providers failed');
}

/**
 * Record a rate-limit hit, raise the backoff window, and return the best
 * available snapshot (stale cache when present, static fallback otherwise).
 */
function handleRateLimit(err: PriceProviderRateLimitError): PriceResponse {
  const backoffMs = Math.min(
    err.retryAfterMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS,
    MAX_RATE_LIMIT_BACKOFF_MS,
  );
  rateLimitedUntil = Date.now() + backoffMs;

  priceProviderRateLimitedTotal.inc({ provider: err.provider });
  logger.warn('coingecko_rate_limited', {
    provider: err.provider,
    retryAfterMs: err.retryAfterMs,
    backoffMs,
    hasCache: Boolean(cache),
  });

  if (cache) {
    return withStaleFlag(cache.data);
  }

  logger.warn('No cache available — returning static fallback prices');
  return staticFallbackPrices();
}

/**
 * Fetch upstream and refresh the cache, converting failures into the most
 * useful snapshot. Never rejects, so the single-flight promise is always
 * awaitable by every concurrent caller.
 */
async function fetchAndCache(): Promise<PriceResponse> {
  try {
    const assetPrices = await fetchAssetPricesWithFailover();
    const fresh = toPriceResponse(assetPrices);
    cache = { data: fresh, fetchedAt: Date.now() };
    // A successful fetch clears any outstanding rate-limit backoff.
    rateLimitedUntil = 0;
    return fresh;
  } catch (err) {
    if (isPriceProviderRateLimitError(err)) {
      return handleRateLimit(err);
    }

    logger.warn('All multi-asset price providers failed', {
      error: err instanceof Error ? err.message : String(err),
      hasCache: Boolean(cache),
    });

    if (cache) {
      return withStaleFlag(cache.data);
    }

    logger.warn('No cache available — returning static fallback prices');
    return staticFallbackPrices();
  }
}

/** Reset in-memory cache and single-flight state (for tests). */
export function resetPriceCache(): void {
  cache = null;
  inFlight = null;
  rateLimitedUntil = 0;
}

export const getPrices = async (): Promise<PriceResponse> => {
  if (config.app.dataMode === 'mock') {
    return getMockPrices();
  }

  const now = Date.now();

  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  // Honor an active rate-limit window without touching the network.
  if (now < rateLimitedUntil) {
    if (cache) {
      return withStaleFlag(cache.data);
    }
    return staticFallbackPrices();
  }

  // Single-flight: concurrent cache misses share one upstream request.
  if (!inFlight) {
    inFlight = fetchAndCache().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
};

import axios from 'axios';
import { mockData } from '../data/mockData';
import config from '../config';
import logger from '../utils/logger';

const COINGECKO_URL =
  process.env.COINGECKO_MULTI_PRICE_URL ??
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,stellar&vs_currencies=usd';

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

function mapCoinGeckoResponse(data: Record<string, { usd?: number }>): PriceResponse {
  const btc = data.bitcoin?.usd;
  const eth = data.ethereum?.usd;
  const xlm = data.stellar?.usd;

  if (btc == null || eth == null || xlm == null) {
    throw new Error('CoinGecko response missing required price fields');
  }

  const now = new Date().toISOString();
  return {
    BTC: btc,
    ETH: eth,
    XLM: xlm,
    stale: false,
    lastUpdatedAt: now,
  };
}

function withStaleFlag(data: PriceResponse): PriceResponse {
  return { ...data, stale: true };
}

async function fetchFromCoinGecko(): Promise<PriceResponse> {
  const response = await axios.get<Record<string, { usd?: number }>>(COINGECKO_URL, {
    timeout: 5_000,
  });
  return mapCoinGeckoResponse(response.data);
}

/** Reset in-memory cache (for tests). */
export function resetPriceCache(): void {
  cache = null;
}

export const getPrices = async (): Promise<PriceResponse> => {
  if (config.app.dataMode === 'mock') {
    return getMockPrices();
  }

  const now = Date.now();

  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  try {
    const fresh = await fetchFromCoinGecko();
    cache = { data: fresh, fetchedAt: now };
    return fresh;
  } catch (err) {
    logger.warn('CoinGecko price fetch failed', {
      error: err instanceof Error ? err.message : String(err),
      hasCache: Boolean(cache),
    });

    if (cache) {
      return withStaleFlag(cache.data);
    }

    throw err;
  }
};

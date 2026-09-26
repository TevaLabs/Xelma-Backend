import { Decimal } from '@prisma/client/runtime/library';

/** BTC/ETH/XLM snapshot returned by the multi-asset price endpoint. */
export interface AssetPriceSet {
  BTC: Decimal;
  ETH: Decimal;
  XLM: Decimal;
}

export interface PriceProvider {
  readonly name: string;
  /** Single XLM/USD price, used by the settlement oracle poller. */
  fetchPrice(): Promise<Decimal>;
  /** BTC/ETH/XLM snapshot, used by the on-demand /api/prices endpoint. */
  fetchAssetPrices(): Promise<AssetPriceSet>;
}

/**
 * Default backoff applied when a provider returns HTTP 429 without a usable
 * `Retry-After` header. Chosen to match CoinGecko's free-tier window.
 */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

/**
 * Upper bound on how long a `Retry-After` value is honored. Guards against a
 * hostile or buggy upstream pinning the service to stale data indefinitely.
 */
export const MAX_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

/**
 * Typed error raised when a price provider responds with HTTP 429.
 *
 * Unlike a generic upstream failure, a rate limit carries an explicit
 * "try again in N seconds" signal. Bubbling it as a distinct type lets the
 * failover chain stop hammering every provider and lets `priceService` serve
 * stale cache until the backoff expires.
 */
export class PriceProviderRateLimitError extends Error {
  readonly provider: string;
  /** Parsed `Retry-After` in milliseconds, or null when absent/invalid. */
  readonly retryAfterMs: number | null;

  constructor(provider: string, retryAfterMs: number | null, message?: string) {
    super(message ?? `Price provider ${provider} returned HTTP 429 (rate limited)`);
    this.name = 'PriceProviderRateLimitError';
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Type guard usable from catch blocks (serialization-safe). */
export function isPriceProviderRateLimitError(
  err: unknown,
): err is PriceProviderRateLimitError {
  return (
    err instanceof PriceProviderRateLimitError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: string }).name === 'PriceProviderRateLimitError')
  );
}

/**
 * Parse an HTTP `Retry-After` header into milliseconds.
 *
 * Accepts both spec forms:
 *   - delta-seconds: `"120"`
 *   - HTTP-date:     `"Wed, 21 Oct 2026 07:28:00 GMT"`
 * Returns null when the header is missing or unparseable so the caller can
 * fall back to {@link DEFAULT_RATE_LIMIT_BACKOFF_MS}. Values are capped at
 * {@link MAX_RATE_LIMIT_BACKOFF_MS}.
 */
export function parseRetryAfterMs(header: unknown): number | null {
  if (header == null) return null;
  const raw = Array.isArray(header) ? header[0] : String(header);
  if (raw.length === 0) return null;

  // delta-seconds (the common CoinGecko form)
  if (/^\d+(?:\.\d+)?$/.test(raw.trim())) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(Math.round(seconds * 1000), MAX_RATE_LIMIT_BACKOFF_MS);
  }

  // HTTP-date
  const dateMs = Date.parse(raw);
  if (Number.isNaN(dateMs)) return null;
  const delta = dateMs - Date.now();
  if (delta <= 0) return 0;
  return Math.min(delta, MAX_RATE_LIMIT_BACKOFF_MS);
}

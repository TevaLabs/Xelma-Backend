import { Request, Response, NextFunction } from "express";

/** Cache a public response for a short period while allowing CDN revalidation. */
export function setPublicCache(res: Response, seconds: number): void {
  const ttl = Math.max(0, Math.floor(seconds));
  res.setHeader(
    "Cache-Control",
    `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${ttl}`,
  );
}

/**
 * Resolve a public cache TTL (seconds) from the environment.
 *
 * WHY PER-ENDPOINT TTLs
 * ---------------------
 * Every public feed used to share one hardcoded `30`, so a CDN could not be
 * tuned per route: the landing-page counters change on every round resolution
 * and want a short TTL, while the price feed is refreshed by the oracle
 * poller and tolerates a longer one. Each endpoint therefore owns its own
 * env variable and its own default.
 *
 * The value is read per request (not at module load) so tests and operators
 * can change it without reloading the module graph. Invalid, negative or
 * non-numeric values fall back to the caller-supplied default rather than
 * disabling caching by accident.
 */
export function resolveCacheTtlSeconds(
  envVar: string,
  fallbackSeconds: number,
): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw.trim() === "") {
    return fallbackSeconds;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallbackSeconds;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Per-endpoint TTL knobs (Issue #871)
// ---------------------------------------------------------------------------

/** Env variable controlling the public cache TTL of the price endpoints. */
export const PRICES_CACHE_TTL_ENV = "PRICES_CACHE_TTL_SECONDS";

/** Default TTL (seconds) for `GET /api/prices` and `GET /api/price`. */
export const PRICES_CACHE_TTL_DEFAULT_SECONDS = 30;

/** Env variable controlling the public cache TTL of the platform counters. */
export const STATS_CACHE_TTL_ENV = "STATS_CACHE_TTL_SECONDS";

/**
 * Default TTL (seconds) for `GET /api/stats`.
 *
 * Deliberately short: the counters change on every round resolution, so a
 * long shared TTL would let a CDN pin stale numbers on the landing page.
 */
export const STATS_CACHE_TTL_DEFAULT_SECONDS = 5;

/** Resolved TTL (seconds) for the price endpoints. */
export function pricesCacheTtlSeconds(): number {
  return resolveCacheTtlSeconds(
    PRICES_CACHE_TTL_ENV,
    PRICES_CACHE_TTL_DEFAULT_SECONDS,
  );
}

/** Resolved TTL (seconds) for the platform counters. */
export function statsCacheTtlSeconds(): number {
  return resolveCacheTtlSeconds(
    STATS_CACHE_TTL_ENV,
    STATS_CACHE_TTL_DEFAULT_SECONDS,
  );
}

/** Prevent browsers and shared proxies from retaining private or health data. */
export function setNoStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

export function noStoreHeaders(_req: Request, res: Response, next: NextFunction): void {
  setNoStore(res);
  next();
}

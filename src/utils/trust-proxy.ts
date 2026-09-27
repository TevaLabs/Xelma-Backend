/**
 * `trust proxy` resolution from the environment.
 *
 * Behind Render (or any load balancer) the socket peer is the proxy, not the
 * user, so `req.ip` — and therefore every per-IP rate limit — buckets the whole
 * internet into one counter. Express ignores `X-Forwarded-For` entirely until
 * `app.set('trust proxy', …)` declares the hop trustworthy, so the setting is
 * opt-in and resolved here instead of being hard-coded.
 *
 * `TRUST_PROXY` accepts:
 *   unset / false / off / 0  — trust nothing (default; local dev, tests)
 *   1, 2, 3 …                — trust that many hops back from the socket
 *   true                     — trust every hop (see the warning below)
 *   loopback, 10.0.0.0/8, …  — proxy-addr trust string (IP/CIDR/name list)
 *
 * **Use a hop count, not `true`.** `true` reads the left-most
 * `X-Forwarded-For` entry, which a client controls, so anyone could forge the
 * address the rate limiters bucket on and bypass every per-IP limit. A hop
 * count reads only the entries appended by hops you actually operate.
 *
 * Render-safe value: `TRUST_PROXY=1` — Render's edge is exactly one proxy hop
 * in front of the service. Add a CDN or Cloudflare in front of Render and
 * raise it to the real hop count (`2`).
 */

import type { Application } from 'express';
import logger from './logger';

/** Anything Express accepts for `app.set('trust proxy', …)`. */
export type TrustProxySetting = boolean | number | string;

const TRUTHY = new Set(['true', 'on', 'yes', 'enable', 'enabled']);
const FALSY = new Set(['false', 'off', 'no', 'disable', 'disabled', 'none', '0']);
// proxy-addr's trust-string grammar: comma-separated IPv4/IPv6 addresses, CIDR
// ranges, and the named ranges Express understands. Anything else is a typo,
// not a subnet, and must not be handed to Express.
const ADDRESS_LIKE = /^[0-9a-fA-F.:/,\s]+$/;
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * Turn a raw `TRUST_PROXY` value into the Express setting.
 *
 * Pure and side-effect free: an unset or unrecognised value resolves to
 * `false`, so the safe behaviour is always the fallback. Anything that is
 * explicitly disabled (`false`, `off`, `0`, …) also resolves to `false` and is
 * distinguishable from a typo only by comparing the raw value — see
 * {@link applyTrustProxy}.
 */
export function resolveTrustProxy(raw: string | undefined = process.env.TRUST_PROXY): TrustProxySetting {
  const value = (raw ?? '').trim();
  if (value === '') return false;

  const lowered = value.toLowerCase();
  if (FALSY.has(lowered)) return false;
  if (TRUTHY.has(lowered)) return true;

  if (/^\d+$/.test(value)) {
    const hops = Number.parseInt(value, 10);
    // 0 hops means "trust nobody", which is exactly "off".
    return hops > 0 ? hops : false;
  }

  const candidates = value.split(',').map((part) => part.trim()).filter(Boolean);
  const isTrustString =
    candidates.length > 0 &&
    candidates.every((part) => NAMED_RANGES.has(part.toLowerCase()) || ADDRESS_LIKE.test(part));

  return isTrustString ? value : false;
}

/** Whether a resolved setting makes Express read `X-Forwarded-For`. */
export function trustsForwardedFor(value: TrustProxySetting): boolean {
  if (value === false) return false;
  if (typeof value === 'number') return value > 0;
  return String(value).trim() !== '';
}

/**
 * Apply the resolved setting to an Express app and log what was decided.
 *
 * Called once per app from `createApp` (src/app-factory.ts) so both
 * entrypoints — production and hackathon — share one answer. Returns the
 * resolved value so callers (and tests) can assert on it.
 */
export function applyTrustProxy(
  app: Application,
  raw: string | undefined = process.env.TRUST_PROXY,
): TrustProxySetting {
  const configured = (raw ?? '').trim();
  const value = resolveTrustProxy(raw);
  app.set('trust proxy', value);

  if (trustsForwardedFor(value)) {
    logger.info('Trust proxy enabled: req.ip resolves to the forwarded client IP', {
      TRUST_PROXY: configured,
      resolved: value === true ? 'all' : value,
    });
    return value;
  }

  if (configured !== '' && !FALSY.has(configured.toLowerCase())) {
    // A typo must not silently degrade to "trust nothing" on a proxied deploy.
    logger.warn(
      'TRUST_PROXY is set to an unrecognised value — trusting nothing. Use a hop count ' +
        '(e.g. TRUST_PROXY=1 behind Render), true/false, or a proxy-addr trust string ' +
        '(e.g. loopback, 10.0.0.0/8).',
      { TRUST_PROXY: configured },
    );
  } else if (process.env.NODE_ENV === 'production') {
    logger.warn(
      'TRUST_PROXY is unset: req.ip is the reverse proxy, so every per-IP rate limit ' +
        'buckets by the proxy address instead of the client. Behind Render set TRUST_PROXY=1.',
    );
  }

  return value;
}

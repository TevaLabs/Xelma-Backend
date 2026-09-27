/**
 * TRUST_PROXY: per-IP rate limits must bucket by the real client behind a proxy.
 *
 * Behind Render the socket peer is the load balancer, so without
 * `app.set('trust proxy', …)` `req.ip` is the proxy address and every visitor
 * shares one limiter bucket. These tests pin the three halves of the fix:
 * the value is configurable (and defaults to off), the app factory applies it,
 * and both `req.ip` and the rate-limit key then follow `X-Forwarded-For`.
 */

import express from 'express';
import type { Application } from 'express';
import request from 'supertest';

// The 429 path records a hit in Prisma; this is a unit test with no database,
// so keep the recorder in memory.
jest.mock('../services/rate-limit-metrics.service', () => ({
  RateLimitMetricsService: { recordHit: () => undefined },
  rateLimitMetricsService: { recordHit: () => Promise.resolve() },
}));

import {
  applyTrustProxy,
  resolveTrustProxy,
  trustsForwardedFor,
} from '../utils/trust-proxy';

const CLIENT_A = '203.0.113.10';
const CLIENT_B = '198.51.100.20';
const SPOOFED = '192.0.2.99';

const ENV_KEYS = [
  'TRUST_PROXY',
  'RATE_LIMIT_WRITE_MAX',
  'RATE_LIMIT_WRITE_WINDOW_MS',
  'REDIS_URL',
] as const;

const originalEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));

function setEnv(patch: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// The rate limiter reads its policy at module load, so the small window and the
// in-process store have to be in place before the module below is required.
// (Redis configured would merge the counters of both limiter fixtures in this
// file, since they would share one counter namespace.)
setEnv({
  RATE_LIMIT_WRITE_MAX: '1',
  RATE_LIMIT_WRITE_WINDOW_MS: '60000',
  REDIS_URL: '',
});

/* eslint-disable @typescript-eslint/no-var-requires */
const { createApp } = require('../app-factory');
const { writeRateLimiter, getRateLimitIp } = require('../middleware/rateLimiter.middleware');
/* eslint-enable @typescript-eslint/no-var-requires */

/** Factory-built app with one route that reports what Express resolved. */
function factoryAppReportingIp(): Application {
  const app = createApp({ mode: 'full', includeErrorHandlers: false });
  app.get('/__client-ip', (req, res) => {
    res.json({ ip: req.ip });
  });
  return app;
}

/** Minimal app with a single write-limited route, trusting the configured proxy hops. */
function writeLimitedApp(): Application {
  const app = express();
  applyTrustProxy(app);
  app.post('/w', writeRateLimiter, (_req, res) => res.sendStatus(200));
  return app;
}

const post = (app: Application, forwardedFor: string) =>
  request(app).post('/w').set('X-Forwarded-For', forwardedFor);

describe('trust proxy', () => {
  afterEach(() => {
    delete process.env.TRUST_PROXY;
  });

  afterAll(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('resolveTrustProxy', () => {
    it.each([
      [undefined, false],
      ['', false],
      ['   ', false],
      ['false', false],
      ['off', false],
      ['no', false],
      ['0', false],
      ['1', 1],
      ['2', 2],
      ['10', 10],
      ['true', true],
      ['yes', true],
      ['loopback', 'loopback'],
      ['10.0.0.0/8', '10.0.0.0/8'],
      ['loopback, 10.0.0.0/8', 'loopback, 10.0.0.0/8'],
    ])('resolves TRUST_PROXY=%p to %p', (raw, expected) => {
      expect(resolveTrustProxy(raw as string | undefined)).toEqual(expected);
    });

    it('falls back to trusting nothing when the value is a typo', () => {
      // Never hand an unparsed string to Express: a bad value must degrade to
      // the safe default, not to trusting arbitrary forwarded headers.
      expect(resolveTrustProxy('enabled-ish')).toBe(false);
      expect(resolveTrustProxy('*')).toBe(false);
    });

    it('reports whether a resolved setting trusts X-Forwarded-For', () => {
      expect(trustsForwardedFor(resolveTrustProxy(undefined))).toBe(false);
      expect(trustsForwardedFor(resolveTrustProxy('false'))).toBe(false);
      expect(trustsForwardedFor(resolveTrustProxy('1'))).toBe(true);
      expect(trustsForwardedFor(resolveTrustProxy('true'))).toBe(true);
    });
  });

  describe('applyTrustProxy', () => {
    it('sets the Express setting from the resolved value', () => {
      const oneHop = express();
      expect(applyTrustProxy(oneHop, '1')).toBe(1);
      expect(oneHop.get('trust proxy')).toBe(1);

      const all = express();
      expect(applyTrustProxy(all, 'true')).toBe(true);
      expect(all.get('trust proxy')).toBe(true);
    });

    it('leaves trust proxy disabled by default so local dev and tests are unaffected', () => {
      const app = express();
      expect(applyTrustProxy(app, undefined)).toBe(false);
      expect(app.get('trust proxy')).toBe(false);
    });
  });

  describe('app factory wiring', () => {
    it('trusts the configured proxy hops', () => {
      setEnv({ TRUST_PROXY: '1' });
      expect(createApp().get('trust proxy')).toBe(1);

      setEnv({ TRUST_PROXY: '2' });
      expect(createApp().get('trust proxy')).toBe(2);
    });

    it('does not enable trust proxy when TRUST_PROXY is unset (test/local default)', () => {
      delete process.env.TRUST_PROXY;
      expect(createApp().get('trust proxy')).toBe(false);
    });
  });

  describe('req.ip behind a proxy', () => {
    it('resolves req.ip from X-Forwarded-For when trust proxy is enabled', async () => {
      setEnv({ TRUST_PROXY: '1' });
      const app = factoryAppReportingIp();

      const res = await request(app).get('/__client-ip').set('X-Forwarded-For', CLIENT_A);

      expect(res.status).toBe(200);
      expect(res.body.ip).toBe(CLIENT_A);
    });

    it('ignores X-Forwarded-For when trust proxy is disabled', async () => {
      delete process.env.TRUST_PROXY;
      const app = factoryAppReportingIp();

      const res = await request(app).get('/__client-ip').set('X-Forwarded-For', CLIENT_A);

      expect(res.status).toBe(200);
      // The socket peer, not the header — this is the bucket-everyone-together case.
      expect(res.body.ip).not.toBe(CLIENT_A);
    });

    it('counts hops, so a client-supplied left-most entry is not trusted', async () => {
      // Render appends the real client to X-Forwarded-For; anything to the left
      // of it was supplied by the client and must not decide req.ip.
      setEnv({ TRUST_PROXY: '1' });
      const oneHop = await request(factoryAppReportingIp())
        .get('/__client-ip')
        .set('X-Forwarded-For', `${SPOOFED}, ${CLIENT_A}`);
      expect(oneHop.body.ip).toBe(CLIENT_A);

      // One extra trusted hop (a CDN in front of Render) shifts the window by
      // exactly one entry — the spoofed entry is still skipped.
      setEnv({ TRUST_PROXY: '2' });
      const twoHops = await request(factoryAppReportingIp())
        .get('/__client-ip')
        .set('X-Forwarded-For', `${SPOOFED}, ${CLIENT_A}, 198.51.100.1`);
      expect(twoHops.body.ip).toBe(CLIENT_A);
    });
  });

  describe('rate-limit key', () => {
    it('uses the forwarded client IP when trust proxy is enabled', async () => {
      setEnv({ TRUST_PROXY: '1' });
      const app = writeLimitedApp();

      // Exhaust the window for one forwarded client, then confirm a different
      // forwarded client is unaffected — i.e. the key is the client IP, not the
      // proxy address and not a single shared bucket.
      expect((await post(app, CLIENT_A)).status).toBe(200);
      expect((await post(app, CLIENT_A)).status).toBe(429);
      expect((await post(app, CLIENT_B)).status).toBe(200);
      expect((await post(app, CLIENT_B)).status).toBe(429);
    });

    it('falls back to the socket address when trust proxy is disabled', async () => {
      delete process.env.TRUST_PROXY;
      const app = writeLimitedApp();

      expect((await post(app, CLIENT_A)).status).toBe(200);
      // Different header, same proxy socket: without TRUST_PROXY the second
      // request is throttled anyway, which is the shared-bucket bug.
      expect((await post(app, CLIENT_B)).status).toBe(429);
    });

    it('derives the limiter IP from req.ip, never from the raw header', () => {
      expect(getRateLimitIp({ ip: CLIENT_A } as never)).toBe(CLIENT_A);
      expect(getRateLimitIp({} as never)).toBe('unknown');
    });
  });
});

/**
 * Credential redaction in HTTP logs (Issue #886).
 *
 * The http request log entry carries a redacted copy of the request headers,
 * and the full app's error log redacts sensitive query parameters. These tests
 * capture every logger call and assert that raw credentials never reach the
 * log sink, while the request the route handlers see is left untouched.
 *
 * Run:  npx jest src/tests/http-logger-redaction.spec.ts
 */

import { describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import express, { Request, Response } from 'express';
import request from 'supertest';
import {
  REDACTED,
  SENSITIVE_HEADERS,
  redactUrl,
  sanitizeHeaders,
} from '../utils/log-redaction.util';
import { httpLoggerMiddleware } from '../middleware/httpLogger.middleware';

// Must be set before either app (and therefore src/config) is imported below,
// so /metrics authenticates through requireMetricsAuth's Bearer comparison.
const METRICS_TOKEN = 'metrics-scrape-token-886-do-not-log';
process.env.METRICS_SCRAPE_TOKEN = METRICS_TOKEN;

const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
const mockLogError = jest.fn();

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: (...args: any[]) => mockLogInfo(...args),
    warn: (...args: any[]) => mockLogWarn(...args),
    error: (...args: any[]) => mockLogError(...args),
    debug: jest.fn(),
  },
}));

// Mocks required to import both app entrypoints without a database or
// Soroban, matching src/tests/http-logger-unified.spec.ts.
jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: { getActiveRound: jest.fn().mockResolvedValue(null), isReady: jest.fn().mockReturnValue(false) },
}));

jest.mock('../services/round.service', () => ({
  __esModule: true,
  default: { getRoundsForApi: jest.fn().mockResolvedValue({ source: 'mock', rounds: [] }) },
}));

jest.mock('../middleware/rateLimiter.middleware', () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return {
    apiRateLimiter: pass,
    writeRateLimiter: pass,
    betRateLimiter: pass,
    adminRoundRateLimiter: pass,
    oracleResolveRateLimiter: pass,
    challengeRateLimiter: pass,
    connectRateLimiter: pass,
    authRateLimiter: pass,
    chatMessageRateLimiter: pass,
    predictionRateLimiter: pass,
    batchPredictionRateLimiter: pass,
    batchLeaderboardRateLimiter: pass,
  };
});

jest.mock('../lib/prisma', () => ({ prisma: {} }));

// The first import of an app entrypoint compiles the whole route tree under
// ts-jest, which can exceed the 30s per-test timeout on a cold cache. Load the
// apps in beforeAll with a longer budget so the assertions themselves stay fast.
const APP_IMPORT_TIMEOUT_MS = 120_000;

const SECRET_JWT = 'eyJhbGciOiJIUzI1NiJ9.secret-payload-886.secret-signature-886';

/** Every argument passed to any logger level, serialized. */
function allLogOutput(): string {
  return JSON.stringify([
    ...mockLogInfo.mock.calls,
    ...mockLogWarn.mock.calls,
    ...mockLogError.mock.calls,
  ]);
}

function getLastHttpLog(): Record<string, any> {
  const calls = mockLogInfo.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0] === 'http request') return calls[i][1];
  }
  throw new Error('no http request log entry was emitted');
}

/** Minimal app: the real logger middleware in front of an echo route. */
function buildEchoApp() {
  const app = express();
  app.use(httpLoggerMiddleware);
  app.get('/echo', (req: Request, res: Response) => {
    res.json({ authorization: req.headers.authorization ?? null, headers: req.headers });
  });
  return app;
}

describe('sanitizeHeaders', () => {
  it('replaces every listed credential header and keeps the key', () => {
    const input: Record<string, string> = {};
    for (const name of SENSITIVE_HEADERS) input[name] = `secret-for-${name}`;

    const out = sanitizeHeaders(input);

    for (const name of SENSITIVE_HEADERS) {
      expect(out).toHaveProperty(name, REDACTED);
    }
    expect(JSON.stringify(out)).not.toContain('secret-for-');
  });

  it('matches header names case-insensitively', () => {
    const out = sanitizeHeaders({
      authorization: `Bearer ${SECRET_JWT}`,
      AUTHORIZATION: `Bearer ${SECRET_JWT}`,
      Authorization: `Bearer ${SECRET_JWT}`,
      'X-Api-Key': 'k1',
      COOKIE: 'sid=abc',
    });

    expect(out).toEqual({
      authorization: REDACTED,
      AUTHORIZATION: REDACTED,
      Authorization: REDACTED,
      'X-Api-Key': REDACTED,
      COOKIE: REDACTED,
    });
  });

  it('redacts each element of array values', () => {
    const out = sanitizeHeaders({
      'set-cookie': ['sid=abc; HttpOnly', 'refresh=def; HttpOnly'],
      'x-forwarded-for': ['10.0.0.1', '10.0.0.2'],
    });

    expect(out['set-cookie']).toEqual([REDACTED, REDACTED]);
    expect(out['x-forwarded-for']).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('redacts credential-scheme values found in unlisted headers', () => {
    const out = sanitizeHeaders({
      'x-upstream-auth': `Bearer ${SECRET_JWT}`,
      'x-forwarded-authorization': 'Basic dXNlcjpwYXNz',
      'x-multi': ['plain', `bearer ${SECRET_JWT}`],
      'user-agent': 'jest',
    });

    expect(out['x-upstream-auth']).toBe(REDACTED);
    expect(out['x-forwarded-authorization']).toBe(REDACTED);
    expect(out['x-multi']).toEqual(['plain', REDACTED]);
    expect(out['user-agent']).toBe('jest');
  });

  it('leaves non-sensitive headers, numbers and undefined values untouched', () => {
    const input = {
      'content-type': 'application/json',
      'content-length': 42 as unknown as string,
      'x-request-id': 'req-1',
      'idempotency-key': 'idem-1',
      'x-missing': undefined,
    };

    expect(sanitizeHeaders(input)).toEqual(input);
  });

  it('returns a copy and never mutates the input', () => {
    const input = { authorization: `Bearer ${SECRET_JWT}`, 'set-cookie': ['a=1'] };
    const snapshot = JSON.parse(JSON.stringify(input));

    const out = sanitizeHeaders(input);

    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(out['set-cookie']).not.toBe(input['set-cookie']);
  });

  it('handles missing header objects', () => {
    expect(sanitizeHeaders(undefined)).toEqual({});
    expect(sanitizeHeaders(null)).toEqual({});
  });
});

describe('redactUrl', () => {
  it('returns URLs without a query string unchanged', () => {
    expect(redactUrl('/api/rounds')).toBe('/api/rounds');
    expect(redactUrl('/api/rounds#frag')).toBe('/api/rounds#frag');
  });

  it('redacts sensitive params and keeps the rest of the URL readable', () => {
    expect(redactUrl('/api/rounds?limit=10&token=abc&page=2')).toBe(
      `/api/rounds?limit=10&token=${REDACTED}&page=2`,
    );
  });

  it.each([
    'token',
    'access_token',
    'accessToken',
    'refresh_token',
    'id_token',
    'api_key',
    'apikey',
    'API-KEY',
    'key',
    'jwt',
    'secret',
    'client_secret',
    'password',
    'signature',
    'sig',
  ])('redacts the %s param', (param) => {
    const out = redactUrl(`/x?${param}=s3cr3t-value&ok=1`);
    expect(out).toBe(`/x?${param}=${REDACTED}&ok=1`);
  });

  it('redacts repeated and URL-encoded param names', () => {
    expect(redactUrl('/x?token=a&token=b')).toBe(`/x?token=${REDACTED}&token=${REDACTED}`);
    expect(redactUrl('/x?access%5Ftoken=abc')).toBe(`/x?access%5Ftoken=${REDACTED}`);
  });

  it('preserves the fragment, empty pairs and valueless flags', () => {
    expect(redactUrl('/x?token=abc&&flag#section')).toBe(`/x?token=${REDACTED}&&flag#section`);
  });

  it('does not throw on malformed percent-encoding', () => {
    expect(redactUrl('/x?%E0%A4%A=1&token=abc')).toBe(`/x?%E0%A4%A=1&token=${REDACTED}`);
  });
});

describe('httpLoggerMiddleware redaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs Authorization: Bearer <secret> as [REDACTED] and the secret appears nowhere', async () => {
    await request(buildEchoApp()).get('/echo').set('Authorization', `Bearer ${SECRET_JWT}`);

    const log = getLastHttpLog();
    expect(log.headers.authorization).toBe(REDACTED);
    expect(allLogOutput()).not.toContain(SECRET_JWT);
    expect(allLogOutput()).not.toContain('secret-payload-886');
  });

  it.each(['authorization', 'AUTHORIZATION', 'Authorization', 'aUtHoRiZaTiOn'])(
    'redacts the %s header name variant',
    async (headerName) => {
      await request(buildEchoApp()).get('/echo').set(headerName, `Bearer ${SECRET_JWT}`);

      const log = getLastHttpLog();
      expect(log.headers.authorization).toBe(REDACTED);
      expect(allLogOutput()).not.toContain(SECRET_JWT);
    },
  );

  it('redacts cookie, x-api-key and the other listed headers', async () => {
    await request(buildEchoApp())
      .get('/echo')
      .set('Cookie', 'session=cookie-secret-886')
      .set('X-API-Key', 'api-key-secret-886')
      .set('Proxy-Authorization', 'Basic cHJveHktc2VjcmV0LTg4Ng==')
      .set('X-Auth-Token', 'auth-token-secret-886')
      .set('X-Access-Token', 'access-token-secret-886');

    const { headers } = getLastHttpLog();
    expect(headers.cookie).toBe(REDACTED);
    expect(headers['x-api-key']).toBe(REDACTED);
    expect(headers['proxy-authorization']).toBe(REDACTED);
    expect(headers['x-auth-token']).toBe(REDACTED);
    expect(headers['x-access-token']).toBe(REDACTED);
    expect(allLogOutput()).not.toMatch(/secret-886|cHJveHktc2VjcmV0LTg4Ng/);
  });

  it('redacts every element of an array-valued header', async () => {
    await request(buildEchoApp())
      .get('/echo')
      .set('Set-Cookie', ['sid=first-cookie-886', 'refresh=second-cookie-886']);

    const { headers } = getLastHttpLog();
    expect(headers['set-cookie']).toEqual([REDACTED, REDACTED]);
    expect(allLogOutput()).not.toContain('cookie-886');
  });

  it('logs requests without sensitive headers exactly as before', async () => {
    const res = await request(buildEchoApp())
      .get('/echo?limit=5')
      .set('X-Request-ID', 'plain-request-1')
      .set('User-Agent', 'redaction-spec');

    const log = getLastHttpLog();
    expect(Object.keys(log).sort()).toEqual(
      ['durationMs', 'headers', 'method', 'path', 'requestId', 'status'].sort(),
    );
    expect(log.method).toBe('GET');
    expect(log.path).toBe('/echo');
    expect(log.status).toBe(200);
    expect(typeof log.durationMs).toBe('number');
    // Nothing to redact: the logged headers are exactly what the route saw.
    expect(log.headers).toEqual(res.body.headers);
    expect(JSON.stringify(log.headers)).not.toContain(REDACTED);
  });

  it('leaves req.headers.authorization intact for downstream handlers', async () => {
    const res = await request(buildEchoApp())
      .get('/echo')
      .set('Authorization', `Bearer ${SECRET_JWT}`)
      .set('Cookie', 'session=cookie-secret-886');

    expect(res.body.authorization).toBe(`Bearer ${SECRET_JWT}`);
    expect(res.body.headers.cookie).toBe('session=cookie-secret-886');
    expect(getLastHttpLog().headers.authorization).toBe(REDACTED);
  });
});

describe.each([
  ['production app (src/index.ts)', '../index'],
  ['hackathon app (src/app.ts)', '../app'],
])('redaction through the %s', (_label, modulePath) => {
  let createApp: () => express.Application;

  beforeAll(async () => {
    ({ createApp } = await import(modulePath));
  }, APP_IMPORT_TIMEOUT_MS);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('authenticates /metrics with the real token but logs it as [REDACTED]', async () => {
    const app = createApp();

    const res = await request(app)
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .set('Cookie', 'session=cookie-secret-886');

    // 200 proves requireMetricsAuth received the unredacted header.
    expect(res.status).toBe(200);

    const log = getLastHttpLog();
    expect(log.path).toBe('/metrics');
    expect(log.headers.authorization).toBe(REDACTED);
    expect(log.headers.cookie).toBe(REDACTED);
    expect(allLogOutput()).not.toContain(METRICS_TOKEN);
    expect(allLogOutput()).not.toContain('cookie-secret-886');
  });

  it('never logs a bearer token sent to an API route', async () => {
    const app = createApp();

    await request(app)
      .get('/api/rounds?token=query-secret-886')
      .set('Authorization', `Bearer ${SECRET_JWT}`)
      .set('X-API-Key', 'api-key-secret-886');

    const log = getLastHttpLog();
    expect(log.path).toBe('/api/rounds');
    expect(log.headers.authorization).toBe(REDACTED);
    expect(log.headers['x-api-key']).toBe(REDACTED);
    expect(allLogOutput()).not.toContain(SECRET_JWT);
    expect(allLogOutput()).not.toContain('secret-886');
  });
});

describe('error log redaction (src/index.ts error handler)', () => {
  let createApp: () => express.Application;

  beforeAll(async () => {
    ({ createApp } = await import('../index'));
  }, APP_IMPORT_TIMEOUT_MS);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('redacts sensitive query params in the logged path', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/api/rounds?access_token=query-secret-886&limit=5')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${SECRET_JWT}`)
      .send('{ not json');

    expect(res.status).toBe(400);

    const errorCall = mockLogError.mock.calls.find(
      (call) => typeof call[1] === 'object' && call[1]?.path?.startsWith('/api/rounds'),
    );
    expect(errorCall).toBeDefined();
    expect(errorCall![1].path).toBe(`/api/rounds?access_token=${REDACTED}&limit=5`);
    expect(allLogOutput()).not.toContain('query-secret-886');
    expect(allLogOutput()).not.toContain(SECRET_JWT);
  });
});

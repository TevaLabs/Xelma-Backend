/**
 * 429 backoff contract: `Retry-After` must be present on every rate-limited
 * response and must report the time left in the limiter window. Hackathon
 * clients retry immediately without it and amplify load.
 *
 * Uses the real `betRateLimiter` against a bare Express app (no DB): the limiter,
 * its store, and the 429 handler are the code under test.
 */
import { describe, expect, it } from '@jest/globals';
import express from 'express';
import type { Request } from 'express';
import request from 'supertest';

// Pin a small cap and a window that comfortably outlives this suite. The
// policies are read from the environment when the module loads, so the env has
// to be set *before* the require below.
process.env.RATE_LIMIT_BET_MAX = '2';
process.env.RATE_LIMIT_BET_WINDOW_MS = '20000';

const rateLimiter = require('../middleware/rateLimiter.middleware') as typeof import('../middleware/rateLimiter.middleware');
const { betRateLimiter, RATE_LIMIT_POLICIES, resolveRetryAfterSeconds } = rateLimiter;

const WINDOW_SECONDS = Math.ceil(RATE_LIMIT_POLICIES.bet.windowMs / 1000);

/** Shape of a supertest response this suite asserts on. */
type TestResponse = {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

function makeLimitedApp(): express.Express {
  const app = express();
  app.post('/api/bets/up-down', betRateLimiter, (_req, res) => {
    res.json({ success: true });
  });
  return app;
}

/** Hammer the limiter from a single IP until it answers 429. */
async function tripLimiter(): Promise<TestResponse> {
  const app = makeLimitedApp();
  let response: TestResponse | undefined;

  for (let attempt = 0; attempt <= RATE_LIMIT_POLICIES.bet.max; attempt += 1) {
    response = (await request(app).post('/api/bets/up-down').send({})) as unknown as TestResponse;
    if (response.status === 429) return response;
  }

  throw new Error(
    `betRateLimiter never returned 429 after ${RATE_LIMIT_POLICIES.bet.max + 1} requests`,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stand-in for the request express-rate-limit decorates with window info. */
function requestWithWindow(rateLimit?: unknown): Request {
  return { rateLimit } as unknown as Request;
}

describe('rate limiter Retry-After contract', () => {
  it('sets Retry-After in seconds on a 429 and mirrors it in the body', async () => {
    const limited = await tripLimiter();

    expect(limited.status).toBe(429);

    const retryAfterHeader = limited.headers['retry-after'];
    expect(retryAfterHeader).toBeDefined();
    expect(retryAfterHeader).toMatch(/^\d+$/);
    expect(Number(retryAfterHeader)).toBeGreaterThanOrEqual(1);
    expect(Number(retryAfterHeader)).toBeLessThanOrEqual(WINDOW_SECONDS);

    // Envelope unchanged: error + message + retryAfter, nothing else.
    expect(limited.body).toEqual({
      error: 'Too Many Requests',
      message: expect.any(String),
      retryAfter: Number(retryAfterHeader),
    });
  });

  it('reports the window time remaining, not the full window', async () => {
    await tripLimiter();

    const before = Number((await tripLimiter()).headers['retry-after']);

    await sleep(1200);

    const after = Number((await tripLimiter()).headers['retry-after']);

    // The window kept counting down while we waited, so the advertised backoff
    // shrank by at least the second we slept through.
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(1);
  });

  it('derives the backoff from the limiter window reset time', () => {
    const req = requestWithWindow({ resetTime: new Date(Date.now() + 30_000) });
    expect(resolveRetryAfterSeconds(req, 60_000)).toBe(30);
  });

  it('clamps an already expired window to 1 second instead of 0', () => {
    const req = requestWithWindow({ resetTime: new Date(Date.now() - 5_000) });
    expect(resolveRetryAfterSeconds(req, 60_000)).toBe(1);
  });

  it('falls back to the configured window when the store reports no reset time', () => {
    expect(resolveRetryAfterSeconds(requestWithWindow(), 60_000)).toBe(60);
    expect(resolveRetryAfterSeconds(requestWithWindow({ resetTime: 'not-a-date' }), 60_000)).toBe(
      60,
    );
  });
});

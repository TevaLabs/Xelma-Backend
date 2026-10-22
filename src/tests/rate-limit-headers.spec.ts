/**
 * Every limiter (chat included) must emit the same RateLimit-* headers and no
 * legacy X-RateLimit-* headers, on both allowed and 429 responses.
 */
import express from 'express';
import request from 'supertest';
import * as limiters from '../middleware/rateLimiter.middleware';

jest.mock('../lib/prisma', () => ({ prisma: {} }));

const limiterNames = Object.keys(limiters).filter((k) =>
  k.endsWith('RateLimiter'),
) as Array<keyof typeof limiters>;

describe('RateLimit header standardization', () => {
  it('discovers the chat limiter among the limiters', () => {
    expect(limiterNames).toContain('chatMessageRateLimiter');
  });

  it.each(limiterNames)('%s sets RateLimit-* and no X-RateLimit-*', async (name) => {
    const app = express();
    app.set('trust proxy', false);
    app.use((req, _res, next) => {
      (req as any).user = { userId: `user-${String(name)}` };
      next();
    });
    app.all('/t', (limiters as any)[name], (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).post('/t');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(res.headers['ratelimit-remaining']).toBeDefined();
    expect(res.headers['ratelimit-reset']).toBeDefined();
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
  });

  it('chat limiter keeps RateLimit-* and sets Retry-After on 429', async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).user = { userId: 'chat-429-user' };
      next();
    });
    app.post('/chat', limiters.chatMessageRateLimiter, (_req, res) => {
      res.json({ ok: true });
    });

    let last = await request(app).post('/chat');
    for (let i = 0; i < 5; i++) last = await request(app).post('/chat');

    expect(last.status).toBe(429);
    expect(last.headers['ratelimit-limit']).toBe('5');
    expect(last.headers['ratelimit-remaining']).toBe('0');
    expect(last.headers['ratelimit-reset']).toBeDefined();
    expect(last.headers['retry-after']).toBeDefined();
    expect(last.headers['x-ratelimit-limit']).toBeUndefined();
  });
});

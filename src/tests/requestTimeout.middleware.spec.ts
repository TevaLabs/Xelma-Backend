import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { requestIdMiddleware } from '../middleware/requestId.middleware';
import { requestTimeoutMiddleware } from '../middleware/requestTimeout.middleware';

function createTestApp(timeoutMs: number) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(requestTimeoutMiddleware(timeoutMs));
  return app;
}

describe('requestTimeoutMiddleware', () => {
  it('returns a requestId-bearing 504 envelope when a route exceeds the deadline', async () => {
    const app = createTestApp(15);
    app.get('/slow', async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!res.writableEnded) res.json({ ok: true });
    });

    const response = await request(app).get('/slow').set('X-Request-ID', 'slow-request-1');

    expect(response.status).toBe(504);
    expect(response.headers['x-request-id']).toBe('slow-request-1');
    expect(response.headers.connection).toBe('close');
    expect(response.body).toMatchObject({
      error: 'Request timed out',
      message: 'Request timed out',
      code: 'REQUEST_TIMEOUT',
      path: '/slow',
      requestId: 'slow-request-1',
    });
    expect(response.body.timestamp).toEqual(expect.any(String));
  });

  it('does not apply the general deadline to health endpoints', async () => {
    const app = createTestApp(5);
    app.get('/health', async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      res.json({ status: 'healthy' });
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'healthy' });
  });
});
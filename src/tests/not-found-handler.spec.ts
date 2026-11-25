import { describe, it, expect, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { notFoundHandler } from '../middleware/notFound';

describe('notFoundHandler', () => {
  it('returns 404 with the standard error envelope', async () => {
    const app = express();
    app.use(notFoundHandler);

    const res = await request(app).get('/anything');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: 'NotFoundError',
      message: 'Route GET /anything not found',
      code: 'NOT_FOUND',
      path: '/anything',
    });
    expect(typeof res.body.timestamp).toBe('string');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('preserves the path segment, not the originalUrl', async () => {
    const app = express();
    app.use(notFoundHandler);

    const res = await request(app).get('/foo?q=bar');

    expect(res.status).toBe(404);
    expect(res.body.path).toBe('/foo');
  });

  it('includes requestId when set upstream on the request', async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).requestId = 'test-request-id';
      next();
    });
    app.use(notFoundHandler);

    const res = await request(app).get('/anything');

    expect(res.body.requestId).toBe('test-request-id');
  });

  it('omits requestId when not set upstream', async () => {
    const app = express();
    app.use(notFoundHandler);

    const res = await request(app).get('/anything');

    expect(res.body.requestId).toBeUndefined();
  });
});

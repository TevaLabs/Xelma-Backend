import { describe, it, expect, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { notFoundHandler } from '../middleware/notFound';

describe('notFoundHandler', () => {
  it('returns 404 with the matched path', async () => {
    const app = express();
    app.use(notFoundHandler);

    const res = await request(app).get('/anything');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: 'Not Found',
      path: '/anything',
    });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('preserves the path segment, not the originalUrl', async () => {
    const app = express();
    app.use(notFoundHandler);

    const res = await request(app).get('/foo?q=bar');

    expect(res.status).toBe(404);
    expect(res.body.path).toBe('/foo');
  });
});

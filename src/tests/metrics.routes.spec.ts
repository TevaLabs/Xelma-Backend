// Tests for the metrics readiness endpoint
import request from 'supertest';
import express from 'express';
import router from '../routes/metrics.routes';
import { checkSchemaReadiness } from '../services/schema-readiness.service';

jest.mock('../services/schema-readiness.service');

const app = express();
app.use('/', router);

const mockCheck = checkSchemaReadiness as jest.MockedFunction<typeof checkSchemaReadiness>;

describe('GET /readiness', () => {
  it('returns 200 when schema is compatible', async () => {
    const payload = {
      database: 'healthy' as const,
      schema: 'compatible' as const,
      appliedMigrations: 3,
      totalMigrations: 3,
      pendingMigrations: 0,
      pendingNames: [] as string[],
      ready: true,
    };
    mockCheck.mockResolvedValueOnce(payload);
    const res = await request(app).get('/readiness');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
  });

  it('returns 503 when pending migrations exist', async () => {
    const payload = {
      database: 'healthy' as const,
      schema: 'outdated' as const,
      appliedMigrations: 1,
      totalMigrations: 3,
      pendingMigrations: 2,
      pendingNames: ['20260130171720_add_wins_streak', '20260226000000_decimal_monetary_fields'],
      ready: false,
    };
    mockCheck.mockResolvedValueOnce(payload);
    const res = await request(app).get('/readiness');
    expect(res.status).toBe(503);
    expect(res.body).toEqual(payload);
  });

  it('returns 503 when database is unreachable', async () => {
    const payload = {
      database: 'unreachable' as const,
      schema: 'unknown' as const,
      appliedMigrations: 0,
      totalMigrations: 3,
      pendingMigrations: 3,
      pendingNames: ['20260130171459_init', '20260130171720_add_wins_streak', '20260226000000_decimal_monetary_fields'],
      ready: false,
    };
    mockCheck.mockResolvedValueOnce(payload);
    const res = await request(app).get('/readiness');
    expect(res.status).toBe(503);
    expect(res.body).toEqual(payload);
  });
});

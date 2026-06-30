import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';

jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (address: string) => address && address.startsWith('G') && address.length === 56,
  verifySignature: jest.fn(),
}));

jest.mock('../services/soroban.service', () => ({
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getHealth: jest.fn(),
}));

import { createApp } from '../app';

describe('Hackathon new routes', () => {
  const app = createApp();

  describe('GET /api/tournaments', () => {
    it('returns paginated tournament list', async () => {
      const res = await request(app).get('/api/tournaments?limit=10&offset=0');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.total).toBeGreaterThanOrEqual(1);
    });

    it('filters by status', async () => {
      const res = await request(app).get('/api/tournaments?status=ACTIVE');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.every((t: any) => t.status === 'ACTIVE')).toBe(true);
    });
  });

  describe('GET /api/tournaments/:id', () => {
    it('returns tournament detail for known id', async () => {
      const res = await request(app).get('/api/tournaments/t-001');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('t-001');
      expect(res.body.data.name).toBeDefined();
    });

    it('returns 404 for unknown id', async () => {
      const res = await request(app).get('/api/tournaments/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/user/profile', () => {
    it('requires authentication instead of returning 404', async () => {
      const res = await request(app).get('/api/user/profile');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/bets/up-down', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(app)
        .post('/api/bets/up-down')
        .send({ address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', amount: 10, side: 'UP' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/bets/precision', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(app)
        .post('/api/bets/precision')
        .send({ address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', amount: 5, predictedPrice: 0.12 });
      expect(res.status).toBe(401);
    });
  });
});

import { describe, expect, it, beforeAll } from '@jest/globals';
import express, { Express } from 'express';
import request from 'supertest';
import healthRoutes from '../routes/health';
import statsRoutes from '../routes/stats';

describe('health and platform stats routes', () => {
   let app: Express;

   beforeAll(() => {
      app = express();
      app.use('/api/health', healthRoutes);
      app.use('/api/stats', statsRoutes);
   });

   it('returns the lightweight API health probe shape', async () => {
      const before = Date.now();
      const res = await request(app).get('/api/health');
      const after = Date.now();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
         status: 'ok',
         timestamp: expect.any(Number),
      });
      expect(res.body.timestamp).toBeGreaterThanOrEqual(before);
      expect(res.body.timestamp).toBeLessThanOrEqual(after);
   });

   it('returns landing-page platform stats from mock data', async () => {
      const res = await request(app).get('/api/stats');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
         totalRounds: 1247,
         totalVxlmDistributed: 4200000,
         activePlayers: 893,
         totalBetsPlaced: 8432,
      });
   });
});

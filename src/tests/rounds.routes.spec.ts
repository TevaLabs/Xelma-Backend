import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../index';
import { generateToken } from '../utils/jwt.util';
import { Express } from 'express';

const ADMIN_ID = 'rounds-admin-id';
const mockUserFindUnique = jest.fn();
const mockStartRound = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/round.service', () => ({
  __esModule: true,
  default: {
    startRound: (...args: any[]) => mockStartRound(...args),
  },
}));

describe('Rounds Routes - Mode Validation (Issue #63)', () => {
  let app: Express;
  let adminUser: { id: string; walletAddress: string };
  let adminToken: string;

  beforeAll(async () => {
    app = createApp();

    adminUser = {
      id: ADMIN_ID,
      walletAddress: 'GADMIN_MODE_TEST_AAAAAAAAAAAAAAAAA',
    };
    adminToken = generateToken(adminUser.id, adminUser.walletAddress);

    mockUserFindUnique.mockResolvedValue({
      id: adminUser.id,
      walletAddress: adminUser.walletAddress,
      role: 'ADMIN',
    });

    mockStartRound.mockImplementation((mode: string, startPrice: number, duration: number) =>
      Promise.resolve({
        id: 'round-' + Date.now(),
        mode: mode === 'UP_DOWN' ? 'UP_DOWN' : 'LEGENDS',
        status: 'ACTIVE',
        startTime: new Date(),
        endTime: new Date(Date.now() + duration * 60 * 1000),
        startPrice,
        sorobanRoundId: null,
        priceRanges: mode === 'LEGENDS' ? [] : null,
      })
    );
  });

  afterAll(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/rounds/start - mode validation', () => {
    it('should accept mode=0 (UP_DOWN) without falsy rejection', async () => {
      const res = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: 0.1234,
          duration: 300,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.round).toBeDefined();
      expect(res.body.round.mode).toBe('UP_DOWN');
    });

    it('should accept mode=1 (LEGENDS)', async () => {
      const res = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 1,
          startPrice: 0.1234,
          duration: 300,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.round).toBeDefined();
      expect(res.body.round.mode).toBe('LEGENDS');
    });

    it('should reject mode=-1 as invalid', async () => {
      const res = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: -1,
          startPrice: 0.1234,
          duration: 300,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid mode');
    });

    it('should reject mode=2 as out of range', async () => {
      const res = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 2,
          startPrice: 0.1234,
          duration: 300,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid mode');
    });

    it('should reject mode as string', async () => {
      const res = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 'UP_DOWN',
          startPrice: 0.1234,
          duration: 300,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid mode');
    });

    it('should reject missing mode (undefined)', async () => {
      const res = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          startPrice: 0.1234,
          duration: 300,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid mode');
    });

    it('should reject mode=null', async () => {
      const res = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: null,
          startPrice: 0.1234,
          duration: 300,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid mode');
    });
  });

  describe('POST /api/rounds/start - startPrice and duration validation', () => {
    it('should reject startPrice=0 (edge case for falsy check)', async () => {
      const res = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: 0,
          duration: 300,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid start price');
    });

    it('should reject duration=0 (edge case for falsy check)', async () => {
      const res = await request(app)
        .post('/api/rounds/start')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          mode: 0,
          startPrice: 0.1234,
          duration: 0,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid duration');
    });
  });
});

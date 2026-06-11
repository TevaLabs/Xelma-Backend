import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../index';
import { generateToken } from '../utils/jwt.util';
import { Express } from 'express';
import { UserRole } from '@prisma/client';
import { createHash } from 'crypto';

const USER_A_ID = 'pred-user-a-id';
const USER_B_ID = 'pred-user-b-id';
const ROUND_ID = 'pred-test-round-id';

const mockUserFindUnique = jest.fn();
const mockIdempotencyFindUnique = jest.fn();
const mockIdempotencyUpsert = jest.fn();
const mockSubmitPrediction = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
    },
    idempotencyKey: {
      findUnique: (...args: any[]) => mockIdempotencyFindUnique(...args),
      upsert: (...args: any[]) => mockIdempotencyUpsert(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

function requestHash(body: any): string {
  const stableStringify = (value: any): string => {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value) ?? 'undefined';
    }
    if (Array.isArray(value)) {
      return `[${value.map(stableStringify).join(',')}]`;
    }
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  };
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

jest.mock('../services/prediction.service', () => ({
  __esModule: true,
  default: {
    submitPrediction: (...args: any[]) => mockSubmitPrediction(...args),
  },
}));

describe('Predictions Routes - Auth Identity Binding (Issue #64)', () => {
  let app: Express;
  let userA: { id: string; walletAddress: string };
  let userB: { id: string; walletAddress: string };
  let userAToken: string;
  let userBToken: string;
  let testRound: { id: string };

  beforeAll(async () => {
    app = createApp();

    userA = {
      id: USER_A_ID,
      walletAddress: 'GUSER_A_PRED_TEST_AAAAAAAAAAAAAAAA',
    };
    userB = {
      id: USER_B_ID,
      walletAddress: 'GUSER_B_PRED_TEST_BBBBBBBBBBBBBBBB',
    };
    userAToken = generateToken(userA.id, userA.walletAddress, UserRole.USER);
    userBToken = generateToken(userB.id, userB.walletAddress, UserRole.USER);

    mockUserFindUnique.mockImplementation((args: any) => {
      if (args?.where?.id === userA.id)
        return Promise.resolve({ id: userA.id, walletAddress: userA.walletAddress, role: UserRole.USER });
      if (args?.where?.id === userB.id)
        return Promise.resolve({ id: userB.id, walletAddress: userB.walletAddress, role: UserRole.USER });
      return Promise.resolve(null);
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserFindUnique.mockImplementation((args: any) => {
      if (args?.where?.id === userA.id)
        return Promise.resolve({ id: userA.id, walletAddress: userA.walletAddress, role: UserRole.USER });
      if (args?.where?.id === userB.id)
        return Promise.resolve({ id: userB.id, walletAddress: userB.walletAddress, role: UserRole.USER });
      return Promise.resolve(null);
    });
    mockIdempotencyFindUnique.mockResolvedValue(null);
    mockIdempotencyUpsert.mockResolvedValue({});
    testRound = { id: ROUND_ID + '-' + Date.now() };
    mockSubmitPrediction.mockResolvedValue({
      id: 'pred-' + Date.now(),
      roundId: testRound.id,
      userId: userA.id,
      amount: 100,
      side: 'UP',
      priceRange: null,
      createdAt: new Date(),
    });
  });

  afterAll(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/predictions/submit - user identity enforcement', () => {
    it('should use authenticated user ID (not body userId)', async () => {
      const res = await request(app)
        .post('/api/predictions/submit')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          roundId: testRound.id,
          amount: 100,
          side: 'UP',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.prediction).toBeDefined();
      expect(mockSubmitPrediction).toHaveBeenCalledWith(
        userA.id,
        testRound.id,
        100,
        'UP',
        undefined
      );
    });

    it('should ignore userId in request body if provided', async () => {
      const res = await request(app)
        .post('/api/predictions/submit')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          roundId: testRound.id,
          userId: userB.id,
          amount: 50,
          side: 'DOWN',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSubmitPrediction).toHaveBeenCalledWith(
        userA.id,
        testRound.id,
        50,
        'DOWN',
        undefined
      );
    });

    it('should prevent user from making predictions on behalf of others', async () => {
      const res = await request(app)
        .post('/api/predictions/submit')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          roundId: testRound.id,
          userId: userB.id,
          amount: 200,
          side: 'UP',
        });

      expect(res.status).toBe(200);
      expect(mockSubmitPrediction).toHaveBeenCalledWith(
        userA.id,
        testRound.id,
        200,
        'UP',
        undefined
      );
    });
  });

  describe('POST /api/predictions/submit - validation', () => {
    it('should reject missing roundId', async () => {
      const res = await request(app)
        .post('/api/predictions/submit')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          amount: 100,
          side: 'UP',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Round ID is required');
    });

    it('should reject missing amount', async () => {
      const res = await request(app)
        .post('/api/predictions/submit')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          roundId: testRound.id,
          side: 'UP',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid amount');
    });

    it('should reject invalid amount (negative)', async () => {
      const res = await request(app)
        .post('/api/predictions/submit')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          roundId: testRound.id,
          amount: -50,
          side: 'UP',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid amount');
    });

    it('should reject amount=0', async () => {
      const res = await request(app)
        .post('/api/predictions/submit')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          roundId: testRound.id,
          amount: 0,
          side: 'UP',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid amount');
    });

    it('should require authentication', async () => {
      const res = await request(app)
        .post('/api/predictions/submit')
        .send({
          roundId: testRound.id,
          amount: 100,
          side: 'UP',
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('POST /api/predictions/submit - idempotency', () => {
    it('stores successful responses for retry using Idempotency-Key', async () => {
      const res = await request(app)
        .post('/api/predictions/submit')
        .set('Authorization', `Bearer ${userAToken}`)
        .set('Idempotency-Key', 'test-key-12345')
        .send({
          roundId: testRound.id,
          amount: 100,
          side: 'UP',
        });

      expect(res.status).toBe(200);
      expect(mockSubmitPrediction).toHaveBeenCalledTimes(1);
      expect(mockIdempotencyUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            userId: userA.id,
            endpoint: '/api/predictions/submit',
            idempotencyKey: 'test-key-12345',
            responseStatus: 200,
          }),
        }),
      );
    });

    it('returns cached response for duplicate identical retries', async () => {
      const responseBody = {
        success: true,
        prediction: { id: 'cached-prediction', roundId: testRound.id },
      };
      mockIdempotencyFindUnique.mockResolvedValueOnce({
        id: 'idem-1',
        userId: userA.id,
        endpoint: '/api/predictions/submit',
        idempotencyKey: 'test-key-12345',
        requestHash: requestHash({
          roundId: testRound.id,
          amount: 100,
          side: 'UP',
          priceRange: undefined,
        }),
        responseStatus: 200,
        responseBody,
        expiresAt: new Date(Date.now() + 60_000),
      });

      const res = await request(app)
        .post('/api/predictions/submit')
        .set('Authorization', `Bearer ${userAToken}`)
        .set('Idempotency-Key', 'test-key-12345')
        .send({
          roundId: testRound.id,
          amount: 100,
          side: 'UP',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(responseBody);
      expect(mockSubmitPrediction).not.toHaveBeenCalled();
    });

    it('returns 409 when an idempotency key is reused with a different body', async () => {
      mockIdempotencyFindUnique.mockResolvedValueOnce({
        id: 'idem-1',
        userId: userA.id,
        endpoint: '/api/predictions/submit',
        idempotencyKey: 'test-key-12345',
        requestHash: requestHash({
          roundId: testRound.id,
          amount: 50,
          side: 'UP',
          priceRange: undefined,
        }),
        responseStatus: 200,
        responseBody: { success: true },
        expiresAt: new Date(Date.now() + 60_000),
      });

      const res = await request(app)
        .post('/api/predictions/submit')
        .set('Authorization', `Bearer ${userAToken}`)
        .set('Idempotency-Key', 'test-key-12345')
        .send({
          roundId: testRound.id,
          amount: 100,
          side: 'UP',
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      expect(mockSubmitPrediction).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, afterEach } from '@jest/globals';
import request from 'supertest';
import { Express } from 'express';
import { createApp } from '../index';
import { generateToken } from '../utils/jwt.util';
import { UserRole } from '@prisma/client';

const mockJoinTournament = jest.fn();
const mockUserFindUnique = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

// The service is mocked, but the read endpoints are backed by the real mock
// seed data — so the mock delegates listing/detail to the actual service.
jest.mock('../services/tournament.service', () => {
  const actual = jest.requireActual('../services/tournament.service');
  return {
    __esModule: true,
    default: {
      joinTournament: (...args: any[]) => mockJoinTournament(...args),
      listTournaments: (...args: any[]) => actual.default.listTournaments(...args),
      getMockById: (...args: any[]) => actual.default.getMockById(...args),
    },
  };
});

jest.mock('../middleware/rateLimiter.middleware', () => ({
  challengeRateLimiter: (_req: any, _res: any, next: any) => next(),
  connectRateLimiter: (_req: any, _res: any, next: any) => next(),
  authRateLimiter: (_req: any, _res: any, next: any) => next(),
  chatMessageRateLimiter: (_req: any, _res: any, next: any) => next(),
  adminRoundRateLimiter: (_req: any, _res: any, next: any) => next(),
  oracleResolveRateLimiter: (_req: any, _res: any, next: any) => next(),
  betRateLimiter: (_req: any, _res: any, next: any) => next(),
  predictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchPredictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchLeaderboardRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

describe('Tournaments Routes (Issue #412)', () => {
  const app: Express = createApp();
  const userId = 'tourney-user-id';
  const walletAddress = 'GUSER_TOURNEY_TEST_AAAAAAAAAAAAAA';
  const token = generateToken(userId, walletAddress, UserRole.USER);

  beforeEach(() => {
    mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress, role: UserRole.USER });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/tournaments', () => {
    it('returns the default paginated list', async () => {
      const res = await request(app).get('/api/tournaments');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(3);
      expect(res.body.meta.pagination.total).toBe(3);
    });

    it('filters by status (case-insensitive)', async () => {
      const res = await request(app).get('/api/tournaments').query({ status: 'active' });

      expect(res.status).toBe(200);
      expect(res.body.data.every((t: any) => t.status === 'ACTIVE')).toBe(true);
      expect(res.body.meta.pagination.total).toBe(1);
    });

    it('returns an empty list for a status with no matches', async () => {
      const res = await request(app).get('/api/tournaments').query({ status: 'cancelled' });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.pagination.total).toBe(0);
    });

    it('applies limit and offset', async () => {
      const res = await request(app).get('/api/tournaments').query({ limit: 1, offset: 1 });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.meta.pagination).toEqual({ limit: 1, offset: 1, total: 3 });
    });

    it('rejects an invalid (negative) limit', async () => {
      const res = await request(app).get('/api/tournaments').query({ limit: -1 });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/tournaments/:id', () => {
    it('returns tournament detail for a known id', async () => {
      const res = await request(app).get('/api/tournaments/t-001');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('t-001');
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(app).get('/api/tournaments/does-not-exist');

      expect(res.status).toBe(404);
      expect(res.body.message ?? res.body.error?.message).toMatch(/not found/i);
    });
  });

  describe('POST /api/tournaments/:id/join', () => {
    it('requires authentication', async () => {
      const res = await request(app).post('/api/tournaments/t-001/join');

      expect(res.status).toBe(401);
      expect(mockJoinTournament).not.toHaveBeenCalled();
    });

    it('joins successfully and returns updated participant count', async () => {
      mockJoinTournament.mockResolvedValueOnce({
        currentParticipants: 68,
        status: 'CONFIRMED',
      });

      const res = await request(app)
        .post('/api/tournaments/t-001/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
        tournamentId: 't-001',
        currentParticipants: 68,
        status: 'CONFIRMED',
      });
      expect(mockJoinTournament).toHaveBeenCalledWith(userId, 't-001');
    });

    it('reports the waitlist position when the tournament is full', async () => {
      mockJoinTournament.mockResolvedValueOnce({
        currentParticipants: 68,
        status: 'WAITLISTED',
        waitlistPosition: 3,
      });

      const res = await request(app)
        .post('/api/tournaments/t-001/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        tournamentId: 't-001',
        currentParticipants: 68,
        status: 'WAITLISTED',
        waitlistPosition: 3,
      });
    });

    it('propagates a 404 when the service reports tournament not found', async () => {
      const { NotFoundError } = require('../utils/errors');
      mockJoinTournament.mockRejectedValueOnce(new NotFoundError('Tournament not found'));

      const res = await request(app)
        .post('/api/tournaments/unknown-id/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('propagates a 409 when the user already joined', async () => {
      const { ConflictError } = require('../utils/errors');
      mockJoinTournament.mockRejectedValueOnce(new ConflictError('Already joined this tournament'));

      const res = await request(app)
        .post('/api/tournaments/t-001/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
    });

    it('propagates a 409 when the user is already on the waitlist', async () => {
      const { ConflictError } = require('../utils/errors');
      mockJoinTournament.mockRejectedValueOnce(
        new ConflictError('Already on the tournament waitlist'),
      );

      const res = await request(app)
        .post('/api/tournaments/t-001/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
    });

    it('propagates a 400 when the tournament is cancelled', async () => {
      const { ValidationError } = require('../utils/errors');
      mockJoinTournament.mockRejectedValueOnce(new ValidationError('Tournament is cancelled'));

      const res = await request(app)
        .post('/api/tournaments/t-001/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });
  });
});
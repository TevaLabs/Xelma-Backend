import { describe, it, expect, afterEach } from '@jest/globals';
import request from 'supertest';
import { Express } from 'express';
import { createApp } from '../index';
import { generateToken } from '../utils/jwt.util';
import { UserRole } from '@prisma/client';

const mockJoinTournament = jest.fn();
const mockListTournaments = jest.fn();
const mockGetMockById = jest.fn();
const mockUserFindUnique = jest.fn();

jest.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/tournament.service', () => ({
  __esModule: true,
  default: {
    joinTournament: (...args: any[]) => mockJoinTournament(...args),
    listTournaments: (...args: any[]) => mockListTournaments(...args),
    getMockById: (...args: any[]) => mockGetMockById(...args),
  },
}));

jest.mock('../middleware/rateLimiter.middleware', () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return {
    apiRateLimiter: pass,
    writeRateLimiter: pass,
    betRateLimiter: pass,
    challengeRateLimiter: pass,
    connectRateLimiter: pass,
    authRateLimiter: pass,
    chatMessageRateLimiter: pass,
    adminRoundRateLimiter: pass,
    oracleResolveRateLimiter: pass,
    predictionRateLimiter: pass,
    batchPredictionRateLimiter: pass,
    batchLeaderboardRateLimiter: pass,
  };
});

describe('Tournaments Routes (Issue #412)', () => {
  const app: Express = createApp();
  const userId = 'tourney-user-id';
  const walletAddress = 'GUSER_TOURNEY_TEST_AAAAAAAAAAAAAA';
  const token = generateToken(userId, walletAddress, UserRole.USER);

  beforeEach(() => {
    mockUserFindUnique.mockResolvedValue({ id: userId, walletAddress, role: UserRole.USER });
    mockListTournaments.mockImplementation(async (query: any) => {
      const all = [
        { id: 't-001', name: 'Alpha', status: 'ACTIVE', mode: 'UP_DOWN', maxParticipants: 100, currentParticipants: 0 },
        { id: 't-002', name: 'Beta', status: 'UPCOMING', mode: 'UP_DOWN', maxParticipants: 50, currentParticipants: 0 },
        { id: 't-003', name: 'Gamma', status: 'COMPLETED', mode: 'PRECISION', maxParticipants: 200, currentParticipants: 0 },
      ];
      let filtered = all;
      if (query.status) filtered = filtered.filter((t: any) => t.status === query.status);
      const limit = query.limit ?? 20;
      const offset = query.offset ?? 0;
      return {
        data: filtered.slice(offset, offset + limit),
        pagination: { limit, offset, total: filtered.length },
      };
    });
    mockGetMockById.mockImplementation((id: string) => {
      if (id === 't-001') return { id: 't-001', name: 'Alpha', status: 'ACTIVE', mode: 'UP_DOWN', maxParticipants: 100, currentParticipants: 0 };
      return undefined;
    });
    mockJoinTournament.mockImplementation(async (_userId: string, _id: string) => ({
      currentParticipants: 1,
    }));
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
      const res = await request(app).get('/api/tournaments').query({ status: 'ACTIVE' });

      expect(res.status).toBe(200);
      expect(res.body.data.every((t: any) => t.status === 'ACTIVE')).toBe(true);
      expect(res.body.meta.pagination.total).toBe(1);
    });

    it('returns an empty list for a status with no matches', async () => {
      const res = await request(app).get('/api/tournaments').query({ status: 'CANCELLED' });

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
      mockJoinTournament.mockResolvedValueOnce({ currentParticipants: 68 });

      const res = await request(app)
        .post('/api/tournaments/t-001/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({ tournamentId: 't-001', currentParticipants: 68 });
      expect(mockJoinTournament).toHaveBeenCalledWith(userId, 't-001');
    });

    it('propagates a 404 when the service reports tournament not found', async () => {
      const { NotFoundError } = require('../utils/errors');
      mockJoinTournament.mockRejectedValueOnce(new NotFoundError('Tournament not found'));

      const res = await request(app)
        .post('/api/tournaments/unknown-id/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('propagates a 409 when the tournament is full', async () => {
      const { ConflictError } = require('../utils/errors');
      mockJoinTournament.mockRejectedValueOnce(new ConflictError('Tournament is full'));

      const res = await request(app)
        .post('/api/tournaments/t-001/join')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
    });

    it('propagates a 409 when the user already joined', async () => {
      const { ConflictError } = require('../utils/errors');
      mockJoinTournament.mockRejectedValueOnce(new ConflictError('Already joined this tournament'));

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
import { describe, it, expect, afterEach } from '@jest/globals';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from '../app';
import { setRepositoriesForTests } from '../repositories';

jest.mock('../middleware/rateLimiter.middleware', () => ({
  apiRateLimiter: (_req: any, _res: any, next: any) => next(),
  writeRateLimiter: (_req: any, _res: any, next: any) => next(),
  betRateLimiter: (_req: any, _res: any, next: any) => next(),
  challengeRateLimiter: (_req: any, _res: any, next: any) => next(),
  connectRateLimiter: (_req: any, _res: any, next: any) => next(),
  authRateLimiter: (_req: any, _res: any, next: any) => next(),
  chatMessageRateLimiter: (_req: any, _res: any, next: any) => next(),
  predictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  adminRoundRateLimiter: (_req: any, _res: any, next: any) => next(),
  oracleResolveRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchPredictionRateLimiter: (_req: any, _res: any, next: any) => next(),
  batchLeaderboardRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../services/priceService', () => ({
  __esModule: true,
  getPrices: jest.fn(),
}));

jest.mock('../lib/prisma', () => ({
  prisma: {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    authChallenge: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
    transaction: { create: jest.fn() },
    bet: { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), groupBy: jest.fn() },
    round: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    prediction: { findMany: jest.fn(), update: jest.fn() },
    outboxEvent: { create: jest.fn() },
    $disconnect: jest.fn(),
  },
}));

jest.mock('@prisma/client', () => ({
  UserRole: { USER: 'USER', ADMIN: 'ADMIN', ORACLE: 'ORACLE' },
  BetStatus: { ACCEPTED: 'ACCEPTED', SUBMITTED: 'SUBMITTED', CONFIRMED: 'CONFIRMED', RESOLVED: 'RESOLVED', FAILED: 'FAILED' },
  BetMode: { UP_DOWN: 'UP_DOWN', PRECISION: 'PRECISION', LEGENDS: 'LEGENDS' },
  GameMode: { UP_DOWN: 'UP_DOWN', LEGENDS: 'LEGENDS' },
  OutboxEventType: { BET_ACCEPTED: 'BET_ACCEPTED', BET_CONFIRMED: 'BET_CONFIRMED', BET_RESOLVED: 'BET_RESOLVED', BET_FAILED: 'BET_FAILED', NOTIFICATION_CREATE: 'NOTIFICATION_CREATE', WEBSOCKET_EMIT: 'WEBSOCKET_EMIT' },
  TournamentStatus: { UPCOMING: 'UPCOMING', ACTIVE: 'ACTIVE', COMPLETED: 'COMPLETED' },
  DispatchChannel: { NOTIFICATION_CREATE: 'NOTIFICATION_CREATE', WEBSOCKET_EMIT: 'WEBSOCKET_EMIT' },
  Prisma: {},
}));

jest.mock('../lib/redis', () => ({
  invalidateNamespace: jest.fn(),
  invalidateLeaderboardSortedSet: jest.fn(),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
  getCache: jest.fn(),
  setCache: jest.fn(),
  deleteCache: jest.fn(),
}));

jest.mock('../services/soroban.service', () => ({
  __esModule: true,
  default: {
    getUserStats: jest.fn().mockResolvedValue({
      total_wins: 0,
      total_losses: 0,
      best_streak: 0,
      current_streak: 0,
    }),
    getPendingWinnings: jest.fn().mockResolvedValue(0),
    getBalance: jest.fn().mockResolvedValue(0),
    getHealth: jest.fn().mockResolvedValue({ status: 'ok' }),
    placeBet: jest.fn(),
    placePrecisionBet: jest.fn(),
    claimWinnings: jest.fn(),
  },
}));

jest.mock('../services/oracle', () => ({
  __esModule: true,
  default: {
    getPriceString: jest.fn(() => '0.1'),
    getLastUpdatedAt: jest.fn(() => new Date()),
    isStale: jest.fn(() => false),
    isRunning: jest.fn(() => false),
    getLastProvider: jest.fn(() => 'mock'),
    getActiveSource: jest.fn(() => 'mock'),
  },
}));

jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (address: string) =>
    !!address && address.startsWith('G') && address.length === 56,
  verifySignature: jest.fn().mockResolvedValue(true),
}));

jest.mock('../services/websocket.service', () => ({
  __esModule: true,
  default: {
    emitBetAccepted: jest.fn(),
    emitRoundResolved: jest.fn(),
    emitNotification: jest.fn(),
    replayEmit: jest.fn(),
  },
}));

jest.mock('../services/chat.service', () => ({
  __esModule: true,
  default: {
    sendMessage: jest.fn(),
    getMessages: jest.fn(),
  },
}));

jest.mock('../services/notification.service', () => ({
  __esModule: true,
  default: {
    createNotification: jest.fn(),
    getNotifications: jest.fn(),
    markAsRead: jest.fn(),
    markAllAsRead: jest.fn(),
  },
}));

jest.mock('../services/round.service', () => ({
  __esModule: true,
  default: {
    getRoundsForApi: jest.fn().mockResolvedValue({ source: 'mock', rounds: [] }),
    getActiveRound: jest.fn(),
    startNewRound: jest.fn(),
    lockRound: jest.fn(),
  },
}));

jest.mock('../services/resolution.service', () => ({
  __esModule: true,
  default: {
    resolveRound: jest.fn(),
  },
  ResolutionService: jest.fn().mockImplementation(() => ({
    resolveRound: jest.fn(),
  })),
}));

jest.mock('../services/simulation.service', () => ({
  __esModule: true,
  default: {
    simulate: jest.fn(),
    simulateRound: jest.fn(),
  },
}));

jest.mock('../services/tournament.service', () => ({
  __esModule: true,
  default: {
    listTournaments: jest.fn().mockResolvedValue({
      data: [],
      pagination: { limit: 20, offset: 0, total: 0 },
    }),
    getTournament: jest.fn(),
    getMockById: jest.fn((id: string) => ({ id })),
    joinTournament: jest.fn(),
    createTournament: jest.fn(),
  },
}));

jest.mock('../services/education-tip.service', () => ({
  __esModule: true,
  default: {
    generateTip: jest.fn().mockResolvedValue({ category: 'tip', message: 'learn' }),
  },
}));

jest.mock('../services/bet.service', () => ({
  __esModule: true,
  default: {
    recordUpDownBet: jest.fn(),
    recordPrecisionBet: jest.fn(),
    getBet: jest.fn(),
    getBets: jest.fn().mockResolvedValue([]),
    reconcileBet: jest.fn(),
    claimWinnings: jest.fn(),
  },
}));

jest.mock('../services/bet-audit.service', () => ({
  __esModule: true,
  default: {
    emitBetAccepted: jest.fn(),
    emitBetFailed: jest.fn(),
    emitBetReconciled: jest.fn(),
    emitClaimAccepted: jest.fn(),
  },
}));

jest.mock('../services/outbox.service', () => ({
  __esModule: true,
  default: {
    processOutbox: jest.fn(),
    cleanupProcessed: jest.fn(),
  },
}));

jest.mock('../services/dead-letter-queue.service', () => ({
  __esModule: true,
  default: {
    recordFailure: jest.fn(),
    retry: jest.fn(),
    retryAll: jest.fn(),
    list: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/schema-readiness.service', () => ({
  checkSchemaReadiness: jest.fn().mockResolvedValue({ ready: true }),
}));

jest.mock('../services/hackathon.service', () => ({
  __esModule: true,
  default: {
    getHackathonStats: jest.fn(),
  },
}));

jest.mock('../metrics/application.metrics', () => {
  const metric = () => ({
    inc: jest.fn(),
    observe: jest.fn(),
    set: jest.fn(),
    labels: jest.fn(),
  });
  const base: Record<string, unknown> = {
    metricsRegistry: {
      getSingleMetricAsString: jest.fn(() => ''),
      getMetricsAsJSON: jest.fn(() => []),
      removeSingleMetric: jest.fn(),
    },
    recordOracleHealth: jest.fn(),
    setSocketConnectionsActive: jest.fn(),
  };
  return new Proxy(base, {
    get: (obj, prop) => {
      if (prop in obj) return obj[prop];
      return metric();
    },
  });
});

jest.mock('../middleware/auth.middleware', () => ({
  authenticateUser: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireOracle: (_req: any, _res: any, next: any) => next(),
  verifyStellarAuth: (_req: any, _res: any, next: any) => next(),
  bindAuthenticatedWallet: (_req: any, _res: any, next: any) => next(),
  optionalAuthentication: (_req: any, _res: any, next: any) => next(),
}));

import { getPrices } from '../services/priceService';

const app = createApp();

afterEach(() => {
  setRepositoriesForTests(null);
  jest.clearAllMocks();
});

const emptyRepos = () => ({
  rounds: { placeBet: jest.fn() },
  leaderboard: { listLeaderboard: jest.fn() },
  stats: { getPlatformStats: jest.fn(), invalidateStatsCache: jest.fn() },
});

describe('API Contract Tests - frontend-critical endpoints (Issue #333)', () => {
  describe('GET /api/rounds', () => {
    it('returns a success envelope with source and rounds', async () => {
      // GET /api/rounds delegates to roundService.getRoundsForApi(),
      // which falls back to mock data when Soroban/database are unavailable.
      const res = await request(app).get('/api/rounds');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('source');
      expect(res.body.data).toHaveProperty('rounds');
      expect(Array.isArray(res.body.data.rounds)).toBe(true);
    });
  });

  describe('GET /api/leaderboard', () => {
    const leaderboardContract = z.object({
      success: z.literal(true),
      data: z.object({
        entries: z.array(
          z.object({
            userId: z.string(),
            rank: z.number(),
            score: z.union([z.string(), z.number()]),
          }),
        ),
      }),
      meta: z.object({
        pagination: z.object({
          limit: z.number(),
          offset: z.number(),
          total: z.number(),
        }),
      }),
    });

    it('matches the documented response contract', async () => {
      const repos = emptyRepos();
      (repos.leaderboard.listLeaderboard as jest.Mock).mockResolvedValue({
        entries: [{ userId: 'u-1', rank: 1, score: 100 }],
        pagination: { limit: 100, offset: 0, total: 1 },
      });
      setRepositoriesForTests(repos as any);

      const res = await request(app).get('/api/leaderboard');

      expect(res.status).toBe(200);
      expect(() => leaderboardContract.parse(res.body)).not.toThrow();
    });
  });

  describe('GET /api/stats', () => {
    const statsContract = z.object({
      success: z.literal(true),
      data: z.object({
        totalRounds: z.number(),
        totalUsers: z.number(),
        totalBets: z.number(),
        isFallback: z.boolean(),
        cachedAt: z.string(),
      }),
    });

    it('matches the documented response contract', async () => {
      const repos = emptyRepos();
      (repos.stats.getPlatformStats as jest.Mock).mockResolvedValue({
        totalRounds: 142,
        totalUsers: 89,
        totalBets: 530,
        isFallback: false,
        cachedAt: new Date().toISOString(),
      });
      setRepositoriesForTests(repos as any);

      const res = await request(app).get('/api/stats');

      expect(res.status).toBe(200);
      expect(() => statsContract.parse(res.body)).not.toThrow();
    });
  });

  describe('GET /api/prices', () => {
    const pricesContract = z.object({
      success: z.literal(true),
      data: z.object({
        BTC: z.number(),
        ETH: z.number(),
        XLM: z.number(),
        stale: z.boolean(),
        lastUpdatedAt: z.string().nullable(),
      }),
    });

    it('matches the documented response contract', async () => {
      (getPrices as jest.Mock).mockResolvedValue({
        BTC: 60000,
        ETH: 3000,
        XLM: 0.2891,
        stale: false,
        lastUpdatedAt: new Date().toISOString(),
      });

      const res = await request(app).get('/api/prices');

      expect(res.status).toBe(200);
      expect(() => pricesContract.parse(res.body)).not.toThrow();
    });
  });
});
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import request from 'supertest';

// ── Mocks (must be declared before imports that use them) ──────────────────

// Mock Stellar SDK to avoid ESM parse issues in Jest
jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (addr: string) => addr?.startsWith('G') && addr.length === 56,
  verifySignature: jest.fn(),
}));

const mockIsReady = jest.fn().mockReturnValue(true);
jest.mock('../services/soroban.service', () => ({
  isReady: (...args: unknown[]) => mockIsReady(...args),
  getUserStats: jest.fn(),
  getPendingWinnings: jest.fn(),
  getBalance: jest.fn(),
  getHealth: jest.fn(),
}));

jest.mock('../services/oracle', () => ({
  __esModule: true,
  default: {
    isRunning: jest.fn().mockReturnValue(false),
    isStale: jest.fn().mockReturnValue(false),
    getLastUpdatedAt: jest.fn().mockReturnValue(null),
    getStalenessSeconds: jest.fn().mockReturnValue(null),
    getActiveSource: jest.fn().mockReturnValue(null),
  },
}));

const mockCheckRedisHealth = jest.fn<() => Promise<{ status: string; durationMs: number; error?: string }>>();
const mockIsRedisCacheEnabled = jest.fn<boolean>();

jest.mock('../lib/redis', () => ({
  checkRedisHealth: (...args: unknown[]) => mockCheckRedisHealth(...args),
  isRedisCacheEnabled: (...args: unknown[]) => mockIsRedisCacheEnabled(...args),
}));

// Mock config — provide all properties that downstream modules may access
let mockDataStore: 'memory' | 'postgres' = 'memory';
jest.mock('../config', () => ({
  __esModule: true,
  default: {
    get app() {
      return {
        dataStore: mockDataStore,
        dataMode: 'mock',
        enableMultiplayerSocial: true,
        socketDemoMode: true,
        safetyProfile: 'demo',
      };
    },
    get jwt() {
      return { secret: 'test-secret', expiry: '7d' };
    },
    get database() {
      return { url: 'postgresql://mock:mock@localhost/mock', connectionLimit: 10 };
    },
    get soroban() {
      return { contractId: '', network: 'testnet', rpcUrl: '', adminSecret: '', oracleSecret: '', failClosed: false };
    },
    get scheduler() {
      return { roundSchedulerEnabled: false, roundSchedulerMode: 'UP_DOWN' };
    },
    get stellar() {
      return { network: 'testnet' };
    },
    get socket() {
      return { clientUrl: '*' };
    },
    get oracle() {
      return {
        pollingIntervalMs: 10000,
        requestTimeoutMs: 5000,
        maxRetries: 3,
        stalenessThresholdMs: 60000,
        coinGeckoUrl: '',
        coinCapUrl: '',
      };
    },
  },
}));

const mockQueryRaw = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
jest.mock('../lib/prisma', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    user: { create: jest.fn(), deleteMany: jest.fn() },
  },
}));

// ── Import app AFTER mocks are in place ────────────────────────────────────
import { createApp } from '../app';

describe('Hackathon health – optional dependency probes', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsReady.mockReturnValue(true);
    mockIsRedisCacheEnabled.mockReturnValue(false);
    mockDataStore = 'memory';
    mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);

    app = createApp({ mode: 'hackathon', features: { apiDocs: false } });
  });

  // ── Unconfigured deps are omitted ──────────────────────────────────────
  describe('when no optional deps are configured', () => {
    it('omits database and redis from services', async () => {
      mockDataStore = 'memory';
      mockIsRedisCacheEnabled.mockReturnValue(false);
      app = createApp({ mode: 'hackathon', features: { apiDocs: false } });

      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.data.services.database).toBeUndefined();
      expect(res.body.data.services.redis).toBeUndefined();
      expect(res.body.data.services).toHaveProperty('price');
      expect(res.body.data.services).toHaveProperty('soroban');
    });
  });

  // ── DB configured ─────────────────────────────────────────────────────
  describe('when database is configured (dataStore=postgres)', () => {
    it('includes database probe with healthy status', async () => {
      mockDataStore = 'postgres';
      mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
      app = createApp({ mode: 'hackathon', features: { apiDocs: false } });

      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.data.services.database).toEqual(
        expect.objectContaining({ status: 'healthy' }),
      );
      expect(res.body.data.services.database.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns degraded when database probe fails', async () => {
      mockDataStore = 'postgres';
      mockQueryRaw.mockRejectedValue(new Error('connection refused'));
      app = createApp({ mode: 'hackathon', features: { apiDocs: false } });

      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('degraded');
      expect(res.body.data.services.database).toEqual(
        expect.objectContaining({
          status: 'unhealthy',
          error: 'connection refused',
        }),
      );
    });
  });

  // ── Redis configured ──────────────────────────────────────────────────
  describe('when redis is configured', () => {
    it('includes redis probe with healthy status', async () => {
      mockIsRedisCacheEnabled.mockReturnValue(true);
      mockCheckRedisHealth.mockResolvedValue({ status: 'healthy', durationMs: 5 });
      app = createApp({ mode: 'hackathon', features: { apiDocs: false } });

      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.data.services.redis).toEqual(
        expect.objectContaining({ status: 'healthy', durationMs: 5 }),
      );
    });

    it('returns degraded when redis probe is unavailable', async () => {
      mockIsRedisCacheEnabled.mockReturnValue(true);
      mockCheckRedisHealth.mockResolvedValue({ status: 'unavailable', durationMs: 12 });
      app = createApp({ mode: 'hackathon', features: { apiDocs: false } });

      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('degraded');
      expect(res.body.data.services.redis.status).toBe('unavailable');
    });

    it('returns degraded when redis probe is degraded', async () => {
      mockIsRedisCacheEnabled.mockReturnValue(true);
      mockCheckRedisHealth.mockResolvedValue({ status: 'degraded', durationMs: 18, error: 'timeout' });
      app = createApp({ mode: 'hackathon', features: { apiDocs: false } });

      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('degraded');
      expect(res.body.data.services.redis.status).toBe('degraded');
      expect(res.body.data.services.redis.error).toBe('timeout');
    });

    it('keeps ok status when redis returns bypassed', async () => {
      mockIsRedisCacheEnabled.mockReturnValue(true);
      mockCheckRedisHealth.mockResolvedValue({ status: 'bypassed', durationMs: 0 });
      app = createApp({ mode: 'hackathon', features: { apiDocs: false } });

      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ok');
      expect(res.body.data.services.redis.status).toBe('bypassed');
    });
  });

  // ── Both DB + Redis configured ────────────────────────────────────────
  describe('when both database and redis are configured', () => {
    it('includes both probes and reports ok when both healthy', async () => {
      mockDataStore = 'postgres';
      mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockIsRedisCacheEnabled.mockReturnValue(true);
      mockCheckRedisHealth.mockResolvedValue({ status: 'healthy', durationMs: 3 });
      app = createApp({ mode: 'hackathon', features: { apiDocs: false } });

      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ok');
      expect(res.body.data.services.database.status).toBe('healthy');
      expect(res.body.data.services.redis.status).toBe('healthy');
    });

    it('returns degraded when only one of them fails', async () => {
      mockDataStore = 'postgres';
      mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockIsRedisCacheEnabled.mockReturnValue(true);
      mockCheckRedisHealth.mockResolvedValue({ status: 'unavailable', durationMs: 8 });
      app = createApp({ mode: 'hackathon', features: { apiDocs: false } });

      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('degraded');
      expect(res.body.data.services.database.status).toBe('healthy');
      expect(res.body.data.services.redis.status).toBe('unavailable');
    });
  });

  // ── durationMs is always present ──────────────────────────────────────
  it('always includes a durationMs field in the response', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(typeof res.body.data.durationMs).toBe('number');
    expect(res.body.data.durationMs).toBeGreaterThanOrEqual(0);
  });
});

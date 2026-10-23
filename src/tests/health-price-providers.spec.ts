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
  isRedisRateLimitConfigured: () => false,
  RedisRateLimitStore: class {},
}));

// Mock config — provide all properties that downstream modules may access
let mockDataStore: 'memory' | 'postgres' = 'memory';

const mockPriceHealth = jest.fn();
jest.mock('../services/priceService', () => ({
  __esModule: true,
  getPriceProviderHealth: (...args: unknown[]) => mockPriceHealth(...args),
}));
jest.mock('../config', () => ({
  __esModule: true,
  default: {
    get app() {
      return {
        dataStore: mockDataStore,
        dataMode: 'live',
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

const provider = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  consecutiveFailures: 0,
  ...extra,
});

describe('Health – price provider status (#869)', () => {
  const app = createApp({ mode: 'hackathon', features: { apiDocs: false } });

  beforeEach(() => {
    mockIsReady.mockReturnValue(true);
    mockIsRedisCacheEnabled.mockReturnValue(false);
    mockDataStore = 'memory';
  });

  it('reports ok with per-provider last success when prices are fresh', async () => {
    mockPriceHealth.mockReturnValue({
      providers: [provider('coingecko', { lastSuccessAt: '2026-10-21T10:00:00.000Z' }), provider('coincap')],
      activeProvider: 'coingecko',
      lastSuccessAt: '2026-10-21T10:00:00.000Z',
      degraded: false,
    });

    const res = await request(app).get('/api/health');
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.services.price).toEqual(
      expect.objectContaining({
        status: 'ok',
        source: 'coingecko',
        lastSuccessAt: '2026-10-21T10:00:00.000Z',
      }),
    );
    expect(res.body.data.services.price.providers).toHaveLength(2);
  });

  it('degrades overall status when every price provider failed', async () => {
    mockPriceHealth.mockReturnValue({
      providers: [
        provider('coingecko', { lastFailureAt: '2026-10-21T10:05:00.000Z', lastError: 'timeout', consecutiveFailures: 3 }),
        provider('coincap', { lastFailureAt: '2026-10-21T10:05:01.000Z', lastError: '503', consecutiveFailures: 3 }),
      ],
      activeProvider: null,
      lastSuccessAt: null,
      degraded: true,
    });

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.services.price.status).toBe('degraded');
    expect(res.body.data.services.price.providers[0].lastError).toBe('timeout');
  });
});

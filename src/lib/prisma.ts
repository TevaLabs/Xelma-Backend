import { PrismaClient } from '@prisma/client';
import config from '../config';
import logger from '../utils/logger';
import { createMemoryPrismaClient } from './memory-prisma';

// PrismaClient is attached to the `global` object in development to prevent
// exhausting your database connection limit.
const globalForPrisma = global as unknown as { prisma: PrismaClient };

function sanitizeDatabaseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<invalid DATABASE_URL>";
  }
}

export const prisma = (() => {
  if (
    process.env.NODE_ENV === 'test' &&
    process.env.TEST_TYPE === 'unit' &&
    config.app.dataStore !== 'memory'
  ) {
    // Prefer a Jest-provided PrismaClient mock so service tests can assert on
    // model calls; fall back to a dependency-free mock for other unit tests.
    // (A test that explicitly opts into DATA_STORE=memory wants the fuller
    // in-memory store below instead of this partial mock.)
    const MockedPrismaClient = PrismaClient as unknown as {
      new (): PrismaClient;
      _isMockFunction?: boolean;
    };
    if (typeof MockedPrismaClient === 'function' && MockedPrismaClient._isMockFunction) {
      return new MockedPrismaClient();
    }

    const mock: Partial<PrismaClient> = {
      idempotencyKey: {
        deleteMany: async () => ({ count: 0 }) as any,
        findUnique: async () => null as any,
        upsert: async () => null as any,
        create: async () => null as any,
        updateMany: async () => ({ count: 0 }) as any,
        // Add other model mocks if needed.
      },
      // #391: lightweight in-memory stubs for the hackathon-data models so
      // unit tests (NODE_ENV=test, no real DATABASE_URL) exercise the same
      // Prisma-shaped API as production without needing a live database.
      mockRound: (() => {
        const seed = [
          { id: 'btc-updown-live', asset: 'BTC', mode: 'updown', status: 'live', startPrice: 60000, poolUp: 0, poolDown: 0, totalPool: null, predictionCount: null, closesAt: new Date(Date.now() + 300_000).toISOString() },
          { id: 'eth-precision-live', asset: 'ETH', mode: 'precision', status: 'live', startPrice: 3000, poolUp: null, poolDown: null, totalPool: 0, predictionCount: 0, closesAt: new Date(Date.now() + 300_000).toISOString() },
          { id: 'xlm-updown-new', asset: 'XLM', mode: 'updown', status: 'new', startPrice: 0.29, poolUp: 0, poolDown: 0, totalPool: null, predictionCount: null, closesAt: new Date(Date.now() + 600_000).toISOString() },
        ];
        const store = new Map<string, any>(seed.map(r => [r.id, { ...r }]));
        return {
          findMany: async () => Array.from(store.values()),
          findUnique: async ({ where }: any) => store.get(where.id) ?? null,
          update: async ({ where, data }: any) => {
            const existing = store.get(where.id);
            if (!existing) return null;
            const updated = { ...existing };
            for (const [key, value] of Object.entries(data)) {
              if (value && typeof value === 'object' && 'increment' in (value as any)) {
                updated[key] = (updated[key] ?? 0) + (value as any).increment;
              } else {
                updated[key] = value;
              }
            }
            store.set(where.id, updated);
            return updated;
          },
        };
      })(),
      mockLeaderboard: (() => {
        const store = new Map<string, any>();
        return {
          findMany: async ({ orderBy }: any = {}) => {
            const all = Array.from(store.values());
            if (orderBy?.xp === 'desc') all.sort((a, b) => b.xp - a.xp);
            return all;
          },
          findUnique: async ({ where }: any) => store.get(where.address) ?? null,
          create: async ({ data }: any) => {
            store.set(data.address, { ...data });
            return { ...data };
          },
          update: async ({ where, data }: any) => {
            const existing = store.get(where.address);
            if (!existing) return null;
            const updated = { ...existing };
            for (const [key, value] of Object.entries(data)) {
              if (value && typeof value === 'object' && 'decrement' in (value as any)) {
                updated[key] -= (value as any).decrement;
              } else if (value && typeof value === 'object' && 'increment' in (value as any)) {
                updated[key] += (value as any).increment;
              } else {
                updated[key] = value;
              }
            }
            store.set(where.address, updated);
            return updated;
          },
          deleteMany: async () => {
            store.clear();
            return { count: 0 };
          },
        };
      })(),
      mockBet: (() => {
        let store: any[] = [];
        let nextId = 1;
        return {
          create: async ({ data }: any) => {
            const record = { id: nextId++, createdAt: new Date(), ...data };
            store.push(record);
            return record;
          },
          findMany: async () => store,
          deleteMany: async () => {
            store = [];
            return { count: 0 };
          },
        };
      })(),
      round: {
        findMany: async () => [],
        findUnique: async () => null,
        findFirst: async () => null,
        create: async ({ data }: any) => ({ id: "round-1", ...data }),
        update: async ({ data }: any) => data,
        count: async () => 0,
      },
      // Add a generic $queryRaw mock for connectivity checks.
      $queryRaw: async () => null,
    } as any;
    return mock as PrismaClient;
  }

  // DB-less hackathon demo mode (DATA_STORE=memory / DATA_MODE=mock): back the
  // Prisma client entirely with in-memory collections so hackathon-mounted
  // routes work without a live Postgres instance. See src/lib/memory-prisma.ts
  // for exactly which models/operations are covered.
  if (config.app.dataStore === 'memory') {
    logger.info('Prisma client backed by in-memory store (DATA_STORE=memory)');
    return createMemoryPrismaClient() as unknown as PrismaClient;
  }

  // Production / development client.
  return globalForPrisma.prisma || new PrismaClient({
    datasources: {
      db: { url: config.database.url },
    },
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });
})();

if (!globalForPrisma.prisma && config.app.dataStore !== 'memory') {
  logger.info("Prisma datasource configured", {
    databaseUrl: sanitizeDatabaseUrl(config.database.url),
    pool: {
      connectionLimit: config.database.connectionLimit,
      poolTimeoutSeconds: config.database.poolTimeoutSeconds,
      connectTimeoutSeconds: config.database.connectTimeoutSeconds,
      statementTimeoutMs: config.database.statementTimeoutMs,
      pgbouncer: config.database.pgbouncer,
    },
  });
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

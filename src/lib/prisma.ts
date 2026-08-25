import { PrismaClient } from '@prisma/client';
import config from '../config';
import logger from '../utils/logger';

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
  if (process.env.NODE_ENV === 'test') {
    // Minimal mock to satisfy type expectations during unit tests.
    const mock: Partial<PrismaClient> = {
      round: {
        findUnique: async () => null as any,
        findMany: async () => [] as any,
        create: async ({ data }: any) => ({ id: 'mock-round', ...data }) as any,
        update: async ({ where, data }: any) => ({ id: where.id, ...data }) as any,
      },
      user: {
        findUnique: async () => null as any,
        create: async ({ data }: any) => ({ id: 'mock-user', ...data }) as any,
        update: async ({ where, data }: any) => ({ id: where.id, ...data }) as any,
      },
      userStats: {
        findUnique: async () => null as any,
        findMany: async () => [] as any,
        create: async ({ data }: any) => ({ id: 'mock-stats', ...data }) as any,
        update: async ({ where, data }: any) => ({ id: where.id, ...data }) as any,
        count: async () => 0,
      },
      transaction: {
        findMany: async () => [] as any,
        create: async ({ data }: any) => ({ id: 'mock-tx', ...data }) as any,
        deleteMany: async () => ({ count: 0 }) as any,
        count: async () => 0,
      },
      prediction: {
        findMany: async () => [] as any,
        create: async ({ data }: any) => ({ id: 'mock-pred', ...data }) as any,
        update: async ({ where, data }: any) => ({ id: where.id, ...data }) as any,
      },
      leaderboard: {
        findMany: async () => [] as any,
        findUnique: async () => null as any,
        create: async ({ data }: any) => ({ id: 'mock-lb', ...data }) as any,
        update: async ({ where, data }: any) => ({ id: where.id, ...data }) as any,
      },
      notification: {
        findMany: async () => [] as any,
        count: async () => 0,
        create: async ({ data }: any) => ({ id: 'mock-notif', ...data }) as any,
      },
      idempotencyKey: {
        deleteMany: async () => ({ count: 0 }) as any,
        findUnique: async () => null as any,
        upsert: async () => null as any,
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
            const updated = { ...existing, ...data };
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
            const updated = { ...existing, ...data };
            store.set(where.address, updated);
            return updated;
          },
        };
      })(),
      mockBet: (() => {
        const store: any[] = [];
        let nextId = 1;
        return {
          create: async ({ data }: any) => {
            const record = { id: nextId++, createdAt: new Date(), ...data };
            store.push(record);
            return record;
          },
          findMany: async () => store,
        };
      })(),
      // Add a generic $queryRaw mock for connectivity checks.
      $queryRaw: async () => null,
    } as any;
    return mock as PrismaClient;
  }

  // Production / development client.
  return globalForPrisma.prisma || new PrismaClient({
    datasources: {
      db: { url: config.database.url },
    },
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });
})();

if (!globalForPrisma.prisma) {
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

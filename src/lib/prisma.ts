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
  if (process.env.NODE_ENV === 'test' && process.env.TEST_TYPE === 'unit') {
    // Prefer a Jest-provided PrismaClient mock so service tests can assert on
    // model calls; fall back to a dependency-free mock for other unit tests.
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
      // #519: in-memory stub for the durable bet-store table so unit tests
      // exercise the same Prisma-shaped API as production without a live
      // database. Mirrors the BetRecord model (id is the client-facing
      // "bet-N" id; money columns are stored as strings/numbers here).
      betRecord: (() => {
        const store = new Map<string, any>();
        const clone = (record: any) => ({ ...record });
        const now = () => new Date();
        return {
          create: async ({ data }: any) => {
            const record = { createdAt: now(), updatedAt: now(), ...data };
            store.set(record.id, record);
            return clone(record);
          },
          findUnique: async ({ where }: any) => {
            const record = store.get(where.id);
            return record ? clone(record) : null;
          },
          findMany: async ({ where, orderBy }: any = {}) => {
            let rows = Array.from(store.values());
            if (where) {
              rows = rows.filter((r) =>
                Object.entries(where).every(([key, value]) => r[key] === value),
              );
            }
            if (orderBy) {
              const [key, dir] = Object.entries(orderBy)[0];
              rows.sort((a, b) => {
                const av = a[key];
                const bv = b[key];
                const cmp =
                  av < bv ? -1 : av > bv ? 1 : 0;
                return dir === 'desc' ? -cmp : cmp;
              });
            }
            return rows.map(clone);
          },
          update: async ({ where, data }: any) => {
            const existing = store.get(where.id);
            if (!existing) return null;
            const updated = { ...existing, ...data, updatedAt: now() };
            store.set(where.id, updated);
            return clone(updated);
          },
          deleteMany: async () => {
            const count = store.size;
            store.clear();
            return { count };
          },
          count: async () => store.size,
          groupBy: async ({ by }: any) => {
            const groups = new Map<string, number>();
            for (const record of store.values()) {
              const key = record[by[0]];
              groups.set(key, (groups.get(key) ?? 0) + 1);
            }
            return Array.from(groups.entries()).map(([key, count]) => ({
              [by[0]]: key,
              _count: { [by[0]]: count },
            }));
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
      // Model stubs used by retention.service (and friends) so unit tests
      // can spyOn the count/deleteMany methods without a live database.
      authChallenge: {
        deleteMany: async () => ({ count: 0 }),
        count: async () => 0,
      },
      message: {
        deleteMany: async () => ({ count: 0 }),
        count: async () => 0,
      },
      auditLog: {
        create: async ({ data }: any) => ({ id: "audit-log-1", ...data }),
        deleteMany: async () => ({ count: 0 }),
        count: async () => 0,
      },
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

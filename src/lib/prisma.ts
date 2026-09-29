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
      // #664: authChallenge stub with the same one-time/TTL/atomic-consume
      // semantics the full app enforces via Prisma's updateMany. Without it,
      // any unit test exercising the auth flow crashes on `authChallenge`
      // instead of getting the production-shaped 401 behaviour, and a
      // signature replay could mint multiple JWTs in mock mode.
      authChallenge: (() => {
        // Keyed by the challenge string — the only unique lookup the auth
        // routes perform (challenge text == primary key in the schema).
        const store = new Map<
          string,
          {
            id: string;
            challenge: string;
            walletAddress: string;
            expiresAt: Date;
            isUsed: boolean;
            usedAt: Date | null;
            createdAt: Date;
          }
        >();
        let nextId = 1;

        const snapshot = (row: (typeof store) extends Map<string, infer R> ? R : never) =>
          ({ ...row }) as any;

        return {
          create: async ({ data }: any) => {
            const row = {
              id: `challenge-${nextId++}`,
              usedAt: null,
              createdAt: new Date(),
              ...data,
            };
            store.set(row.challenge, row);
            return snapshot(row);
          },
          findUnique: async ({ where }: any) => {
            const row = store.get(where?.challenge);
            return row ? snapshot(row) : null;
          },
          findMany: async ({ where }: any = {}) =>
            Array.from(store.values())
              .filter((row) =>
                Object.entries(where ?? {}).every(([key, condition]) => {
                  // Flat equality + `{ not: x }` shapes used by the routes.
                  if (
                    condition &&
                    typeof condition === 'object' &&
                    'not' in (condition as Record<string, unknown>)
                  ) {
                    return (row as any)[key] !== (condition as any).not;
                  }
                  return (row as any)[key] === condition;
                }),
              )
              .map(snapshot),
          /**
           * Atomic consume: only rows matching challenge + wallet + unused +
           * unexpired are flipped to used, mirroring the SQL the real client
           * runs. Two concurrent calls can never both report count=1 for the
           * same row because the second call observes isUsed=true.
           */
          updateMany: async ({ where, data }: any) => {
            let count = 0;
            for (const row of store.values()) {
              const matches =
                (where?.challenge === undefined || row.challenge === where.challenge) &&
                (where?.walletAddress === undefined || row.walletAddress === where.walletAddress) &&
                (where?.isUsed === undefined || row.isUsed === where.isUsed) &&
                (!where?.expiresAt?.gt || row.expiresAt > where.expiresAt.gt);
              if (!matches) continue;
              if (data?.isUsed !== undefined) row.isUsed = data.isUsed;
              if (data?.usedAt !== undefined) row.usedAt = data.usedAt;
              else if (data?.isUsed === true) row.usedAt = new Date();
              count += 1;
            }
            return { count };
          },
          deleteMany: async ({ where }: any = {}) => {
            let count = 0;
            for (const [key, row] of store.entries()) {
              const matches = Object.entries(where ?? {}).every(
                ([key2, condition]: [string, any]) => {
                  if (key2 === 'usedAt' && condition?.lt) {
                    return row.usedAt !== null && row.usedAt < condition.lt;
                  }
                  if (key2 === 'expiresAt' && condition?.lt) {
                    return row.expiresAt < condition.lt;
                  }
                  return (row as any)[key2] === condition;
                },
              );
              if (matches) {
                store.delete(key);
                count += 1;
              }
            }
            return { count };
          },
          /** Test helper: purge all challenges between tests. */
          _clear: async () => {
            store.clear();
          },
        };
      })(),
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
      round: {
        findMany: async () => [],
        findUnique: async () => null,
        findFirst: async () => null,
        create: async ({ data }: any) => ({ id: "round-1", ...data }),
        update: async ({ data }: any) => data,
        count: async () => 0,
      },
      claim: {
        findMany: async () => [],
        findFirst: async () => null,
        create: async ({ data }: any) => ({ id: "claim-1", ...data }),
        update: async ({ data }: any) => data,
        updateMany: async () => ({ count: 1 }),
        groupBy: async () => [],
        count: async () => 0,
      },
      bet: {
        findMany: async () => [],
        findFirst: async () => null,
        findUnique: async () => null,
        groupBy: async () => [],
      },
      user: {
        findUnique: async () => null,
        findFirst: async () => null,
        // #664: create/update so the auth connect flow can mint a JWT for a
        // first-time wallet without a database, matching Prisma's return
        // shape (the full created/updated row).
        create: async ({ data }: any) => ({
          id: 'mock-user-1',
          publicKey: data.walletAddress ?? null,
          role: 'USER',
          wins: 0,
          streak: 0,
          virtualBalance: data.virtualBalance ?? 1000,
          lastLoginAt: data.lastLoginAt ?? new Date(),
          createdAt: new Date(),
          ...data,
        }),
        update: async ({ data }: any) => ({
          id: 'mock-user-1',
          walletAddress: 'mock-user-wallet',
          publicKey: 'mock-user-wallet',
          role: 'USER',
          wins: 0,
          streak: 0,
          virtualBalance: 1000,
          createdAt: new Date(),
          lastLoginAt: new Date(),
          ...data,
        }),
      },
      // #664: signup/daily-bonus ledger entries written by the connect flow.
      transaction: {
        create: async ({ data }: any) => ({ id: 'mock-txn-1', createdAt: new Date(), ...data }),
        findMany: async () => [],
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

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
  if (process.env.NODE_ENV === 'test' && process.env.USE_PRISMA_MOCK === 'true') {
    const mock: Partial<PrismaClient> = {
      idempotencyKey: {
        deleteMany: async () => ({ count: 0 }) as any,
        findUnique: async () => null as any,
        upsert: async () => null as any,
        create: async () => null as any,
        updateMany: async () => ({ count: 0 }) as any,
      },
      $queryRaw: async () => null,
    } as any;
    return mock as PrismaClient;
  }

  if (config.app.dataStore === 'memory') {
    logger.info('Prisma client backed by in-memory store (DATA_STORE=memory)');
    return createMemoryPrismaClient() as unknown as PrismaClient;
  }

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

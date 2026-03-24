import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';

const DEFAULT_DB_POOL_MAX = 10;
const DEFAULT_DB_CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_DB_IDLE_TIMEOUT_MS = 300000;
const DEFAULT_DB_MAX_LIFETIME_S = 0;

type PoolConfig = {
  poolMax: number;
  connectionTimeoutMs: number;
  poolTimeoutSeconds: number;
  idleTimeoutMs: number;
  maxLifetimeSeconds: number;
};

type PoolConfigBuildResult = {
  databaseUrl: string;
  config: PoolConfig;
  normalized: string[];
  warnings: string[];
};

const parseNonNegativeInteger = (
  rawValue: string | undefined,
  envVar: string,
  fallback: number,
  minimum: number,
): number => {
  if (rawValue === undefined || rawValue.trim() === '') {
    return fallback;
  }

  if (!/^\d+$/.test(rawValue)) {
    throw new Error(
      `Invalid ${envVar} value "${rawValue}". Expected an integer >= ${minimum}.`,
    );
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (parsed < minimum) {
    throw new Error(
      `Invalid ${envVar} value "${rawValue}". Expected an integer >= ${minimum}.`,
    );
  }

  return parsed;
};

export const buildPrismaPoolConfig = (
  env: NodeJS.ProcessEnv = process.env,
): PoolConfigBuildResult => {
  const rawDatabaseUrl = env.DATABASE_URL;
  if (!rawDatabaseUrl) {
    throw new Error('Missing required environment variable: DATABASE_URL');
  }

  const poolMax = parseNonNegativeInteger(
    env.DB_POOL_MAX,
    'DB_POOL_MAX',
    DEFAULT_DB_POOL_MAX,
    1,
  );
  const connectionTimeoutMs = parseNonNegativeInteger(
    env.DB_CONNECTION_TIMEOUT_MS,
    'DB_CONNECTION_TIMEOUT_MS',
    DEFAULT_DB_CONNECTION_TIMEOUT_MS,
    0,
  );
  const idleTimeoutMs = parseNonNegativeInteger(
    env.DB_IDLE_TIMEOUT_MS,
    'DB_IDLE_TIMEOUT_MS',
    DEFAULT_DB_IDLE_TIMEOUT_MS,
    0,
  );
  const maxLifetimeSeconds = parseNonNegativeInteger(
    env.DB_MAX_LIFETIME_S,
    'DB_MAX_LIFETIME_S',
    DEFAULT_DB_MAX_LIFETIME_S,
    0,
  );

  const normalized: string[] = [];
  // Prisma v5 pool_timeout is in seconds. Keep "0 means disabled".
  let poolTimeoutSeconds = 0;
  if (connectionTimeoutMs > 0) {
    poolTimeoutSeconds = Math.ceil(connectionTimeoutMs / 1000);
    if (poolTimeoutSeconds * 1000 !== connectionTimeoutMs) {
      normalized.push(
        `DB_CONNECTION_TIMEOUT_MS=${connectionTimeoutMs}ms normalized to pool_timeout=${poolTimeoutSeconds}s for Prisma v5.`,
      );
    }
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawDatabaseUrl);
  } catch (error) {
    throw new Error(
      `Invalid DATABASE_URL value "${rawDatabaseUrl}". Expected a valid database connection URL.`,
    );
  }

  parsedUrl.searchParams.set('connection_limit', String(poolMax));
  parsedUrl.searchParams.set('pool_timeout', String(poolTimeoutSeconds));

  const warnings: string[] = [];
  // Prisma v5 query engine doesn't expose direct idle/lifetime pool controls.
  if (idleTimeoutMs !== DEFAULT_DB_IDLE_TIMEOUT_MS) {
    warnings.push(
      'DB_IDLE_TIMEOUT_MS is validated and logged, but Prisma v5 does not expose a direct pool idle timeout setting.',
    );
  }
  if (maxLifetimeSeconds !== DEFAULT_DB_MAX_LIFETIME_S) {
    warnings.push(
      'DB_MAX_LIFETIME_S is validated and logged, but Prisma v5 does not expose a direct pool max lifetime setting.',
    );
  }

  return {
    databaseUrl: parsedUrl.toString(),
    config: {
      poolMax,
      connectionTimeoutMs,
      poolTimeoutSeconds,
      idleTimeoutMs,
      maxLifetimeSeconds,
    },
    normalized,
    warnings,
  };
};

const prismaPoolConfig = buildPrismaPoolConfig();
for (const message of prismaPoolConfig.normalized) {
  logger.warn(message);
}
for (const message of prismaPoolConfig.warnings) {
  logger.warn(message);
}
logger.info('Prisma pool configuration loaded', {
  poolMax: prismaPoolConfig.config.poolMax,
  connectionTimeoutMs: prismaPoolConfig.config.connectionTimeoutMs,
  poolTimeoutSeconds: prismaPoolConfig.config.poolTimeoutSeconds,
  idleTimeoutMs: prismaPoolConfig.config.idleTimeoutMs,
  maxLifetimeSeconds: prismaPoolConfig.config.maxLifetimeSeconds,
});

// PrismaClient is attached to the `global` object in development to prevent
// exhausting your database connection limit.
const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    datasources: {
      db: {
        url: prismaPoolConfig.databaseUrl,
      },
    },
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

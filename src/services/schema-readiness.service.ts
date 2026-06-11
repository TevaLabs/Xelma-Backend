/**
 * Schema Compatibility Readiness Service
 *
 * Compares the set of migration files on disk against the migrations that
 * Prisma has already applied in the _prisma_migrations table.  Returns a
 * structured payload that distinguishes three states:
 *
 *   "compatible"  — every on-disk migration is applied; schema is in sync.
 *   "outdated"    — one or more migrations exist on disk but have not been
 *                   applied yet; a `prisma migrate deploy` is needed.
 *   "unknown"     — the _prisma_migrations table could not be queried (DB
 *                   down, no permission, schema never initialised).
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

export interface SchemaReadinessPayload {
  database: 'healthy' | 'unreachable';
  schema: 'compatible' | 'outdated' | 'unknown';
  appliedMigrations: number;
  totalMigrations: number;
  pendingMigrations: number;
  /** Names of migrations on-disk that have not yet been applied. */
  pendingNames: string[];
  ready: boolean;
}

/** Resolve the prisma/migrations directory relative to the project root. */
function getMigrationsDir(): string {
  return join(process.cwd(), 'prisma', 'migrations');
}

/**
 * List migration names (folder names) present on disk, sorted
 * chronologically by the timestamp prefix Prisma uses.
 */
function listDiskMigrations(migrationsDir: string): string[] {
  try {
    return readdirSync(migrationsDir, { withFileTypes: true })
      .filter(
        entry =>
          entry.isDirectory() &&
          /^\d{14}_/.test(entry.name), // Prisma timestamp prefix
      )
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Query _prisma_migrations for rows whose applied_steps_count > 0,
 * meaning Prisma considers them successfully applied.
 */
async function listAppliedMigrations(
  prisma: PrismaClient,
): Promise<string[]> {
  const rows = await (prisma as any).$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name
    FROM _prisma_migrations
    WHERE applied_steps_count > 0
    ORDER BY started_at ASC
  `;
  return rows.map((r: { migration_name: string }) => r.migration_name);
}

/**
 * Build and return a SchemaReadinessPayload.
 *
 * @param prisma        PrismaClient instance to query.
 * @param migrationsDir Optional override for the migrations directory path
 *                      (useful in tests).
 */
export async function checkSchemaReadiness(
  prisma: PrismaClient,
  migrationsDir?: string,
): Promise<SchemaReadinessPayload> {
  const dir = migrationsDir ?? getMigrationsDir();
  const diskMigrations = listDiskMigrations(dir);
  const total = diskMigrations.length;

  let applied: string[];
  let dbStatus: 'healthy' | 'unreachable';

  try {
    applied = await listAppliedMigrations(prisma);
    dbStatus = 'healthy';
  } catch {
    return {
      database: 'unreachable',
      schema: 'unknown',
      appliedMigrations: 0,
      totalMigrations: total,
      pendingMigrations: total,
      pendingNames: diskMigrations,
      ready: false,
    };
  }

  const appliedSet = new Set(applied);
  const pendingNames = diskMigrations.filter(name => !appliedSet.has(name));
  const pending = pendingNames.length;
  const appliedCount = total - pending;

  const schema: 'compatible' | 'outdated' =
    pending === 0 ? 'compatible' : 'outdated';

  return {
    database: dbStatus,
    schema,
    appliedMigrations: appliedCount,
    totalMigrations: total,
    pendingMigrations: pending,
    pendingNames,
    ready: schema === 'compatible',
  };
}

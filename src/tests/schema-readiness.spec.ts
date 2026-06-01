/**
 * Tests for the schema compatibility readiness service.
 * Uses a fake prisma client and an in-memory migration directory list
 * so no real database is required.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { checkSchemaReadiness } from '../services/schema-readiness.service';
import { readdirSync } from 'fs';

// Stub out filesystem reads so tests are hermetic
jest.mock('fs', () => ({
  ...jest.requireActual('fs') as object,
  readdirSync: jest.fn(),
}));

const mockReaddirSync = readdirSync as jest.MockedFunction<typeof readdirSync>;

function fakeDirEntry(name: string) {
  return {
    name,
    isDirectory: () => true,
    isFile: () => false,
  } as any;
}

function buildPrisma(appliedNames: string[], shouldFail = false) {
  return {
    $queryRaw: jest.fn().mockImplementation(() => {
      if (shouldFail) return Promise.reject(new Error('DB error'));
      return Promise.resolve(
        appliedNames.map(n => ({ migration_name: n })),
      );
    }),
  } as any;
}

const DISK_MIGRATIONS = [
  '20260130171459_init',
  '20260130171720_add_wins_streak',
  '20260226000000_decimal_monetary_fields',
];

beforeEach(() => {
  mockReaddirSync.mockReturnValue(DISK_MIGRATIONS.map(fakeDirEntry));
});

describe('checkSchemaReadiness', () => {
  it('reports compatible when all migrations are applied', async () => {
    const prisma = buildPrisma(DISK_MIGRATIONS);
    const result = await checkSchemaReadiness(prisma, '/fake/migrations');
    expect(result.ready).toBe(true);
    expect(result.schema).toBe('compatible');
    expect(result.database).toBe('healthy');
    expect(result.pendingMigrations).toBe(0);
    expect(result.pendingNames).toHaveLength(0);
  });

  it('reports outdated when migrations are pending', async () => {
    const applied = DISK_MIGRATIONS.slice(0, 1);
    const prisma = buildPrisma(applied);
    const result = await checkSchemaReadiness(prisma, '/fake/migrations');
    expect(result.ready).toBe(false);
    expect(result.schema).toBe('outdated');
    expect(result.pendingMigrations).toBe(2);
    expect(result.pendingNames).toContain('20260130171720_add_wins_streak');
    expect(result.pendingNames).toContain('20260226000000_decimal_monetary_fields');
  });

  it('reports database unreachable when Prisma throws', async () => {
    const prisma = buildPrisma([], true);
    const result = await checkSchemaReadiness(prisma, '/fake/migrations');
    expect(result.database).toBe('unreachable');
    expect(result.schema).toBe('unknown');
    expect(result.ready).toBe(false);
    expect(result.pendingMigrations).toBe(DISK_MIGRATIONS.length);
  });

  it('returns zero totals when the migrations folder is empty', async () => {
    mockReaddirSync.mockReturnValue([]);
    const prisma = buildPrisma([]);
    const result = await checkSchemaReadiness(prisma, '/fake/migrations');
    expect(result.totalMigrations).toBe(0);
    expect(result.ready).toBe(true);
    expect(result.schema).toBe('compatible');
  });

  it('counts applied and total correctly', async () => {
    const applied = DISK_MIGRATIONS.slice(0, 2);
    const prisma = buildPrisma(applied);
    const result = await checkSchemaReadiness(prisma, '/fake/migrations');
    expect(result.totalMigrations).toBe(3);
    expect(result.appliedMigrations).toBe(2);
    expect(result.pendingMigrations).toBe(1);
  });
});

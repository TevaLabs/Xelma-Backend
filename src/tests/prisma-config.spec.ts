import { describe, expect, it } from '@jest/globals';
import { buildPrismaPoolConfig } from '../lib/prisma';

const baseEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/xelma_db',
};

describe('buildPrismaPoolConfig', () => {
  it('uses safe defaults when pool vars are unset', () => {
    const result = buildPrismaPoolConfig({ ...baseEnv });

    expect(result.config.poolMax).toBe(10);
    expect(result.config.connectionTimeoutMs).toBe(5000);
    expect(result.config.poolTimeoutSeconds).toBe(5);
    expect(result.config.idleTimeoutMs).toBe(300000);
    expect(result.config.maxLifetimeSeconds).toBe(0);

    const url = new URL(result.databaseUrl);
    expect(url.searchParams.get('connection_limit')).toBe('10');
    expect(url.searchParams.get('pool_timeout')).toBe('5');
  });

  it('maps custom pool settings into datasource URL', () => {
    const result = buildPrismaPoolConfig({
      ...baseEnv,
      DB_POOL_MAX: '24',
      DB_CONNECTION_TIMEOUT_MS: '12000',
      DB_IDLE_TIMEOUT_MS: '600000',
      DB_MAX_LIFETIME_S: '3600',
    });

    const url = new URL(result.databaseUrl);
    expect(url.searchParams.get('connection_limit')).toBe('24');
    expect(url.searchParams.get('pool_timeout')).toBe('12');
    expect(result.config.idleTimeoutMs).toBe(600000);
    expect(result.config.maxLifetimeSeconds).toBe(3600);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('normalizes non-second connection timeout values up to whole seconds', () => {
    const result = buildPrismaPoolConfig({
      ...baseEnv,
      DB_CONNECTION_TIMEOUT_MS: '1500',
    });

    expect(result.config.poolTimeoutSeconds).toBe(2);
    expect(result.normalized).toEqual(
      expect.arrayContaining([
        expect.stringContaining('normalized to pool_timeout=2s'),
      ]),
    );
  });

  it('rejects invalid DB_POOL_MAX values', () => {
    expect(() =>
      buildPrismaPoolConfig({
        ...baseEnv,
        DB_POOL_MAX: '0',
      }),
    ).toThrow('Invalid DB_POOL_MAX value "0"');

    expect(() =>
      buildPrismaPoolConfig({
        ...baseEnv,
        DB_POOL_MAX: 'abc',
      }),
    ).toThrow('Invalid DB_POOL_MAX value "abc"');
  });

  it('rejects invalid timeout values', () => {
    expect(() =>
      buildPrismaPoolConfig({
        ...baseEnv,
        DB_CONNECTION_TIMEOUT_MS: '-1',
      }),
    ).toThrow('Invalid DB_CONNECTION_TIMEOUT_MS value "-1"');

    expect(() =>
      buildPrismaPoolConfig({
        ...baseEnv,
        DB_IDLE_TIMEOUT_MS: '1.5',
      }),
    ).toThrow('Invalid DB_IDLE_TIMEOUT_MS value "1.5"');
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() =>
      buildPrismaPoolConfig({
        DB_POOL_MAX: '10',
      }),
    ).toThrow('Missing required environment variable: DATABASE_URL');
  });
});

/**
 * Tests for the runtime preflight gate (src/config/preflight.ts).
 * All checks run against a fake env object so no real env vars are needed.
 */
import { describe, it, expect } from '@jest/globals';
import { runPreflightChecks, assertPreflightOrExit, PreflightError } from '../config/preflight';

const VALID_ENV: NodeJS.ProcessEnv = {
  JWT_SECRET: 'super-secret-value-for-tests-only',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/xelma',
  NODE_ENV: 'test',
};

describe('runPreflightChecks', () => {
  it('passes with a fully-valid env', () => {
    const result = runPreflightChecks(VALID_ENV);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when JWT_SECRET is missing', () => {
    const env = { ...VALID_ENV, JWT_SECRET: undefined };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('JWT_SECRET'))).toBe(true);
    expect(result.errors.some(e => e.includes('.env.example'))).toBe(true);
  });

  it('fails when DATABASE_URL is missing', () => {
    const env = { ...VALID_ENV, DATABASE_URL: undefined };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('DATABASE_URL'))).toBe(true);
  });

  it('fails when DATABASE_URL is not a valid URL', () => {
    const env = { ...VALID_ENV, DATABASE_URL: 'not-a-url' };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('valid URL'))).toBe(true);
  });

  it('fails when JWT_SECRET is too short', () => {
    const env = { ...VALID_ENV, JWT_SECRET: 'short' };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('too short'))).toBe(true);
    expect(result.errors.some(e => e.includes('openssl rand -base64 32'))).toBe(true);
  });

  it('warns when REDIS_URL has an unexpected scheme', () => {
    const env = { ...VALID_ENV, REDIS_URL: 'http://localhost:6379' };
    const result = runPreflightChecks(env);
    expect(result.warnings.some(w => w.includes('unexpected scheme'))).toBe(true);
  });

  it('does not warn when REDIS_URL is valid', () => {
    const env = { ...VALID_ENV, REDIS_URL: 'redis://localhost:6379' };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('reports multiple failures at once', () => {
    const result = runPreflightChecks({ NODE_ENV: 'test' });
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('includes nodeVersion and environment in result', () => {
    const result = runPreflightChecks(VALID_ENV);
    expect(result.nodeVersion).toMatch(/^v\d+/);
    expect(result.environment).toBe('test');
  });
});

describe('assertPreflightOrExit', () => {
  it('does not throw with a valid env in test environment', () => {
    expect(() => assertPreflightOrExit(VALID_ENV)).not.toThrow();
  });

  it('throws PreflightError in test environment when checks fail', () => {
    const env = { NODE_ENV: 'test', JEST_WORKER_ID: '1' };
    expect(() => assertPreflightOrExit(env)).toThrow(PreflightError);
  });

  it('PreflightError carries the list of failures', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      JEST_WORKER_ID: '1',
      DATABASE_URL: undefined,
      JWT_SECRET: undefined,
    };
    try {
      assertPreflightOrExit(env);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(PreflightError);
      const pf = err as PreflightError;
      expect(pf.failures.length).toBeGreaterThanOrEqual(2);
      expect(pf.message).toContain('cp .env.example .env');
    }
  });
});

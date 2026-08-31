/**
 * Tests for the runtime preflight gate (src/config/preflight.ts).
 * All checks run against a fake env object so no real env vars are needed.
 */
import { describe, it, expect } from '@jest/globals';
import {
  runPreflightChecks,
  assertPreflightOrExit,
  PreflightError,
  detectMode,
  detectSafetyProfile,
} from '../config/preflight';

const FULL_ENV: NodeJS.ProcessEnv = {
  JWT_SECRET: 'super-secret-value-for-tests-only',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/xelma',
  NODE_ENV: 'test',
};

const PRODUCTION_ENV: NodeJS.ProcessEnv = {
  ...FULL_ENV,
  SAFETY_PROFILE: 'production',
  SOROBAN_FAIL_CLOSED: 'true',
  SOROBAN_ADMIN_SECRET: 'SABCDEF...test',
  SOROBAN_ORACLE_SECRET: 'SABCDEF...test',
};

const HACKATHON_ENV: NodeJS.ProcessEnv = {
  DATA_MODE: 'mock',
  JWT_SECRET: 'dev-secret',
  NODE_ENV: 'test',
};

describe('detectMode', () => {
  it('detects hackathon mode when DATA_MODE=mock', () => {
    expect(detectMode({ DATA_MODE: 'mock' })).toBe('hackathon');
  });

  it('detects full mode when DATA_MODE is unset', () => {
    expect(detectMode({})).toBe('full');
  });

  it('detects full mode when DATA_MODE=live', () => {
    expect(detectMode({ DATA_MODE: 'live' })).toBe('full');
  });
});

describe('runPreflightChecks — full mode', () => {
  it('passes with a fully-valid env', () => {
    const result = runPreflightChecks(FULL_ENV);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.mode).toBe('full');
  });

  it('fails when JWT_SECRET is missing', () => {
    const env = { ...FULL_ENV, JWT_SECRET: undefined };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('JWT_SECRET'))).toBe(true);
    expect(result.errors.some(e => e.includes('.env.example'))).toBe(true);
  });

  it('fails when DATABASE_URL is missing', () => {
    const env = { ...FULL_ENV, DATABASE_URL: undefined };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('DATABASE_URL'))).toBe(true);
  });

  it('fails when DATABASE_URL is not a valid URL', () => {
    const env = { ...FULL_ENV, DATABASE_URL: 'not-a-url' };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('valid URL'))).toBe(true);
  });

  it('fails when JWT_SECRET is too short', () => {
    const env = { ...FULL_ENV, JWT_SECRET: 'short' };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('too short'))).toBe(true);
    expect(result.errors.some(e => e.includes('openssl rand -base64 32'))).toBe(true);
  });

  it('warns when REDIS_URL has an unexpected scheme', () => {
    const env = { ...FULL_ENV, REDIS_URL: 'http://localhost:6379' };
    const result = runPreflightChecks(env);
    expect(result.warnings.some(w => w.includes('unexpected scheme'))).toBe(true);
  });

  it('does not warn when REDIS_URL is valid', () => {
    const env = { ...FULL_ENV, REDIS_URL: 'redis://localhost:6379' };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('runPreflightChecks — hackathon mode', () => {
  it('passes with DATA_MODE=mock and a short JWT_SECRET, no DATABASE_URL', () => {
    const result = runPreflightChecks(HACKATHON_ENV);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.mode).toBe('hackathon');
  });

  it('passes even without DATABASE_URL', () => {
    const env = { ...HACKATHON_ENV, DATABASE_URL: undefined };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('hackathon');
  });

  it('passes even with a short JWT_SECRET', () => {
    const env = { ...HACKATHON_ENV, JWT_SECRET: 'ab' };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(true);
  });

  it('fails when JWT_SECRET is missing in hackathon mode', () => {
    const env = { ...HACKATHON_ENV, JWT_SECRET: undefined };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('JWT_SECRET'))).toBe(true);
  });

  it('fails when DATA_MODE is mock but JWT_SECRET is empty string', () => {
    const env = { ...HACKATHON_ENV, JWT_SECRET: '' };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('JWT_SECRET'))).toBe(true);
  });
});

describe('runPreflightChecks — edge cases', () => {
  it('reports multiple failures at once in full mode', () => {
    const result = runPreflightChecks({ NODE_ENV: 'test' });
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('includes nodeVersion, environment, and mode in result', () => {
    const result = runPreflightChecks(FULL_ENV);
    expect(result.nodeVersion).toMatch(/^v\d+/);
    expect(result.environment).toBe('test');
    expect(result.mode).toBe('full');
  });
});

describe('detectSafetyProfile', () => {
  it('detects production when SAFETY_PROFILE=production', () => {
    expect(detectSafetyProfile({ SAFETY_PROFILE: 'production' })).toBe('production');
  });

  it('detects demo when SAFETY_PROFILE is unset', () => {
    expect(detectSafetyProfile({})).toBe('demo');
  });

  it('detects demo when SAFETY_PROFILE=demo', () => {
    expect(detectSafetyProfile({ SAFETY_PROFILE: 'demo' })).toBe('demo');
  });
});

describe('runPreflightChecks — production safety profile', () => {
  it('passes with a fully-valid production env', () => {
    const result = runPreflightChecks(PRODUCTION_ENV);
    expect(result.ok).toBe(true);
    expect(result.safetyProfile).toBe('production');
  });

  it('rejects BET_STUB_MODE=true under production profile', () => {
    const env = { ...PRODUCTION_ENV, BET_STUB_MODE: 'true' };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('BET_STUB_MODE'))).toBe(true);
    expect(result.errors.some(e => e.includes('forbidden'))).toBe(true);
  });

  it('allows BET_STUB_MODE=true under demo profile', () => {
    const env = { ...FULL_ENV, BET_STUB_MODE: 'true' };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(true);
  });

  it('rejects SOROBAN_FAIL_CLOSED=false under production profile', () => {
    const env = { ...PRODUCTION_ENV, SOROBAN_FAIL_CLOSED: 'false' };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('SOROBAN_FAIL_CLOSED'))).toBe(true);
  });

  it('rejects SOROBAN_FAIL_CLOSED=unset under production profile', () => {
    const env = { ...PRODUCTION_ENV, SOROBAN_FAIL_CLOSED: undefined };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('SOROBAN_FAIL_CLOSED'))).toBe(true);
  });

  it('allows SOROBAN_FAIL_CLOSED=false under demo profile', () => {
    const env = { ...FULL_ENV, SOROBAN_FAIL_CLOSED: 'false' };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(true);
  });

  it('rejects missing SOROBAN_ADMIN_SECRET under production profile', () => {
    const env = { ...PRODUCTION_ENV, SOROBAN_ADMIN_SECRET: undefined };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('SOROBAN_ADMIN_SECRET'))).toBe(true);
  });

  it('rejects missing SOROBAN_ORACLE_SECRET under production profile', () => {
    const env = { ...PRODUCTION_ENV, SOROBAN_ORACLE_SECRET: undefined };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('SOROBAN_ORACLE_SECRET'))).toBe(true);
  });

  it('allows missing Soroban secrets under demo profile', () => {
    const env = {
      ...FULL_ENV,
      SOROBAN_ADMIN_SECRET: undefined,
      SOROBAN_ORACLE_SECRET: undefined,
    };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(true);
  });

  it('reports ALL production failures at once', () => {
    const env = {
      ...FULL_ENV,
      SAFETY_PROFILE: 'production',
      BET_STUB_MODE: 'true',
      SOROBAN_FAIL_CLOSED: 'false',
      SOROBAN_ADMIN_SECRET: undefined,
      SOROBAN_ORACLE_SECRET: undefined,
    };
    const result = runPreflightChecks(env);
    expect(result.ok).toBe(false);
    // Should have errors for BET_STUB_MODE, SOROBAN_FAIL_CLOSED, SOROBAN_ADMIN_SECRET, SOROBAN_ORACLE_SECRET
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe('assertPreflightOrExit', () => {
  it('does not throw with a valid full env in test environment', () => {
    expect(() => assertPreflightOrExit(FULL_ENV)).not.toThrow();
  });

  it('does not throw with a valid hackathon env in test environment', () => {
    expect(() => assertPreflightOrExit(HACKATHON_ENV)).not.toThrow();
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
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(PreflightError);
      const pf = err as PreflightError;
      expect(pf.failures.length).toBeGreaterThanOrEqual(2);
    }
  });
});

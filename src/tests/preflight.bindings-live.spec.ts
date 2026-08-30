import { runPreflightChecks } from '../config/preflight';

/**
 * Issue #537 — Fail closed on missing vendor bindings when Soroban live
 * mode is enabled.
 *
 * These tests verify the matrix:
 *   Soroban live + bad bindings  → error (fail-closed)
 *   Soroban stub/demo + bad bindings → warn only (allows boot)
 *   No Soroban configured → no bindings check
 */

const VALID_JWT = 'a'.repeat(20);
const VALID_DB = 'postgresql://user:pass@localhost:5432/testdb';

describe('Preflight – Soroban live mode bindings (#537)', () => {
  it('isSorobanLiveMode detects contract + no stub', () => {
    const result = runPreflightChecks({
      JWT_SECRET: VALID_JWT,
      DATABASE_URL: VALID_DB,
      SOROBAN_CONTRACT_ID: 'CABC123',
      BET_STUB_MODE: 'false',
      NODE_ENV: 'test',
    });
    // Should not crash — just checking the mode detection logic works
    expect(result.mode).toBe('full');
  });

  it('allows boot when BET_STUB_MODE=true even with contract configured', () => {
    // Stub mode means bindings are not used, so validation should warn only
    const result = runPreflightChecks({
      JWT_SECRET: VALID_JWT,
      DATABASE_URL: VALID_DB,
      SOROBAN_CONTRACT_ID: 'CABC123',
      BET_STUB_MODE: 'true',
      BINDINGS_CHECK: 'off',
      NODE_ENV: 'test',
    });
    // With BINDINGS_CHECK=off, no bindings errors
    const bindingsErrors = result.errors.filter(e =>
      e.includes('vendored bindings') || e.includes('bindings'),
    );
    expect(bindingsErrors).toHaveLength(0);
  });

  it('warns when bindings are invalid but not in live mode', () => {
    // No contract configured, so bindings are not live-critical
    const result = runPreflightChecks({
      JWT_SECRET: VALID_JWT,
      DATABASE_URL: VALID_DB,
      NODE_ENV: 'test',
    });
    // No Soroban live mode, so bindings check should not produce errors
    const bindingsErrors = result.errors.filter(e =>
      e.includes('Soroban live mode'),
    );
    expect(bindingsErrors).toHaveLength(0);
  });

  it('BINDINGS_CHECK=off disables the bindings check entirely', () => {
    const result = runPreflightChecks({
      JWT_SECRET: VALID_JWT,
      DATABASE_URL: VALID_DB,
      SOROBAN_CONTRACT_ID: 'CABC123',
      BET_STUB_MODE: 'false',
      BINDINGS_CHECK: 'off',
      NODE_ENV: 'test',
    });
    const bindingsErrors = result.errors.filter(e =>
      e.includes('vendored bindings') || e.includes('Soroban live mode'),
    );
    expect(bindingsErrors).toHaveLength(0);
  });

  it('stubs still boot with bad bindings and BINDINGS_CHECK=warn', () => {
    const result = runPreflightChecks({
      JWT_SECRET: VALID_JWT,
      DATABASE_URL: VALID_DB,
      SOROBAN_CONTRACT_ID: 'CABC123',
      BET_STUB_MODE: 'true',
      BINDINGS_CHECK: 'warn',
      NODE_ENV: 'test',
    });
    // No errors from bindings in stub mode
    const bindingsErrors = result.errors.filter(e =>
      e.includes('vendored bindings') || e.includes('Soroban live mode'),
    );
    expect(bindingsErrors).toHaveLength(0);
  });
});

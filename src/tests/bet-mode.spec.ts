/**
 * Tests for the bet-mode resolver (src/config/bet-mode.ts).
 *
 * The resolver is the single source of truth for stub vs on-chain bet mode and
 * is exercised here across the full env matrix, including the four
 * prod/non-prod × secrets present/absent combinations required by #622.
 */
import { describe, it, expect } from '@jest/globals';
import {
  resolveBetMode,
  isBetStubMode,
  isProductionProfile,
  isExplicitStubMode,
  missingSorobanConfig,
} from '../config/bet-mode';

/** Complete on-chain Soroban config. */
const SOROBAN_CONFIG = {
  SOROBAN_CONTRACT_ID: 'CCJZ5DGZBW5JRZYPZ6J6V3JZ5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z',
  SOROBAN_ADMIN_SECRET: 'SADMINSECRETADMINSECRETADMINSECRETADMINSECRETADMINSECR',
  SOROBAN_ORACLE_SECRET: 'SORACLESECRETORACLESECRETORACLESECRETORACLESECRETORACLES',
};

const DEV_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
const TEST_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test' };

/** Production-like signals that must behave the same way. */
const PRODUCTION_PROFILES: Array<{ label: string; env: NodeJS.ProcessEnv }> = [
  { label: 'NODE_ENV=production', env: { NODE_ENV: 'production' } },
  { label: 'SAFETY_PROFILE=production', env: { SAFETY_PROFILE: 'production' } },
];

describe('isProductionProfile', () => {
  it('is true for NODE_ENV=production', () => {
    expect(isProductionProfile({ NODE_ENV: 'production' })).toBe(true);
  });

  it('is true for SAFETY_PROFILE=production', () => {
    expect(isProductionProfile({ SAFETY_PROFILE: 'production' })).toBe(true);
  });

  it('is false for development / test / demo', () => {
    expect(isProductionProfile({ NODE_ENV: 'development' })).toBe(false);
    expect(isProductionProfile({ NODE_ENV: 'test' })).toBe(false);
    expect(isProductionProfile({ SAFETY_PROFILE: 'demo' })).toBe(false);
  });
});

describe('isExplicitStubMode', () => {
  it('only treats the literal string "true" as explicit stub', () => {
    expect(isExplicitStubMode({ BET_STUB_MODE: 'true' })).toBe(true);
    expect(isExplicitStubMode({ BET_STUB_MODE: 'TRUE' })).toBe(true);
    expect(isExplicitStubMode({ BET_STUB_MODE: ' true ' })).toBe(true);
    expect(isExplicitStubMode({ BET_STUB_MODE: 'false' })).toBe(false);
    expect(isExplicitStubMode({})).toBe(false);
  });
});

describe('missingSorobanConfig', () => {
  it('reports nothing when all required vars are present', () => {
    expect(missingSorobanConfig({ ...SOROBAN_CONFIG })).toEqual([]);
  });

  it('accepts the CONTRACT_ID alias', () => {
    expect(
      missingSorobanConfig({
        CONTRACT_ID: SOROBAN_CONFIG.SOROBAN_CONTRACT_ID,
        SOROBAN_ADMIN_SECRET: SOROBAN_CONFIG.SOROBAN_ADMIN_SECRET,
        SOROBAN_ORACLE_SECRET: SOROBAN_CONFIG.SOROBAN_ORACLE_SECRET,
      }),
    ).toEqual([]);
  });

  it('reports every missing/blank var', () => {
    expect(
      missingSorobanConfig({
        SOROBAN_CONTRACT_ID: '   ',
        SOROBAN_ADMIN_SECRET: undefined,
        SOROBAN_ORACLE_SECRET: '',
      }),
    ).toEqual([
      'SOROBAN_CONTRACT_ID',
      'SOROBAN_ADMIN_SECRET',
      'SOROBAN_ORACLE_SECRET',
    ]);
  });
});

describe('resolveBetMode — prod/non-prod × secrets present/absent', () => {
  const cases: Array<{
    name: string;
    env: NodeJS.ProcessEnv;
    mode: 'stub' | 'on-chain';
    source: string;
    fellBackToStub: boolean;
  }> = [
    {
      name: 'non-production + secrets present → on-chain',
      env: { ...DEV_ENV, ...SOROBAN_CONFIG },
      mode: 'on-chain',
      source: 'config',
      fellBackToStub: false,
    },
    {
      name: 'non-production + secrets absent → stub fallback',
      env: { ...DEV_ENV },
      mode: 'stub',
      source: 'stub-fallback',
      fellBackToStub: true,
    },
    {
      name: 'test env + secrets absent → stub fallback',
      env: { ...TEST_ENV },
      mode: 'stub',
      source: 'stub-fallback',
      fellBackToStub: true,
    },
  ];

  for (const profile of PRODUCTION_PROFILES) {
    cases.push({
      name: `production (${profile.label}) + secrets present → on-chain`,
      env: { ...profile.env, ...SOROBAN_CONFIG },
      mode: 'on-chain',
      source: 'config',
      fellBackToStub: false,
    });
    cases.push({
      name: `production (${profile.label}) + secrets absent → never silently stub`,
      env: { ...profile.env },
      mode: 'on-chain',
      source: 'production-guard',
      fellBackToStub: false,
    });
  }

  it.each(cases)('$name', ({ env, mode, source, fellBackToStub }) => {
    const result = resolveBetMode(env);
    expect(result.mode).toBe(mode);
    expect(result.source).toBe(source);
    expect(result.fellBackToStub).toBe(fellBackToStub);
    expect(isBetStubMode(env)).toBe(mode === 'stub');
  });

  it('production without secrets is never stub', () => {
    for (const profile of PRODUCTION_PROFILES) {
      expect(isBetStubMode({ ...profile.env })).toBe(false);
    }
  });
});

describe('resolveBetMode — explicit BET_STUB_MODE', () => {
  it('explicit true wins even with full Soroban config', () => {
    const result = resolveBetMode({ ...DEV_ENV, ...SOROBAN_CONFIG, BET_STUB_MODE: 'true' });
    expect(result.mode).toBe('stub');
    expect(result.source).toBe('explicit');
    expect(result.fellBackToStub).toBe(false);
  });

  it('explicit true with missing config is not a fallback', () => {
    const result = resolveBetMode({ ...DEV_ENV, BET_STUB_MODE: 'true' });
    expect(result.mode).toBe('stub');
    expect(result.source).toBe('explicit');
    expect(result.fellBackToStub).toBe(false);
    expect(result.missingConfig).toHaveLength(3);
  });

  it('explicit false with full config stays on-chain', () => {
    const result = resolveBetMode({ ...DEV_ENV, ...SOROBAN_CONFIG, BET_STUB_MODE: 'false' });
    expect(result.mode).toBe('on-chain');
    expect(result.fellBackToStub).toBe(false);
  });

  it('explicit false with missing config falls back to stub in non-production', () => {
    const result = resolveBetMode({ ...DEV_ENV, BET_STUB_MODE: 'false' });
    expect(result.mode).toBe('stub');
    expect(result.source).toBe('stub-fallback');
    expect(result.fellBackToStub).toBe(true);
  });

  it('explicit true under production is honoured here (preflight rejects it)', () => {
    const result = resolveBetMode({ NODE_ENV: 'production', BET_STUB_MODE: 'true' });
    expect(result.mode).toBe('stub');
    expect(result.source).toBe('explicit');
  });
});

describe('resolveBetMode — fallback details', () => {
  it('reports the missing config that forced the fallback', () => {
    const result = resolveBetMode({
      NODE_ENV: 'development',
      SOROBAN_CONTRACT_ID: SOROBAN_CONFIG.SOROBAN_CONTRACT_ID,
    });
    expect(result.fellBackToStub).toBe(true);
    expect(result.missingConfig).toEqual(['SOROBAN_ADMIN_SECRET', 'SOROBAN_ORACLE_SECRET']);
  });

  it('defaults to process.env when no env is supplied', () => {
    expect(typeof resolveBetMode().mode).toBe('string');
    expect(typeof isBetStubMode()).toBe('boolean');
  });
});

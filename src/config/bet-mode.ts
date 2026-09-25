/**
 * Bet-mode resolution — the single source of truth for whether bet placement
 * runs against Soroban (on-chain) or records DB-only stub bets.
 *
 * Precedence:
 *  1. An explicit `BET_STUB_MODE=true` always wins (stub).
 *  2. With `BET_STUB_MODE` unset/`false` and the required Soroban config
 *     present, bets run on-chain.
 *  3. With required Soroban config missing:
 *       - production-like (`NODE_ENV=production` or `SAFETY_PROFILE=production`):
 *         never silently stub. The mode resolves on-chain and startup preflight
 *         refuses to boot, so a production box cannot take money paths without
 *         secrets.
 *       - non-production: fall back to stub and warn loudly at boot. Local
 *         clones and hackathon deploys boot instead of throwing opaque Soroban
 *         RPC errors.
 *
 * `BetService` and the startup logs both call this so the resolved mode cannot
 * drift between what runs and what is reported.
 */
import { resolveSorobanEnvVars } from './env';

export type BetMode = 'stub' | 'on-chain';

/**
 * How the mode was decided.
 * - `explicit`          — `BET_STUB_MODE=true`.
 * - `config`            — Soroban config present (or explicit `false`), on-chain.
 * - `stub-fallback`     — non-production fallback because config was missing.
 * - `production-guard`  — production-like environment with config missing; does
 *                         not stub so preflight fails instead.
 */
export type BetModeSource =
  | 'explicit'
  | 'config'
  | 'stub-fallback'
  | 'production-guard';

export interface BetModeResolution {
  /** Resolved mode: `'stub'` or `'on-chain'`. */
  mode: BetMode;
  /** How the mode was decided. */
  source: BetModeSource;
  /** Required Soroban env vars that are unset/blank (empty when none). */
  missingConfig: string[];
  /** True when the mode was forced to stub by missing config (not explicit). */
  fellBackToStub: boolean;
  /** True when `NODE_ENV=production` or `SAFETY_PROFILE=production`. */
  production: boolean;
}

/** Required for on-chain bet placement. */
export const REQUIRED_SOROBAN_CONFIG = [
  'SOROBAN_CONTRACT_ID',
  'SOROBAN_ADMIN_SECRET',
  'SOROBAN_ORACLE_SECRET',
] as const;

/**
 * Production-like environments never silently stub. `NODE_ENV=production` is
 * the conventional signal used by deployments; `SAFETY_PROFILE=production` is
 * the explicit money-path safety profile.
 */
export function isProductionProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env.SAFETY_PROFILE === 'production';
}

/** True when `BET_STUB_MODE` is explicitly set to `true`. */
export function isExplicitStubMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BET_STUB_MODE?.trim().toLowerCase() === 'true';
}

/** Names of the required Soroban vars that are unset/blank. */
export function missingSorobanConfig(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const resolved = resolveSorobanEnvVars(env);
  const missing: string[] = [];
  // `resolveSorobanEnvVars` resolves the CONTRACT_ID alias for us.
  if (!resolved.contractId.value) missing.push('SOROBAN_CONTRACT_ID');
  if (!resolved.adminSecret) missing.push('SOROBAN_ADMIN_SECRET');
  if (!resolved.oracleSecret) missing.push('SOROBAN_ORACLE_SECRET');
  return missing;
}

/**
 * Resolve the active bet mode and explain why.
 *
 * Pure: reads only the supplied env object and never logs or throws, which
 * keeps it usable both at startup (with a warning) and inside `BetService`
 * (per request) and trivially table-testable.
 */
export function resolveBetMode(
  env: NodeJS.ProcessEnv = process.env,
): BetModeResolution {
  const production = isProductionProfile(env);
  const missingConfig = missingSorobanConfig(env);

  if (isExplicitStubMode(env)) {
    return {
      mode: 'stub',
      source: 'explicit',
      missingConfig,
      fellBackToStub: false,
      production,
    };
  }

  if (missingConfig.length === 0) {
    return {
      mode: 'on-chain',
      source: 'config',
      missingConfig,
      fellBackToStub: false,
      production,
    };
  }

  if (production) {
    // Refuse to silently stub: preflight is expected to abort startup.
    return {
      mode: 'on-chain',
      source: 'production-guard',
      missingConfig,
      fellBackToStub: false,
      production,
    };
  }

  return {
    mode: 'stub',
    source: 'stub-fallback',
    missingConfig,
    fellBackToStub: true,
    production,
  };
}

/** Convenience boolean for call sites that only need stub-or-not. */
export function isBetStubMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveBetMode(env).mode === 'stub';
}

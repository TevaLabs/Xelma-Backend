/**
 * Runtime preflight gate — validates critical startup conditions before
 * Express initializes. Fails fast with human-readable diagnostics.
 *
 * The checks are mode-aware based on DATA_MODE:
 *   "mock"  — hackathon/demo mode: lightweight checks, no database required
 *   "live"  — full production mode: strict checks on all required vars
 *   unset   — defaults to "live" (full mode)
 *
 * Hackathon checks:
 *  1. DATA_MODE is explicitly set to "mock"
 *  2. JWT_SECRET is present and non-empty
 *  3. Node.js version >= 22.x
 *
 * Full mode checks:
 *  1. Required env vars (JWT_SECRET, DATABASE_URL) present and non-empty
 *  2. Node.js version >= 22.x
 *  3. DATABASE_URL is parseable as a URL
 *  4. JWT_SECRET meets minimum length (16+ chars)
 *  5. REDIS_URL (warning only)
 */

import { execSync } from 'child_process';
import logger from '../utils/logger';
export type RuntimeMode = 'hackathon' | 'full';
export type SafetyProfile = 'production' | 'demo';

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  nodeVersion: string;
  environment: string;
  mode: RuntimeMode;
  safetyProfile: SafetyProfile;
}

/** Variables required in ALL modes. */
const BASE_REQUIRED_VARS: Record<string, string> = {
  JWT_SECRET:
    'Generate a strong value, for example: openssl rand -base64 32',
};

/** Variables required ONLY in full (live) mode. */
const FULL_REQUIRED_VARS: Record<string, string> = {
  DATABASE_URL:
    'Expected format: postgresql://user:pass@host:5432/database',
};

/** Variables required when SAFETY_PROFILE=production. */
const PRODUCTION_REQUIRED_VARS: Record<string, string> = {
  SOROBAN_ADMIN_SECRET:
    'Production requires SOROBAN_ADMIN_SECRET for on-chain bet placement.',
  SOROBAN_ORACLE_SECRET:
    'Production requires SOROBAN_ORACLE_SECRET for round resolution.',
};

/** Minimum Node.js major version required (mirrors package.json engines). */
const MIN_NODE_MAJOR = 22;

/** JWT_SECRET must be at least this long to prevent trivially-weak secrets. */
const MIN_JWT_SECRET_LENGTH = 16;

/**
 * Detect runtime mode from environment.
 * DATA_MODE=mock => hackathon, anything else => full.
 */
export function detectMode(env: NodeJS.ProcessEnv): RuntimeMode {
  return env.DATA_MODE === 'mock' ? 'hackathon' : 'full';
}

/**
 * Detect safety profile from environment.
 * SAFETY_PROFILE=production => production, anything else => demo.
 */
export function detectSafetyProfile(env: NodeJS.ProcessEnv): SafetyProfile {
  return env.SAFETY_PROFILE === 'production' ? 'production' : 'demo';
}

/**
 * Return the env template file to recommend based on mode.
 */
function envTemplateForMode(mode: RuntimeMode): string {
  return mode === 'hackathon' ? '.env.hackathon.example' : '.env.example';
}

function checkRequiredEnvVars(
  env: NodeJS.ProcessEnv,
  mode: RuntimeMode,
  safetyProfile: SafetyProfile,
): string[] {
  const required = { ...BASE_REQUIRED_VARS };
  if (mode === 'full') {
    Object.assign(required, FULL_REQUIRED_VARS);
  }
  if (safetyProfile === 'production') {
    Object.assign(required, PRODUCTION_REQUIRED_VARS);
  }

  return Object.entries(required)
    .filter(([name]) => !env[name] || env[name]!.trim().length === 0)
    .map(([name, guidance]) => {
      const template = envTemplateForMode(mode);
      if (mode === 'hackathon' && name === 'JWT_SECRET') {
        return [
          `Missing required environment variable: JWT_SECRET. `,
          `In hackathon mode, set any non-empty string. `,
          `Example: JWT_SECRET=dev-secret`,
        ].join('');
      }
      return [
        `Missing required environment variable: ${name}. ${guidance}. `,
        `Set it in ${template} or in your deployment secrets.`,
      ].join('');
    });
}

function checkDataMode(env: NodeJS.ProcessEnv, mode: RuntimeMode): string[] {
  if (mode === 'hackathon' && env.DATA_MODE !== 'mock') {
    return [
      `Hackathon mode requires DATA_MODE=mock. ` +
        `Either set DATA_MODE=mock in .env, or remove it to run in full mode.`,
    ];
  }
  return [];
}

function checkNodeVersion(): string[] {
  if (process.env.NODE_ENV === 'test') return [];
  const raw = process.version; // e.g. "v22.3.0"
  const major = parseInt(raw.replace('v', '').split('.')[0], 10);
  if (isNaN(major) || major < MIN_NODE_MAJOR) {
    return [
      `Node.js version ${raw} is below the minimum required v${MIN_NODE_MAJOR}.x. ` +
        `Upgrade Node.js before starting the server.`,
    ];
  }
  return [];
}

function checkDatabaseUrl(
  env: NodeJS.ProcessEnv,
  mode: RuntimeMode,
): string[] {
  if (mode !== 'full') return [];
  const url = env.DATABASE_URL;
  if (!url) return [];
  try {
    new URL(url);
    return [];
  } catch {
    return [
      `DATABASE_URL is not a valid URL. ` +
        `Expected format: postgresql://user:pass@host:5432/db. ` +
        `Copy .env.example to .env and update DATABASE_URL for your local database.`,
    ];
  }
}

function checkJwtSecretStrength(
  env: NodeJS.ProcessEnv,
  mode: RuntimeMode,
): string[] {
  const secret = env.JWT_SECRET;
  if (!secret) return [];
  if (mode === 'hackathon') return [];
  if (secret.trim().length < MIN_JWT_SECRET_LENGTH) {
    return [
      `JWT_SECRET is too short (${secret.trim().length} chars). ` +
        `Minimum length is ${MIN_JWT_SECRET_LENGTH} characters. ` +
        `Generate one with: openssl rand -base64 32`,
    ];
  }
  return [];
}

function checkRedisIfConfigured(env: NodeJS.ProcessEnv): string[] {
  const url = env.REDIS_URL;
  if (!url) return [];
  try {
    const parsed = new URL(url);
    const validSchemes = ['redis:', 'rediss:', 'redis+sentinel:'];
    if (!validSchemes.includes(parsed.protocol)) {
      return [
        `REDIS_URL has unexpected scheme "${parsed.protocol}". ` +
          `Expected one of: redis://, rediss://, redis+sentinel://`,
      ];
    }
    return [];
  } catch {
    return [`REDIS_URL is set but is not a valid URL.`];
  }
}

function checkProductionSafetyProfile(
  env: NodeJS.ProcessEnv,
  safetyProfile: SafetyProfile,
): string[] {
  if (safetyProfile !== 'production') return [];

  const errors: string[] = [];

  // BET_STUB_MODE must NOT be true in production
  if (env.BET_STUB_MODE === 'true') {
    errors.push(
      `BET_STUB_MODE=true is forbidden under SAFETY_PROFILE=production. ` +
        `Stub mode bypasses on-chain settlement and is unsafe for real stakes. ` +
        `Set BET_STUB_MODE=false or remove it, or switch to SAFETY_PROFILE=demo.`,
    );
  }

  // SOROBAN_FAIL_CLOSED must be true in production
  if (env.SOROBAN_FAIL_CLOSED !== 'true') {
    errors.push(
      `SAFETY_PROFILE=production requires SOROBAN_FAIL_CLOSED=true. ` +
        `Current value: "${env.SOROBAN_FAIL_CLOSED ?? '(unset defaults to false)'}". ` +
        `Fail-closed ensures bets abort when Soroban chain verification fails.`,
    );
  }

  return errors;
}

/**
 * Run all preflight checks against the supplied environment.
 * Does NOT call process.exit — callers decide what to do with the result.
 */
export function runPreflightChecks(
  env: NodeJS.ProcessEnv = process.env,
): PreflightResult {
  const mode: RuntimeMode = detectMode(env);
  const safetyProfile: SafetyProfile = detectSafetyProfile(env);

  const errors: string[] = [
    ...checkRequiredEnvVars(env, mode, safetyProfile),
    ...checkDataMode(env, mode),
    ...checkNodeVersion(),
    ...checkDatabaseUrl(env, mode),
    ...checkJwtSecretStrength(env, mode),
    ...checkProductionSafetyProfile(env, safetyProfile),
  ];

  const warnings: string[] = [...checkRedisIfConfigured(env)];

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    nodeVersion: process.version,
    environment: env.NODE_ENV ?? 'development',
    mode,
    safetyProfile,
  };
}

/**
 * Build a human-readable setup guide based on runtime mode.
 */
function setupGuide(mode: RuntimeMode, safetyProfile: SafetyProfile): string[] {
  if (mode === 'hackathon') {
    return [
      'Local hackathon setup:',
      '  1. cp .env.hackathon.example .env',
      '  2. Set JWT_SECRET to any non-empty string',
      '  3. Ensure DATA_MODE=mock is set',
      '  4. npm run dev:hackathon',
      '',
      'Deployment (Render) hackathon setup:',
      '  - Use the "xelma-backend-hackathon" service profile in render.yaml',
      '  - Configure JWT_SECRET as a secret env var',
      '  - DATA_MODE=mock is pre-configured in render.yaml',
      '',
    ];
  }
  const lines = [
    'Local full-mode setup:',
    '  1. cp .env.example .env',
    '  2. Fill in DATABASE_URL with a running PostgreSQL connection string',
    '  3. Fill in JWT_SECRET (16+ chars; generate with: openssl rand -base64 32)',
    '  4. npm run dev',
    '',
    'Deployment (Render) full-mode setup:',
    '  - Use the "xelma-backend" service profile in render.yaml',
    '  - Configure DATABASE_URL, JWT_SECRET, and Soroban secrets as secret env vars',
    '',
  ];
  if (safetyProfile === 'production') {
    lines.push(
      'Production safety profile (SAFETY_PROFILE=production):',
      '  - BET_STUB_MODE must be false or unset',
      '  - SOROBAN_FAIL_CLOSED must be true',
      '  - SOROBAN_ADMIN_SECRET and SOROBAN_ORACLE_SECRET are required',
      '',
    );
  }
  return lines;
}

/**
 * Run preflight checks and exit the process with code 1 if any fail.
 * Safe to call from src/index.ts or src/server.ts before createApp().
 *
 * In test environments (NODE_ENV=test or JEST_WORKER_ID set) the function
 * throws a PreflightError instead of calling process.exit so test suites
 * can assert on failures.
 */
export function assertPreflightOrExit(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = runPreflightChecks(env);

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
       logger.warn("[preflight] WARNING", { warning: w });
    }
  }

  if (!result.ok) {
    const lines = [
      '',
      '╔══════════════════════════════════════════════════════════╗',
      '║          RUNTIME PREFLIGHT FAILED — SERVER STOPPED       ║',
      '╚══════════════════════════════════════════════════════════╝',
      '',
      ...result.errors.map(e => `  ✗ ${e}`),
      '',
      `  Node.js : ${result.nodeVersion}`,
      `  Env     : ${result.environment}`,
      `  Mode    : ${result.mode.toUpperCase()}`,
      `  Profile : ${result.safetyProfile.toUpperCase()}`,
      '',
      ...setupGuide(result.mode, result.safetyProfile),
      '',
    ];

    const isTestEnv =
      env.NODE_ENV === 'test' || Boolean(process.env.JEST_WORKER_ID);

    if (isTestEnv) {
      throw new PreflightError(result.errors, lines.join('\n'));
    }

       logger.error("Preflight failed", { errors: lines.join('\n') });
    process.exit(1);
  }
}

export class PreflightError extends Error {
  constructor(
    public readonly failures: string[],
    message: string,
  ) {
    super(message);
    this.name = 'PreflightError';
  }
}

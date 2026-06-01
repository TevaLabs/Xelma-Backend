/**
 * Runtime preflight gate — validates critical startup conditions before
 * Express initializes. Fails fast with human-readable diagnostics.
 *
 * Checks performed:
 *  1. Required environment variables are present and non-empty.
 *  2. Node.js version meets the minimum declared in package.json (>=22.x).
 *  3. DATABASE_URL is parseable as a URL.
 *  4. JWT_SECRET has a minimum length to catch placeholder values.
 */

import { execSync } from 'child_process';

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  nodeVersion: string;
  environment: string;
}

/** Variables that MUST be present for the server to function at all. */
const REQUIRED_VARS: Record<string, string> = {
  JWT_SECRET:
    'Generate a strong value, for example: openssl rand -base64 32',
  DATABASE_URL:
    'Expected format: postgresql://user:pass@host:5432/database',
};

/** Minimum Node.js major version required (mirrors package.json engines). */
const MIN_NODE_MAJOR = 22;

/** JWT_SECRET must be at least this long to prevent trivially-weak secrets. */
const MIN_JWT_SECRET_LENGTH = 16;

function checkRequiredEnvVars(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(REQUIRED_VARS)
    .filter(([name]) => !env[name] || env[name]!.trim().length === 0)
    .map(
      ([name, guidance]) =>
        `Missing required environment variable: ${name}. ${guidance}. ` +
        `Set it in .env (see .env.example) or in your deployment secrets.`,
    );
}

function checkNodeVersion(): string[] {
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

function checkDatabaseUrl(env: NodeJS.ProcessEnv): string[] {
  const url = env.DATABASE_URL;
  if (!url) return []; // already caught by checkRequiredEnvVars
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

function checkJwtSecretStrength(env: NodeJS.ProcessEnv): string[] {
  const secret = env.JWT_SECRET;
  if (!secret) return []; // already caught by checkRequiredEnvVars
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

/**
 * Run all preflight checks against the supplied environment.
 * Does NOT call process.exit — callers decide what to do with the result.
 */
export function runPreflightChecks(
  env: NodeJS.ProcessEnv = process.env,
): PreflightResult {
  const errors: string[] = [
    ...checkRequiredEnvVars(env),
    ...checkNodeVersion(),
    ...checkDatabaseUrl(env),
    ...checkJwtSecretStrength(env),
  ];

  const warnings: string[] = [...checkRedisIfConfigured(env)];

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    nodeVersion: process.version,
    environment: env.NODE_ENV ?? 'development',
  };
}

/**
 * Run preflight checks and exit the process with code 1 if any fail.
 * Safe to call from src/index.ts before createApp().
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
      console.warn(`[preflight] WARNING: ${w}`);
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
      '',
      'Local setup:',
      '  1. cp .env.example .env',
      '  2. Fill in DATABASE_URL and JWT_SECRET',
      '  3. npm run dev:render-parity or npm run dev',
      '',
      'Deployment setup: configure the same variables as secrets/env vars.',
      '',
    ];

    const isTestEnv =
      env.NODE_ENV === 'test' || Boolean(process.env.JEST_WORKER_ID);

    if (isTestEnv) {
      throw new PreflightError(result.errors, lines.join('\n'));
    }

    console.error(lines.join('\n'));
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

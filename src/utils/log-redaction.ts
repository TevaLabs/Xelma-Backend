/**
 * Central log redaction helpers.
 *
 * Shared Render logs and request/money-path logs must never carry full
 * Stellar wallet addresses, `Authorization` headers, JWTs or env-like secrets
 * (JWT_SECRET, SOROBAN_*_SECRET, DATABASE_URL, ...). Everything that writes
 * log metadata goes through these helpers:
 *
 * - {@link redactWallet} truncates a wallet to first-4/last-4 form
 *   (`GABC…WXYZ`) so money-path logs stay debuggable without exposing the
 *   full address (privacy / phishing risk during campaigns).
 * - {@link redactField} redacts a single `key: value` pair (header or body
 *   field) with key-aware rules.
 * - {@link redact} walks any value recursively with the same rules.
 * - {@link redactLogInfo} is the Winston format adapter installed by
 *   ./logger.ts so every emitted log entry is scrubbed centrally, even from
 *   call sites that forget to redact.
 *
 * Conventions intentionally match the pre-existing DLQ preview redactor in
 * ./redact-payload.ts: `[REDACTED]` markers, `Bearer [REDACTED]` for bearer
 * values, and first-4/last-4 truncation separated by `…`.
 */

/** Placeholder written in place of anything that must never be logged. */
export const REDACTED = '[REDACTED]';

/** Replacement for bearer credentials — keeps the scheme, drops the token. */
const REDACTED_BEARER = 'Bearer [REDACTED]';

/** Replacement for repeated object references while walking log metadata. */
const CIRCULAR = '[Circular]';

/**
 * Keys whose values are fully masked. Substring match on purpose so
 * `jwtSecret`, `x-api-key`, `set-cookie`, `accessToken`, ... are all covered.
 */
const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|secret|password|passwd|token|jwt|api[_-]?key|private[_-]?key|access[_-]?key|seed|mnemonic|credential|signature|session|bearer|email|ssn|phone/i;

/**
 * Keys whose values are wallet addresses — truncated (not fully masked) so
 * operators can still correlate accounts from shared logs.
 */
const WALLET_KEY_PATTERN = /address$|^wallet$|^publickey$/i;

/** `Bearer <anything>` — never emit the credential part. */
const BEARER_VALUE_PATTERN = /Bearer\s+\S+/i;

/**
 * Full Stellar public addresses: `G` + 55 base32 characters (56 total),
 * bounded so partial overlaps of longer base32 runs are not mis-matched.
 */
const STELLAR_ADDRESS_PATTERN = /(?<![A-Za-z0-9])G[A-Z2-7]{55}(?![A-Z2-7])/g;

/** JWT-shaped values (`eyJ...`.`...`.`...`) regardless of surrounding text. */
const JWT_VALUE_PATTERN = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g;

/**
 * Environment variables whose values are secrets. Their values are scrubbed
 * from anywhere inside a log string (Prisma errors, for example, can embed
 * the database URL).
 */
const SECRET_ENV_VARS = [
  'JWT_SECRET',
  'SOROBAN_ADMIN_SECRET',
  'SOROBAN_ORACLE_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
] as const;

/** Guard against pathological nesting in log metadata. */
const MAX_DEPTH = 6;

/**
 * Truncate a wallet address to its first and last 4 characters.
 *
 * `redactWallet('GBZXN7KW34J5XFG2...')` → `GBZX…9QRA`
 *
 * Anything too short to truncate safely (or not a string at all) is fully
 * masked instead.
 */
export function redactWallet(address: unknown): string {
  if (typeof address !== 'string' || address.length <= 8) {
    return REDACTED;
  }
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Configured env secret values, read lazily so tests can set them later. */
function secretEnvValues(): string[] {
  const values: string[] = [];
  for (const name of SECRET_ENV_VARS) {
    const value = process.env[name];
    if (value && value.length >= 8) {
      values.push(value);
    }
  }
  return values;
}

/**
 * Scrub a raw string: bearer credentials, configured env secrets, JWT-shaped
 * tokens and wallet addresses embedded anywhere in the text.
 */
function redactString(value: string): string {
  if (BEARER_VALUE_PATTERN.test(value)) {
    return REDACTED_BEARER;
  }

  let out = value;
  for (const secret of secretEnvValues()) {
    if (out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  out = out.replace(JWT_VALUE_PATTERN, REDACTED);
  out = out.replace(STELLAR_ADDRESS_PATTERN, (match) => redactWallet(match));
  return out;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (typeof value !== 'object') {
    // numbers, booleans, bigint, symbols, functions — nothing to leak by key.
    return value;
  }
  if (value instanceof Date || value instanceof RegExp || value instanceof Error) {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return REDACTED;
  }
  if (seen.has(value)) {
    return CIRCULAR;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, depth + 1, seen));
    }
    // Leave non-plain objects (Buffer, TypedArray, class instances) untouched.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactEntry(key, entry, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Redact one `key: value` pair. Sensitive keys are fully masked, wallet keys
 * truncated, and string values scrubbed via {@link redactString}.
 */
function redactEntry(key: string, value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    if (typeof value === 'string' && BEARER_VALUE_PATTERN.test(value)) {
      return REDACTED_BEARER;
    }
    return REDACTED;
  }
  if (typeof value === 'string') {
    if (BEARER_VALUE_PATTERN.test(value)) {
      return REDACTED_BEARER;
    }
    if (WALLET_KEY_PATTERN.test(key)) {
      return redactWallet(value);
    }
    return redactString(value);
  }
  return redactValue(value, depth, seen);
}

/**
 * Redact a single field identified by its key (request header, body field,
 * metadata entry). This is what the HTTP logger uses for headers/body.
 *
 * `redactField('authorization', 'Bearer ...')` → `'Bearer [REDACTED]'`
 * `redactField('walletAddress', 'GBZXN...9QRA')` → `'GBZX…9QRA'`
 */
export function redactField(key: string, value: unknown): unknown {
  return redactEntry(key, value, 0, new WeakSet<object>());
}

/**
 * Recursively redact any value: sensitive keys are fully masked, wallet keys
 * truncated, and embedded bearer/JWT/env-secret/Stellar-address text scrubbed.
 * The input is never mutated, and re-redacting redacted data is a no-op.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet<object>());
}

/**
 * Winston format adapter: returns a redacted copy of an `info` entry while
 * preserving symbol-keyed winston internals (level/splat/message markers).
 * Installed by ./logger.ts so the guarantee holds for every transport.
 */
export function redactLogInfo<T extends object>(info: T): T {
  const out = { ...info } as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    out[key] = redactEntry(key, out[key], 0, new WeakSet<object>());
  }
  return out as T;
}

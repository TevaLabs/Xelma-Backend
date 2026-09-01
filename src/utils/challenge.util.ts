import crypto from 'crypto';

const CHALLENGE_EXPIRY_MINUTES = 5; // Challenges expire after 5 minutes

/** Default domains when no environment configuration is present. */
export const DEFAULT_AUTH_DOMAIN = 'xelma.io';
export const DEFAULT_HOME_DOMAIN = 'xelma.io';

/**
 * SEP-10-inspired challengedomain resolution.
 *
 * Priority:
 *  1. `AUTH_DOMAIN` / `HOME_DOMAIN` (explicit, SEP-10-style naming)
 *  2. `CLIENT_URL` hostname (already used for CORS)
 *  3. `API_BASE_URL` hostname
 *  4. hard-coded default – keeps tests and hackathon demos working without env
 */
export function getAuthDomain(): string {
  if (process.env.AUTH_DOMAIN) return process.env.AUTH_DOMAIN.trim();
  if (process.env.WEB_AUTH_DOMAIN) return process.env.WEB_AUTH_DOMAIN.trim();
  if (process.env.CLIENT_URL) {
    try {
      return new URL(process.env.CLIENT_URL).hostname || DEFAULT_AUTH_DOMAIN;
    } catch {
      // fall through
    }
  }
  if (process.env.API_BASE_URL) {
    try {
      return new URL(process.env.API_BASE_URL).hostname || DEFAULT_AUTH_DOMAIN;
    } catch {
      // fall through
    }
  }
  return DEFAULT_AUTH_DOMAIN;
}

export function getHomeDomain(): string {
  if (process.env.HOME_DOMAIN) return process.env.HOME_DOMAIN.trim();
  if (process.env.AUTH_DOMAIN) return process.env.AUTH_DOMAIN.trim();
  if (process.env.WEB_AUTH_DOMAIN) return process.env.WEB_AUTH_DOMAIN.trim();
  if (process.env.CLIENT_URL) {
    try {
      return new URL(process.env.CLIENT_URL).hostname || DEFAULT_HOME_DOMAIN;
    } catch {
      // fall through
    }
  }
  if (process.env.API_BASE_URL) {
    try {
      return new URL(process.env.API_BASE_URL).hostname || DEFAULT_HOME_DOMAIN;
    } catch {
      // fall through
    }
  }
  return DEFAULT_HOME_DOMAIN;
}

/** Legacy format: xelma_auth_<timestamp>_<64 hex> */
const LEGACY_CHALLENGE_RE = /^xelma_auth_(\d+)_([0-9a-f]{64})$/;

export interface ParsedChallenge {
  /** Raw challenge string as stored/signed */
  raw: string;
  /** True for legacy xelma_auth_* strings */
  isLegacy: boolean;
  /** SEP-10-style domains (null for legacy) */
  domain: string | null;
  homeDomain: string | null;
  /** Random nonce (64 hex chars) */
  nonce: string | null;
  /** Millisecond timestamp from generation */
  timestamp: number | null;
  /** ISO issued-at for the new format */
  issuedAt: string | null;
  /** Wallet address embedded in the new format, if present */
  walletAddress: string | null;
  /** Version marker for the new format */
  version: number | null;
}

/**
 * Build a SEP-10-style human-readable challenge message.
 *
 * The format is intentionally human-readable so wallets display the domain
 * that requested the signature (anti-phishing), e.g.:
 *
 * ```
 * Xelma Authentication
 * Domain: xelma.io
 * Home Domain: xelma.io
 * Address: G...
 * Nonce: <64hex>
 * Issued At: 2026-09-01T00:00:00.000Z
 * Version: 1
 * ```
 *
 * Signing this exact UTF-8 string with the Stellar keypair is the proof.
 */
export function buildChallengeMessage(params: {
  domain?: string;
  homeDomain?: string;
  nonce?: string;
  timestamp?: number;
  issuedAt?: string;
  walletAddress?: string;
  version?: number;
}): string {
  const domain = (params.domain ?? getAuthDomain()).trim();
  const homeDomain = (params.homeDomain ?? getHomeDomain()).trim();
  const nonce = params.nonce ?? crypto.randomBytes(32).toString('hex');
  const timestamp = params.timestamp ?? Date.now();
  const issuedAt = params.issuedAt ?? new Date(timestamp).toISOString();
  const version = params.version ?? 1;

  const lines: string[] = [
    'Xelma Authentication',
    `Domain: ${domain}`,
    `Home Domain: ${homeDomain}`,
  ];

  if (params.walletAddress) {
    lines.push(`Address: ${params.walletAddress}`);
  }

  lines.push(`Nonce: ${nonce}`);
  lines.push(`Issued At: ${issuedAt}`);
  lines.push(`Version: ${version}`);

  // Keep a timestamp line for strict backward-compat tooling that expects a numeric ts
  lines.push(`Timestamp: ${timestamp}`);

  return lines.join('\n');
}

/**
 * Generate a cryptographically secure challenge string.
 *
 * New format (SEP-10-style): human-readable message including Domain and
 * Home Domain so wallets can show the requesting origin.
 *
 * Legacy format is still accepted on verify for backward compatibility.
 *
 * @param walletAddress - Optional wallet to bind into the challenge (recommended)
 * @returns Challenge string to be signed (UTF-8)
 */
export function generateChallenge(walletAddress?: string): string {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(32).toString('hex');
  const domain = getAuthDomain();
  const homeDomain = getHomeDomain();
  const issuedAt = new Date(timestamp).toISOString();

  return buildChallengeMessage({
    domain,
    homeDomain,
    nonce,
    timestamp,
    issuedAt,
    walletAddress: walletAddress || undefined,
  });
}

/** Legacy helper kept for migration / tests — generates the old raw format. */
export function generateLegacyChallenge(): string {
  const timestamp = Date.now();
  const randomBytes = crypto.randomBytes(32).toString('hex');
  return `xelma_auth_${timestamp}_${randomBytes}`;
}

/**
 * Calculate expiration date for a challenge
 * @returns Date object representing challenge expiration
 */
export function getChallengeExpiry(): Date {
  const expiry = new Date();
  expiry.setMinutes(expiry.getMinutes() + CHALLENGE_EXPIRY_MINUTES);
  return expiry;
}

/**
 * Check if a challenge has expired
 * @param expiresAt Expiration date of the challenge
 * @returns True if expired, false otherwise
 */
export function isChallengeExpired(expiresAt: Date): boolean {
  return new Date() > expiresAt;
}

/**
 * Get the challenge expiry duration in seconds
 * @returns Challenge expiry duration in seconds
 */
export function getChallengeExpirySeconds(): number {
  return CHALLENGE_EXPIRY_MINUTES * 60;
}

/**
 * Whether a challenge matches the legacy xelma_auth_* format.
 */
export function isLegacyChallenge(challenge: string): boolean {
  return LEGACY_CHALLENGE_RE.test(challenge);
}

/**
 * Parse a challenge string (legacy or new) into structured fields.
 *
 * Returns null only if the string is empty. Legacy challenges return
 * domain/homeDomain as null so callers can branch.
 */
export function parseChallenge(challenge: string): ParsedChallenge | null {
  if (!challenge || typeof challenge !== 'string') return null;

  const legacyMatch = challenge.match(LEGACY_CHALLENGE_RE);
  if (legacyMatch) {
    return {
      raw: challenge,
      isLegacy: true,
      domain: null,
      homeDomain: null,
      nonce: legacyMatch[2],
      timestamp: Number(legacyMatch[1]),
      issuedAt: null,
      walletAddress: null,
      version: null,
    };
  }

  // New format: line-based key: value
  const lines = challenge.split('\n');
  const map = new Map<string, string>();
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    map.set(key, val);
  }

  const domain = map.get('domain') ?? null;
  const homeDomain = map.get('home domain') ?? map.get('home_domain') ?? null;
  const nonce = map.get('nonce') ?? null;
  const walletAddress = map.get('address') ?? null;
  const issuedAt = map.get('issued at') ?? null;
  const versionRaw = map.get('version');
  const tsRaw = map.get('timestamp');
  const timestamp = tsRaw ? Number(tsRaw) : issuedAt ? Date.parse(issuedAt) : null;
  const version = versionRaw ? Number(versionRaw) : null;

  // Consider it a valid parsed challenge if at least Domain and Nonce are present
  if (!domain || !nonce) {
    // Not a recognized new-format challenge – treat as opaque unknown but not legacy
    return {
      raw: challenge,
      isLegacy: false,
      domain,
      homeDomain,
      nonce,
      timestamp: timestamp && !Number.isNaN(timestamp) ? timestamp : null,
      issuedAt,
      walletAddress,
      version: version && !Number.isNaN(version) ? version : null,
    };
  }

  return {
    raw: challenge,
    isLegacy: false,
    domain,
    homeDomain,
    nonce,
    timestamp: timestamp && !Number.isNaN(timestamp) ? timestamp : null,
    issuedAt,
    walletAddress,
    version: version && !Number.isNaN(version) ? version : null,
  };
}

/**
 * Validate that a new-format challenge's domain fields match the server's
 * expected domains. Legacy challenges bypass this check (return true) so
 * existing clients and stored challenges keep working.
 *
 * This is the anti-phishing guard: a challenge issued by evil.com cannot
 * be replayed against xelma.io.
 */
export function isValidChallengeDomain(challenge: string): boolean {
  const parsed = parseChallenge(challenge);
  if (!parsed) return false;
  if (parsed.isLegacy) return true;
  if (!parsed.domain) return false;
  const expectedDomain = getAuthDomain();
  const expectedHome = getHomeDomain();
  // Domain must match exactly; homeDomain if present must also match
  if (parsed.domain !== expectedDomain) return false;
  if (parsed.homeDomain && parsed.homeDomain !== expectedHome) return false;
  return true;
}

/**
 * Validate that a challenge's embedded wallet address (if present) matches
 * the wallet that is attempting to connect. Legacy challenges have no
 * embedded address and always pass this check.
 */
export function isChallengeWalletBindingValid(
  challenge: string,
  walletAddress: string,
): boolean {
  const parsed = parseChallenge(challenge);
  if (!parsed) return false;
  if (parsed.isLegacy) return true;
  if (!parsed.walletAddress) return true; // not bound – accept but log
  return parsed.walletAddress === walletAddress;
}

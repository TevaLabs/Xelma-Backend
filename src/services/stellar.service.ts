import * as StellarSdk from '@stellar/stellar-sdk';
import logger from '../utils/logger';
import { CircuitBreaker, CircuitBreakerOpenError, CircuitBreakerSnapshot } from '../utils/circuit-breaker';
import { AppError } from '../utils/errors';
import { horizonRequestsTotal } from '../metrics/application.metrics';
import {
  isValidChallengeDomain,
  isChallengeWalletBindingValid,
  parseChallenge,
} from '../utils/challenge.util';

export interface StellarBalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
  last_modified_ledger?: number;
  is_authorized?: boolean;
}

export interface StellarSigner {
  key: string;
  weight: number;
  type: string;
}

export interface StellarThresholds {
  low_threshold: number;
  med_threshold: number;
  high_threshold: number;
}

export interface StellarFlags {
  auth_required: boolean;
  auth_revocable: boolean;
  auth_immutable: boolean;
  auth_clawback_enabled?: boolean;
}

export interface StellarAccountInfo {
  id: string;
  account_id: string;
  sequence: string;
  subentry_count: number;
  thresholds: StellarThresholds;
  flags: StellarFlags;
  balances: StellarBalanceLine[];
  signers: StellarSigner[];
  data: Record<string, string>;
}

/** The subset of Horizon's account JSON used by this service. */
export interface HorizonAccount {
  id?: string;
  account_id?: string;
  sequence?: string;
  subentry_count?: number;
  thresholds?: Partial<StellarThresholds>;
  flags?: Partial<StellarFlags>;
  balances?: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
    limit?: string;
    buying_liabilities?: string;
    selling_liabilities?: string;
    last_modified_ledger?: number;
    is_authorized?: boolean;
  }>;
  signers?: Array<{ key: string; weight: number; type?: string }>;
  data?: Record<string, string>;
  data_attr?: Record<string, string>;
}

export interface GetAccountInfoOptions {
  timeoutMs?: number;
  serverUrl?: string;
}

export class StellarHorizonError extends AppError {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
    statusCode = 503,
  ) {
    super(message, statusCode, code);
  }
}

export class StellarInvalidAddressError extends StellarHorizonError {
  constructor(public readonly address: string) {
    super('Invalid Stellar wallet address.', 'INVALID_ADDRESS', undefined, 400);
    this.name = 'StellarInvalidAddressError';
  }
}

export class StellarAccountNotFoundError extends StellarHorizonError {
  constructor(public readonly address: string) {
    super('Stellar account not found.', 'ACCOUNT_NOT_FOUND', undefined, 404);
    this.name = 'StellarAccountNotFoundError';
  }
}

export class StellarHorizonTimeoutError extends StellarHorizonError {
  constructor(public readonly timeoutMs: number, cause?: unknown) {
    super(`Stellar Horizon lookup timed out after ${timeoutMs}ms`, 'HORIZON_TIMEOUT', cause, 504);
    this.name = 'StellarHorizonTimeoutError';
  }
}

export class StellarHorizonUnavailableError extends StellarHorizonError {
  constructor(message: string, cause?: unknown) {
    super(message, 'HORIZON_UNAVAILABLE', cause, 502);
    this.name = 'StellarHorizonUnavailableError';
  }
}

const DEFAULT_HORIZON_TIMEOUT_MS = 5000;

export const horizonCircuitBreaker = new CircuitBreaker({
  name: 'stellar-horizon',
  failureThreshold: 3,
  openBackoffMs: 30000,
});

export function getHorizonBreakerSnapshot(): CircuitBreakerSnapshot {
  return horizonCircuitBreaker.getSnapshot();
}

export function resetHorizonBreaker(): void {
  horizonCircuitBreaker.reset('test_reset');
}

/**
 * Low-level StrKey check for a Stellar Ed25519 public key.
 *
 * This is the single place the `@stellar/stellar-sdk` `StrKey` validator is
 * called, which is why tests mock this module to avoid loading the SDK's ESM
 * build. The shared, consumer-facing validator (with edge-case handling, a
 * Zod schema, and a route guard) lives in
 * [`utils/stellar-address.util`](../utils/stellar-address.util.ts) and
 * delegates here.
 */
export function isValidStellarAddress(address: string): boolean {
  try {
    return StellarSdk.StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

/**
 * Verify a signature against a challenge using Stellar wallet verification.
 * This implements the SEP-10-style challenge-response pattern with domain
 * binding (anti-phishing): the challenge string must contain the server's
 * expected `Domain`/`Home Domain` and — when bound — the wallet address.
 *
 * Legacy `xelma_auth_*` challenges bypass domain checks for backward
 * compatibility with stored challenges and hackathon demos.
 *
 * @param walletAddress The Stellar wallet address (public key)
 * @param challenge The challenge string that was signed (new or legacy)
 * @param signature The signature in base64 format
 * @returns True if signature is valid and domain binding passes
 */
export async function verifySignature(
  walletAddress: string,
  challenge: string,
  signature: string
): Promise<boolean> {
  try {
    // Validate wallet address format (shared validator)
    if (!isValidStellarAddress(walletAddress)) {
      logger.error('Invalid Stellar wallet address format');
      return false;
    }

    // SEP-10-style domain binding check (legacy challenges skip this)
    if (!isValidChallengeDomain(challenge)) {
      const parsed = parseChallenge(challenge);
      logger.warn('Challenge domain mismatch - possible phishing replay', {
        challengeDomain: parsed?.domain,
        expectedDomain: parsed ? undefined : 'unknown',
        walletAddress,
      });
      return false;
    }

    if (!isChallengeWalletBindingValid(challenge, walletAddress)) {
      const parsed = parseChallenge(challenge);
      logger.warn('Challenge wallet binding mismatch', {
        challengeAddress: parsed?.walletAddress,
        walletAddress,
      });
      return false;
    }

    // Create a keypair from the public key
    const keypair = StellarSdk.Keypair.fromPublicKey(walletAddress);

    // Convert signature from base64 to Buffer
    const signatureBuffer = Buffer.from(signature, 'base64');

    // Convert challenge to buffer (new multi-line SEP-10-style or legacy)
    const challengeBuffer = Buffer.from(challenge, 'utf8');

    // Verify the signature
    const isValid = keypair.verify(challengeBuffer, signatureBuffer);

    return isValid;
  } catch (error) {
    logger.error('Error verifying signature:', { error });
    return false;
  }
}

/**
 * Map raw Horizon account response to typed StellarAccountInfo model.
 */
export function mapHorizonAccountResponse(raw: HorizonAccount): StellarAccountInfo {
  return {
    id: raw.id || raw.account_id || '',
    account_id: raw.account_id || raw.id || '',
    sequence: String(raw.sequence || '0'),
    subentry_count: Number(raw.subentry_count || 0),
    thresholds: {
      low_threshold: Number(raw.thresholds?.low_threshold ?? 0),
      med_threshold: Number(raw.thresholds?.med_threshold ?? 0),
      high_threshold: Number(raw.thresholds?.high_threshold ?? 0),
    },
    flags: {
      auth_required: Boolean(raw.flags?.auth_required),
      auth_revocable: Boolean(raw.flags?.auth_revocable),
      auth_immutable: Boolean(raw.flags?.auth_immutable),
      auth_clawback_enabled: Boolean(raw.flags?.auth_clawback_enabled),
    },
    balances: Array.isArray(raw.balances)
      ? raw.balances.map((b) => ({
          asset_type: b.asset_type,
          asset_code: b.asset_code,
          asset_issuer: b.asset_issuer,
          balance: String(b.balance ?? '0'),
          limit: b.limit !== undefined ? String(b.limit) : undefined,
          buying_liabilities: b.buying_liabilities !== undefined ? String(b.buying_liabilities) : undefined,
          selling_liabilities: b.selling_liabilities !== undefined ? String(b.selling_liabilities) : undefined,
          last_modified_ledger: b.last_modified_ledger !== undefined ? Number(b.last_modified_ledger) : undefined,
          is_authorized: b.is_authorized !== undefined ? Boolean(b.is_authorized) : undefined,
        }))
      : [],
    signers: Array.isArray(raw.signers)
      ? raw.signers.map((s) => ({
          key: s.key,
          weight: Number(s.weight ?? 0),
          type: String(s.type || 'ed25519_public_key'),
        }))
      : [],
    data: typeof raw.data_attr === 'object' && raw.data_attr !== null ? raw.data_attr : (raw.data || {}),
  };
}

/**
 * Get account information from Stellar network with typing, timeouts, and circuit-breaker.
 *
 * @param publicKey Stellar public key
 * @param options Timeout and server URL options
 * @returns Account info or null if not found
 */
export async function getAccountInfo(
  publicKey: string,
  options?: GetAccountInfoOptions
): Promise<StellarAccountInfo> {
  if (!isValidStellarAddress(publicKey)) {
    logger.warn('getAccountInfo called with invalid Stellar address format', { publicKey });
    throw new StellarInvalidAddressError(publicKey);
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_HORIZON_TIMEOUT_MS;
  const serverUrl =
    options?.serverUrl ||
    (process.env.STELLAR_NETWORK === 'mainnet'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org');

  let outcome: 'success' | 'not_found' | 'timeout' | 'failure' | 'breaker_open' = 'failure';
  try {
    const account = await horizonCircuitBreaker.execute(async () => {
      const server = new StellarSdk.Horizon.Server(serverUrl);
      const loadAccountPromise = server.loadAccount(publicKey) as Promise<unknown>;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const rawAccount = await Promise.race([
          loadAccountPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new StellarHorizonTimeoutError(timeoutMs)), timeoutMs);
          }),
        ]);
        return mapHorizonAccountResponse(rawAccount as HorizonAccount);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    outcome = 'success';
    return account;
  } catch (error: unknown) {
    if (error instanceof CircuitBreakerOpenError) {
      outcome = 'breaker_open';
      logger.warn('Horizon circuit breaker is open, skipping account lookup', {
        publicKey,
        error: error.message,
      });
      throw new StellarHorizonError('Stellar Horizon is temporarily unavailable.', 'HORIZON_BREAKER_OPEN');
    }

    const details = getHorizonErrorDetails(error);
    const isNotFound = details.status === 404 || details.name === 'NotFoundError';

    if (isNotFound) {
      outcome = 'not_found';
      logger.info('Stellar account not found on Horizon network', { publicKey });
      throw new StellarAccountNotFoundError(publicKey);
    }

    const isTimeout = error instanceof StellarHorizonTimeoutError || details.code === 'ECONNABORTED' || details.name === 'TimeoutError';

    if (isTimeout) {
      outcome = 'timeout';
      logger.error('Stellar Horizon account lookup timed out', {
        publicKey,
        timeoutMs,
        error: details.message,
      });
      throw error instanceof StellarHorizonTimeoutError
        ? error
        : new StellarHorizonTimeoutError(timeoutMs, error);
    }

    logger.error('Error fetching Stellar account info from Horizon:', {
      publicKey,
      error: details.message,
    });
    throw new StellarHorizonUnavailableError('Stellar Horizon is unavailable.', error);
  } finally {
    horizonRequestsTotal.inc({ outcome });
  }
}

function getHorizonErrorDetails(error: unknown): { status?: number; code?: string; name?: string; message: string } {
  if (!(error instanceof Error)) return { message: String(error) };
  const value = error as Error & { code?: unknown; response?: { status?: unknown; data?: { status?: unknown } } };
  const statusValue = value.response?.status ?? value.response?.data?.status;
  return {
    status: typeof statusValue === 'number' ? statusValue : undefined,
    code: typeof value.code === 'string' ? value.code : undefined,
    name: value.name,
    message: value.message,
  };
}

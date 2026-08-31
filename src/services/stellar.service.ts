import * as StellarSdk from '@stellar/stellar-sdk';
import logger from '../utils/logger';
import { CircuitBreaker, CircuitBreakerOpenError, CircuitBreakerSnapshot } from '../utils/circuit-breaker';
import { timeoutPromise } from '../utils/timeout-wrapper';

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

export interface GetAccountInfoOptions {
  timeoutMs?: number;
  serverUrl?: string;
}

export class StellarHorizonError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StellarHorizonError';
  }
}

export class StellarInvalidAddressError extends StellarHorizonError {
  constructor(public readonly address: string) {
    super(`Invalid Stellar wallet address: ${address}`, 'INVALID_ADDRESS');
    this.name = 'StellarInvalidAddressError';
  }
}

export class StellarAccountNotFoundError extends StellarHorizonError {
  constructor(public readonly address: string) {
    super(`Stellar account not found: ${address}`, 'ACCOUNT_NOT_FOUND');
    this.name = 'StellarAccountNotFoundError';
  }
}

export class StellarHorizonTimeoutError extends StellarHorizonError {
  constructor(public readonly timeoutMs: number, cause?: unknown) {
    super(`Stellar Horizon lookup timed out after ${timeoutMs}ms`, 'HORIZON_TIMEOUT', cause);
    this.name = 'StellarHorizonTimeoutError';
  }
}

export class StellarHorizonUnavailableError extends StellarHorizonError {
  constructor(message: string, cause?: unknown) {
    super(message, 'HORIZON_UNAVAILABLE', cause);
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
 * Verify a signature against a challenge using Stellar wallet verification
 * This implements the SEP-style challenge-response pattern
 *
 * @param walletAddress The Stellar wallet address (public key)
 * @param challenge The challenge string that was signed
 * @param signature The signature in base64 format
 * @returns True if signature is valid, false otherwise
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

    // Create a keypair from the public key
    const keypair = StellarSdk.Keypair.fromPublicKey(walletAddress);

    // Convert signature from base64 to Buffer
    const signatureBuffer = Buffer.from(signature, 'base64');

    // Convert challenge to buffer
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
export function mapHorizonAccountResponse(raw: any): StellarAccountInfo {
  return {
    id: raw.id || raw.account_id,
    account_id: raw.account_id || raw.id,
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
      ? raw.balances.map((b: any) => ({
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
      ? raw.signers.map((s: any) => ({
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
): Promise<StellarAccountInfo | null> {
  if (!isValidStellarAddress(publicKey)) {
    logger.warn('getAccountInfo called with invalid Stellar address format', { publicKey });
    return null;
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_HORIZON_TIMEOUT_MS;
  const serverUrl =
    options?.serverUrl ||
    (process.env.STELLAR_NETWORK === 'mainnet'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org');

  try {
    return await horizonCircuitBreaker.execute(async () => {
      const server = new StellarSdk.Horizon.Server(serverUrl);

      const loadAccountPromise = server.loadAccount(publicKey);
      const rawAccount = await timeoutPromise(loadAccountPromise, timeoutMs);

      return mapHorizonAccountResponse(rawAccount);
    });
  } catch (error: any) {
    if (error instanceof CircuitBreakerOpenError) {
      logger.warn('Horizon circuit breaker is open, skipping account lookup', {
        publicKey,
        error: error.message,
      });
      return null;
    }

    const isNotFound =
      error?.response?.status === 404 ||
      error?.name === 'NotFoundError' ||
      error?.message?.toLowerCase().includes('not found') ||
      error?.response?.data?.status === 404;

    if (isNotFound) {
      logger.info('Stellar account not found on Horizon network', { publicKey });
      return null;
    }

    const isTimeout =
      error?.message?.includes('Operation timeout') ||
      error?.code === 'ECONNABORTED' ||
      error?.name === 'TimeoutError';

    if (isTimeout) {
      logger.error('Stellar Horizon account lookup timed out', {
        publicKey,
        timeoutMs,
        error: error.message,
      });
      return null;
    }

    logger.error('Error fetching Stellar account info from Horizon:', {
      publicKey,
      error: error.message || error,
    });
    return null;
  }
}

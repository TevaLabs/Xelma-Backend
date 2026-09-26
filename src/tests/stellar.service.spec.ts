import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockLoadAccount = jest.fn();
const mockVerify = jest.fn();
const mockIsValidEd25519PublicKey = jest.fn();
const mockFromPublicKey = jest.fn();

jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: {
    isValidEd25519PublicKey: (addr: string) => mockIsValidEd25519PublicKey(addr),
  },
  Keypair: {
    fromPublicKey: (pk: string) => mockFromPublicKey(pk),
  },
  Horizon: {
    Server: jest.fn().mockImplementation(() => ({
      loadAccount: (pk: string) => mockLoadAccount(pk),
    })),
  },
}));

import {
  isValidStellarAddress,
  verifySignature,
  getAccountInfo,
  mapHorizonAccountResponse,
  resetHorizonBreaker,
  getHorizonBreakerSnapshot,
  StellarAccountNotFoundError,
  StellarHorizonTimeoutError,
  StellarHorizonUnavailableError,
  StellarInvalidAddressError,
  horizonCircuitBreaker,
} from '../services/stellar.service';
import {
  generateChallenge,
  generateLegacyChallenge,
  buildChallengeMessage,
} from '../utils/challenge.util';

const VALID_ADDRESS = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

describe('StellarService — isValidStellarAddress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns true for valid Ed25519 public key', () => {
    mockIsValidEd25519PublicKey.mockReturnValue(true);
    expect(isValidStellarAddress(VALID_ADDRESS)).toBe(true);
    expect(mockIsValidEd25519PublicKey).toHaveBeenCalledWith(VALID_ADDRESS);
  });

  it('returns false for invalid Ed25519 public key', () => {
    mockIsValidEd25519PublicKey.mockReturnValue(false);
    expect(isValidStellarAddress('GINVALID')).toBe(false);
  });

  it('returns false when SDK validator throws an error', () => {
    mockIsValidEd25519PublicKey.mockImplementation(() => {
      throw new Error('invalid format');
    });
    expect(isValidStellarAddress('invalid')).toBe(false);
  });
});

describe('StellarService — verifySignature', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsValidEd25519PublicKey.mockReturnValue(true);
    mockFromPublicKey.mockReturnValue({
      verify: mockVerify,
    });
  });

  it('returns false early when wallet address format is invalid', async () => {
    mockIsValidEd25519PublicKey.mockReturnValue(false);
    const result = await verifySignature('INVALID', 'challenge', 'c2lnbmF0dXJl');
    expect(result).toBe(false);
    expect(mockFromPublicKey).not.toHaveBeenCalled();
  });

  it('verifies valid signature successfully (SEP-10-style challenge)', async () => {
    mockVerify.mockReturnValue(true);
    const challenge = generateChallenge(VALID_ADDRESS);
    const result = await verifySignature(VALID_ADDRESS, challenge, 'c2lnbmF0dXJl');
    expect(result).toBe(true);
    expect(mockFromPublicKey).toHaveBeenCalledWith(VALID_ADDRESS);
    expect(mockVerify).toHaveBeenCalled();
  });

  it('verifies valid signature for legacy challenge (backward compat)', async () => {
    mockVerify.mockReturnValue(true);
    const legacy = generateLegacyChallenge();
    const result = await verifySignature(VALID_ADDRESS, legacy, 'c2lnbmF0dXJl');
    expect(result).toBe(true);
    expect(mockVerify).toHaveBeenCalled();
  });

  it('returns false when signature is invalid', async () => {
    mockVerify.mockReturnValue(false);
    const challenge = generateChallenge(VALID_ADDRESS);
    const result = await verifySignature(VALID_ADDRESS, challenge, 'c2lnbmF0dXJl');
    expect(result).toBe(false);
  });

  it('returns false when keypair creation or verification throws', async () => {
    mockFromPublicKey.mockImplementation(() => {
      throw new Error('corrupt key');
    });
    const challenge = generateChallenge(VALID_ADDRESS);
    const result = await verifySignature(VALID_ADDRESS, challenge, 'c2lnbmF0dXJl');
    expect(result).toBe(false);
  });

  it('returns false when challenge domain is tampered (anti-phishing)', async () => {
    mockVerify.mockReturnValue(true);
    const evil = buildChallengeMessage({ domain: 'evil.com', homeDomain: 'evil.com', nonce: 'ab'.repeat(32) });
    const result = await verifySignature(VALID_ADDRESS, evil, 'c2lnbmF0dXJl');
    expect(result).toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('returns false when wallet binding mismatches', async () => {
    mockVerify.mockReturnValue(true);
    const challenge = generateChallenge(VALID_ADDRESS);
    const other = 'GA3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX';
    const result = await verifySignature(other, challenge, 'c2lnbmF0dXJl');
    expect(result).toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });
});

describe('StellarService — mapHorizonAccountResponse', () => {
  it('maps complete Horizon account response to typed model', () => {
    const raw = {
      id: VALID_ADDRESS,
      account_id: VALID_ADDRESS,
      sequence: '123456789',
      subentry_count: 3,
      thresholds: {
        low_threshold: 1,
        med_threshold: 2,
        high_threshold: 3,
      },
      flags: {
        auth_required: true,
        auth_revocable: false,
        auth_immutable: false,
        auth_clawback_enabled: true,
      },
      balances: [
        {
          asset_type: 'native',
          balance: '100.5000000',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          balance: '50.0000000',
          limit: '1000.0000000',
          last_modified_ledger: 12345,
          is_authorized: true,
        },
      ],
      signers: [
        {
          key: VALID_ADDRESS,
          weight: 1,
          type: 'ed25519_public_key',
        },
      ],
      data_attr: {
        test_key: 'dGVzdF92YWx1ZQ==',
      },
    };

    const mapped = mapHorizonAccountResponse(raw);
    expect(mapped.id).toBe(VALID_ADDRESS);
    expect(mapped.account_id).toBe(VALID_ADDRESS);
    expect(mapped.sequence).toBe('123456789');
    expect(mapped.subentry_count).toBe(3);
    expect(mapped.thresholds).toEqual({ low_threshold: 1, med_threshold: 2, high_threshold: 3 });
    expect(mapped.flags.auth_required).toBe(true);
    expect(mapped.flags.auth_clawback_enabled).toBe(true);
    expect(mapped.balances).toHaveLength(2);
    expect(mapped.balances[0].asset_type).toBe('native');
    expect(mapped.balances[1].asset_code).toBe('USDC');
    expect(mapped.signers[0].weight).toBe(1);
    expect(mapped.data.test_key).toBe('dGVzdF92YWx1ZQ==');
  });

  it('handles missing and sparse fields safely', () => {
    const raw = {
      account_id: VALID_ADDRESS,
    };

    const mapped = mapHorizonAccountResponse(raw);
    expect(mapped.id).toBe(VALID_ADDRESS);
    expect(mapped.sequence).toBe('0');
    expect(mapped.subentry_count).toBe(0);
    expect(mapped.thresholds).toEqual({ low_threshold: 0, med_threshold: 0, high_threshold: 0 });
    expect(mapped.flags).toEqual({
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
      auth_clawback_enabled: false,
    });
    expect(mapped.balances).toEqual([]);
    expect(mapped.signers).toEqual([]);
    expect(mapped.data).toEqual({});
  });
});

describe('StellarService — getAccountInfo with timeout and breaker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetHorizonBreaker();
    mockIsValidEd25519PublicKey.mockReturnValue(true);
  });

  afterEach(() => {
    resetHorizonBreaker();
  });

  it('returns null early if address is invalid', async () => {
    mockIsValidEd25519PublicKey.mockReturnValue(false);
    const result = await getAccountInfo('GINVALID');
    expect(result).toBeNull();
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('fetches and returns typed account info successfully', async () => {
    const rawAccount = {
      id: VALID_ADDRESS,
      account_id: VALID_ADDRESS,
      sequence: '1000',
      subentry_count: 1,
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
      balances: [{ asset_type: 'native', balance: '25.0000000' }],
      signers: [{ key: VALID_ADDRESS, weight: 1, type: 'ed25519_public_key' }],
    };
    mockLoadAccount.mockResolvedValue(rawAccount);

    const result = await getAccountInfo(VALID_ADDRESS);
    expect(result).not.toBeNull();
    expect(result?.account_id).toBe(VALID_ADDRESS);
    expect(result?.balances[0].balance).toBe('25.0000000');
    expect(getHorizonBreakerSnapshot().state).toBe('closed');
  });

  it('returns null when account is not found (404)', async () => {
    const notFoundError: any = new Error('Not Found');
    notFoundError.response = { status: 404 };
    notFoundError.name = 'NotFoundError';
    mockLoadAccount.mockRejectedValue(notFoundError);

    const result = await getAccountInfo(VALID_ADDRESS);
    expect(result).toBeNull();
  });

  it('handles timeout when Horizon response is delayed', async () => {
    mockLoadAccount.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 200)),
    );

    const result = await getAccountInfo(VALID_ADDRESS, { timeoutMs: 50 });
    expect(result).toBeNull();
  });

  it('trips circuit breaker after consecutive failures', async () => {
    mockLoadAccount.mockRejectedValue(new Error('Horizon server 500 error'));

    // 3 failures to reach threshold
    await getAccountInfo(VALID_ADDRESS);
    await getAccountInfo(VALID_ADDRESS);
    await getAccountInfo(VALID_ADDRESS);

    const snapshot = getHorizonBreakerSnapshot();
    expect(snapshot.state).toBe('open');
    expect(snapshot.failureCount).toBe(3);

    // Subsequent call fails fast without calling loadAccount
    mockLoadAccount.mockClear();
    const fastFailResult = await getAccountInfo(VALID_ADDRESS);
    expect(fastFailResult).toBeNull();
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('resets circuit breaker on manual reset', () => {
    (horizonCircuitBreaker as any).transitionTo('open', 'test');
    expect(getHorizonBreakerSnapshot().state).toBe('open');

    resetHorizonBreaker();
    expect(getHorizonBreakerSnapshot().state).toBe('closed');
  });

  it('instantiates custom error classes properly', () => {
    const invalidErr = new StellarInvalidAddressError('BAD_ADDR');
    expect(invalidErr.name).toBe('StellarInvalidAddressError');
    expect(invalidErr.code).toBe('INVALID_ADDRESS');

    const notFoundErr = new StellarAccountNotFoundError('NOT_FOUND_ADDR');
    expect(notFoundErr.name).toBe('StellarAccountNotFoundError');
    expect(notFoundErr.code).toBe('ACCOUNT_NOT_FOUND');

    const timeoutErr = new StellarHorizonTimeoutError(5000);
    expect(timeoutErr.name).toBe('StellarHorizonTimeoutError');
    expect(timeoutErr.code).toBe('HORIZON_TIMEOUT');

    const unavailErr = new StellarHorizonUnavailableError('Down');
    expect(unavailErr.name).toBe('StellarHorizonUnavailableError');
    expect(unavailErr.code).toBe('HORIZON_UNAVAILABLE');
  });
});

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/**
 * The util delegates the raw StrKey check to services/stellar.service (the
 * single `@stellar/stellar-sdk` boundary). The SDK is ESM and cannot be parsed
 * by ts-jest under this repo's pnpm layout, so — exactly like the other
 * suites — we mock stellar.service and drive its verdict per-case. This unit
 * tests OUR wrapper, route guard, and schema wiring; the SDK's checksum math
 * is its own responsibility (and is exercised by the auth/bet integration
 * tests in CI).
 */
const mockIsValidEd25519 = jest.fn<(addr: string) => boolean>();
jest.mock('../services/stellar.service', () => ({
  isValidStellarAddress: (addr: string) => mockIsValidEd25519(addr),
  verifySignature: jest.fn(),
}));

import {
  isValidStellarAddress,
  stellarAddressSchema,
  optionalStellarAddressSchema,
  validateStellarAddressParam,
} from '../utils/stellar-address.util';
import { ValidationError, ErrorCode } from '../utils/errors';

// A correctly-shaped placeholder; validity is decided by the mocked StrKey.
const ADDR = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

beforeEach(() => {
  mockIsValidEd25519.mockReset();
});

describe('isValidStellarAddress', () => {
  it('delegates to StrKey for non-empty strings and returns its verdict', () => {
    mockIsValidEd25519.mockReturnValue(true);
    expect(isValidStellarAddress(ADDR)).toBe(true);

    mockIsValidEd25519.mockReturnValue(false);
    expect(isValidStellarAddress('GINVALID')).toBe(false);
  });

  it('returns false for empty / non-string input without calling StrKey', () => {
    for (const bad of ['', null, undefined, 42, {}, [], true]) {
      expect(isValidStellarAddress(bad as unknown)).toBe(false);
    }
    expect(mockIsValidEd25519).not.toHaveBeenCalled();
  });

  it('returns false (does not throw) when StrKey throws', () => {
    mockIsValidEd25519.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(isValidStellarAddress(ADDR)).toBe(false);
  });
});

describe('stellarAddressSchema', () => {
  it('accepts a valid address', () => {
    mockIsValidEd25519.mockReturnValue(true);
    const parsed = stellarAddressSchema.safeParse(ADDR);
    expect(parsed.success).toBe(true);
  });

  it('rejects a malformed address with the format message', () => {
    mockIsValidEd25519.mockReturnValue(false);
    const parsed = stellarAddressSchema.safeParse('GINVALID');
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe('Invalid Stellar wallet address format');
    }
  });

  it('rejects an empty string as required', () => {
    const parsed = stellarAddressSchema.safeParse('');
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toBe('address is required');
    }
  });

  it('optional schema accepts undefined', () => {
    const parsed = optionalStellarAddressSchema.safeParse(undefined);
    expect(parsed.success).toBe(true);
  });
});

describe('validateStellarAddressParam (route guard)', () => {
  const run = (params: Record<string, unknown>, paramName?: string) => {
    const next = jest.fn();
    const req = { params } as any;
    validateStellarAddressParam(paramName)(req, {} as any, next as any);
    return next;
  };

  it('calls next() with no error when the param is a valid address', () => {
    mockIsValidEd25519.mockReturnValue(true);
    const next = run({ address: ADDR });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]).toHaveLength(0);
  });

  it('forwards a 400 ValidationError when the param is invalid', () => {
    mockIsValidEd25519.mockReturnValue(false);
    const next = run({ address: 'not-an-address' });
    const err = next.mock.calls[0][0] as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(err.details?.[0]).toEqual({
      field: 'address',
      message: 'Invalid Stellar wallet address format',
    });
  });

  it('rejects a missing param with 400', () => {
    const next = run({}, 'walletAddress');
    const err = next.mock.calls[0][0] as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.statusCode).toBe(400);
    expect(err.details?.[0].field).toBe('walletAddress');
  });

  it('honors a custom param name', () => {
    mockIsValidEd25519.mockReturnValue(true);
    const next = run({ walletAddress: ADDR }, 'walletAddress');
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]).toHaveLength(0);
  });
});

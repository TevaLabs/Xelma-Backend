import { isValidStellarAddress } from '../utils/stellar-address.util';
import {
  CHALLENGE_EXAMPLE_PUBLIC_KEY,
  CONNECT_EXAMPLE_PUBLIC_KEY,
} from '../docs/strkey-fixtures';

describe('StrKey fixtures validation', () => {
  it('should validate CHALLENGE_EXAMPLE_PUBLIC_KEY as a valid Stellar address', () => {
    expect(isValidStellarAddress(CHALLENGE_EXAMPLE_PUBLIC_KEY)).toBe(true);
  });

  it('should validate CONNECT_EXAMPLE_PUBLIC_KEY as a valid Stellar address', () => {
    expect(isValidStellarAddress(CONNECT_EXAMPLE_PUBLIC_KEY)).toBe(true);
  });

  it('should reject an invalid placeholder address', () => {
    const invalidAddress = 'GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX';
    expect(isValidStellarAddress(invalidAddress)).toBe(false);
  });
});

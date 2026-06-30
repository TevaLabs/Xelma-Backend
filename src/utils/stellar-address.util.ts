import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { isValidStellarAddress as strKeyIsValid } from '../services/stellar.service';
import { ValidationError } from './errors';

/**
 * Shared Stellar wallet-address validation.
 *
 * Single source of truth for "is this a well-formed Stellar account?" used by
 * the auth, bet, and user surfaces (Zod schemas, route guards, and services).
 * Centralizing it here keeps validation consistent — every wallet-related
 * endpoint accepts and rejects the exact same set of addresses.
 *
 * Format: an Ed25519 public key in StrKey form — a 56-character base32 string
 * starting with `G`, with an embedded CRC16 checksum. The actual StrKey check
 * is delegated to `services/stellar.service` (the single `@stellar/stellar-sdk`
 * boundary) so the checksum is genuinely verified and the SDK stays mockable
 * in tests.
 */

/**
 * Returns true only for a valid Stellar Ed25519 public key (`G...`).
 *
 * Accepts `unknown` so it is safe to call directly on route params / untyped
 * input: non-strings, empty strings, and malformed values all return false
 * instead of throwing.
 */
export function isValidStellarAddress(address: unknown): address is string {
  if (typeof address !== 'string' || address.length === 0) {
    return false;
  }
  try {
    return strKeyIsValid(address);
  } catch {
    return false;
  }
}

/** Reusable Zod schema for a required Stellar address field. */
export const stellarAddressSchema = z
  .string({ error: 'address is required' })
  .min(1, 'address is required')
  .refine(isValidStellarAddress, 'Invalid Stellar wallet address format');

/** Reusable Zod schema for an optional Stellar address field. */
export const optionalStellarAddressSchema = stellarAddressSchema.optional();

/**
 * Express route guard that rejects a request whose `:<paramName>` route
 * parameter is not a valid Stellar address, forwarding a 400
 * `VALIDATION_ERROR` to the centralized error handler. Defaults to `address`.
 *
 * Use on routes that take a wallet address in the path, e.g.
 *   router.get('/:address/stats', validateStellarAddressParam('address'), handler)
 */
export function validateStellarAddressParam(paramName = 'address') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const value = req.params[paramName];
    if (!isValidStellarAddress(value)) {
      return next(
        new ValidationError('Invalid Stellar wallet address format', [
          { field: paramName, message: 'Invalid Stellar wallet address format' },
        ])
      );
    }
    next();
  };
}

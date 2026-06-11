import { UserRole } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types/auth.types';


const getJwtExpiry = (): string | number => process.env.JWT_EXPIRY || '7d';

/**
 * Helper to get JWT secret at runtime.
 * Throws an explicit error if missing, acting as a secondary safeguard.
 */
const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('FATAL: JWT_SECRET environment variable is missing.');
  }
  return secret;
};

/**
 * Generate a JWT token for authenticated user
 * @param userId User ID
 * @param walletAddress Stellar wallet address
 * @param role User role
 * @returns Signed JWT token
 */
export function generateToken(userId: string, walletAddress: string, role: UserRole): string {
  const payload: JwtPayload = {
    userId,
    walletAddress,
    role,
  };

  // Pass options directly to avoid TypeScript type inference issues
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: getJwtExpiry() as any,
  });
}

/**
 * Verify and decode a JWT token
 * @param token JWT token to verify
 * @returns Decoded payload or null if invalid
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as JwtPayload;
    return decoded;
  } catch (error) {
    return null;
  }
}

export type TokenVerifyResult =
  | { valid: true; payload: JwtPayload }
  | { valid: false; expired: true }
  | { valid: false; expired: false };

/**
 * Verify a token and distinguish between expiry and other failures.
 * Used by the Socket.IO auth middleware to emit the correct error event.
 */
export function verifyTokenDetailed(token: string): TokenVerifyResult {
  try {
    const payload = jwt.verify(token, getJwtSecret()) as JwtPayload;
    return { valid: true, payload };
  } catch (error: any) {
    if (error?.name === 'TokenExpiredError') {
      return { valid: false, expired: true };
    }
    return { valid: false, expired: false };
  }
}

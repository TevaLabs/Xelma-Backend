import { UserRole } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types/auth.types';


const getJwtExpiry = (): string | number => process.env.JWT_EXPIRY || '7d';
const getJwtIssuer = (): string | undefined => process.env.JWT_ISSUER || undefined;
const getJwtAudience = (): string | undefined => process.env.JWT_AUDIENCE || undefined;

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

  const issuer = getJwtIssuer();
  const audience = getJwtAudience();

  // Pass options directly to avoid TypeScript type inference issues
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: getJwtExpiry() as any,
    ...(issuer ? { issuer } : {}),
    ...(audience ? { audience } : {}),
  });
}

/**
 * Verify and decode a JWT token
 * @param token JWT token to verify
 * @returns Decoded payload or null if invalid
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const issuer = getJwtIssuer();
    const audience = getJwtAudience();
    const decoded = jwt.verify(token, getJwtSecret(), {
      ...(issuer ? { issuer } : {}),
      ...(audience ? { audience } : {}),
    }) as JwtPayload;
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
    const issuer = getJwtIssuer();
    const audience = getJwtAudience();
    const payload = jwt.verify(token, getJwtSecret(), {
      ...(issuer ? { issuer } : {}),
      ...(audience ? { audience } : {}),
    }) as JwtPayload;
    return { valid: true, payload };
  } catch (error: any) {
    if (error?.name === 'TokenExpiredError') {
      return { valid: false, expired: true };
    }
    return { valid: false, expired: false };
  }
}


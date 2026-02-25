import jwt, { SignOptions } from 'jsonwebtoken';
import { JwtPayload } from '../types/auth.types';


const JWT_EXPIRY: string | number = process.env.JWT_EXPIRY || '7d'; // 7 days default

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
 * @returns Signed JWT token
 */
export function generateToken(userId: string, walletAddress: string): string {
  const payload: JwtPayload = {
    userId,
    walletAddress,
  };

  // Pass options directly to avoid TypeScript type inference issues
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: JWT_EXPIRY as any,
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

/**
 * Decode a JWT token without verification (use for debugging only)
 * @param token JWT token to decode
 * @returns Decoded payload or null if invalid
 */
export function decodeToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.decode(token) as JwtPayload;
    return decoded;
  } catch (error) {
    return null;
  }
}

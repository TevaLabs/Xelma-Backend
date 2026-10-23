import { Request } from "express";
import { UserRole } from "@prisma/client";

export interface ChallengeRequestBody {
  walletAddress: string;
}

export interface ChallengeResponse {
  challenge: string;
  /** SEP-10-style domain that requested the signature (wallet UX / anti-phishing) */
  domain: string;
  /** Home domain of the Xelma deployment */
  homeDomain: string;
  expiresAt: string;
}

export interface ConnectRequestBody {
  walletAddress: string;
  challenge: string;
  signature: string;
}

export interface ConnectResponse {
  token: string;
  user: {
    id: string;
    walletAddress: string;
    createdAt: string;
    lastLoginAt: string;
  };
}

/**
 * Claims carried by the JWT returned from `POST /api/auth/connect` and verified
 * on every authenticated request (issued/verified in src/utils/jwt.util.ts;
 * documented in the OpenAPI `JwtPayload` component schema).
 *
 * Custom claims:
 * - `userId` — platform user id for the authenticated wallet.
 * - `walletAddress` — Stellar G... public key the token was minted for.
 * - `role` — `USER` | `ADMIN` | `ORACLE` (prisma `UserRole`).
 *
 * Registered claims added by `jsonwebtoken` at sign time:
 * - `iat` / `exp` — NumericDate timestamps (integer **seconds** since the Unix
 *   epoch), never milliseconds. `exp = iat + JWT_EXPIRY` (default `7d`).
 * - `iss` / `aud` — only present when `JWT_ISSUER` / `JWT_AUDIENCE` are set.
 *
 * Clock skew: verification runs with `clockTolerance: 0` (the jsonwebtoken
 * default — see `verifyToken`/`verifyTokenDetailed`), so `exp` is compared
 * strictly against the **server** clock with no leeway: a token is rejected
 * with 401 `Invalid or expired token` the moment server time reaches `exp`,
 * regardless of how far the client clock differs. `iat` is not independently
 * validated (no `maxAge` option is configured). Clients must therefore never
 * decide expiry from their own clock — on 401, re-run the challenge/connect
 * flow instead of retrying with the same token.
 */
export interface JwtPayload {
  /** Platform user id the token authenticates. */
  userId: string;
  /** Stellar wallet public key (G...) the token was issued for. */
  walletAddress: string;
  /** Privilege level enforced by role-gated routes (USER | ADMIN | ORACLE). */
  role: UserRole;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
  walletAddress?: string;
}

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
  walletAddress: string;
}

import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt.util";
import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import logger from "../utils/logger";
import { AuthRequest, AuthenticatedRequest, JwtPayload } from "../types/auth.types";
import { ORACLE_ALLOWED_ROLES } from "../security/route-auth.registry";
import config from "../config";
import { AuthenticationError, AuthorizationError } from "../utils/errors";

// Re-export UserRole for backwards compatibility
export { UserRole };

// Export AuthRequest and AuthenticatedRequest type for use in routes
export { AuthRequest, AuthenticatedRequest };

// Extend Express Request to include authenticated wallet metadata
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      walletAddress?: string;
    }
  }
}

type ResolvedUser = {
  id: string;
  walletAddress: string;
  role: UserRole;
};

async function loadUserFromBearerToken(
  authHeader: string | undefined,
): Promise<ResolvedUser | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring(7);
  const decoded = verifyToken(token);

  if (!decoded) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
    select: {
      id: true,
      walletAddress: true,
      role: true,
    },
  });

  return user;
}

function attachUser(req: Request, user: ResolvedUser): void {
  req.user = {
    userId: user.id,
    walletAddress: user.walletAddress,
    role: user.role,
  };
}

function userHasAnyRole(user: ResolvedUser, allowedRoles: UserRole[]): boolean {
  return allowedRoles.includes(user.role);
}

function attachWalletAddress(req: Request, payload: JwtPayload): void {
  req.walletAddress = payload.walletAddress;
  req.user = payload;
}

/**
 * Middleware to verify Stellar JWT auth and attach the authenticated wallet address.
 */
export async function verifyStellarAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new AuthenticationError("No token provided"));
  }

  const token = authHeader.substring(7);
  const decoded = verifyToken(token);

  if (!decoded || !decoded.walletAddress) {
    return next(new AuthenticationError("Invalid or expired token"));
  }

  attachWalletAddress(req, decoded);
  next();
}

/**
 * Factory for role-gated middleware. Centralizes JWT verification and DB role lookup
 * so new routes cannot drift from the route auth registry expectations.
 */
export function requireRole(
  allowedRoles: UserRole[],
  options?: { forbiddenMessage?: string },
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const forbiddenMessage =
    options?.forbiddenMessage ?? "You do not have permission to access this resource";

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requestId = (req as any).requestId;
    try {
      const user = await loadUserFromBearerToken(req.headers.authorization);

      if (!user) {
        const hasHeader = Boolean(req.headers.authorization?.startsWith("Bearer "));
        return next(
          new AuthenticationError(
            hasHeader ? "Invalid or expired token" : "No token provided"
          )
        );
      }

      if (!userHasAnyRole(user, allowedRoles)) {
        return next(new AuthorizationError(forbiddenMessage));
      }

      attachUser(req, user);
      next();
    } catch (error) {
      logger.error("Role authentication error:", { error, requestId });
      return next(new AuthenticationError("Authentication failed"));
    }
  };
}

/**
 * Middleware to authenticate user via JWT token
 */
export const authenticateUser = requireRole(
  [UserRole.USER, UserRole.ADMIN, UserRole.ORACLE],
);

// Alias for backwards compatibility
export const authenticateToken = authenticateUser;

/**
 * Middleware to optionally authenticate user via JWT token.
 * If a Bearer token is provided and valid, attaches `req.user`; otherwise continues unauthenticated.
 */
export const optionalAuthentication = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = await loadUserFromBearerToken(req.headers.authorization);

    if (user) {
      attachUser(req, user);
    }

    next();
  } catch (error) {
    // Optional auth should never block the request
    next();
  }
};

/**
 * Middleware to require admin role
 */
export const requireAdmin = requireRole([UserRole.ADMIN], {
  forbiddenMessage: "Admin access required",
});

/**
 * Middleware to authenticate Prometheus metrics scrape.
 * Allows access if a valid Bearer token matching METRICS_SCRAPE_TOKEN is provided,
 * otherwise falls back to requiring an Admin JWT.
 */
export const requireMetricsAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (
    config.app.metricsScrapeToken &&
    authHeader === `Bearer ${config.app.metricsScrapeToken}`
  ) {
    next();
    return;
  }

  return requireAdmin(req, res, next);
};

/**
 * Middleware to require oracle role (oracle or admin)
 */
export const requireOracle = requireRole(ORACLE_ALLOWED_ROLES, {
  forbiddenMessage: "Oracle or Admin access required",
});

/**
 * Binds mutation payloads to the authenticated wallet. Rejects mismatched
 * client-supplied addresses so bet placement cannot impersonate another user.
 */
export function bindAuthenticatedWallet(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return next(new AuthenticationError("No token provided"));
  }

  if (req.body?.address && req.body.address !== walletAddress) {
    return next(new AuthorizationError("Wallet address does not match authenticated user"));
  }

  req.body.address = walletAddress;
  next();
}

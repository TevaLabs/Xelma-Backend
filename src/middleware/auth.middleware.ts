import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt.util";
import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import logger from "../utils/logger";
import { AuthRequest, AuthenticatedRequest, JwtPayload } from "../types/auth.types";
import { ORACLE_ALLOWED_ROLES } from "../security/route-auth.registry";

// Re-export UserRole for backwards compatibility
export { UserRole };

// Export AuthRequest and AuthenticatedRequest type for use in routes
export { AuthRequest, AuthenticatedRequest };

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
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
        res.status(401).json({
          error: hasHeader ? "Invalid or expired token" : "No token provided",
        });
        return;
      }

      if (!userHasAnyRole(user, allowedRoles)) {
        res.status(403).json({ error: forbiddenMessage });
        return;
      }

      attachUser(req, user);
      next();
    } catch (error) {
      logger.error("Role authentication error:", { error, requestId });
      res.status(401).json({ error: "Authentication failed" });
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
 * Middleware to require oracle role (oracle or admin)
 */
export const requireOracle = requireRole(ORACLE_ALLOWED_ROLES, {
  forbiddenMessage: "Oracle or Admin access required",
});

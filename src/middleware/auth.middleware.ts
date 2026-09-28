import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt.util";
import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import logger from "../utils/logger";
import { AuthRequest, AuthenticatedRequest, JwtPayload } from "../types/auth.types";
import { ORACLE_ALLOWED_ROLES } from "../security/route-auth.registry";
import {
  AdminPermission,
  roleHasAdminPermission,
} from "../security/admin-permissions";
import { auditLogger } from "../utils/audit-logger";
import config from "../config";

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
    res.status(401).json({ error: "No token provided" });
    return;
  }

  const token = authHeader.substring(7);
  const decoded = verifyToken(token);

  if (!decoded || !decoded.walletAddress) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
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
 * Middleware factory that enforces the admin RBAC matrix (Issue #497).
 *
 * Behaves like `requireAdmin` (401 without a valid token, 403 for a role that
 * lacks the permission) but is scoped to a single {@link AdminPermission} and
 * writes an append-only audit record for every privileged call:
 *
 *  - denied attempts are recorded immediately (`admin.access.denied`);
 *  - allowed calls are recorded on response finish (`admin.action`) so the
 *    audit trail captures the handler's status code and latency.
 *
 * Roles with no admin permissions fail closed, so an unrecognised role in a
 * JWT can never reach an admin route.
 */
export function requireAdminPermission(
  permission: AdminPermission,
  options?: { forbiddenMessage?: string },
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const forbiddenMessage =
    options?.forbiddenMessage ?? "Admin access required";

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requestId = (req as any).requestId;
    const endpoint = (req.originalUrl || req.path).split("?")[0];
    const userAgent = req.headers["user-agent"] as string | undefined;

    try {
      const user = await loadUserFromBearerToken(req.headers.authorization);

      if (!user) {
        const hasHeader = Boolean(req.headers.authorization?.startsWith("Bearer "));
        res.status(401).json({
          error: hasHeader ? "Invalid or expired token" : "No token provided",
        });
        return;
      }

      attachUser(req, user);

      if (!roleHasAdminPermission(user.role, permission)) {
        auditLogger.logAdminAccessDenied({
          userId: user.id,
          walletAddress: user.walletAddress,
          role: user.role,
          permission,
          endpoint,
          method: req.method,
          requestId,
          ipAddress: req.ip,
          userAgent,
        });
        res.status(403).json({ error: forbiddenMessage });
        return;
      }

      const startedAt = Date.now();
      res.once("finish", () => {
        auditLogger.logAdminAction({
          userId: user.id,
          walletAddress: user.walletAddress,
          role: user.role,
          permission,
          endpoint,
          method: req.method,
          statusCode: res.statusCode,
          requestId,
          ipAddress: req.ip,
          userAgent,
          durationMs: Date.now() - startedAt,
        });
      });

      next();
    } catch (error) {
      logger.error("Admin permission check error:", { error, requestId });
      res.status(401).json({ error: "Authentication failed" });
    }
  };
}

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
    res.status(401).json({ error: "No token provided" });
    return;
  }

  if (req.body?.address && req.body.address !== walletAddress) {
    res.status(403).json({
      error: "Wallet address does not match authenticated user",
    });
    return;
  }

  req.body.address = walletAddress;
  next();
}

import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt.util";
import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import logger from "../utils/logger";

// Re-export UserRole for backwards compatibility
export { UserRole };

// Export AuthRequest type for use in routes
export interface AuthRequest extends Request {
  user?: {
    userId: string;
    walletAddress: string;
    role: UserRole;
  };
}

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        walletAddress: string;
        role: UserRole;
      };
      userId?: string;
    }
  }
}

/**
 * Middleware to authenticate user via JWT token
 */
export const authenticateUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      (req as any).userId = undefined;
      res.status(401).json({ error: "No token provided" });
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    const decoded = verifyToken(token);

    if (!decoded) {
      (req as any).userId = undefined;
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    // Get user from database to check role
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        walletAddress: true,
        role: true,
      },
    });

    if (!user) {
      (req as any).userId = undefined;
      res.status(401).json({ error: "User not found" });
      return;
    }

    // Attach user to request
    req.user = {
      userId: user.id,
      walletAddress: user.walletAddress,
      role: user.role,
    };
    (req as any).userId = user.id;

    next();
  } catch (error) {
    logger.error("Authentication error:", error);
    (req as any).userId = undefined;
    res.status(401).json({ error: "Authentication failed" });
  }
};

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
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      next();
      return;
    }

    const token = authHeader.substring(7);
    const decoded = verifyToken(token);

    if (!decoded) {
      next();
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        walletAddress: true,
        role: true,
      },
    });

    if (user) {
      req.user = {
        userId: user.id,
        walletAddress: user.walletAddress,
        role: user.role,
      };
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
export const requireAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "No token provided" });
      return;
    }

    const token = authHeader.substring(7);
    const decoded = verifyToken(token);

    if (!decoded) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, walletAddress: true, role: true },
    });

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    if (user.role !== UserRole.ADMIN) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    req.user = {
      userId: user.id,
      walletAddress: user.walletAddress,
      role: user.role,
    };

    next();
  } catch (error) {
    logger.error("Admin authentication error:", error);
    res.status(401).json({ error: "Authentication failed" });
  }
};

/**
 * Middleware to require oracle role
 */
export const requireOracle = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "No token provided" });
      return;
    }

    const token = authHeader.substring(7);
    const decoded = verifyToken(token);

    if (!decoded) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, walletAddress: true, role: true },
    });

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    if (user.role !== UserRole.ORACLE && user.role !== UserRole.ADMIN) {
      res.status(403).json({ error: "Oracle or Admin access required" });
      return;
    }

    req.user = {
      userId: user.id,
      walletAddress: user.walletAddress,
      role: user.role,
    };

    next();
  } catch (error) {
    logger.error("Oracle authentication error:", error);
    res.status(401).json({ error: "Authentication failed" });
  }
};

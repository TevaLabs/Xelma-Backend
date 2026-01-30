import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt.util";
import { PrismaClient, UserRole } from "@prisma/client";
import logger from "../utils/logger";

const prisma = new PrismaClient();

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

export interface AuthRequest extends Request {
  user?: {
    userId: string;
    walletAddress: string;
    role: UserRole;
  };
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

/**
 * Middleware for optional authentication (user may or may not be logged in)
 */
export const optionalAuthentication = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      // No token, but that's ok for optional auth
      (req as any).userId = undefined;
      next();
      return;
    }

    const token = authHeader.substring(7);
    const decoded = verifyToken(token);

    if (!decoded) {
      (req as any).userId = undefined;
      next();
      return;
    }

    // Get user from database
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
      (req as any).userId = user.id;
    }

    next();
  } catch (error) {
    logger.error("Optional authentication error:", error);
    // Don't fail on error, just continue without user
    next();
    res.status(401).json({ error: "Authentication failed" });
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
  await authenticateUser(req, res, () => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    if (req.user.role !== UserRole.ADMIN) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    next();
  });
};

/**
 * Middleware to require oracle role
 */
export const requireOracle = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  await authenticateUser(req, res, () => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    if (req.user.role !== UserRole.ORACLE && req.user.role !== UserRole.ADMIN) {
      res.status(403).json({ error: "Oracle or Admin access required" });
      return;
    }

    next();
  });
};

/**
 * Optional authentication middleware
 * Validates token if present, but doesn't require it
 * Middleware that attempts to authenticate but doesn't block if fails
 */
export const optionalAuthentication = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No token provided, continue without user
      next();
      return;
    }

    const token = authHeader.substring(7);
    const decoded = verifyToken(token);

    if (!decoded) {
      // Invalid token, continue without user
      next();
      return;
    }

    // Get user from database
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
    // On error, continue without user
    logger.warn('Optional authentication error:', error);
    next();
  }
};

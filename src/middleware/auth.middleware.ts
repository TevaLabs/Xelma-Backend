import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt.util';
import { PrismaClient, UserRole } from '@prisma/client';
import logger from '../utils/logger';

const prisma = new PrismaClient();

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        walletAddress: string;
        role: UserRole;
      };
    }
  }
}

/**
 * Middleware to authenticate user via JWT token
 */
export const authenticateUser = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    const decoded = verifyToken(token);

    if (!decoded) {
      res.status(401).json({ error: 'Invalid or expired token' });
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
      res.status(401).json({ error: 'User not found' });
      return;
    }

    // Attach user to request
    req.user = {
      userId: user.id,
      walletAddress: user.walletAddress,
      role: user.role,
    };

    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
};

/**
 * Middleware to require admin role
 */
export const requireAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  await authenticateUser(req, res, () => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (req.user.role !== UserRole.ADMIN) {
      res.status(403).json({ error: 'Admin access required' });
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
  next: NextFunction
): Promise<void> => {
  await authenticateUser(req, res, () => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (req.user.role !== UserRole.ORACLE && req.user.role !== UserRole.ADMIN) {
      res.status(403).json({ error: 'Oracle or Admin access required' });
      return;
    }

    next();
  });
};

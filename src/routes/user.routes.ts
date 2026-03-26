import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { authenticateUser } from "../middleware/auth.middleware";
import { NotFoundError } from "../utils/errors";

const router = Router();

/**
 * GET /api/user/profile
 * Returns the authenticated user's full profile information
 */
router.get(
  "/profile",
  authenticateUser,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          walletAddress: true,
          nickname: true,
          avatarUrl: true,
          createdAt: true,
          preferences: true,
          streak: true,
          lastLoginAt: true,
          virtualBalance: true,
          wins: true,
        },
      });

      if (!user) {
        return next(new NotFoundError("User not found"));
      }

      // Map to API response format if needed, primarily just ensuring naming consistency
      const profile = {
        walletAddress: user.walletAddress,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        joinedAt: user.createdAt,
        preferences: user.preferences,
        streak: user.streak,
        lastLoginAt: user.lastLoginAt,
        balance: user.virtualBalance,
      };

      return res.json({
        success: true,
        profile,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/user/balance
 * Returns current virtual balance
 */
router.get(
  "/balance",
  authenticateUser,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { virtualBalance: true },
      });

      if (!user) return next(new NotFoundError("User not found"));

      return res.json({
        success: true,
        balance: user.virtualBalance,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/user/stats
 * Returns detailed user statistics
 */
router.get("/stats", authenticateUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;

    const stats = await prisma.userStats.findUnique({
      where: { userId },
    });

    return res.json({
      success: true,
      stats: stats || {
        totalPredictions: 0,
        correctPredictions: 0,
        totalEarnings: 0,
        upDownWins: 0,
        upDownLosses: 0,
        legendsWins: 0,
        legendsLosses: 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/user/profile
 * Update user preferences/profile
 */
router.patch(
  "/profile",
  authenticateUser,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId;

      const { nickname, avatarUrl, preferences } = req.body;

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: {
          nickname,
          avatarUrl,
          preferences,
        },
        select: {
          nickname: true,
          avatarUrl: true,
          preferences: true,
        },
      });

      return res.json({
        success: true,
        profile: updatedUser,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/user/transactions
 * Paginated list of balance changes
 */
router.get(
  "/transactions",
  authenticateUser,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId;

      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      const [transactions, total] = await prisma.$transaction([
        prisma.transaction.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip,
        }),
        prisma.transaction.count({ where: { userId } }),
      ]);

      return res.json({
        success: true,
        data: transactions,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/user/:walletAddress/public-profile
 * Public profile view for any user
 */
router.get(
  "/:walletAddress/public-profile",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { walletAddress } = req.params;

      const user = await prisma.user.findUnique({
        where: { walletAddress },
        select: {
          walletAddress: true,
          nickname: true,
          avatarUrl: true,
          createdAt: true,
          stats: {
            select: {
              totalPredictions: true,
              correctPredictions: true,
            },
          },
        },
      });

      if (!user) {
        return next(new NotFoundError("User not found"));
      }

      return res.json({
        success: true,
        profile: {
          walletAddress: user.walletAddress,
          nickname: user.nickname,
          avatarUrl: user.avatarUrl,
          joinedAt: user.createdAt,
          stats: user.stats,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;

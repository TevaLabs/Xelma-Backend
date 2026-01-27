import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticateUser } from "../middleware/auth.middleware";

const router = Router();

/**
 * GET /api/user/profile
 * Returns the authenticated user's full profile information
 */
router.get(
  "/profile",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.userId;

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

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
        return res.status(404).json({ error: "User not found" });
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
        balance: user.virtualBalance, // Added balance for convenience
      };

      return res.json({
        success: true,
        profile,
      });
    } catch (error) {
      console.error("Error fetching profile:", error);
      return res.status(500).json({ error: "Internal Server Error" });
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
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { virtualBalance: true },
      });

      if (!user) return res.status(404).json({ error: "User not found" });

      return res.json({
        success: true,
        balance: user.virtualBalance,
      });
    } catch (error) {
      console.error("Error fetching balance:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

/**
 * GET /api/user/stats
 * Returns detailed user statistics
 */
router.get("/stats", authenticateUser, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const stats = await prisma.userStats.findUnique({
      where: { userId },
    });

    // If no stats specific record, return defaults or create one?
    // Usually existing logic creates it, but we can fallback to user basic fields or return empty zeros.

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
    console.error("Error fetching stats:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * PATCH /api/user/profile
 * Update user preferences/profile
 */
router.patch(
  "/profile",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const { nickname, avatarUrl, preferences } = req.body;

      // Validate inputs if necessary

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
      console.error("Error updating profile:", error);
      return res.status(500).json({ error: "Internal Server Error" });
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
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

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
      console.error("Error fetching transactions:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

/**
 * GET /api/user/:walletAddress/public-profile
 * Public profile view for any user
 */
router.get(
  "/:walletAddress/public-profile",
  async (req: Request, res: Response) => {
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
        return res.status(404).json({ error: "User not found" });
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
      console.error("Error fetching public profile:", error);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

export default router;

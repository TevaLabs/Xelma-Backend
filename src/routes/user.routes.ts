import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { authenticateUser, AuthenticatedRequest } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { updateProfileSchema } from "../schemas/user.schema";
import { unifiedPaginationSchema, UnifiedPaginationParams } from "../schemas/pagination.schema";
import { NotFoundError } from "../utils/errors";
import sorobanService from "../services/soroban.service";

const router = Router();

/**
 * GET /api/user/profile
 * Returns the authenticated user's full profile information
 */
router.get(
  "/profile",
  authenticateUser,
  (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user.userId;

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
  }) as any,
);

/**
 * GET /api/user/balance
 * Returns current virtual balance
 */
router.get(
  "/balance",
  authenticateUser,
  (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user.userId;

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
  }) as any,
);

/**
 * GET /api/user/stats
 * Returns detailed user statistics
 */
router.get("/stats", authenticateUser, (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user.userId;

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
}) as any);

/**
 * GET /api/user/:address/stats
 * Returns on-chain user stats and pending winnings from the Soroban contract.
 * Public endpoint — no authentication required.
 */
router.get(
  "/:address/stats",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;

      const [contractStats, pendingWinnings] = await Promise.all([
        sorobanService.getUserStats(address),
        sorobanService.getPendingWinnings(address),
      ]);

      if (!contractStats) {
        return res.json({
          success: true,
          stats: {
            totalWins: 0,
            totalLosses: 0,
            bestStreak: 0,
            currentStreak: 0,
            pendingWinnings: "0",
            isRegistered: false,
          },
        });
      }

      return res.json({
        success: true,
        stats: {
          totalWins: contractStats.total_wins,
          totalLosses: contractStats.total_losses,
          bestStreak: contractStats.best_streak,
          currentStreak: contractStats.current_streak,
          pendingWinnings: pendingWinnings.toString(),
          isRegistered: contractStats.total_wins > 0 || contractStats.total_losses > 0,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * PATCH /api/user/profile
 * Update user preferences/profile
 */
router.patch(
  "/profile",
  authenticateUser,
  validate(updateProfileSchema),
  (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user.userId;

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
  }) as any,
);

/**
 * GET /api/user/transactions
 * Paginated list of balance changes
 */
router.get(
  "/transactions",
  authenticateUser,
  (async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user.userId;

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
  }) as any,
);

/**
 * GET /api/user/:address/history
 * Paginated bet (prediction) history for a Stellar address.
 * Public endpoint — no authentication required.
 *
 * Pagination modes
 * ────────────────
 * Cursor (preferred for large histories):
 *   ?limit=20&cursor=<opaque-cursor>
 *   Response includes `nextCursor`; use it as `cursor` in the next request.
 *   Returns `nextCursor: null` on the last page.
 *
 * Offset (legacy, backward-compatible):
 *   ?limit=20&offset=0
 *   Returns `total` and `totalPages` for UI paginators.
 *   Performance degrades for offsets > ~10 000 rows.
 *
 * Cursor mode is selected automatically when `cursor` is present in the query
 * (even `cursor=""` keeps offset mode — only a non-empty string activates it).
 */
router.get(
  "/:address/history",
  validate(unifiedPaginationSchema, "query"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const { limit, offset, cursor } = req.query as unknown as UnifiedPaginationParams;

      // Resolve the user record once — shared by both pagination modes.
      const user = await prisma.user.findUnique({
        where: { walletAddress: address },
        select: { id: true },
      });

      // Unknown address → empty response (not a 404: the address may exist on-chain
      // but have never placed a bet, and callers should not need to handle errors).
      if (!user) {
        return res.json({
          success: true,
          data: [],
          ...(cursor
            ? { nextCursor: null }
            : { pagination: { limit, offset, total: 0, totalPages: 0 } }),
        });
      }

      // ── Shared include shape ────────────────────────────────────────────────
      const roundSelect = {
        select: {
          id: true,
          mode: true,
          startPrice: true,
          endPrice: true,
          status: true,
          startTime: true,
          endTime: true,
          resolvedAt: true,
        },
      };

      // ── Cursor-based path ────────────────────────────────────────────────────
      if (cursor) {
        // The cursor is a base64-encoded ISO timestamp (createdAt of the last
        // record seen). We fetch limit + 1 rows to detect whether a next page
        // exists without a separate COUNT query.
        let cursorDate: Date | undefined;
        try {
          cursorDate = new Date(Buffer.from(cursor, "base64url").toString("utf8"));
          if (isNaN(cursorDate.getTime())) throw new Error("invalid date");
        } catch {
          return res.status(400).json({
            success: false,
            error: "Invalid cursor. Use the nextCursor value returned by a previous response.",
          });
        }

        const predictions = await prisma.prediction.findMany({
          where: {
            userId: user.id,
            createdAt: { lt: cursorDate },
          },
          orderBy: { createdAt: "desc" },
          take: limit + 1,          // fetch one extra to check for next page
          include: { round: roundSelect },
        });

        const hasNextPage = predictions.length > limit;
        const page = hasNextPage ? predictions.slice(0, limit) : predictions;

        // Encode the createdAt of the last returned record as the next cursor.
        const nextCursor = hasNextPage
          ? Buffer.from(page[page.length - 1].createdAt.toISOString()).toString("base64url")
          : null;

        return res.json({
          success: true,
          data: page.map(mapPrediction),
          nextCursor,
        });
      }

      // ── Offset-based path (backward-compatible) ───────────────────────────
      const [predictions, total] = await prisma.$transaction([
        prisma.prediction.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
          include: { round: roundSelect },
        }),
        prisma.prediction.count({ where: { userId: user.id } }),
      ]);

      return res.json({
        success: true,
        data: predictions.map(mapPrediction),
        pagination: {
          limit,
          offset,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/** Maps a raw Prisma prediction + round to the public API shape. */
function mapPrediction(p: any) {
  return {
    roundId: p.roundId,
    asset: "XLM",
    mode: p.round.mode,
    amount: p.amount,
    side: p.side,
    predictedPrice: p.priceRange,
    result: p.won === null ? "PENDING" : p.won ? "WIN" : "LOSS",
    payout: p.payout,
    timestamp: p.createdAt,
    roundStatus: p.round.status,
  };
}

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
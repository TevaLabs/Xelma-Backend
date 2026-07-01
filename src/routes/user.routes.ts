import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { authenticateUser, AuthenticatedRequest } from "../middleware/auth.middleware";
import { validate } from "../middleware/validate.middleware";
import { updateProfileSchema } from "../schemas/user.schema";
import { unifiedPaginationSchema, UnifiedPaginationParams, encodeCursor } from "../schemas/pagination.schema";
import { NotFoundError } from "../utils/errors";
import { validateStellarAddressParam } from "../utils/stellar-address.util";
import sorobanService from "../services/soroban.service";
import { toDecimalString } from "../utils/decimal.util";
import config from "../config";
import { getMockBetHistory } from "../data/mockData";

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
        balance: toDecimalString(user.virtualBalance),
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
        balance: toDecimalString(user.virtualBalance),
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
      stats: stats
        ? {
            totalPredictions: stats.totalPredictions,
            correctPredictions: stats.correctPredictions,
            totalEarnings: toDecimalString(stats.totalEarnings),
            upDownWins: stats.upDownWins,
            upDownLosses: stats.upDownLosses,
            upDownEarnings: toDecimalString(stats.upDownEarnings),
            legendsWins: stats.legendsWins,
            legendsLosses: stats.legendsLosses,
            legendsEarnings: toDecimalString(stats.legendsEarnings),
          }
        : {
            totalPredictions: 0,
            correctPredictions: 0,
            totalEarnings: "0",
            upDownWins: 0,
            upDownLosses: 0,
            upDownEarnings: "0",
            legendsWins: 0,
            legendsLosses: 0,
            legendsEarnings: "0",
          },
    });
  } catch (error) {
    next(error);
  }
}) as any);

/**
 * Computes an XP score from on-chain user stats.
 * XP = totalWins × 100 + bestStreak × 50
 */
function computeXp(totalWins: number, bestStreak: number): number {
  return totalWins * 100 + bestStreak * 50;
}

/**
 * Derives a rank title from XP.
 * Thresholds match hackathon profile expectations.
 */
function computeRankTitle(xp: number): string {
  if (xp >= 10000) return "Diamond";
  if (xp >= 5000) return "Platinum";
  if (xp >= 3000) return "Gold";
  if (xp >= 1500) return "Silver";
  if (xp >= 500) return "Bronze";
  return "Rookie";
}

/**
 * GET /api/user/:address/stats
 * Returns on-chain user stats and pending winnings from the Soroban contract.
 * Public endpoint — no authentication required.
 *
 * Response includes a `stats` block (existing consumers) and a `profile` block
 * with hackathon-friendly fields (balance, xp, rankTitle) for the frontend UI.
 */
router.get(
  "/:address/stats",
  validateStellarAddressParam("address"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;

      const [contractStats, pendingWinnings, balance] = await Promise.all([
        sorobanService.getUserStats(address),
        sorobanService.getPendingWinnings(address),
        sorobanService.getBalance(address),
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
          profile: {
            balance: 0,
            xp: 0,
            rankTitle: "Rookie",
          },
        });
      }

      const xp = computeXp(contractStats.total_wins, contractStats.best_streak);

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
        profile: {
          balance,
          xp,
          rankTitle: computeRankTitle(xp),
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

      const serializedTransactions = transactions.map((tx: any) => ({
        ...tx,
        amount: toDecimalString(tx.amount),
      }));

      return res.json({
        success: true,
        data: serializedTransactions,
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
  validateStellarAddressParam("address"),
  validate(unifiedPaginationSchema, "query"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const { limit, offset, cursor } = req.query as unknown as UnifiedPaginationParams;

      // ── In-memory fallback (hackathon mode) ────────────────────────────────────
      if (config.app.dataStore === "memory") {
        return handleMockHistory(address, limit, offset, cursor, res);
      }

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
    amount: toDecimalString(p.amount),
    side: p.side,
    predictedPrice: p.priceRange,
    result: p.won === null ? "PENDING" : p.won ? "WIN" : "LOSS",
    payout: p.payout !== null && p.payout !== undefined ? toDecimalString(p.payout) : null,
    timestamp: p.createdAt,
    roundStatus: p.round.status,
  };
}

/**
 * In-memory fallback for GET /api/user/:address/history when DATA_STORE=memory.
 * Generates deterministic stub predictions so the frontend can demo the full
 * user journey without PostgreSQL.
 */
function handleMockHistory(
  address: string,
  limit: number,
  offset: number,
  cursor: string | undefined,
  res: Response,
): void {
  const all = getMockBetHistory(address);

  if (!all.length) {
    res.json({
      success: true,
      data: [],
      ...(cursor
        ? { nextCursor: null }
        : { pagination: { limit, offset, total: 0, totalPages: 0 } }),
    });
    return;
  }

  // Cursor-based pagination
  if (cursor) {
    let cursorDate: Date;
    try {
      cursorDate = new Date(Buffer.from(cursor, "base64url").toString("utf8"));
      if (isNaN(cursorDate.getTime())) throw new Error("invalid date");
    } catch {
      res.status(400).json({
        success: false,
        error: "Invalid cursor. Use the nextCursor value returned by a previous response.",
      });
      return;
    }

    const filtered = all.filter((item) => item.timestamp < cursorDate);
    const hasNextPage = filtered.length > limit;
    const page = hasNextPage ? filtered.slice(0, limit) : filtered;
    const nextCursor = hasNextPage
      ? encodeCursor(page[page.length - 1].timestamp)
      : null;

    res.json({ success: true, data: page, nextCursor });
    return;
  }

  // Offset-based pagination
  const page = all.slice(offset, offset + limit);
  const total = all.length;

  res.json({
    success: true,
    data: page,
    pagination: {
      limit,
      offset,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}

/**
 * GET /api/user/:walletAddress/public-profile
 * Public profile view for any user
 */
router.get(
  "/:walletAddress/public-profile",
  validateStellarAddressParam("walletAddress"),
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
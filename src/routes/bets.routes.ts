import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate.middleware";
import {
  verifyStellarAuth,
  bindAuthenticatedWallet,
  requireAdmin,
} from "../middleware/auth.middleware";
import { betRateLimiter } from "../middleware/rateLimiter.middleware";
import { upDownBetSchema, precisionBetSchema, claimWinningsSchema } from "../schemas/bets.schema";
import betService from "../services/bet.service";
import { BetStatus } from "@prisma/client";
import {
  IDEMPOTENT_REPLAYED_HEADER,
  readIdempotencyKey,
  runIdempotent,
} from "../utils/idempotency.util";
import { ValidationError, NotFoundError } from "../utils/errors";
import { serializeBet } from "../serializers/monetary.serializer";
import { prisma } from "../lib/prisma";
import { executeBet } from "./bet-execution";

const router = Router();

/**
 * @swagger
 * /api/bets/up-down:
 *   post:
 *     summary: Submit an UP/DOWN bet (stub)
 *     tags: [bets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema: { type: string, minLength: 8, maxLength: 255, pattern: "^[a-zA-Z0-9_-]+$" }
 *         description: >
 *           Optional client key for safe retries. Retrying with the same key and
 *           body replays the original response (with `Idempotent-Replayed: true`)
 *           instead of placing a second bet. Keys are scoped per user and endpoint
 *           and kept for 24 hours.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address, amount, side]
 *             properties:
 *               address: { type: string, description: "Optional; must match JWT wallet when provided" }
 *               amount: { type: number }
 *               side: { type: string, enum: [UP, DOWN] }
 *     responses:
 *       200:
 *         description: Bet recorded (stub)
 *       401:
 *         description: Missing or invalid JWT
 *       400:
 *         description: Validation error
 *       409:
 *         description: Idempotency key reused with a different body, or still in flight
 *       503:
 *         description: Idempotency store / distributed lock unavailable
 */
router.post(
  "/up-down",
  verifyStellarAuth,
  bindAuthenticatedWallet,
  betRateLimiter,
  validate(upDownBetSchema),
  (async (req: any, res: Response, next: NextFunction) => {
    await executeBet(req, res, next, {
      kind: "up-down",
      endpoint: "/api/bets/up-down",
    });
  }) as any,
);

/**
 * @swagger
 * /api/bets/precision:
 *   post:
 *     summary: Submit a Precision bet (stub)
 *     tags: [bets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: false
 *         schema: { type: string, minLength: 8, maxLength: 255, pattern: "^[a-zA-Z0-9_-]+$" }
 *         description: >
 *           Optional client key for safe retries. Retrying with the same key and
 *           body replays the original response (with `Idempotent-Replayed: true`)
 *           instead of placing a second bet. Keys are scoped per user and endpoint
 *           and kept for 24 hours.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address, amount, predictedPrice]
 *             properties:
 *               address: { type: string, description: "Optional; must match JWT wallet when provided" }
 *               amount: { type: number }
 *               predictedPrice: { type: number }
 *     responses:
 *       200:
 *         description: Bet recorded (stub)
 *       401:
 *         description: Missing or invalid JWT
 *       400:
 *         description: Validation error
 *       409:
 *         description: Idempotency key reused with a different body, or still in flight
 *       503:
 *         description: Idempotency store / distributed lock unavailable
 */
router.post(
  "/precision",
  verifyStellarAuth,
  bindAuthenticatedWallet,
  betRateLimiter,
  validate(precisionBetSchema),
  (async (req: any, res: Response, next: NextFunction) => {
    await executeBet(req, res, next, {
      kind: "precision",
      endpoint: "/api/bets/precision",
    });
  }) as any,
);

/**
 * @swagger
 * /api/bets/claim:
 *   post:
 *     summary: Claim pending Soroban winnings
 *     tags: [bets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         schema: { type: string }
 *         required: false
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               address: { type: string, description: "Optional; must match JWT wallet when provided" }
 *     responses:
 *       200:
 *         description: Claim recorded or submitted on-chain
 *       401:
 *         description: Missing or invalid JWT
 *       403:
 *         description: Wallet address mismatch
 *       400:
 *         description: Invalid Idempotency-Key format
 *       409:
 *         description: Idempotency key reused with a different body, or still in flight
 *       422:
 *         description: No claimable winnings / invalid contract state
 *       503:
 *         description: Contract interaction failed
 */
router.post(
  "/claim",
  verifyStellarAuth,
  (req: Request, _res: Response, next: NextFunction) => {
    req.body = req.body ?? {};
    next();
  },
  bindAuthenticatedWallet,
  validate(claimWinningsSchema),
  (async (req: Request, res: Response, next: NextFunction) => {
    const idempotencyKey = readIdempotencyKey(req.headers);
    const requestId = (req as any).requestId as string | undefined;

    try {
      const result = await runIdempotent({
        userId: req.user!.userId,
        endpoint: "/api/bets/claim",
        idempotencyKey,
        requestBody: req.body,
        ttlHours: 24,
        operation: async () => {
          const claim = await betService.claimWinnings(
            req.body.address,
            idempotencyKey,
            requestId,
          );
          return {
            status: 200,
            body: {
              success: true,
              message:
                claim.state === "stub"
                  ? "Claim recorded (stub)"
                  : "Winnings claimed on-chain",
              state: claim.state,
              amount: claim.amount,
              ...(claim.txHash ? { txHash: claim.txHash } : {}),
              ...(requestId ? { requestId } : {}),
            },
          };
        },
      });

      if (result.replayed) {
        res.setHeader(IDEMPOTENT_REPLAYED_HEADER, "true");
      }
      return res.status(result.status).json(result.body);
    } catch (error) {
      return next(error);
    }
  }),
);

const BET_STATUSES: BetStatus[] = ["ACCEPTED", "SUBMITTED", "CONFIRMED", "RESOLVED", "FAILED"];

/**
 * @swagger
 * /api/bets/reconciliation:
 *   get:
 *     summary: Query bet records and their on-chain reconciliation state
 *     description: >
 *       Admin-only. Returns bet records with their reconciliation fields
 *       (status, txHash, submittedAt) plus a per-status summary, so stub bets
 *       and their eventual on-chain transactions can be audited together.
 *     tags: [bets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: address
 *         schema: { type: string }
 *         description: Filter by Stellar wallet address
 *       - in: query
 *         name: roundId
 *         schema: { type: string }
 *         description: Filter by round
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [STUB, SUBMITTED, CONFIRMED, FAILED] }
 *         description: Filter by reconciliation status
 *     responses:
 *       200:
 *         description: Matching bet records, newest first, with a status summary
 *       400:
 *         description: Unknown status filter
 *       401:
 *         description: Missing or invalid JWT
 *       403:
 *         description: Admin access required
 */
router.get(
  "/reconciliation",
  requireAdmin,
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address, roundId, status } = req.query;

      if (status !== undefined && !BET_STATUSES.includes(status as BetStatus)) {
        throw new ValidationError(
          `Invalid status filter. Expected one of: ${BET_STATUSES.join(", ")}.`
        );
      }

      // If address is provided, look up userId
      let userId: string | undefined;
      if (address) {
        const user = await prisma.user.findUnique({
          where: { walletAddress: address as string },
          select: { id: true },
        });
        userId = user?.id;
      }

      const bets = await betService.getBets({
        userId,
        roundId: roundId as string | undefined,
        status: status as BetStatus | undefined,
      });

      const summary = await betService.getReconciliationSummary();

      res.json({
        success: true,
        summary,
        count: bets.length,
        bets: bets.map((bet) => serializeBet(bet as unknown as Record<string, unknown>)),
      });
    } catch (error) {
      next(error);
    }
  }),
);

/**
 * @swagger
 * /api/bets/{id}:
 *   get:
 *     summary: Get a single bet record with its reconciliation state
 *     tags: [bets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Bet ID returned when the bet was placed
 *     responses:
 *       200:
 *         description: Bet record
 *       401:
 *         description: Missing or invalid JWT
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Bet not found
 */
router.get(
  "/:id",
  requireAdmin,
  ((req: Request, res: Response, next: NextFunction) => {
    try {
      const bet = betService.getBet(req.params.id);

      if (!bet) {
        throw new NotFoundError(`Bet ${req.params.id} not found`);
      }

      res.json({ success: true, bet: serializeBet(bet as unknown as Record<string, unknown>) });
    } catch (error) {
      next(error);
    }
  }) as any
);

export default router;

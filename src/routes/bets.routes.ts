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
import { BetStatus } from "../data/bet-store";
import {
  acquireIdempotencyLock,
  IDEMPOTENCY_STORE_UNAVAILABLE,
  IdempotencyStoreUnavailableError,
  releaseIdempotencyLock,
  storeIdempotencyResult,
  isValidIdempotencyKey,
} from "../utils/idempotency.util";
import {
  ConflictError,
  ValidationError,
  ErrorCode,
  ExternalServiceError,
  NotFoundError,
} from "../utils/errors";
import { sendSuccess } from "../utils/response";
import { serializeBet } from "../serializers/monetary.serializer";

const router = Router();

/**
 * @swagger
 * /api/bets/up-down:
 *   post:
 *     summary: Submit an UP/DOWN bet (stub)
 *     tags: [bets]
 *     security:
 *       - bearerAuth: []
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
 */
router.post(
  "/up-down",
  verifyStellarAuth,
  bindAuthenticatedWallet,
  betRateLimiter,
  validate(upDownBetSchema),
  (async (req: any, res: Response, next: NextFunction) => {
    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
    const userId = req.user.userId;
    const endpoint = "/api/bets/up-down";
    let lockAcquired = false;
    let operationCompleted = false;

    try {
      if (idempotencyKey) {
        if (!isValidIdempotencyKey(idempotencyKey)) {
          throw new ValidationError(
            "Invalid Idempotency-Key format. Must be 8-255 alphanumeric characters."
          );
        }

        const lockResult = await acquireIdempotencyLock(
          userId,
          endpoint,
          idempotencyKey,
          req.body,
          24 // TTL hours
        );

        if (lockResult.isIdempotent && lockResult.cachedResponse) {
          return res
            .status(lockResult.cachedResponse.status)
            .json(lockResult.cachedResponse.body);
        }

        if (lockResult.error === IDEMPOTENCY_STORE_UNAVAILABLE) {
          throw new ExternalServiceError(
            "Idempotency store unavailable. Please try again.",
            ErrorCode.EXTERNAL_SERVICE_ERROR
          );
        }

        if (lockResult.error) {
          throw new ConflictError(
            lockResult.error,
            ErrorCode.IDEMPOTENCY_KEY_CONFLICT
          );
        }

        lockAcquired = !!lockResult.lockAcquired;
      }

      const result = await betService.recordUpDownBet(req.body, idempotencyKey);
      operationCompleted = true;
      const data = {
        message: result.state === "stub" ? "Bet recorded (stub)" : "Bet placed on-chain",
        state: result.state,
        betId: result.betId,
        status: result.status,
        ...(result.txHash ? { txHash: result.txHash } : {}),
      };
      const responseBody = { success: true as const, data };

      if (idempotencyKey && lockAcquired) {
        await storeIdempotencyResult(
          userId,
          endpoint,
          idempotencyKey,
          req.body,
          200,
          responseBody,
          { ttlHours: 24 }
        );
      }

      return sendSuccess(res, data);
    } catch (error: any) {
      if (idempotencyKey && lockAcquired && !operationCompleted) {
        await releaseIdempotencyLock(userId, endpoint, idempotencyKey);
      }

      if (error instanceof IdempotencyStoreUnavailableError) {
        return next(new ExternalServiceError(
          "Idempotency store unavailable. Please try again.",
          ErrorCode.EXTERNAL_SERVICE_ERROR
        ));
      }

      return next(error);
    }
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
 */
router.post(
  "/precision",
  verifyStellarAuth,
  bindAuthenticatedWallet,
  betRateLimiter,
  validate(precisionBetSchema),
  (async (req: any, res: Response, next: NextFunction) => {
    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
    const userId = req.user.userId;
    const endpoint = "/api/bets/precision";
    let lockAcquired = false;
    let operationCompleted = false;

    try {
      if (idempotencyKey) {
        if (!isValidIdempotencyKey(idempotencyKey)) {
          throw new ValidationError(
            "Invalid Idempotency-Key format. Must be 8-255 alphanumeric characters."
          );
        }

        const lockResult = await acquireIdempotencyLock(
          userId,
          endpoint,
          idempotencyKey,
          req.body,
          24 // TTL hours
        );

        if (lockResult.isIdempotent && lockResult.cachedResponse) {
          return res
            .status(lockResult.cachedResponse.status)
            .json(lockResult.cachedResponse.body);
        }

        if (lockResult.error === IDEMPOTENCY_STORE_UNAVAILABLE) {
          throw new ExternalServiceError(
            "Idempotency store unavailable. Please try again.",
            ErrorCode.EXTERNAL_SERVICE_ERROR
          );
        }

        if (lockResult.error) {
          throw new ConflictError(
            lockResult.error,
            ErrorCode.IDEMPOTENCY_KEY_CONFLICT
          );
        }

        lockAcquired = !!lockResult.lockAcquired;
      }

      const result = await betService.recordPrecisionBet(req.body, idempotencyKey);
      operationCompleted = true;
      const data = {
        message: result.state === "stub" ? "Bet recorded (stub)" : "Bet placed on-chain",
        state: result.state,
        betId: result.betId,
        status: result.status,
        ...(result.txHash ? { txHash: result.txHash } : {}),
      };
      const responseBody = { success: true as const, data };

      if (idempotencyKey && lockAcquired) {
        await storeIdempotencyResult(
          userId,
          endpoint,
          idempotencyKey,
          req.body,
          200,
          responseBody,
          { ttlHours: 24 }
        );
      }

      return sendSuccess(res, data);
    } catch (error: any) {
      if (idempotencyKey && lockAcquired && !operationCompleted) {
        await releaseIdempotencyLock(userId, endpoint, idempotencyKey);
      }

      next(error);
    }
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
 *       409:
 *         description: Idempotency key conflict
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
    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
    const userId = req.user!.userId;
    const endpoint = "/api/bets/claim";
    let lockAcquired = false;

    try {
      if (idempotencyKey) {
        if (!isValidIdempotencyKey(idempotencyKey)) {
          throw new ValidationError(
            "Invalid Idempotency-Key format. Must be 8-255 alphanumeric characters."
          );
        }

        const lockResult = await acquireIdempotencyLock(
          userId,
          endpoint,
          idempotencyKey,
          req.body,
          24
        );

        if (lockResult.isIdempotent && lockResult.cachedResponse) {
          return res
            .status(lockResult.cachedResponse.status)
            .json(lockResult.cachedResponse.body);
        }

        if (lockResult.error) {
          throw new ConflictError(
            lockResult.error,
            ErrorCode.IDEMPOTENCY_KEY_CONFLICT
          );
        }

        lockAcquired = !!lockResult.lockAcquired;
      }

      const result = await betService.claimWinnings(req.body.address, idempotencyKey);
      const responseBody = {
        success: true,
        message:
          result.state === "stub"
            ? "Claim recorded (stub)"
            : "Winnings claimed on-chain",
        state: result.state,
        amount: result.amount,
        ...(result.txHash ? { txHash: result.txHash } : {}),
      };

      if (idempotencyKey && lockAcquired) {
        await storeIdempotencyResult(
          userId,
          endpoint,
          idempotencyKey,
          req.body,
          200,
          responseBody,
          { ttlHours: 24 }
        );
      }

      res.json(responseBody);
    } catch (error: any) {
      if (idempotencyKey && lockAcquired) {
        await releaseIdempotencyLock(userId, endpoint, idempotencyKey);
      }

      return next(error);
    }
  }),
);

const BET_STATUSES: BetStatus[] = ["STUB", "SUBMITTED", "CONFIRMED", "FAILED"];

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

      const [bets, summary] = await Promise.all([
        betService.getBets({
          address: address as string | undefined,
          roundId: roundId as string | undefined,
          status: status as BetStatus | undefined,
        }),
        betService.getReconciliationSummary(),
      ]);

      res.json({
        success: true,
        summary,
        count: bets.length,
        bets: bets.map((bet) => serializeBet(bet as unknown as Record<string, unknown>)),
      });
    } catch (error) {
      next(error);
    }
  }) as any,
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
  (async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bet = await betService.getBet(req.params.id);

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

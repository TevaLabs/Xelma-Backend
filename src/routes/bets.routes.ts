import { Router, Response, NextFunction } from "express";
import { validate } from "../middleware/validate.middleware";
import { verifyStellarAuth, AuthenticatedRequest } from "../middleware/auth.middleware";
import { upDownBetSchema, precisionBetSchema } from "../schemas/bets.schema";
import betService from "../services/bet.service";
import {
  acquireIdempotencyLock,
  releaseIdempotencyLock,
  storeIdempotencyResult,
  isValidIdempotencyKey,
} from "../utils/idempotency.util";
import { ConflictError, ValidationError, ErrorCode } from "../utils/errors";

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
 *             required: [amount, side]
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
  validate(upDownBetSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
    const userId = req.user.userId;
    const endpoint = "/api/bets/up-down";
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
          24 // TTL hours
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

      const result = await betService.recordUpDownBet(req.body, idempotencyKey);
      const responseBody = {
        success: true,
        message: result.state === "stub" ? "Bet recorded (stub)" : "Bet placed on-chain",
        state: result.state,
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

      if (error?.message?.includes("Soroban") || error?.message?.includes("Circuit breaker")) {
        res.status(503).json({ success: false, error: "Contract interaction failed. Please try again." });
      } else {
        next(error);
      }
    }
  },
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
 *             required: [amount, predictedPrice]
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
  validate(precisionBetSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
    const userId = req.user.userId;
    const endpoint = "/api/bets/precision";
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
          24 // TTL hours
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

      const result = await betService.recordPrecisionBet(req.body, idempotencyKey);
      const responseBody = {
        success: true,
        message: result.state === "stub" ? "Bet recorded (stub)" : "Bet placed on-chain",
        state: result.state,
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

      if (error?.message?.includes("Soroban") || error?.message?.includes("Circuit breaker")) {
        res.status(503).json({ success: false, error: "Contract interaction failed. Please try again." });
      } else {
        next(error);
      }
    }
  },
);

export default router;

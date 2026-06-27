import { Router, Response, NextFunction } from "express";
import { validate } from "../middleware/validate.middleware";
import { verifyStellarAuth, AuthenticatedRequest } from "../middleware/auth.middleware";
import { upDownBetSchema, precisionBetSchema } from "../schemas/bets.schema";
import betService from "../services/bet.service";

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
  async (req, res: Response, next: NextFunction) => {
    try {
      const result = await betService.recordUpDownBet(req.body);
      res.json({
        success: true,
        message: result.state === "stub" ? "Bet recorded (stub)" : "Bet placed on-chain",
        state: result.state,
        ...(result.txHash ? { txHash: result.txHash } : {}),
      });
    } catch (error: any) {
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
  async (req, res: Response, next: NextFunction) => {
    try {
      const result = await betService.recordPrecisionBet(req.body);
      res.json({
        success: true,
        message: result.state === "stub" ? "Bet recorded (stub)" : "Bet placed on-chain",
        state: result.state,
        ...(result.txHash ? { txHash: result.txHash } : {}),
      });
    } catch (error: any) {
      if (error?.message?.includes("Soroban") || error?.message?.includes("Circuit breaker")) {
        res.status(503).json({ success: false, error: "Contract interaction failed. Please try again." });
      } else {
        next(error);
      }
    }
  },
);

export default router;

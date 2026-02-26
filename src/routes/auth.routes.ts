import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import {
  generateChallenge,
  getChallengeExpiry,
  isChallengeExpired,
} from "../utils/challenge.util";
import { generateToken } from "../utils/jwt.util";
import {
  verifySignature,
  isValidStellarAddress,
} from "../services/stellar.service";
import {
  ChallengeRequestBody,
  ChallengeResponse,
  ConnectRequestBody,
  ConnectResponse,
} from "../types/auth.types";
import {
  challengeRateLimiter,
  connectRateLimiter,
} from "../middleware/rateLimiter.middleware";
import { validate } from "../middleware/validate.middleware";
import { challengeSchema, connectSchema } from "../schemas/auth.schema";
import logger from "../utils/logger";

const router = Router();

/**
 * @swagger
 * /api/auth/challenge:
 *   post:
 *     summary: Request a wallet authentication challenge
 *     description: |
 *       Step 1 of wallet authentication. Returns a one-time challenge string for the wallet to sign.\n
 *       Rate limit: **10 requests per 15 minutes per IP**. On limit, responds with **429**.
 *     tags: [auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AuthChallengeRequest'
 *           example:
 *             walletAddress: GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX
 *     responses:
 *       200:
 *         description: Challenge created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthChallengeResponse'
 *             example:
 *               challenge: random-challenge-string
 *               expiresAt: 2026-01-29T00:00:00.000Z
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             examples:
 *               missingWallet:
 *                 value: { error: "Validation Error", message: "walletAddress is required" }
 *               invalidWallet:
 *                 value: { error: "Validation Error", message: "Invalid Stellar wallet address format" }
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RateLimitResponse'
 *             example:
 *               error: Too Many Requests
 *               message: Too many challenge requests from this IP, please try again after 15 minutes
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example:
 *               error: Internal Server Error
 *               message: Failed to generate authentication challenge
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X POST "$API_BASE_URL/api/auth/challenge" \\
 *             -H "Content-Type: application/json" \\
 *             -d '{"walletAddress":"GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX"}'
 */
router.post(
  "/challenge",
  challengeRateLimiter,
  validate(challengeSchema),
  async (req: Request, res: Response) => {
    try {
      const { walletAddress }: ChallengeRequestBody = req.body;

      // Clean up expired challenges for this wallet (housekeeping)
      await prisma.authChallenge.deleteMany({
        where: {
          walletAddress,
          expiresAt: {
            lt: new Date(),
          },
        },
      });

      // Generate new challenge
      const challenge = generateChallenge();
      const expiresAt = getChallengeExpiry();

      // Store challenge in database
      await prisma.authChallenge.create({
        data: {
          challenge,
          walletAddress,
          expiresAt,
          isUsed: false,
        },
      });

      const response: ChallengeResponse = {
        challenge,
        expiresAt: expiresAt.toISOString(),
      };

      return res.status(200).json(response);
    } catch (error) {
      logger.error("Error generating challenge:", { error });
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to generate authentication challenge",
      });
    }
  },
);

/**
 * @swagger
 * /api/auth/connect:
 *   post:
 *     summary: Verify signature and authenticate wallet
 *     description: |
 *       Step 2 of wallet authentication. Verifies the signature for the challenge and returns a JWT.\n
 *       Rate limit: **5 requests per 15 minutes per IP**. On limit, responds with **429**.
 *     tags: [auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AuthConnectRequest'
 *           example:
 *             walletAddress: GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX
 *             challenge: random-challenge-string
 *             signature: base64-or-hex-signature
 *     responses:
 *       200:
 *         description: Authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthConnectResponse'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             example:
 *               error: Validation Error
 *               message: walletAddress, challenge, and signature are required
 *       401:
 *         description: Authentication failed
 *         content:
 *           application/json:
 *             examples:
 *               invalidSignature:
 *                 value: { error: "Authentication Error", message: "Invalid signature" }
 *               expiredChallenge:
 *                 value: { error: "Authentication Error", message: "Challenge has expired. Please request a new one." }
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RateLimitResponse'
 *             example:
 *               error: Too Many Requests
 *               message: Too many authentication attempts from this IP, please try again after 15 minutes
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             example:
 *               error: Internal Server Error
 *               message: Failed to authenticate wallet
 *     x-codeSamples:
 *       - lang: cURL
 *         source: |
 *           curl -X POST "$API_BASE_URL/api/auth/connect" \\
 *             -H "Content-Type: application/json" \\
 *             -d '{"walletAddress":"GB3JDWCQWJ5VQJ3H6E6GQGZVFKU4ZQXGJ6S4Q2W7S6ZJ5R2YQH2B7ZQX","challenge":"random-challenge-string","signature":"base64-or-hex-signature"}'
 */
router.post(
  "/connect",
  connectRateLimiter,
  validate(connectSchema),
  async (req: Request, res: Response) => {
    try {
      const { walletAddress, challenge, signature }: ConnectRequestBody =
        req.body;

      // Use atomic update to consume challenge (prevent race conditions)
      const now = new Date();
      const updateResult = await prisma.authChallenge.updateMany({
        where: {
          challenge,
          walletAddress,
          isUsed: false,
          expiresAt: {
            gt: now,
          },
        },
        data: {
          isUsed: true,
          usedAt: now,
        },
      });

      // If no rows were updated, the challenge is invalid, expired, or already used
      if (updateResult.count === 0) {
        // Find challenge to provide specific error message (original behavior)
        const existingChallenge = await prisma.authChallenge.findUnique({
          where: { challenge },
        });

        if (!existingChallenge || existingChallenge.walletAddress !== walletAddress) {
          return res.status(401).json({
            error: "Authentication Error",
            message: "Invalid or expired challenge",
          });
        }

        if (existingChallenge.isUsed) {
          return res.status(401).json({
            error: "Authentication Error",
            message: "Challenge has already been used",
          });
        }

        if (isChallengeExpired(existingChallenge.expiresAt)) {
          return res.status(401).json({
            error: "Authentication Error",
            message: "Challenge has expired. Please request a new one.",
          });
        }

        return res.status(401).json({
          error: "Authentication Error",
          message: "Invalid or expired challenge",
        });
      }

      // Re-fetch the challenge record to get its ID for later steps
      const authChallenge = await prisma.authChallenge.findUnique({
        where: { challenge },
      });

      if (!authChallenge) {
        return res.status(401).json({
          error: "Authentication Error",
          message: "Invalid or expired challenge",
        });
      }

      // Verify the signature using Stellar SDK
      const isValidSignature = await verifySignature(
        walletAddress,
        challenge,
        signature,
      );

      if (!isValidSignature) {
        return res.status(401).json({
          error: "Authentication Error",
          message: "Invalid signature",
        });
      }

      let user = await prisma.user.findUnique({
        where: { walletAddress },
      });

      let bonusAmount = 0;
      let newStreak = 0;
      let streakBonusApplied = false;

      if (!user) {
        // Create new user (First login ever)
        // Initial bonus of 100 for joining
        bonusAmount = 100;
        newStreak = 1;
        streakBonusApplied = true;

        user = await prisma.user.create({
          data: {
            walletAddress,
            publicKey: walletAddress,
            lastLoginAt: now,
            virtualBalance: 1000 + bonusAmount, // Start with 1000 + bonus
            streak: newStreak,
          },
        });

        // Create transaction for signup bonus
        await prisma.transaction.create({
          data: {
            userId: user.id,
            amount: bonusAmount,
            type: "BONUS", // Using string literal if Enum not available yet, or TransactionType.BONUS
            description: "Welcome Bonus",
          },
        });
      } else {
        // Check for daily login bonus
        const lastLogin = user.lastLoginAt || new Date(0);

        // Reset times to midnight for day comparison
        const lastLoginDate = new Date(lastLogin);
        lastLoginDate.setHours(0, 0, 0, 0);

        const todayDate = new Date(now);
        todayDate.setHours(0, 0, 0, 0);

        const diffTime = Math.abs(
          todayDate.getTime() - lastLoginDate.getTime(),
        );
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays >= 1) {
          // It's a new day
          if (diffDays === 1) {
            // Consecutive day
            newStreak = user.streak + 1;
          } else {
            // Missed a day (or more), reset streak
            newStreak = 1;
          }

          // Calculate bonus
          // Base bonus: 100 XLM
          // Multiplier: 1.5x after 3 days, 2x after 7 days
          let multiplier = 1;
          if (newStreak >= 7) multiplier = 2;
          else if (newStreak >= 3) multiplier = 1.5;

          bonusAmount = 100 * multiplier;
          streakBonusApplied = true;

          // Create transaction
          await prisma.transaction.create({
            data: {
              userId: user.id,
              amount: bonusAmount,
              type: "BONUS",
              description: `Daily Login Bonus (Day ${newStreak})`,
            },
          });
        } else {
          // Same day login, keep existing streak
          newStreak = user.streak;
        }

        // Update user
        user = await prisma.user.update({
          where: { walletAddress },
          data: {
            lastLoginAt: now,
            streak: newStreak,
            virtualBalance: streakBonusApplied
              ? { increment: bonusAmount }
              : undefined,
          },
        });
      }

      // Link challenge to user
      await prisma.authChallenge.update({
        where: { id: authChallenge.id },
        data: {
          userId: user.id,
        },
      });

      // Generate JWT token
      const token = generateToken(user.id, user.walletAddress);

      // Clean up old used challenges for this user (housekeeping)
      await prisma.authChallenge.deleteMany({
        where: {
          walletAddress,
          isUsed: true,
          usedAt: {
            lt: new Date(Date.now() - 24 * 60 * 60 * 1000), // Older than 24 hours
          },
        },
      });

      const response: ConnectResponse & { bonus?: number; streak?: number } = {
        token,
        user: {
          id: user.id,
          walletAddress: user.walletAddress,
          createdAt: user.createdAt.toISOString(),
          lastLoginAt: user.lastLoginAt?.toISOString() || now.toISOString(),
        },
        bonus: streakBonusApplied ? bonusAmount : 0,
        streak: newStreak,
      };

      return res.status(200).json(response);
    } catch (error) {
      logger.error("Error authenticating wallet:", { error });
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to authenticate wallet",
      });
    }
  },
);

export default router;

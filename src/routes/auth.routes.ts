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

const router = Router();

/**
 * POST /api/auth/challenge
 * Step 1: Request a challenge for wallet authentication
 *
 * Security Features:
 * - Rate limited: 10 requests per 15 minutes per IP
 * - Generates cryptographically secure random challenge
 * - Challenge expires after 5 minutes
 * - Validates wallet address format
 */
router.post(
  "/challenge",
  challengeRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const { walletAddress }: ChallengeRequestBody = req.body;

      // Validate required fields
      if (!walletAddress) {
        return res.status(400).json({
          error: "Validation Error",
          message: "walletAddress is required",
        });
      }

      // Validate Stellar address format
      if (!isValidStellarAddress(walletAddress)) {
        return res.status(400).json({
          error: "Validation Error",
          message: "Invalid Stellar wallet address format",
        });
      }

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
      console.error("Error generating challenge:", error);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to generate authentication challenge",
      });
    }
  },
);

/**
 * POST /api/auth/connect
 * Step 2: Verify signature and authenticate wallet
 *
 * Security Features:
 * - Rate limited: 5 requests per 15 minutes per IP
 * - Verifies Stellar signature using Ed25519
 * - Implements replay protection (one-time use challenges)
 * - Validates challenge expiration
 * - Creates/updates user record
 * - Returns signed JWT with expiry
 */
router.post(
  "/connect",
  connectRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const { walletAddress, challenge, signature }: ConnectRequestBody =
        req.body;

      // Validate required fields
      if (!walletAddress || !challenge || !signature) {
        return res.status(400).json({
          error: "Validation Error",
          message: "walletAddress, challenge, and signature are required",
        });
      }

      // Validate Stellar address format
      if (!isValidStellarAddress(walletAddress)) {
        return res.status(400).json({
          error: "Validation Error",
          message: "Invalid Stellar wallet address format",
        });
      }

      // Find the challenge in database
      const authChallenge = await prisma.authChallenge.findUnique({
        where: {
          challenge,
        },
      });

      // Validate challenge exists
      if (!authChallenge) {
        return res.status(401).json({
          error: "Authentication Error",
          message: "Invalid or expired challenge",
        });
      }

      // Validate challenge belongs to this wallet
      if (authChallenge.walletAddress !== walletAddress) {
        return res.status(401).json({
          error: "Authentication Error",
          message: "Challenge does not match wallet address",
        });
      }

      // Check if challenge has expired
      if (isChallengeExpired(authChallenge.expiresAt)) {
        // Delete expired challenge
        await prisma.authChallenge.delete({
          where: { id: authChallenge.id },
        });

        return res.status(401).json({
          error: "Authentication Error",
          message: "Challenge has expired. Please request a new one.",
        });
      }

      // Replay protection: Check if challenge has been used
      if (authChallenge.isUsed) {
        return res.status(401).json({
          error: "Authentication Error",
          message: "Challenge has already been used",
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

      // Mark challenge as used (replay protection)
      await prisma.authChallenge.update({
        where: { id: authChallenge.id },
        data: {
          isUsed: true,
          usedAt: new Date(),
        },
      });

      // Create or update user record
      let user = await prisma.user.findUnique({
        where: { walletAddress },
      });

      const now = new Date();
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
      console.error("Error authenticating wallet:", error);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to authenticate wallet",
      });
    }
  },
);

export default router;

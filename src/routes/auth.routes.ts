import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { generateChallenge, getChallengeExpiry, isChallengeExpired } from '../utils/challenge.util';
import { generateToken } from '../utils/jwt.util';
import { verifySignature, isValidStellarAddress } from '../services/stellar.service';
import {
  ChallengeRequestBody,
  ChallengeResponse,
  ConnectRequestBody,
  ConnectResponse,
} from '../types/auth.types';
import { challengeRateLimiter, connectRateLimiter } from '../middleware/rateLimiter.middleware';

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
router.post('/challenge', challengeRateLimiter, async (req: Request, res: Response) => {
  try {
    const { walletAddress }: ChallengeRequestBody = req.body;

    // Validate required fields
    if (!walletAddress) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'walletAddress is required',
      });
    }

    // Validate Stellar address format
    if (!isValidStellarAddress(walletAddress)) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Invalid Stellar wallet address format',
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
    console.error('Error generating challenge:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to generate authentication challenge',
    });
  }
});

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
router.post('/connect', connectRateLimiter, async (req: Request, res: Response) => {
  try {
    const { walletAddress, challenge, signature }: ConnectRequestBody = req.body;

    // Validate required fields
    if (!walletAddress || !challenge || !signature) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'walletAddress, challenge, and signature are required',
      });
    }

    // Validate Stellar address format
    if (!isValidStellarAddress(walletAddress)) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Invalid Stellar wallet address format',
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
        error: 'Authentication Error',
        message: 'Invalid or expired challenge',
      });
    }

    // Validate challenge belongs to this wallet
    if (authChallenge.walletAddress !== walletAddress) {
      return res.status(401).json({
        error: 'Authentication Error',
        message: 'Challenge does not match wallet address',
      });
    }

    // Check if challenge has expired
    if (isChallengeExpired(authChallenge.expiresAt)) {
      // Delete expired challenge
      await prisma.authChallenge.delete({
        where: { id: authChallenge.id },
      });

      return res.status(401).json({
        error: 'Authentication Error',
        message: 'Challenge has expired. Please request a new one.',
      });
    }

    // Replay protection: Check if challenge has been used
    if (authChallenge.isUsed) {
      return res.status(401).json({
        error: 'Authentication Error',
        message: 'Challenge has already been used',
      });
    }

    // Verify the signature using Stellar SDK
    const isValidSignature = await verifySignature(walletAddress, challenge, signature);

    if (!isValidSignature) {
      return res.status(401).json({
        error: 'Authentication Error',
        message: 'Invalid signature',
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

    if (!user) {
      // Create new user
      user = await prisma.user.create({
        data: {
          walletAddress,
          publicKey: walletAddress,
          lastLoginAt: now,
        },
      });
    } else {
      // Update existing user's last login
      user = await prisma.user.update({
        where: { walletAddress },
        data: {
          lastLoginAt: now,
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

    const response: ConnectResponse = {
      token,
      user: {
        id: user.id,
        walletAddress: user.walletAddress,
        createdAt: user.createdAt.toISOString(),
        lastLoginAt: user.lastLoginAt?.toISOString() || now.toISOString(),
      },
    };

    return res.status(200).json(response);
  } catch (error) {
    console.error('Error authenticating wallet:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to authenticate wallet',
    });
  }
});

export default router;

import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import sorobanService from '../services/soroban.service';
import { authenticateToken, AuthRequest } from '../middleware/auth.middleware';
import {
  StartRoundRequestBody,
  StartRoundResponse,
  SubmitPredictionRequestBody,
  SubmitPredictionResponse,
  ResolveRoundRequestBody,
  ResolveRoundResponse,
  ActiveRoundResponse,
  GameMode,
  RoundStatus,
  BetSide,
} from '../types/round.types';
import logger from '../utils/logger';

const router = Router();

function priceToStroops(price: string): bigint {
  const priceNum = parseFloat(price);
  if (isNaN(priceNum) || priceNum <= 0) {
    throw new Error('Invalid price: must be a positive number');
  }
  return BigInt(Math.floor(priceNum * 10_000_000));
}

router.post('/start', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { startPrice, durationLedgers, mode }: StartRoundRequestBody = req.body;

    if (!startPrice || !durationLedgers || mode === undefined) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'startPrice, durationLedgers, and mode are required',
      });
    }

    if (durationLedgers <= 0 || durationLedgers > 10000) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'durationLedgers must be between 1 and 10000',
      });
    }

    if (mode === GameMode.LEGENDS) {
      return res.status(501).json({
        error: 'Not Implemented',
        message: 'Legends mode (mode=1) is not yet supported. The Soroban contract currently only supports Up/Down betting. See: https://github.com/TevaLabs/Xelma-Blockchain',
        supportedModes: [{ mode: 0, name: 'Up/Down', status: 'active' }],
      });
    }

    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    const priceInStroops = priceToStroops(startPrice);
    const txHash = await sorobanService.createRound(priceInStroops, durationLedgers, mode);

    const currentLedger = await sorobanService.rpc.getLatestLedger();
    const endLedger = currentLedger.sequence + durationLedgers;

    const round = await prisma.round.create({
      data: {
        mode,
        startPrice: priceInStroops,
        durationLedgers,
        endLedger,
        status: RoundStatus.ACTIVE,
        createdById: req.user.userId,
      },
    });

    const response: StartRoundResponse = {
      roundId: round.id,
      startPrice: priceInStroops,
      endLedger,
      mode,
      createdAt: round.createdAt.toISOString(),
    };

    logger.info(`Round started: ${round.id}, txHash: ${txHash}`);

    return res.status(201).json(response);
  } catch (error: any) {
    logger.error('Error starting round:', error);

    if (error.message?.includes('LEGENDS_NOT_IMPLEMENTED')) {
      return res.status(501).json({
        error: 'Not Implemented',
        message: error.message,
      });
    }

    if (error.message?.includes('ADMIN_SECRET_KEY')) {
      return res.status(500).json({
        error: 'Configuration Error',
        message: 'Admin key not configured. Please contact administrator.',
      });
    }

    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to start round',
    });
  }
});

router.post('/predict', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { roundId, side, amount, mode }: SubmitPredictionRequestBody = req.body;

    if (!roundId || !side || !amount || mode === undefined) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'roundId, side, amount, and mode are required',
      });
    }

    if (!Object.values(BetSide).includes(side)) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'side must be either "up" or "down"',
      });
    }

    if (amount <= 0 || amount > 1000) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'amount must be between 1 and 1000 vXLM',
      });
    }

    if (mode === GameMode.LEGENDS) {
      return res.status(501).json({
        error: 'Not Implemented',
        message: 'Legends mode (mode=1) is not yet supported. The Soroban contract currently only supports Up/Down betting. See: https://github.com/TevaLabs/Xelma-Blockchain',
        supportedModes: [{ mode: 0, name: 'Up/Down', status: 'active' }],
      });
    }

    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    const round = await prisma.round.findUnique({
      where: { id: roundId },
    });

    if (!round) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Round not found',
      });
    }

    if (round.status !== RoundStatus.ACTIVE) {
      return res.status(400).json({
        error: 'Invalid Round',
        message: 'Round is not active for betting',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });

    if (!user || !user.publicKey) {
      return res.status(400).json({
        error: 'User Error',
        message: 'User does not have a Stellar public key configured',
      });
    }

    if (!req.headers['x-signature']) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'x-signature header is required for contract interaction',
      });
    }

    const userSecretKey = req.headers['x-signature'] as string;
    const amountInStroops = BigInt(amount) * 10_000_000n;

    const txHash = await sorobanService.placeBet(
      user.walletAddress,
      userSecretKey,
      amountInStroops,
      side,
      mode
    );

    const prediction = await prisma.prediction.create({
      data: {
        roundId,
        userId: req.user.userId,
        side,
        amount: amountInStroops,
        txHash,
      },
    });

    const response: SubmitPredictionResponse = {
      predictionId: prediction.id,
      roundId,
      side,
      amount,
      txHash,
    };

    logger.info(`Prediction submitted: ${prediction.id}, round: ${roundId}, user: ${user.walletAddress}, txHash: ${txHash}`);

    return res.status(201).json(response);
  } catch (error: any) {
    logger.error('Error submitting prediction:', error);

    if (error.message?.includes('LEGENDS_NOT_IMPLEMENTED')) {
      return res.status(501).json({
        error: 'Not Implemented',
        message: error.message,
      });
    }

    if (error.message?.includes('AlreadyBet')) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'You have already placed a bet in this round',
      });
    }

    if (error.message?.includes('InsufficientBalance')) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Insufficient balance to place this bet',
      });
    }

    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to submit prediction',
    });
  }
});

router.post('/resolve', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { roundId, finalPrice, mode }: ResolveRoundRequestBody = req.body;

    if (!roundId || !finalPrice || mode === undefined) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'roundId, finalPrice, and mode are required',
      });
    }

    if (mode === GameMode.LEGENDS) {
      return res.status(501).json({
        error: 'Not Implemented',
        message: 'Legends mode (mode=1) is not yet supported. The Soroban contract currently only supports Up/Down betting. See: https://github.com/TevaLabs/Xelma-Blockchain',
        supportedModes: [{ mode: 0, name: 'Up/Down', status: 'active' }],
      });
    }

    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    const round = await prisma.round.findUnique({
      where: { id: roundId },
    });

    if (!round) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Round not found',
      });
    }

    if (round.status !== RoundStatus.ACTIVE) {
      return res.status(400).json({
        error: 'Invalid Round',
        message: 'Round is not active for resolution',
      });
    }

    const priceInStroops = priceToStroops(finalPrice);
    const txHash = await sorobanService.resolveRound(priceInStroops, mode);

    const updatedRound = await prisma.round.update({
      where: { id: roundId },
      data: {
        finalPrice: priceInStroops,
        status: RoundStatus.RESOLVED,
        resolvedAt: new Date(),
      },
    });

    let outcome: BetSide | null = null;

    if (priceInStroops > round.startPrice) {
      outcome = BetSide.UP;
    } else if (priceInStroops < round.startPrice) {
      outcome = BetSide.DOWN;
    }

    const predictions = await prisma.prediction.findMany({
      where: { roundId },
    });

    const winnersCount = outcome
      ? predictions.filter((p) => p.side === outcome).length
      : 0;
    const losersCount = outcome
      ? predictions.filter((p) => p.side !== outcome).length
      : 0;

    const response: ResolveRoundResponse = {
      roundId,
      outcome,
      winnersCount,
      losersCount,
      txHash,
    };

    logger.info(`Round resolved: ${roundId}, outcome: ${outcome}, txHash: ${txHash}`);

    return res.status(200).json(response);
  } catch (error: any) {
    logger.error('Error resolving round:', error);

    if (error.message?.includes('LEGENDS_NOT_IMPLEMENTED')) {
      return res.status(501).json({
        error: 'Not Implemented',
        message: error.message,
      });
    }

    if (error.message?.includes('ORACLE_SECRET_KEY')) {
      return res.status(500).json({
        error: 'Configuration Error',
        message: 'Oracle key not configured. Please contact administrator.',
      });
    }

    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to resolve round',
    });
  }
});

router.get('/active', async (_req: AuthRequest, res: Response) => {
  try {
    const activeRound = await prisma.round.findFirst({
      where: { status: RoundStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
    });

    if (!activeRound) {
      return res.status(200).json({
        roundId: null,
        startPrice: 0n,
        poolUp: 0n,
        poolDown: 0n,
        endLedger: 0,
        mode: GameMode.UP_DOWN,
      });
    }

    const predictions = await prisma.prediction.findMany({
      where: { roundId: activeRound.id },
    });

    const poolUp = predictions
      .filter((p) => p.side === BetSide.UP)
      .reduce((sum, p) => sum + p.amount, 0n);

    const poolDown = predictions
      .filter((p) => p.side === BetSide.DOWN)
      .reduce((sum, p) => sum + p.amount, 0n);

    const response: ActiveRoundResponse = {
      roundId: activeRound.id,
      startPrice: activeRound.startPrice,
      poolUp,
      poolDown,
      endLedger: activeRound.endLedger,
      mode: activeRound.mode,
    };

    return res.status(200).json(response);
  } catch (error: any) {
    logger.error('Error fetching active round:', error);

    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch active round',
    });
  }
});

export default router;

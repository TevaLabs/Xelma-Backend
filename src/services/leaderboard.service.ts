import { prisma } from '../lib/prisma';
import { LeaderboardEntry, LeaderboardResponse, ModeStats } from '../types/leaderboard.types';

 
// Get leaderboard with pagination

export async function getLeaderboard(
  limit: number = 100,
  offset: number = 0,
  userId?: string
): Promise<LeaderboardResponse> {
  
  // Fetch user stats ordered by earnings
  const userStats = await prisma.userStats.findMany({
    take: limit,
    skip: offset,
    orderBy: { totalEarnings: 'desc' },
    include: {
      user: {
        select: {
          id: true,
          walletAddress: true
        }
      }
    }
  });

  // Format leaderboard entries
  const leaderboard: LeaderboardEntry[] = userStats.map((stat, index) => ({
    rank: offset + index + 1,
    userId: stat.user.id,
    walletAddress: maskWalletAddress(stat.user.walletAddress),
    totalEarnings: parseFloat(stat.totalEarnings.toString()),
    totalPredictions: stat.totalPredictions,
    accuracy: calculateAccuracy(stat.correctPredictions, stat.totalPredictions),
    modeStats: {
      upDown: {
        wins: stat.upDownWins,
        losses: stat.upDownLosses,
        earnings: parseFloat(stat.upDownEarnings.toString()),
        accuracy: calculateAccuracy(stat.upDownWins, stat.upDownWins + stat.upDownLosses)
      },
      legends: {
        wins: stat.legendsWins,
        losses: stat.legendsLosses,
        earnings: parseFloat(stat.legendsEarnings.toString()),
        accuracy: calculateAccuracy(stat.legendsWins, stat.legendsWins + stat.legendsLosses)
      }
    }
  }));

  // Get user position if authenticated
  let userPosition: LeaderboardEntry | undefined;
  if (userId) {
    userPosition = await getUserPosition(userId);
  }

  // Get total users count
  const totalUsers = await prisma.userStats.count();

  return {
    leaderboard,
    userPosition,
    totalUsers,
    lastUpdated: new Date().toISOString()
  };
}

// Get specific user's position and stats

export async function getUserPosition(userId: string): Promise<LeaderboardEntry | undefined> {
  const userStats = await prisma.userStats.findUnique({
    where: { userId },
    include: {
      user: {
        select: {
          id: true,
          walletAddress: true
        }
      }
    }
  });

  if (!userStats) return undefined;

  // Calculate rank by counting users with higher earnings
  const rank = await prisma.userStats.count({
    where: {
      totalEarnings: {
        gt: userStats.totalEarnings
      }
    }
  }) + 1;

  return {
    rank,
    userId: userStats.user.id,
    walletAddress: maskWalletAddress(userStats.user.walletAddress),
    totalEarnings: parseFloat(userStats.totalEarnings.toString()),
    totalPredictions: userStats.totalPredictions,
    accuracy: calculateAccuracy(userStats.correctPredictions, userStats.totalPredictions),
    modeStats: {
      upDown: {
        wins: userStats.upDownWins,
        losses: userStats.upDownLosses,
        earnings: parseFloat(userStats.upDownEarnings.toString()),
        accuracy: calculateAccuracy(userStats.upDownWins, userStats.upDownWins + userStats.upDownLosses)
      },
      legends: {
        wins: userStats.legendsWins,
        losses: userStats.legendsLosses,
        earnings: parseFloat(userStats.legendsEarnings.toString()),
        accuracy: calculateAccuracy(userStats.legendsWins, userStats.legendsWins + userStats.legendsLosses)
      }
    }
  };
}

// Update user stats after a round closes
// Call this when you resolve predictions for a round
export async function updateUserStatsForRound(roundId: string): Promise<void> {
  // Get the round with predictions
  const round = await prisma.round.findUnique({
    where: { id: roundId },
    include: {
      predictions: {
        include: {
          user: true
        }
      }
    }
  });

  if (!round || !round.endPrice) {
    throw new Error('Round not found or not closed');
  }

  // Process each prediction
  for (const prediction of round.predictions) {
    const isCorrect = calculatePredictionResult(prediction, round);
    const earnings = isCorrect ? parseFloat(prediction.amount.toString()) : -parseFloat(prediction.amount.toString());

    // Update or create user stats
    await prisma.userStats.upsert({
      where: { userId: prediction.userId },
      create: {
        userId: prediction.userId,
        totalPredictions: 1,
        correctPredictions: isCorrect ? 1 : 0,
        totalEarnings: earnings,
        upDownWins: prediction.mode === 0 && isCorrect ? 1 : 0,
        upDownLosses: prediction.mode === 0 && !isCorrect ? 1 : 0,
        upDownEarnings: prediction.mode === 0 ? earnings : 0,
        legendsWins: prediction.mode === 1 && isCorrect ? 1 : 0,
        legendsLosses: prediction.mode === 1 && !isCorrect ? 1 : 0,
        legendsEarnings: prediction.mode === 1 ? earnings : 0,
      },
      update: {
        totalPredictions: { increment: 1 },
        correctPredictions: { increment: isCorrect ? 1 : 0 },
        totalEarnings: { increment: earnings },
        upDownWins: { increment: prediction.mode === 0 && isCorrect ? 1 : 0 },
        upDownLosses: { increment: prediction.mode === 0 && !isCorrect ? 1 : 0 },
        upDownEarnings: { increment: prediction.mode === 0 ? earnings : 0 },
        legendsWins: { increment: prediction.mode === 1 && isCorrect ? 1 : 0 },
        legendsLosses: { increment: prediction.mode === 1 && !isCorrect ? 1 : 0 },
        legendsEarnings: { increment: prediction.mode === 1 ? earnings : 0 },
      }
    });
  }
}

// Calculate if a prediction was correct

function calculatePredictionResult(prediction: any, round: any): boolean {
  if (!round.startPrice || !round.endPrice) return false;

  if (prediction.mode === 0) {
    // Up/Down mode
    const priceWentUp = round.endPrice > round.startPrice;
    return (prediction.choice === 'up' && priceWentUp) || 
           (prediction.choice === 'down' && !priceWentUp);
  } else {
    // Legends mode (exact price)
    if (!prediction.guessPrice) return false;
    // Consider correct if within 0.01% of actual price
    const tolerance = parseFloat(round.endPrice.toString()) * 0.0001;
    const diff = Math.abs(parseFloat(prediction.guessPrice.toString()) - parseFloat(round.endPrice.toString()));
    return diff <= tolerance;
  }
}

// Helper functions
function maskWalletAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function calculateAccuracy(correct: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((correct / total) * 100 * 100) / 100; // Round to 2 decimals
}

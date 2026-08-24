import { db } from '../db/db';
import { hackathonUsers, hackathonRounds, hackathonBets } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { decAdd, decSub, toNumber } from '../utils/decimal.util';
import { prisma } from '../lib/prisma';
import { Decimal } from '@prisma/client/runtime/library';
import { BusinessRuleError, ErrorCode } from '../utils/errors';
import logger from '../utils/logger';

export interface PlaceBetInput {
  userId: string;
  roundId: string;
  amount: number;
  side: 'UP' | 'DOWN';
}

export interface BetResult {
  userId: string;
  roundId: string;
  amount: Decimal;
  side: 'UP' | 'DOWN';
  newBalance: Decimal;
  poolUp: Decimal;
  poolDown: Decimal;
}

export class HackathonService {
  async getRounds() {
    const rounds = await prisma.mockRound.findMany();
    return rounds.map(r => {
      if (r.mode === 'updown') {
        return {
          id: r.id,
          asset: r.asset,
          mode: r.mode,
          status: r.status,
          startPrice: r.startPrice,
          poolUp: r.poolUp,
          poolDown: r.poolDown,
          closesAt: r.closesAt,
        };
      } else {
        return {
          id: r.id,
          asset: r.asset,
          mode: r.mode,
          status: r.status,
          startPrice: r.startPrice,
          totalPool: r.totalPool,
          predictionCount: r.predictionCount,
          closesAt: r.closesAt,
        };
      }
    });
  }

  async getLeaderboard() {
    const users = await prisma.mockLeaderboard.findMany({ orderBy: { xp: 'desc' } });
    return users.slice(0, 10).map((u, index) => ({
      rank: index + 1,
      address: u.address,
      totalWins: u.totalWins,
      totalLosses: u.totalLosses,
      winStreak: u.winStreak,
      xp: u.xp,
      rankTitle: u.rankTitle,
    }));
  }

  async getUserStats(address: string) {
    const existing = await prisma.mockLeaderboard.findUnique({ where: { address } });
    if (existing) {
      return {
        address: existing.address,
        balance: existing.balance,
        pendingWinnings: existing.pendingWinnings,
        totalWins: existing.totalWins,
        totalLosses: existing.totalLosses,
        currentStreak: existing.winStreak,
        xp: existing.xp,
        rankTitle: existing.rankTitle,
      };
    }
    // Default mock stats
    const defaultUser = {
      address,
      balance: 1000,
      pendingWinnings: 0,
      totalWins: 3,
      totalLosses: 1,
      currentStreak: 3,
      xp: 410,
      rankTitle: 'Rookie',
    };
    await prisma.mockLeaderboard.create({
      data: {
        address: defaultUser.address,
        rank: 0,
        balance: defaultUser.balance,
        pendingWinnings: defaultUser.pendingWinnings,
        totalWins: defaultUser.totalWins,
        totalLosses: defaultUser.totalLosses,
        winStreak: defaultUser.currentStreak,
        xp: defaultUser.xp,
        rankTitle: defaultUser.rankTitle,
      },
    });
    return defaultUser;
  }

  async placeBet(roundId: string, address: string, amount: number, side?: 'UP' | 'DOWN', predictedPrice?: number) {
    // 1. Ensure user exists
    const existing = await prisma.mockLeaderboard.findUnique({ where: { address } });
    if (!existing) {
      await prisma.mockLeaderboard.create({
        data: {
          address,
          rank: 0,
          balance: 1000,
          pendingWinnings: 0,
          totalWins: 3,
          totalLosses: 1,
          winStreak: 3,
          xp: 410,
          rankTitle: 'Rookie',
        },
      });
    }

    // 2. Insert bet
    await prisma.mockBet.create({
      data: {
        roundId,
        address,
        amount,
        side,
        predictedPrice,
      },
    });

    // 3. Update user balance
    const user = await prisma.mockLeaderboard.findUnique({ where: { address } });
    if (user) {
      const newBalance = Math.max(0, user.balance - amount);
      await prisma.mockLeaderboard.update({
        where: { address },
        data: { balance: newBalance },
      });
    }

    // 4. Update round pool
    const round = await prisma.mockRound.findUnique({ where: { id: roundId } });
    if (round) {
      if (round.mode === 'updown' && side) {
        if (side === 'UP') {
          await prisma.mockRound.update({
            where: { id: roundId },
            data: { poolUp: (round.poolUp ?? 0) + amount },
          });
        } else {
          await prisma.mockRound.update({
            where: { id: roundId },
            data: { poolDown: (round.poolDown ?? 0) + amount },
          });
        }
      } else if (round.mode === 'precision') {
        await prisma.mockRound.update({
          where: { id: roundId },
          data: {
            totalPool: (round.totalPool ?? 0) + amount,
            predictionCount: (round.predictionCount ?? 0) + 1,
          },
        });
      }
    }
  }
}

export default new HackathonService();
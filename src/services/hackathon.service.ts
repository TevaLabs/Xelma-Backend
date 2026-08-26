import { prisma } from '../lib/prisma';

export class HackathonService {
  async getRounds() {
    const rounds = await prisma.hackathonRound.findMany();
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
    const users = await prisma.hackathonUser.findMany({
      orderBy: { xp: 'desc' },
    });
    return users.slice(0, 10).map((u, index) => ({
      rank: index + 1,
      address: u.address,
      totalWins: u.totalWins,
      totalLosses: u.totalLosses,
      winStreak: u.currentStreak,
      xp: u.xp,
      rankTitle: u.rankTitle,
    }));
  }

  async getUserStats(address: string) {
    const user = await prisma.hackathonUser.findUnique({
      where: { address },
    });
    if (user) {
      return {
        address: user.address,
        balance: user.balance,
        pendingWinnings: user.pendingWinnings,
        totalWins: user.totalWins,
        totalLosses: user.totalLosses,
        currentStreak: user.currentStreak,
        xp: user.xp,
        rankTitle: user.rankTitle,
      };
    }
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
    await prisma.hackathonUser.create({ data: defaultUser });
    return defaultUser;
  }

  async placeBet(roundId: string, address: string, amount: number, side?: 'UP' | 'DOWN', predictedPrice?: number) {
    await this.getUserStats(address);

    await prisma.hackathonBet.create({
      data: {
        roundId,
        address,
        amount,
        side: side ?? null,
        predictedPrice: predictedPrice ?? null,
      },
    });

    const user = await prisma.hackathonUser.findUnique({
      where: { address },
    });
    if (user) {
      const newBalance = Math.max(0, user.balance - amount);
      await prisma.hackathonUser.update({
        where: { address },
        data: { balance: newBalance },
      });
    }

    const round = await prisma.hackathonRound.findUnique({
      where: { id: roundId },
    });
    if (round) {
      if (round.mode === 'updown' && side) {
        if (side === 'UP') {
          await prisma.hackathonRound.update({
            where: { id: roundId },
            data: { poolUp: round.poolUp + amount },
          });
        } else {
          await prisma.hackathonRound.update({
            where: { id: roundId },
            data: { poolDown: round.poolDown + amount },
          });
        }
      } else if (round.mode === 'precision') {
        await prisma.hackathonRound.update({
          where: { id: roundId },
          data: {
            totalPool: round.totalPool + amount,
            predictionCount: round.predictionCount + 1,
          },
        });
      }
    }
  }
}

export default new HackathonService();

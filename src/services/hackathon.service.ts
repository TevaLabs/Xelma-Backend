import { prisma } from '../lib/prisma';

export class HackathonService {
  /**
   * Place a bet on a hackathon `MockRound`.
   *
   * This is the single public `placeBet` contract. `PrismaRoundRepository`
   * (used by the `/api/rounds/hackathon/*` routes) and every test call it with
   * this positional signature.
   *
   * The whole bet runs inside one `prisma.$transaction`, so a failing step
   * rolls back the rest:
   *   1. lazily create the bettor's `MockLeaderboard` row when missing,
   *   2. insert the `MockBet`,
   *   3. debit the balance with an atomic `{ decrement }`,
   *   4. credit the round pool (`poolUp`/`poolDown` for up-down rounds,
   *      `totalPool` + `predictionCount` for precision rounds).
   *
   * @param roundId        `MockRound` id (e.g. `btc-updown-live`)
   * @param address        Stellar address of the bettor
   * @param amount         Amount to bet
   * @param side           `UP`/`DOWN` for up-down rounds; omitted for precision rounds
   * @param predictedPrice Predicted price for precision rounds
   */
  async placeBet(
    roundId: string,
    address: string,
    amount: number,
    side?: 'UP' | 'DOWN',
    predictedPrice?: number,
  ): Promise<void> {
    await this.placeMockBet(roundId, address, amount, side, predictedPrice);
  }

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
      }
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
    });
  }

  async getLeaderboard() {
    const users = await (prisma as any).mockLeaderboard.findMany({ orderBy: { xp: 'desc' } });
    return users.slice(0, 10).map((u: any, index: number) => ({
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
    const mockPrisma = prisma as any;
    const existing = await mockPrisma.mockLeaderboard.findUnique({ where: { address } });
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
    await mockPrisma.mockLeaderboard.create({
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

  private async placeMockBet(
    roundId: string,
    address: string,
    amount: number,
    side?: 'UP' | 'DOWN',
    predictedPrice?: number,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.mockLeaderboard.findUnique({ where: { address } });
      if (!existing) {
        await tx.mockLeaderboard.create({
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

      await tx.mockBet.create({
        data: {
          roundId,
          address,
          amount,
          side,
          predictedPrice,
        },
      });

      await tx.mockLeaderboard.update({
        where: { address },
        data: { balance: { decrement: amount } },
      });

      const round = await tx.mockRound.findUnique({ where: { id: roundId } });
      if (round) {
        if (round.mode === 'updown' && side) {
          await tx.mockRound.update({
            where: { id: roundId },
            data:
              side === 'UP'
                ? { poolUp: { increment: amount } }
                : { poolDown: { increment: amount } },
          });
        } else if (round.mode === 'precision') {
          await tx.mockRound.update({
            where: { id: roundId },
            data: {
              totalPool: { increment: amount },
              predictionCount: { increment: 1 },
            },
          });
        }
      }
    });
  }
}

export default new HackathonService();

import { db } from '../db/db';
import { hackathonUsers, hackathonRounds, hackathonBets } from '../db/schema';
import { eq, desc } from 'drizzle-orm';

export class HackathonService {
  async getRounds() {
    const rounds = await db.select().from(hackathonRounds);
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
    const users = await db.select().from(hackathonUsers).orderBy(desc(hackathonUsers.xp));
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
    const result = await db.select().from(hackathonUsers).where(eq(hackathonUsers.address, address));
    if (result.length > 0) {
      const u = result[0];
      return {
        address: u.address,
        balance: u.balance,
        pendingWinnings: u.pendingWinnings,
        totalWins: u.totalWins,
        totalLosses: u.totalLosses,
        currentStreak: u.currentStreak,
        xp: u.xp,
        rankTitle: u.rankTitle,
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
    await db.insert(hackathonUsers).values(defaultUser);
    return defaultUser;
  }

  async placeBet(roundId: string, address: string, amount: number, side?: 'UP' | 'DOWN', predictedPrice?: number) {
    // 1. Ensure user exists
    await this.getUserStats(address);

    // 2. Insert bet
    await db.insert(hackathonBets).values({
      roundId,
      address,
      amount,
      side,
      predictedPrice,
    });

    // 3. Update user balance
    const users = await db.select().from(hackathonUsers).where(eq(hackathonUsers.address, address));
    if (users.length > 0) {
      const newBalance = Math.max(0, users[0].balance - amount);
      await db.update(hackathonUsers).set({ balance: newBalance }).where(eq(hackathonUsers.address, address));
    }

    // 4. Update round pool
    const rounds = await db.select().from(hackathonRounds).where(eq(hackathonRounds.id, roundId));
    if (rounds.length > 0) {
      const round = rounds[0];
      if (round.mode === 'updown' && side) {
        if (side === 'UP') {
          await db.update(hackathonRounds)
            .set({ poolUp: round.poolUp + amount })
            .where(eq(hackathonRounds.id, roundId));
        } else {
          await db.update(hackathonRounds)
            .set({ poolDown: round.poolDown + amount })
            .where(eq(hackathonRounds.id, roundId));
        }
      } else if (round.mode === 'precision') {
        await db.update(hackathonRounds)
          .set({
            totalPool: round.totalPool + amount,
            predictionCount: round.predictionCount + 1,
          })
          .where(eq(hackathonRounds.id, roundId));
      }
    }
  }
}

export default new HackathonService();

import { createInMemoryRepositories } from "../repositories/in-memory.repositories";
import {
  LeaderboardRepository,
  Repositories,
  RoundRepository,
  StatsRepository,
} from "../repositories/interfaces";
import { createRepositories } from "../repositories";

const sharedRepositoryContract = (
  name: string,
  factory: () => Repositories,
) => {
  describe(`${name} repository contract`, () => {
    let repositories: Repositories;

    beforeEach(() => {
      repositories = factory();
    });

    it("exposes round, leaderboard, and stats repositories", () => {
      expect(repositories.rounds).toHaveProperty("listActiveRounds");
      expect(repositories.rounds).toHaveProperty("placeBet");
      expect(repositories.leaderboard).toHaveProperty("listLeaderboard");
      expect(repositories.stats).toHaveProperty("getPlatformStats");
      expect(repositories.stats).toHaveProperty("invalidateStatsCache");
    });
  });
};

class ContractRoundRepository implements RoundRepository {
  async listActiveRounds() {
    return { source: "none", rounds: [] };
  }

  async placeBet(): Promise<void> {}
}

class ContractLeaderboardRepository implements LeaderboardRepository {
  async listLeaderboard() {
    return [];
  }
}

class ContractStatsRepository implements StatsRepository {
  async getPlatformStats() {
    return {
      totalRounds: 0,
      totalUsers: 0,
      totalBets: 0,
      isFallback: true,
      cachedAt: new Date().toISOString(),
    };
  }

  invalidateStatsCache(): void {}
}

const createContractPrismaRepositories = (): Repositories => ({
  rounds: new ContractRoundRepository(),
  leaderboard: new ContractLeaderboardRepository(),
  stats: new ContractStatsRepository(),
});

sharedRepositoryContract("in-memory", createInMemoryRepositories);
sharedRepositoryContract("prisma", createContractPrismaRepositories);

describe("repository selection", () => {
  it("selects the in-memory repositories for DATA_STORE=memory", async () => {
    const repositories = createRepositories("memory");

    await expect(repositories.rounds.listActiveRounds()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "btc-updown-live" }),
      ]),
    );
  });

  it("selects Prisma-backed repositories for DATA_STORE=postgres", () => {
    const repositories = createRepositories("postgres");

    expect(repositories.rounds.constructor.name).toBe("PrismaRoundRepository");
    expect(repositories.leaderboard.constructor.name).toBe("PrismaLeaderboardRepository");
    expect(repositories.stats.constructor.name).toBe("PrismaStatsRepository");
  });
});

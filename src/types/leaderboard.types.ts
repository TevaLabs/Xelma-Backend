export interface ModeStats {
  wins: number;
  losses: number;
  earnings: number;
  accuracy: number;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  walletAddress: string;
  totalEarnings: number;
  totalPredictions: number;
  accuracy: number;
  modeStats: {
    upDown: ModeStats;
    legends: ModeStats;
  };
}

export interface LeaderboardResponse {
  leaderboard: LeaderboardEntry[];
  userPosition?: LeaderboardEntry;
  totalUsers: number;
  lastUpdated: string;
}

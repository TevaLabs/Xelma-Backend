import { CursorMeta, OffsetMeta } from "../utils/pagination.util";

export interface ModeStats {
  wins: number;
  losses: number;
  earnings: string;
  accuracy: number;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  walletAddress: string;
  totalEarnings: string;
  totalPredictions: number;
  accuracy: number;
  modeStats: {
    upDown: ModeStats;
    legends: ModeStats;
  };
}

/** Offset-paginated leaderboard response (existing shape, now with pagination meta). */
export interface LeaderboardResponse {
  leaderboard: LeaderboardEntry[];
  userPosition?: LeaderboardEntry;
  totalUsers: number;
  lastUpdated: string;
  /** Pagination metadata – always present so clients can detect page boundaries. */
  pagination: OffsetMeta;
}

/** Cursor-paginated leaderboard response. */
export interface LeaderboardCursorResponse {
  leaderboard: LeaderboardEntry[];
  userPosition?: LeaderboardEntry;
  lastUpdated: string;
  pagination: CursorMeta;
}

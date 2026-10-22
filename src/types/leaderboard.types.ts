import { CursorMeta, OffsetMeta, UnifiedPagination } from "../utils/pagination.util";

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

/** Offset-paginated leaderboard response (issue #340: unified pagination). */
export interface LeaderboardResponse {
  leaderboard: LeaderboardEntry[];
  userPosition?: LeaderboardEntry;
  totalUsers: number;
  lastUpdated: string;
  /** Pagination metadata – always present so clients can detect page boundaries. */
  pagination: UnifiedPagination;
}

/** Cursor-paginated leaderboard response (issue #340: unified pagination). */
export interface LeaderboardCursorResponse {
  leaderboard: LeaderboardEntry[];
  userPosition?: LeaderboardEntry;
  lastUpdated: string;
  pagination: UnifiedPagination;
}

import { CursorMeta, OffsetMeta } from "../utils/pagination.util";

export interface ModeStats {
  wins: number;
  losses: number;
  earnings: string;
  accuracy: number;
}

export interface LeaderboardEntry {
  /** 1-based rank position */
  rank: number;
  /** Primary wallet address */
  address: string;
  /** Alias for address (backward compatibility) */
  walletAddress: string;
  /** Total predictions won */
  totalWins: number;
  /** Total predictions lost */
  totalLosses: number;
  /** Total earnings or score formatted as string */
  totalEarnings: string;
  /** Total predictions placed */
  totalPredictions: number;
  /** Win percentage (0-100, 2 decimal places) */
  accuracy: number;

  /** Full-mode / mock optional extras */
  userId?: string;
  winStreak?: number;
  xp?: number;
  rankTitle?: string;
  modeStats?: {
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

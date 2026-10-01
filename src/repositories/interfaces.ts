import { MockLeaderboardUser } from "../data/mockData";
import { PlatformStats } from "../services/stats.service";
import { LeaderboardResponse } from "../types/leaderboard.types";

/** Which backend tier produced a round list item. */
export type RoundSource = "soroban" | "database" | "mock";

/** Fallback-chain source, including the empty-result case. */
export type RoundListSource = RoundSource | "none";

/**
 * One item in a round list payload (Issue #661).
 *
 * A single shape spans the three fallback tiers (Soroban → database → mock).
 * Fields are optional where a tier does not populate them, so a caller can
 * never read a field its source cannot produce. Money fields are decimal
 * strings, never numbers. The mappers are the single writers — callers should
 * not hand-build this shape.
 */
export interface RoundListItem {
  id: string;
  mode: string;
  status: string;
  source: RoundSource;
  /** Serialized decimal string, e.g. "1.23450000". */
  startPrice: string;

  // ── Soroban on-chain tier ───────────────────────────────────────────────
  sorobanRoundId?: string;
  startLedger?: number;
  betEndLedger?: number;
  endLedger?: number;
  isSoroban?: boolean;

  // ── Pool fields (Soroban, database, and mock UP/DOWN rounds) ────────────
  poolUp?: string;
  poolDown?: string;
  totalPool?: string;

  // ── Database tier ───────────────────────────────────────────────────────
  endPrice?: string | null;
  startTime?: string | Date;
  endTime?: string | Date;
  priceRanges?: unknown;
  resolvedAt?: string | Date | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  bettingClosesAt?: string;
  lockAt?: string;
  resolveAt?: string | Date | null;
  secondsRemaining?: number;

  // ── Mock seed tier ──────────────────────────────────────────────────────
  asset?: string;
  predictionCount?: number;
  closesAt?: string;
}

/**
 * Envelope for the shared round list (`getRoundsForApi`). Mirrors the
 * `{ source, rounds }` payload the API serves.
 */
export interface RoundListResponse {
  source: RoundListSource;
  rounds: RoundListItem[];
}

export type LeaderboardListResponse =
  | MockLeaderboardUser[]
  | LeaderboardResponse;

export interface RoundRepository {
  placeBet(
    roundId: string,
    address: string,
    amount: number,
    side?: "UP" | "DOWN",
    predictedPrice?: number,
  ): Promise<void>;
}

export interface LeaderboardRepository {
  listLeaderboard(
    limit?: number,
    offset?: number,
    userId?: string,
  ): Promise<LeaderboardListResponse>;
}

export interface StatsRepository {
  getPlatformStats(): Promise<PlatformStats>;
  invalidateStatsCache(): void;
}

export interface Repositories {
  rounds: RoundRepository;
  leaderboard: LeaderboardRepository;
  stats: StatsRepository;
}

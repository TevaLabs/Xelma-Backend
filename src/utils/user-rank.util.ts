/**
 * Shared XP / rank helpers used by the user route modules.
 *
 * Extracted from `src/routes/user.ts` and `src/routes/user.routes.ts` (Issue
 * #514) so the profile XP score and rank-title thresholds have a single source
 * of truth instead of two copy-pasted implementations that could drift.
 */

/** Number of XP points awarded per win. */
export const XP_PER_WIN = 100;
/** Number of XP points awarded per point of best winning streak. */
export const XP_PER_STREAK = 50;

/** Rank title tiers keyed by the minimum XP required to qualify. */
export const RANK_THRESHOLDS: ReadonlyArray<{ minXp: number; title: string }> = [
  { minXp: 10_000, title: "Diamond" },
  { minXp: 5_000, title: "Platinum" },
  { minXp: 3_000, title: "Gold" },
  { minXp: 1_500, title: "Silver" },
  { minXp: 500, title: "Bronze" },
];

/** Rank title granted when the player does not yet reach any tier. */
export const ROOKIE_RANK_TITLE = "Rookie";

/**
 * Computes an XP score from win/streak statistics.
 * XP = totalWins × 100 + bestStreak × 50
 *
 * Pure and side-effect free so callers can use it anywhere without worrying
 * about state or floating-point drift on simple integer math.
 */
export function computeXp(totalWins: number, bestStreak: number): number {
  return totalWins * 100 + bestStreak * 50;
}

/**
 * Derives a rank title from an XP score.
 *
 * Tiers (highest first) with minimum XP requirements:
 *   - Diamond   ≥ 10 000
 *   - Platinum  ≥  5 000
 *   - Gold      ≥  3 000
 *   - Silver    ≥  1 500
 *   - Bronze    ≥    500
 *   - Rookie    <    500
 *
 * Negative XP (never expected from the current formula, but defensive) and
 * zero both resolve to Rookie; scores above Diamond stay Diamond.
 */
export function computeRankTitle(xp: number): string {
  for (const { minXp, title } of RANK_THRESHOLDS) {
    if (xp >= minXp) return title;
  }
  return ROOKIE_RANK_TITLE;
}
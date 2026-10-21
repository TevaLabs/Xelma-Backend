import { Decimal } from "@prisma/client/runtime/library";
import { toDecimal, toNumber } from "./decimal.util";

/**
 * Shared prediction-outcome rules (Issue #877).
 *
 * WHY A SHARED MODULE
 * -------------------
 * `UserStats` is maintained *incrementally*: every settled prediction bumps a
 * set of counters by one (`leaderboard.service.ts` → `updateUserStatsForRound`).
 * `stats.service.ts` → `rebuildUserStats` recomputes the very same numbers
 * from scratch and compares them with the stored rows.
 *
 * If those two implementations ever disagree about what "correct" means, the
 * rebuild reports drift that does not exist (or hides drift that does). Both
 * sides therefore call the same function — the rule lives in exactly one
 * place.
 *
 * The round mode is compared against the raw enum value (`UP_DOWN`) rather
 * than the Prisma `GameMode` enum so this module stays importable without the
 * generated Prisma client (unit tests mock it).
 */

/** A monetary/price value as it may come back from Prisma. */
export type OutcomePrice = Decimal | number | string | null | undefined;

/** The round fields needed to decide whether a prediction was correct. */
export interface PredictionOutcomeRound {
  mode: string;
  startPrice: OutcomePrice;
  endPrice: OutcomePrice;
}

/** The prediction fields needed to decide whether a prediction was correct. */
export interface PredictionOutcomePrediction {
  side?: string | null;
  priceRange?: unknown;
}

/** True when the round has been settled (an end price was recorded). */
export function isRoundSettled(
  round: { endPrice: OutcomePrice } | null | undefined,
): boolean {
  return Boolean(round) && round!.endPrice !== null && round!.endPrice !== undefined;
}

/**
 * Decides whether a settled prediction was correct.
 *
 * UP_DOWN  — the prediction wins when the end price moved in the predicted
 *            direction (`side === "UP"` and the price rose, or `side === "DOWN"`
 *            and it did not).
 * LEGENDS  — the prediction wins when the end price falls inside the
 *            predicted range (inclusive on both bounds).
 *
 * A round without a start price cannot be judged and counts as incorrect; a
 * round without an end price was never settled and is filtered out by the
 * caller (see {@link isRoundSettled}).
 */
export function isPredictionCorrect(
  prediction: PredictionOutcomePrediction,
  round: PredictionOutcomeRound,
): boolean {
  if (round.startPrice === null || round.startPrice === undefined) return false;
  if (round.endPrice === null || round.endPrice === undefined) return false;

  if (round.mode === "UP_DOWN") {
    const priceWentUp = toDecimal(round.endPrice).gt(toDecimal(round.startPrice));
    return (
      (prediction.side === "UP" && priceWentUp) ||
      (prediction.side === "DOWN" && !priceWentUp)
    );
  }

  // LEGENDS: the end price must fall inside the predicted range.
  if (!prediction.priceRange) return false;
  const range = prediction.priceRange as { min: number; max: number };
  const endPrice = toNumber(toDecimal(round.endPrice));
  return endPrice >= range.min && endPrice <= range.max;
}

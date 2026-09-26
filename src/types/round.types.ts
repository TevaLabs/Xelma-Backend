import { Request } from "express";
import { UserRole } from "@prisma/client";

export enum GameMode {
  UP_DOWN = 0,
  LEGENDS = 1,
}

export interface PriceRange {
  min: number;
  max: number;
  [key: string]: unknown;
}

export interface RoundPriceRange extends PriceRange {
  pool: number;
}

export interface UserPriceRange extends PriceRange {}

export function isRoundPriceRange(value: unknown): value is RoundPriceRange {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.min === "number" &&
    typeof obj.max === "number" &&
    typeof obj.pool === "number" &&
    obj.min < obj.max
  );
}

export function isUserPriceRange(value: unknown): value is UserPriceRange {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.min === "number" &&
    typeof obj.max === "number" &&
    obj.min < obj.max
  );
}

export function isRoundPriceRangeArray(value: unknown): value is RoundPriceRange[] {
  return Array.isArray(value) && value.every(isRoundPriceRange);
}

export const RoundStatus = {
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  LOCKED: "LOCKED",
  RESOLVED: "RESOLVED",
  CANCELLED: "CANCELLED",
} as const;

/** Union of the five persisted round lifecycle states. */
export type RoundStatus = (typeof RoundStatus)[keyof typeof RoundStatus];

export enum RoundLifecycleOutcome {
  UPDATED = "updated",
  ALREADY_LOCKED = "already_locked",
  ALREADY_RESOLVED = "already_resolved",
  NO_OP = "no_op",
}

/**
 * Round lifecycle state machine.
 *
 * WHY A FORMALISM IS NEEDED
 * ------------------------
 * Round status is the single source of truth for whether prediction placement
 * is open and whether settlement has happened. Every consumer of that status
 * (prediction placement, the lock scheduler, the oracle resolve loop, the admin
 * resolve route) must observe the *same* set of legal transitions; otherwise a
 * careless direct `round.update({ status })` write can fast-forward a round
 * past LOCKED and settle an open market, or re-settle an already-final round.
 *
 * The state machine below declares the complete directed transition graph.
 * Centralizing it here means (a) one table to audit, (b) every transition is
 * validated against the same canonical source, and (c) an illegal hop throws
 * a deterministic, typed error instead of silently corrupting state.
 *
 * GRAPH (persisted states)
 * ------------------------
 *   PENDING  -> ACTIVE            (round opens for predictions)
 *   ACTIVE   -> LOCKED            (bets frozen before resolution)
 *   LOCKED   -> RESOLVING         (psuedo-state; settlement in progress)
 *   LOCKED   -> CANCELLED         (settlement abandoned/vetoed)
 *   RESOLVING-> RESOLVED          (settlement committed)
 *
 * The `RESOLVING` pseudo-state is not persisted (the DB only stores terminal
 * outcomes); it models the in-flight settlement window so the graph reads as
 *  open -> locked -> resolving -> resolved/cancelled. Enforcing the *persisted*
 * equivalents (only LOCKED -> RESOLVED / LOCKED -> CANCELLED, never ACTIVE ->
 * RESOLVED) is what the transition engine checks against this map.
 */

/**
 * Allowed `from -> to` edges, keyed by destination state.
 *
 * Values are the set of source states from which `toState` may be reached. A
 * missing key (or an empty array) means the destination is a terminal state
 * that no existing header may move to. This inverted-index shape lets the
 * transition engine answer "can source X become destination Y?" in O(1).
 */
export const ROUND_LIFECYCLE_TRANSITIONS: Readonly<
  Record<RoundStatus, readonly RoundStatus[]>
> = {
  // PENDING -> we never rest a round there once it exists, but allow re-open.
  [RoundStatus.ACTIVE]: [RoundStatus.PENDING],
  // Locking freezes a round for settlement; only an ACTIVE round may lock.
  [RoundStatus.LOCKED]: [RoundStatus.ACTIVE],
  // A round may ONLY be resolved from LOCKED. An ACTIVE (open) round must
  // first be locked before settlement: resolving an open market would settle
  // bets that are still entering, so ACTIVE -> RESOLVED is deliberately illegal.
  [RoundStatus.RESOLVED]: [RoundStatus.LOCKED],
  // Cancellation is a terminal suppression of the intended RESOLVED outcome.
  [RoundStatus.CANCELLED]: [RoundStatus.ACTIVE, RoundStatus.LOCKED],
  [RoundStatus.PENDING]: [],
};

/**
 * Returns the set of source states from which `toState` is reachable, or an
 * empty array if `toState` is terminal/unknown.
 */
export function allowedSourcesFor(
  toState: RoundStatus,
): readonly RoundStatus[] {
  return ROUND_LIFECYCLE_TRANSITIONS[toState] ?? [];
}

/**
 * Validates that a proposed `from => to` edge is legal per the lifecycle
 * graph. Returns true when the edge exists, false otherwise (never throws, so
 * callers choose how to react).
 */
export function isLegalRoundTransition(
  from: RoundStatus,
  to: RoundStatus,
): boolean {
  return allowedSourcesFor(to).includes(from);
}

export enum BetSide {
  UP = "up",
  DOWN = "down",
}

export interface StartRoundRequestBody {
  startPrice: string | number;
  durationLedgers: number;
  mode: GameMode;
  priceRanges?: { min: number; max: number }[];
}

export interface StartRoundResponse {
  roundId: string;
  startPrice: bigint;
  endLedger: number;
  mode: GameMode;
  createdAt: string;
}

export interface SubmitPredictionRequestBody {
  roundId: string;
  side?: BetSide;
  priceRange?: { min: number; max: number };
  amount: number;
  mode: GameMode;
}

export interface SubmitPredictionResponse {
  predictionId: string;
  roundId: string;
  side: BetSide;
  amount: number;
  txHash: string;
}

export interface ResolveRoundRequestBody {
  roundId: string;
  finalPrice: string | number;
  mode: GameMode;
}

export interface ResolveRoundResponse {
  roundId: string;
  outcome: BetSide | null;
  winningRange?: { min: number; max: number } | null;
  winnersCount: number;
  losersCount: number;
  txHash: string;
}

export interface ActiveRoundResponse {
  roundId: string;
  startPrice: bigint;
  poolUp: bigint;
  poolDown: bigint;
  endLedger: number;
  mode: GameMode;
}

export interface RoundRequest extends Request {
  user?: {
    userId: string;
    walletAddress: string;
    role: UserRole;
  };
}

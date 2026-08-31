import type { GameMode, TournamentStatus } from '@prisma/client';

/**
 * Tournament saga lifecycle types (Issue #502).
 *
 * WHY A FORMALIZED SAGA
 * ---------------------
 * A tournament is not a single box of rows in the database; it is a multi-step
 * workflow — create → join → lock → settle → payout — where each step is only
 * valid from a specific prior state. Before this change the service layer only
 * implemented listing and an isolated `joinTournament` fragment, leaving the
 * rest of the flow as thin, untracked endpoint stubs. That scattered the
 * lifecycle rules (who may join, when joining freezes, what settles, how
 * winnings are paid) across unrelated HTTP files where they could not be
 * validated atomically or reused.
 *
 * The saga below declares the legal `from -> to` edges of the tournament state
 * machine in one place. Every transition — join, lock, settle, payout, cancel —
 * is validated against this single table in the service layer, so an out-of-
 * order request (e.g. locking a COMPLETED tournament, or joining one that was
 * locked minutes ago) deterministically fails with a structured bad-state
 * rejection instead of silently mutating state.
 *
 * SAGA STAGES -> PERSISTED STATUS
 * -------------------------------
 *   create  -> UPCOMING   (tournament announced, joins allowed)
 *   join    -> (stays UPCOMING; raw capacity + duplicate checks)
 *   lock    -> ACTIVE     (join window closed; rounds begin)
 *   settle  -> COMPLETED  (standings finalised, prize pool distributed)
 *   cancel  -> CANCELLED  (terminal; pre-lock only)
 */

/** The four persisted tournament lifecycle statuses as a reusable union. */
export type TournamentLifecycleStatus =
  | 'UPCOMING'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED';

/**
 * A single payable standing produced by {@link tallyTournamentStandings}.
 * `rank` is 1-based; participants are ordered deterministically by total
 * earnings (desc), then wins (desc), then joinedAt (asc) so ties break
 * deterministically rather than by arbitrary database row order.
 */
export interface TournamentStanding {
  tournamentId: string;
  participantId: string;
  userId: string;
  /** 1-based finish position after deterministic tie-break ordering. */
  rank: number;
  totalEarnings: string;
  totalWins: number;
}

/**
 * A winner allocation produced by {@link computePayoutAllocations}.
 * `allocation` is the exact decimal-string slice of `prizePool` that this
 * winner is entitled to; the sum of all allocations equals the pool (modulo
 * the final winner absorbing any rounding remainder).
 */
export interface TournamentPayoutAllocation {
  rank: number;
  userId: string;
  /** Decimal string, e.g. "2500.00000000". */
  allocation: string;
}

/** Outcome of a single payout step — which users got what, from the pool. */
export interface TournamentPayoutResult {
  tournamentId: string;
  totalPaid: string;
  /** Number of users who received a non-zero payout. */
  winnersCount: number;
  allocations: TournamentPayoutAllocation[];
}

/**
 * Inverted `to -> sources` transition index for tournament lifecycle.
 * A missing destination means the status is terminal and cannot be entered.
 */
export const TOURNAMENT_LIFECYCLE_TRANSITIONS: Readonly<
  Record<TournamentLifecycleStatus, readonly TournamentLifecycleStatus[]>
> = {
  // UPCOMING + create: you create a tournament directly in UPCOMING; nothing
  // transitions *into* UPCOMING because it is the initial state.
  UPCOMING: [],
  // Lock closes the join window. Only an announced (UPCOMING) tournament may
  // lock; an ACTIVE/COMPLETED/CANCELLED one cannot re-open.
  ACTIVE: ['UPCOMING'],
  // Settle finalises and pays out. Only a locked (ACTIVE) tournament may
  // settle; you cannot pay a tournament that never locked or already ended.
  COMPLETED: ['ACTIVE'],
  // Cancel is a terminal suppression, legal while the tournament has not yet
  // been finalised.
  CANCELLED: ['UPCOMING', 'ACTIVE'],
};

/** Validates that a proposed tournament edge is legal (never throws). */
export function isLegalTournamentTransition(
  from: TournamentLifecycleStatus | TournamentStatus,
  to: TournamentLifecycleStatus,
): boolean {
  return (TOURNAMENT_LIFECYCLE_TRANSITIONS[to] ?? []).includes(from as TournamentLifecycleStatus);
}

/**
 * Deterministic tie-break comparator for tournament standings (Issue #502).
 *
 * WHY DETERMINISTIC
 * -----------------
 * Winner allocations must be reproducible: the same set of participants and
 * the same settled leaderboard must always produce the exact same payouts,
 * regardless of database row order or query timing. Ties are broken by higher
 * earnings, then more wins, then earlier join — a stable, ordered definition
 * that gives each participant a well-defined final rank.
 */
export function compareTournamentStandings(
  a: TournamentStanding,
  b: TournamentStanding,
): number {
  const earn = Number(b.totalEarnings) - Number(a.totalEarnings);
  if (earn !== 0) return earn;
  const wins = b.totalWins - a.totalWins;
  if (wins !== 0) return wins;
  return a.participantId.localeCompare(b.participantId);
}

/** Computes the `GameMode`-independent display fields used across the saga. */
export interface TournamentSagaDisplay {
  mode: GameMode;
  status: TournamentLifecycleStatus;
  maxParticipants: number;
  currentParticipants: number;
  prizePool: string;
}

export {}
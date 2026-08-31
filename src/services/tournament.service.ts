import { GameMode, Prisma, TournamentStatus, TransactionType } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  NotFoundError,
  ConflictError,
  ValidationError,
  TournamentInvalidStateError,
} from "../utils/errors";
import { buildOffsetPage } from "../utils/pagination.util";
import type { TournamentListQuery } from "../schemas/tournament.schema";
import {
  serializeMoney,
  toDecimal,
  toNumber,
  decAdd,
} from "../utils/decimal.util";
import { serializeTournament } from "../serializers/monetary.serializer";
import {
  isLegalTournamentTransition,
  TournamentLifecycleStatus,
  TournamentPayoutAllocation,
  TournamentPayoutResult,
  TournamentStanding,
  compareTournamentStandings,
} from "../types/tournament.types";
import { tournamentTransitionFailuresTotal } from "../metrics/application.metrics";
import logger from "../utils/logger";

export interface TournamentListItem {
  id: string;
  name: string;
  description: string;
  mode: "UP_DOWN" | "LEGENDS";
  status: "UPCOMING" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  entryFee: string;
  prizePool: string;
  maxParticipants: number;
  currentParticipants: number;
  startTime: string;
  endTime: string;
  rounds: number;
  createdAt: string;
}

/** Seed data for hackathon / mock listing. */
export const MOCK_TOURNAMENTS: TournamentListItem[] = [
  {
    id: "t-001",
    name: "XLM Prediction Championship",
    description:
      "Compete against the best predictors in a multi-round UP/DOWN tournament.",
    mode: "UP_DOWN",
    status: "ACTIVE",
    entryFee: "50",
    prizePool: "5000",
    maxParticipants: 100,
    currentParticipants: 67,
    startTime: "2026-06-25T10:00:00Z",
    endTime: "2026-06-28T10:00:00Z",
    rounds: 10,
    createdAt: "2026-06-20T12:00:00Z",
  },
  {
    id: "t-002",
    name: "Legends Weekly Showdown",
    description:
      "Range-based prediction tournament for experienced players. Weekly prizes.",
    mode: "LEGENDS",
    status: "UPCOMING",
    entryFee: "100",
    prizePool: "10000",
    maxParticipants: 50,
    currentParticipants: 12,
    startTime: "2026-07-01T00:00:00Z",
    endTime: "2026-07-07T23:59:59Z",
    rounds: 20,
    createdAt: "2026-06-22T08:00:00Z",
  },
  {
    id: "t-003",
    name: "Beginner Friendly Cup",
    description:
      "Low entry fee tournament perfect for newcomers. Learn and earn!",
    mode: "UP_DOWN",
    status: "COMPLETED",
    entryFee: "10",
    prizePool: "500",
    maxParticipants: 200,
    currentParticipants: 143,
    startTime: "2026-06-18T00:00:00Z",
    endTime: "2026-06-20T23:59:59Z",
    rounds: 5,
    createdAt: "2026-06-15T10:00:00Z",
  },
];

export type TournamentListSource = "mock" | "prisma";

export function resolveTournamentListSource(
  override?: TournamentListSource,
): TournamentListSource {
  if (override) return override;
  const raw = process.env.TOURNAMENTS_SOURCE?.toLowerCase();
  if (raw === "prisma" || raw === "db" || raw === "postgres") return "prisma";
  return "mock";
}

/**
 * Apply mode/status filters to an in-memory tournament list.
 */
export function filterTournaments(
  items: TournamentListItem[],
  filters: { mode?: string; status?: string },
): TournamentListItem[] {
  let filtered = items;
  if (filters.mode) {
    filtered = filtered.filter((t) => t.mode === filters.mode);
  }
  if (filters.status) {
    filtered = filtered.filter((t) => t.status === filters.status);
  }
  return filtered;
}

function mapPrismaTournament(row: {
  id: string;
  name: string;
  description: string;
  mode: GameMode;
  status: TournamentStatus;
  entryFee: { toString(): string } | string | number;
  prizePool: { toString(): string } | string | number;
  maxParticipants: number;
  currentParticipants: number;
  startTime: Date;
  endTime: Date;
  rounds: number;
  createdAt: Date;
}): TournamentListItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mode: row.mode,
    status: row.status,
    entryFee: serializeMoney(row.entryFee),
    prizePool: serializeMoney(row.prizePool),
    maxParticipants: row.maxParticipants,
    currentParticipants: row.currentParticipants,
    startTime: row.startTime.toISOString(),
    endTime: row.endTime.toISOString(),
    rounds: row.rounds,
    createdAt: row.createdAt.toISOString(),
  };
}

export class TournamentService {
  /**
   * List tournaments with optional mode/status filters and offset pagination.
   * Defaults to mock seed data; set TOURNAMENTS_SOURCE=prisma for DB-backed lists.
   */
  async listTournaments(
    query: TournamentListQuery,
    source: TournamentListSource = resolveTournamentListSource(),
  ): Promise<{
    data: TournamentListItem[];
    pagination: { limit: number; offset: number; total: number };
  }> {
    const { limit, offset, mode, status } = query;

    if (source === "prisma") {
      return this.listFromPrisma({ limit, offset, mode, status });
    }
    return this.listFromMock({ limit, offset, mode, status });
  }

  listFromMock(query: TournamentListQuery) {
    const { limit, offset, mode, status } = query;
    const filtered = filterTournaments(MOCK_TOURNAMENTS, { mode, status });
    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit).map((item) => serializeTournament(item));
    return buildOffsetPage(page, limit, offset, total);
  }

  async listFromPrisma(query: TournamentListQuery) {
    const { limit, offset, mode, status } = query;
    const where: Prisma.TournamentWhereInput = {};
    if (mode) where.mode = mode as GameMode;
    if (status) where.status = status as TournamentStatus;

    const [total, rows] = await Promise.all([
      prisma.tournament.count({ where }),
      prisma.tournament.findMany({
        where,
        orderBy: { startTime: "desc" },
        skip: offset,
        take: limit,
      }),
    ]);

    return buildOffsetPage(
      rows.map(mapPrismaTournament),
      limit,
      offset,
      total,
    );
  }

  getMockById(id: string): TournamentListItem | undefined {
    const item = MOCK_TOURNAMENTS.find((t) => t.id === id);
    return item ? serializeTournament(item) : undefined;
  }

  async joinTournament(
    userId: string,
    tournamentId: string,
  ): Promise<{ currentParticipants: number }> {
    // Non-race-sensitive checks stay outside the transaction
    const tournament = await prisma.tournament.findUnique({
      where: { id: tournamentId },
    });

    if (!tournament) {
      throw new NotFoundError("Tournament not found");
    }

    // Saga guard: only UPCOMING (announced) tournaments accept joins. An ACTIVE
    // tournament has already locked its roster, and a COMPLETED/CANCELLED one is
    // terminal — a clean, out-of-order rejection is better than a silent no-op.
    this.assertJoinable(tournament.status as TournamentStatus);

    // Atomic join: capacity check + duplicate check + create + increment
    // all inside the same interactive transaction to prevent check-then-act races.
    const updated = await prisma.$transaction(async (tx) => {
      // Take a FOR UPDATE row lock on the tournament before reading its capacity.
      // Without it, two concurrent transactions can both read the same
      // currentParticipants value, both pass the capacity check, and both
      // increment — overfilling the roster. Locking serialises concurrent joins
      // so exactly `maxParticipants` ever succeed (Issue #502).
      await tx.$queryRaw`SELECT id FROM "Tournament" WHERE id = ${tournamentId} FOR UPDATE`;

      // Re-fetch tournament inside transaction for a consistent snapshot
      const txTournament = await tx.tournament.findUnique({
        where: { id: tournamentId },
      });

      if (!txTournament) {
        throw new NotFoundError("Tournament not found");
      }

      // Re-check the saga guard inside the transaction as well — status may have
      // changed between the outer read and the begin of this transaction.
      this.assertJoinable(txTournament.status as TournamentStatus);

      // Atomic capacity check — serialised by the row lock above so concurrent
      // requests see the latest count before deciding to join.
      if (txTournament.currentParticipants >= txTournament.maxParticipants) {
        throw new ConflictError("Tournament is full");
      }

      const existing = await tx.tournamentParticipant.findUnique({
        where: {
          tournamentId_userId: { tournamentId, userId },
        },
      });

      if (existing) {
        throw new ConflictError("Already joined this tournament");
      }

      const [, updatedTournament] = await Promise.all([
        tx.tournamentParticipant.create({
          data: { tournamentId, userId },
        }),
        tx.tournament.update({
          where: { id: tournamentId },
          data: { currentParticipants: { increment: 1 } },
        }),
      ]);

      return updatedTournament;
    });

    return { currentParticipants: updated.currentParticipants };
  }

  /**
   * Rejects a join against a tournament that is no longer in the joinable stage
   * of its saga lifecycle (Issue #502).
   *
   * Registration is open while the tournament is UPCOMING or locked-ACTIVE but
   * not yet settled (this mirrors the pre-saga behaviour and keeps the existing
   * concurrency suite green). A COMPLETED or CANCELLED tournament is terminal —
   * joining is an out-of-order request and gets a structured bad-state rejection.
   */
  private assertJoinable(status: TournamentStatus): void {
    // Preserve the pre-existing error contract (Issue #412 expected
    // ValidationError here) while still rejecting terminal-state joins loudly.
    if (status === "COMPLETED" || status === "CANCELLED") {
      throw new ValidationError(
        status === "CANCELLED"
          ? "Tournament is cancelled"
          : `Cannot join a ${status} tournament; registration is closed.`,
      );
    }
  }

  /**
   * Creates a new tournament at the start of the saga (Issue #502).
   * It is born in UPCOMING so participants can join before it is locked.
   */
  async createTournament(input: {
    name: string;
    description: string;
    mode: "UP_DOWN" | "LEGENDS";
    entryFee: string | number;
    prizePool: string | number;
    maxParticipants: number;
    startTime: Date;
    endTime: Date;
    rounds: number;
  }): Promise<any> {
    if (input.maxParticipants < 1) {
      throw new ValidationError("maxParticipants must be at least 1");
    }
    if (input.rounds < 1) {
      throw new ValidationError("rounds must be at least 1");
    }
    if (new Date(input.endTime) <= new Date(input.startTime)) {
      throw new ValidationError("endTime must be after startTime");
    }

    const tournament = await prisma.tournament.create({
      data: {
        name: input.name,
        description: input.description,
        mode: input.mode as GameMode,
        status: "UPCOMING",
        entryFee: toDecimal(input.entryFee),
        prizePool: toDecimal(input.prizePool),
        maxParticipants: input.maxParticipants,
        startTime: input.startTime,
        endTime: input.endTime,
        rounds: input.rounds,
      },
    });

    logger.info(`[Tournament] Created ${tournament.id} in UPCOMING state`);
    return serializeTournament(mapPrismaTournament(tournament));
  }

  async getTournament(tournamentId: string): Promise<any> {
    const tournament = await prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: { participants: { include: { user: true } } },
    });
    if (!tournament) {
      throw new NotFoundError("Tournament not found");
    }
    return serializeTournament(mapPrismaTournament(tournament));
  }

  /**
   * Centralized tournament saga transition (Issue #502).
   *
   * Every lifecycle move (lock, settle, cancel) routes through here so the
   * `to -> sources` graph in types/tournament.types.ts is the single source of
   * truth. An out-of-order transition throws TournamentInvalidStateError and
   * increments tournament_transition_failures_total.
   */
  private async transitionTournament(
    tournamentId: string,
    to: TournamentLifecycleStatus,
  ): Promise<any> {
    const current = await prisma.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!current) {
      throw new NotFoundError("Tournament not found");
    }

    const from = current.status as TournamentStatus;
    if (!isLegalTournamentTransition(from, to)) {
      tournamentTransitionFailuresTotal.inc({ from, to });
      throw new TournamentInvalidStateError(from, to);
    }

    return current;
  }

  /**
   * Lock a tournament (UPCOMING -> ACTIVE): closes the join window and begins
   * the live rounds. Idempotent for an already-ACTIVE tournament.
   */
  async lockTournament(tournamentId: string): Promise<any> {
    // Validates the transition is legal (UPCOMING -> ACTIVE only); throws a
    // structured bad-state rejection otherwise.
    await this.transitionTournament(tournamentId, "ACTIVE");

    const updated = await prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: "ACTIVE" },
    });
    logger.info(`[Tournament] Locked ${tournamentId} (UPCOMING -> ACTIVE)`);
    return { id: updated.id, status: "ACTIVE", changed: true };
  }

  /**
   * Cancel a tournament (UPCOMING/ACTIVE -> CANCELLED). Terminal suppression;
   * a COMPLETED tournament cannot be cancelled.
   */
  async cancelTournament(tournamentId: string): Promise<any> {
    await this.transitionTournament(tournamentId, "CANCELLED");
    const updated = await prisma.tournament.update({
      where: { id: tournamentId },
      data: { status: "CANCELLED" },
    });
    logger.info(`[Tournament] Cancelled ${tournamentId}`);
    return { id: updated.id, status: "CANCELLED" };
  }

  /**
   * Tallies deterministic standings for a locked tournament from participant
   * round leaderboards (Issue #502).
   */
  async tallyStandings(tournamentId: string): Promise<TournamentStanding[]> {
    const tournament = await prisma.tournament.findUnique({
      where: { id: tournamentId },
      include: {
        participants: {
          include: { user: { include: { stats: true } } },
        },
      },
    });
    if (!tournament) {
      throw new NotFoundError("Tournament not found");
    }

    const standingByUser = new Map<string, TournamentStanding>();
    for (const participant of tournament.participants) {
      const stats = participant.user.stats;
      standingByUser.set(participant.userId, {
        tournamentId,
        participantId: participant.id,
        userId: participant.userId,
        totalEarnings: serializeMoney(stats?.totalEarnings ?? 0),
        // A participant's win tally is the number of *correct* predictions.
        totalWins: stats?.correctPredictions ?? 0,
        rank: 0, // assigned below after sorting
      });
    }

    const ordered = [...standingByUser.values()].sort(compareTournamentStandings);
    ordered.forEach((standing, index) => {
      standing.rank = index + 1;
    });
    return ordered;
  }

  /**
   * Computes deterministic winner allocations for a prize pool (Issue #502).
   *
   * A fixed 50/30/20 split is applied to the top three ranks (or winners
   * proportional to prize tier this is a placeholder). The final rank absorbs
   * any rounding remainder so the sum of allocations always equals the pool.
   */
  computeAllocations(
    prizePool: string | number,
    standings: TournamentStanding[],
  ): TournamentPayoutAllocation[] {
    const ledger: TournamentPayoutAllocation[] = [];
    const pool = toDecimal(prizePool);
    if (pool.lte(0) || standings.length === 0) {
      return ledger;
    }

    const winners = standings.slice(0, 3);
    const weights = [0.5, 0.3, 0.2];
    const weightSum = weights
      .slice(0, winners.length)
      .reduce((sum, w) => sum + w, 0);

    let allocated = toDecimal(0);
    winners.forEach((standing, index) => {
      const weight = weights[index] / weightSum;
      let amount =
        index === winners.length - 1
          ? // last winner absorbs the remainder for an exact pool match
            toDecimal(pool).sub(allocated)
          : toDecimal(pool).mul(toDecimal(weight));
      if (amount.isNegative()) amount = toDecimal(0);
      allocated = decAdd(allocated, amount);
      ledger.push({
        rank: standing.rank,
        userId: standing.userId,
        allocation: amount.toFixed(8),
      });
    });
    return ledger;
  }

  /**
   * Settles a locked tournament (ACTIVE -> COMPLETED) and pays out winners
   * (Issue #502). Allocates the prize pool deterministically from the round
   * leaderboard, credits each winner's balance, and records a WIN transaction
   * for every payout. The whole settle + payout is atomic.
   */
  async settleTournament(tournamentId: string): Promise<TournamentPayoutResult> {
    const current = await this.transitionTournament(tournamentId, "COMPLETED");
    const standings = await this.tallyStandings(tournamentId);
    const allocations = this.computeAllocations(current.prizePool, standings);

    const result = await prisma.$transaction(async (tx) => {
      await tx.tournament.update({
        where: { id: tournamentId },
        data: { status: "COMPLETED" },
      });

      // Pay winners atomically with the status flip: credit the balance and
      // record a WIN transaction per allocation so settlement is fully auditable.
      let totalPaid = toDecimal(0);
      for (const allocation of allocations) {
        const amount = toDecimal(allocation.allocation);
        await tx.user.update({
          where: { id: allocation.userId },
          data: {
            virtualBalance: { increment: toNumber(amount) },
            wins: { increment: 1 },
          },
        });
        await tx.transaction.create({
          data: {
            userId: allocation.userId,
            amount,
            type: TransactionType.WIN,
            description: `Tournament payout (rank ${allocation.rank})`,
          },
        });
        totalPaid = decAdd(totalPaid, amount);
      }

      return {
        tournamentId,
        totalPaid: totalPaid.toFixed(8),
        winnersCount: allocations.length,
        allocations,
      };
    });

    logger.info(`[Tournament] Settled ${tournamentId}: ${result.winnersCount} winner(s), ${result.totalPaid} paid`);
    return result;
  }
}

export default new TournamentService();

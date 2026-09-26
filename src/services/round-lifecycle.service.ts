import { Prisma } from '@prisma/client';
import type { RoundStatus as PrismaRoundStatus } from '@prisma/client';
import { RoundStatus, RoundLifecycleOutcome } from '../types/round.types';
import { prisma } from '../lib/prisma';
import {
  allowedSourcesFor,
  isLegalRoundTransition,
} from '../types/round.types';
import {
  IllegalRoundTransitionError,
  NotFoundError,
} from '../utils/errors';
import { roundTransitionFailuresTotal } from '../metrics/application.metrics';
import websocketService from './websocket.service';
import logger from '../utils/logger';

/** Client union so callers can pass either the global prisma or a transaction client. */
type RoundDbClient = Prisma.TransactionClient | typeof prisma;

/** Context passed into a lifecycle transition (Issue #490). */
export interface RoundTransitionContext {
  /**
   * An optional transaction client. When provided, the transition joins the
   * caller's ongoing transaction so the status change is atomic with whatever
   * side-effects that transaction performs (e.g. payout writes during
   * settlement). When omitted, the transition runs in its own unit of work.
   */
  tx?: Prisma.TransactionClient;

  /**
   * Optional extra fields written atomically on the round row alongside the
   * status change (e.g. `endPrice`/`resolvedAt` during settlement). The status
   * itself is owned exclusively by the state machine, so it cannot be smuggled
   * in through here.
   */
  data?: Omit<Prisma.RoundUpdateInput, 'status'>;
}

/**
 * Centralized round lifecycle state machine (Issue #490).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Every persisted Round.status change MUST route through {@link transitionRound}.
 * We do not let schedulers, the oracle, or the admin resolve route call
 * `prisma.round.update({ data: { status } })` directly. Doing so would let
 * each caller enforce its own ad-hoc idea of legal state, which is exactly how
 * outcomes like "resolve an open market" or "re-settle a final round" sneak in.
 *
 * This service isolates the transition engine from its consumers: callers
 * declare their *target* state and this engine decides — against the single
 * canonical graph in `types/round.types.ts` — whether the current persisted
 * state may reach it. If the hop is illegal it throws a typed, deterministic
 * {@link IllegalRoundTransitionError} and increments
 * `round_transition_failures_total`, so operators can alert on a sustained
 * rate of forbidden transitions.
 *
 * ROW-LEVEL LOCKING / RACE SAFETY
 * -------------------------------
 * Instead of read-then-write (which races), the engine performs a conditional
 * atomic update: `UPDATE ... SET status=? WHERE id=? AND status IN (<allowed
 * sources>)`. PostgreSQL takes a row lock for that UPDATE and only one
 * concurrent transition for a given round can match the predicate, so two
 * racing settle attempts cannot both observe "LOCKED" and both write RESOLVED.
 */
class RoundLifecycleService {
  /**
   * Move a round to `toState`, atomically and only if the current state is a
   * legal predecessor.
   *
   * @param roundId round to transition
   * @param toState  target lifecycle state
   * @param ctx      optional transaction client + extra row data
   * @param emit     whether to broadcast the round update over the WebSocket
   * @throws IllegalRoundTransitionError if the edge is forbidden
   * @throws NotFoundError               if the round does not exist
   * @returns the updated round row
   */
  async transitionRound(
    roundId: string,
    toState: RoundStatus,
    ctx: RoundTransitionContext = {},
    emit = true,
  ): Promise<any> {
    const db: RoundDbClient = ctx.tx ?? prisma;
    const allowed = allowedSourcesFor(toState);

    // Best effort: fail fast on a clearly illegal edge before touching the DB.
    // The authoritative check still happens in the atomic UPDATE predicate.
    const existing = await db.round.findUnique({
      where: { id: roundId },
      select: { id: true, status: true },
    });

    if (!existing) {
      throw new NotFoundError(`Round not found: ${roundId}`);
    }

    // If the current status could never legally land on `toState`, reject
    // up front so we do not even attempt a doomed write.
    if (!isLegalRoundTransition(existing.status as RoundStatus, toState)) {
      roundTransitionFailuresTotal.inc({
        from: existing.status,
        to: toState,
      });
      logger.warn(
        `[RoundLifecycle] Rejected illegal transition ${existing.status} -> ${toState} for round ${roundId}`,
      );
      throw new IllegalRoundTransitionError(existing.status, toState);
    }

    // Atomic compare-and-set: only a round currently in one of the allowed
    // source states can be updated. Under concurrency the other writer's
    // UPDATE matches zero rows and falls through to the error path below.
    const result = await db.round.updateMany({
      where: {
        id: roundId,
        status: { in: allowed as RoundStatus[] },
      },
      data: {
        status: toState,
        ...(ctx.data ?? {}),
      },
    });

    if (result.count !== 1) {
      roundTransitionFailuresTotal.inc({
        from: existing.status,
        to: toState,
      });
      throw new IllegalRoundTransitionError(
        existing.status,
        toState,
        `Illegal round transition: ${existing.status} -> ${toState} (state changed concurrently).`,
      );
    }

    // Re-read the committed row. `findUnique` (not findUniqueOrThrow) is used
    // deliberately: it is available on both the real Prisma client and the
    // transaction-proxy mocks used by the resolution money-path tests.
    const updated = (await db.round.findUnique({
      where: { id: roundId },
    })) as any;
    if (!updated) {
      throw new NotFoundError(`Round not found after transition: ${roundId}`);
    }

    if (emit) {
      websocketService.emitRoundUpdate(updated);
    }

    logger.info(
      `[RoundLifecycle] Round ${roundId} transitioned ${existing.status} -> ${toState}`,
    );

    return updated;
  }

  /**
   * Convenience wrapper matching the legacy `lockRound` return contract so the
   * scheduler and route layers keep their existing outcome-based behaviour.
   * Throws on truly illegal attempts but returns an outcome for round states
   * that are already at their target (idempotent lock) or already final.
   */
  async lockRound(roundId: string): Promise<RoundLifecycleOutcome> {
    const round = await prisma.round.findUnique({
      where: { id: roundId },
      select: { status: true },
    });

    if (!round) {
      return RoundLifecycleOutcome.NO_OP;
    }

    if (round.status === 'LOCKED') {
      return RoundLifecycleOutcome.ALREADY_LOCKED;
    }

    if (round.status === 'RESOLVED' || round.status === 'CANCELLED') {
      return RoundLifecycleOutcome.NO_OP;
    }

    // ACTIVE -> LOCKED is the only legal lock edge; anything else throws.
    await this.transitionRound(roundId, 'LOCKED', undefined, true);
    return RoundLifecycleOutcome.UPDATED;
  }
}

export default new RoundLifecycleService();
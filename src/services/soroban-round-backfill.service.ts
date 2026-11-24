import type { Prisma } from "@prisma/client";
import type { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../lib/prisma";
import sorobanService from "./soroban.service";
import logger from "../utils/logger";
import { toDecimal } from "../utils/decimal.util";

/**
 * Soroban round-ID backfill (Issue #979).
 *
 * WHY THIS EXISTS
 * ---------------
 * `Round.sorobanRoundId` is set at creation from the Soroban contract, but
 * `RoundService.startRound` never captures it: `sorobanService.createRound`
 * returns `void`, so the local `sorobanRoundId` stays `null` and every
 * UP_DOWN round is stored without its on-chain id. Downstream code that
 * joins a DB round to its on-chain round (reconciliation, the active-round
 * API) then has nothing to join on.
 *
 * This service scans the rounds that are missing the id and fills in the
 * ones it can prove, from the chain. The backfill logic lives here;
 * `scripts/backfill-soroban-round-ids.ts` is only the command-line wrapper.
 *
 * WHAT THE CHAIN CAN (AND CANNOT) PROVE
 * --------------------------------------
 * The contract exposes exactly two round reads: `get_active_round` (the
 * one live round) and `get_last_round_id` (the creation counter). There is
 * no `get_round(id)` and no round listing, so the only on-chain round a
 * backfill can ever observe is the currently active one. A DB round is
 * therefore matchable only when it is the live round, and only when the
 * match is unique:
 *
 *   - mode matches (UpDown <-> UP_DOWN, Precision <-> LEGENDS), and
 *   - start price matches, compared in the contract's scaled integer
 *     space (XLM x 10_000) using the same expression `createRound` uses,
 *     so no float rounding can disagree with what was written on chain,
 *   - exactly one DB candidate matches, and
 *   - no other DB row already claims that on-chain id.
 *
 * Everything else is reported and skipped, never filled:
 *
 *   - LEGENDS rounds are never created on the contract (`startRound` only
 *     calls `createRound` for UP_DOWN), so they have no on-chain id.
 *   - Rounds with `isSoroban: false` had no contract call at creation
 *     (Soroban was unavailable), so they have no on-chain round either.
 *   - RESOLVED / CANCELLED / PENDING rounds are no longer the active
 *     round, and the contract keeps no history to match them against.
 *   - A match shared by two or more DB rounds is ambiguous: two rounds
 *     can legitimately start at the same price, so filling either one
 *     would be guessing.
 *
 * Sequential inference from `get_last_round_id` is deliberately NOT used:
 * `createRound` can fail fail-open (the DB round is still created, with
 * no on-chain round), rounds can be created outside this backend, and the
 * offset between DB creation order and chain ids is unknown. Counting
 * backwards from the last id would assign ids to rounds that never had
 * them. The last id is reported only as a chain-head diagnostic.
 *
 * Dry-run by default: pass `{ dryRun: false }` to write the matched ids.
 */

// On-chain `price_start` is scaled by 10_000 (4 decimals) — the same scale
// `SorobanService.createRound` uses when it writes the round.
const PRICE_SCALE = 10_000;

/** DB round statuses that can still be the on-chain active round. */
const LIVE_STATUSES = ["ACTIVE", "LOCKED"] as const;

/** Minimal shape of the on-chain round the backfill reads. */
export interface OnChainRoundRef {
  round_id: bigint | number | string;
  /** Contract round mode: 0 = UpDown, 1 = Precision. */
  mode: number;
  price_start: bigint | number | string;
}

/** Why a round missing its Soroban id was left untouched. */
export type BackfillSkipReason =
  | "not_soroban"
  | "legends"
  | "not_live"
  | "chain_unavailable"
  | "no_active_round"
  | "no_match"
  | "ambiguous"
  | "already_linked"
  | "write_failed";

/** One round examined by the backfill. */
export interface SorobanRoundBackfillEntry {
  roundId: string;
  /** The on-chain id that was (or would be) written, when matched. */
  sorobanRoundId: string | null;
  outcome: "matched" | "skipped";
  reason?: BackfillSkipReason;
  detail?: string;
}

/** Outcome of a backfill run (dry-run or applied). */
export interface SorobanRoundBackfillReport {
  /** true = nothing was written; false = the matched ids were written. */
  dryRun: boolean;
  generatedAt: string;
  /** True when at least one chain read succeeded. */
  chainReachable: boolean;
  /** Last round id on the contract, or null when the chain could not be read. */
  chainLastRoundId: number | null;
  /** Id of the on-chain active round, or null when there is none. */
  chainActiveRoundId: string | null;
  roundsExamined: number;
  roundsMatched: number;
  roundsRepaired: number;
  roundsSkipped: number;
  entries: SorobanRoundBackfillEntry[];
  warnings: string[];
}

/** Options accepted by {@link backfillSorobanRoundIds}. */
export interface BackfillSorobanRoundIdsOptions {
  /**
   * When true (the default) nothing is written and the report only
   * describes what would be backfilled.
   */
  dryRun?: boolean;
  /** Restrict the backfill to these DB round ids. */
  roundIds?: string[];
}

interface MissingRound {
  id: string;
  mode: "UP_DOWN" | "LEGENDS";
  status: string;
  startPrice: Decimal | number | string;
  isSoroban: boolean;
  createdAt: Date;
}

/**
 * Narrows an on-chain round mode into the API's discriminated shape.
 * Throws instead of silently defaulting so an unrecognized mode value
 * (e.g. a contract ABI change) fails loudly rather than matching the
 * wrong round.
 *
 * This mirrors `resolveRoundMode` in `src/utils/soroban-round.mapper.ts`
 * and must agree with it (0 is UP_DOWN, 1 is LEGENDS). It is duplicated
 * rather than imported because the mapper statically imports
 * `@tevalabs/xelma-bindings`, whose vendored CJS build is ESM syntax and
 * cannot load under ts-node — the runtime every `scripts/*.ts` CLI runs
 * under. The compiled app (ESM) is unaffected.
 */
function resolveOnChainRoundMode(mode: number): "UP_DOWN" | "LEGENDS" {
  switch (mode) {
    case 0:
      return "UP_DOWN";
    case 1:
      return "LEGENDS";
    default:
      throw new Error(`Unsupported Soroban round mode: ${String(mode)}`);
  }
}

/**
 * The contract's scaled integer price for a DB round's start price — the
 * same expression `createRound` uses, so the comparison reproduces exactly
 * what was written on chain.
 */
export function scaledStartPrice(
  startPrice: Decimal | number | string,
): string {
  return toDecimal(startPrice).mul(PRICE_SCALE).toFixed(0);
}

/**
 * Scans the rounds missing `sorobanRoundId` and fills in the ones that can
 * be proven from the on-chain active round (see the module docstring for
 * the matching rules). Dry-run by default: pass `{ dryRun: false }` to
 * write the matched ids.
 */
export async function backfillSorobanRoundIds(
  options: BackfillSorobanRoundIdsOptions = {},
): Promise<SorobanRoundBackfillReport> {
  const dryRun = options.dryRun !== false;
  const roundIds = options.roundIds;
  const warnings: string[] = [];

  // ---- Chain state -------------------------------------------------------
  // Both reads are fail-open (null on failure), so a failure here degrades
  // to "nothing matchable" instead of aborting the scan — the report still
  // lists every missing round and why it was skipped.
  let chainLastRoundId: number | null = null;
  let activeRound: OnChainRoundRef | null = null;
  try {
    chainLastRoundId = await sorobanService.getLastRoundId();
  } catch (error) {
    warnings.push(
      `getLastRoundId failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    logger.warn("Soroban round-ID backfill: getLastRoundId failed", { error });
  }
  try {
    activeRound = await sorobanService.getActiveRound();
  } catch (error) {
    warnings.push(
      `getActiveRound failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    logger.warn("Soroban round-ID backfill: getActiveRound failed", { error });
  }

  const chainReachable = chainLastRoundId !== null || activeRound !== null;

  let chainMode: "UP_DOWN" | "LEGENDS" | null = null;
  let chainPriceScaled: string | null = null;
  let chainActiveRoundId: string | null = null;
  if (activeRound) {
    try {
      chainMode = resolveOnChainRoundMode(activeRound.mode);
      chainPriceScaled = String(activeRound.price_start);
      chainActiveRoundId = String(activeRound.round_id);
    } catch (error) {
      // An unrecognized mode (e.g. a contract ABI change) must fail loudly
      // for the match, not silently match the wrong round.
      warnings.push(
        `Active on-chain round has an unsupported mode: ${error instanceof Error ? error.message : String(error)}`,
      );
      logger.warn(
        "Soroban round-ID backfill: active round mode unsupported, skipping match",
        { error },
      );
    }
  }

  // ---- DB rounds missing their Soroban id --------------------------------
  const where: Prisma.RoundWhereInput = { sorobanRoundId: null };
  if (roundIds && roundIds.length > 0) {
    where.id = { in: roundIds };
  }
  const missing = (await prisma.round.findMany({
    where,
    select: {
      id: true,
      mode: true,
      status: true,
      startPrice: true,
      isSoroban: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  })) as MissingRound[];

  // The scope is enforced here as well as in the query, so a scoped run can
  // never report on (or write) a round outside the requested ids.
  const scoped =
    roundIds && roundIds.length > 0
      ? missing.filter((round) => roundIds.includes(round.id))
      : missing;

  // If the active round's id is already claimed by another row, the chain
  // round is already linked and no candidate may take its id.
  let claimedBy: string | null = null;
  if (chainActiveRoundId) {
    const claimed = await prisma.round.findUnique({
      where: { sorobanRoundId: chainActiveRoundId },
      select: { id: true },
    });
    claimedBy = claimed?.id ?? null;
  }

  // ---- Classify each missing round ---------------------------------------
  const entries: SorobanRoundBackfillEntry[] = [];
  const candidates: MissingRound[] = [];

  for (const round of scoped) {
    const skip = (
      reason: BackfillSkipReason,
      detail?: string,
    ): SorobanRoundBackfillEntry => ({
      roundId: round.id,
      sorobanRoundId: null,
      outcome: "skipped",
      reason,
      detail,
    });

    if (round.mode === "LEGENDS") {
      entries.push(
        skip(
          "legends",
          "LEGENDS rounds are never created on the Soroban contract",
        ),
      );
      continue;
    }
    if (!round.isSoroban) {
      entries.push(
        skip(
          "not_soroban",
          "Soroban was unavailable at creation, so no on-chain round exists for it",
        ),
      );
      continue;
    }
    if (!(LIVE_STATUSES as readonly string[]).includes(round.status)) {
      entries.push(
        skip(
          "not_live",
          `Status is ${round.status}; the contract only exposes the active round, so a finished round cannot be matched`,
        ),
      );
      continue;
    }
    if (!chainReachable) {
      entries.push(
        skip("chain_unavailable", "The Soroban contract could not be read"),
      );
      continue;
    }
    if (!chainActiveRoundId || !chainMode || !chainPriceScaled) {
      entries.push(
        skip(
          "no_active_round",
          "The contract has no active round to match against",
        ),
      );
      continue;
    }
    if (claimedBy) {
      entries.push(
        skip(
          "already_linked",
          `On-chain round ${chainActiveRoundId} is already linked to round ${claimedBy}`,
        ),
      );
      continue;
    }
    if (
      round.mode !== chainMode ||
      scaledStartPrice(round.startPrice) !== chainPriceScaled
    ) {
      entries.push(
        skip(
          "no_match",
          `Mode/start price do not match the active on-chain round ${chainActiveRoundId}`,
        ),
      );
      continue;
    }

    candidates.push(round);
  }

  // ---- Match: exactly one candidate may take the active round's id -------
  let roundsRepaired = 0;
  if (candidates.length === 1 && chainActiveRoundId) {
    const round = candidates[0];
    const entry: SorobanRoundBackfillEntry = {
      roundId: round.id,
      sorobanRoundId: chainActiveRoundId,
      outcome: "matched",
    };
    entries.push(entry);

    if (!dryRun) {
      try {
        await prisma.round.update({
          where: { id: round.id },
          data: { sorobanRoundId: chainActiveRoundId },
        });
        roundsRepaired += 1;
      } catch (error) {
        entry.outcome = "skipped";
        entry.sorobanRoundId = null;
        entry.reason = "write_failed";
        entry.detail =
          error instanceof Error ? error.message : String(error);
        logger.error("Soroban round-ID backfill: failed to write round id", {
          roundId: round.id,
          error,
        });
      }
    }
  } else if (candidates.length > 1 && chainActiveRoundId) {
    const competing = candidates.map((round) => round.id).join(", ");
    for (const round of candidates) {
      entries.push({
        roundId: round.id,
        sorobanRoundId: null,
        outcome: "skipped",
        reason: "ambiguous",
        detail: `On-chain round ${chainActiveRoundId} matches ${candidates.length} rounds (${competing}); refusing to guess which one it is`,
      });
    }
  }

  // Keep the report in creation order: the candidates were classified last
  // above, so re-sort by the order the rounds were examined.
  const examinedOrder = new Map(scoped.map((round, index) => [round.id, index]));
  entries.sort(
    (a, b) =>
      (examinedOrder.get(a.roundId) ?? 0) - (examinedOrder.get(b.roundId) ?? 0),
  );

  const roundsMatched = entries.filter(
    (entry) => entry.outcome === "matched",
  ).length;
  const roundsSkipped = entries.filter(
    (entry) => entry.outcome === "skipped",
  ).length;

  logger.info("Soroban round-ID backfill complete", {
    dryRun,
    chainLastRoundId,
    chainActiveRoundId,
    roundsExamined: scoped.length,
    roundsMatched,
    roundsRepaired,
    roundsSkipped,
  });

  return {
    dryRun,
    generatedAt: new Date().toISOString(),
    chainReachable,
    chainLastRoundId,
    chainActiveRoundId,
    roundsExamined: scoped.length,
    roundsMatched,
    roundsRepaired,
    roundsSkipped,
    entries,
    warnings,
  };
}

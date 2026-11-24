import { prisma } from "../lib/prisma";
import { MOCK_PLATFORM_STATS } from "../data/mockData";
import { statsCacheTtlSeconds } from "../utils/http-cache";
import { serializeMoney, toDecimal } from "../utils/decimal.util";
import {
    isPredictionCorrect,
    isRoundSettled,
    type PredictionOutcomePrediction,
    type PredictionOutcomeRound,
} from "../utils/prediction-outcome.util";
import type { Prisma } from "@prisma/client";
import type { Decimal } from "@prisma/client/runtime/library";
import logger from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlatformStats {
    totalRounds: number;
    totalUsers: number;
    totalBets: number;
    /** true = mock constants were served (DATA_MODE=mock or DB unreachable); false = live DB counts */
    isFallback: boolean;
    cachedAt: string; // ISO-8601 timestamp
}

// ---------------------------------------------------------------------------
// In-process cache (replaces a Redis dep for a 30–60 s TTL)
// ---------------------------------------------------------------------------

/**
 * The origin-side cache lives for exactly as long as the public cache window
 * advertised to the CDN (Issue #876). If the origin kept serving 30-second-old
 * counters while the edge revalidated every few seconds, the short
 * `Cache-Control` on `GET /api/stats` would be cosmetic.
 */
function cacheTtlMs(): number {
    return statsCacheTtlSeconds() * 1000;
}

let cachedStats: PlatformStats | null = null;
let cacheExpiresAt = 0;

function getCached(): PlatformStats | null {
    if (cachedStats && Date.now() < cacheExpiresAt) {
        return cachedStats;
    }
    return null;
}

function setCache(stats: PlatformStats): void {
    cachedStats = stats;
    cacheExpiresAt = Date.now() + cacheTtlMs();
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

/**
 * Returns aggregated platform statistics.
 *
 * Behaviour depends on DATA_MODE and database state:
 *   DATA_MODE=mock            → returns MOCK_PLATFORM_STATS with isFallback=true
 *   DATA_MODE=live (or unset) → queries the database:
 *     • DB has data           → returns live counts with isFallback=false
 *     • DB empty              → returns zero counts with isFallback=false
 *     • DB unreachable        → returns MOCK_PLATFORM_STATS with isFallback=true
 *
 * An empty production database returns legitimate zeros (isFallback=false)
 * so dashboards can distinguish "no data yet" from "reading mock constants".
 */
export async function getPlatformStats(): Promise<PlatformStats> {
    // 1. Return cached value if still fresh
    const hit = getCached();
    if (hit) return hit;

    // 2. In mock mode, skip the DB entirely and return seed constants
    if (process.env.DATA_MODE === "mock") {
        const stats: PlatformStats = {
            ...MOCK_PLATFORM_STATS,
            isFallback: true,
            cachedAt: new Date().toISOString(),
        };
        setCache(stats);
        return stats;
    }

    // 3. Query DB (live mode)
    let totalRounds = 0;
    let totalUsers = 0;
    let totalBets = 0;
    let dbAvailable = true;

    try {
        [totalRounds, totalUsers, totalBets] = await Promise.all([
            prisma.round.count(),
            prisma.user.count(),
            prisma.prediction.count({
                where: {
                    chainStatus: { in: ['CONFIRMED', 'NOT_REQUIRED'] },
                },
            }),
        ]);
    } catch (err) {
        dbAvailable = false;
        logger.error("[stats.service] DB query failed, using mock fallback:", {
          error: err instanceof Error ? err.message : String(err),
        });
    }

    // 4. DB unreachable → fall back to mock constants (with isFallback=true)
    if (!dbAvailable) {
        const stats: PlatformStats = {
            ...MOCK_PLATFORM_STATS,
            isFallback: true,
            cachedAt: new Date().toISOString(),
        };
        setCache(stats);
        return stats;
    }

    // 5. DB responded — return live (possibly zero) counts with isFallback=false
    const stats: PlatformStats = {
        totalRounds,
        totalUsers,
        totalBets,
        isFallback: false,
        cachedAt: new Date().toISOString(),
    };
    setCache(stats);
    return stats;
}

/**
 * Manually invalidate the stats cache.
 * Call this after any significant write (e.g. round resolution, new user) if
 * you want the next GET /api/stats to reflect the change immediately rather
 * than waiting for TTL expiry.
 */
export function invalidateStatsCache(): void {
    cachedStats = null;
    cacheExpiresAt = 0;
}

// ---------------------------------------------------------------------------
// UserStats rebuild / drift detection (Issue #877)
// ---------------------------------------------------------------------------

/**
 * WHY A REBUILD
 * -------------
 * `UserStats` is a *materialized* projection: every settled prediction bumps
 * its counters by one (see `updateUserStatsForRound` in
 * `src/services/leaderboard.service.ts`). Incremental maintenance drifts:
 *
 *   - a round resolution that is retried counts the same predictions twice;
 *   - a crash between the prediction write and the stats write loses a count;
 *   - a manual fix-up or a backfill never reaches the projection;
 *   - the projection is written for rounds that were later corrected.
 *
 * Nothing in the request path can detect that: the counters *look* plausible.
 * The only way to know whether the projection still matches reality is to
 * recompute it from the source of truth (the prediction history) and compare.
 *
 * That is what {@link rebuildUserStats} does. It is **dry-run by default**:
 * it reports the drift without touching a single row, so it is safe to run
 * against production. `scripts/rebuild-user-stats.ts` wraps it as a CLI.
 */

/** Chain states of a prediction that counts towards the stats projection. */
const SETTLED_CHAIN_STATUSES = ["CONFIRMED", "NOT_REQUIRED"] as const;

/** The nine fields of the `UserStats` projection, in a stable order. */
export const USER_STATS_FIELDS = [
    "totalPredictions",
    "correctPredictions",
    "totalEarnings",
    "upDownWins",
    "upDownLosses",
    "upDownEarnings",
    "legendsWins",
    "legendsLosses",
    "legendsEarnings",
] as const;

export type UserStatsField = (typeof USER_STATS_FIELDS)[number];

/** The money fields of the projection (serialized as 8-dp decimal strings). */
const USER_STATS_MONEY_FIELDS = new Set<UserStatsField>([
    "totalEarnings",
    "upDownEarnings",
    "legendsEarnings",
]);

/** A user's rebuilt stats, with money fields as 8-dp decimal strings. */
export interface UserStatsTotals {
    totalPredictions: number;
    correctPredictions: number;
    totalEarnings: string;
    upDownWins: number;
    upDownLosses: number;
    upDownEarnings: string;
    legendsWins: number;
    legendsLosses: number;
    legendsEarnings: string;
}

/** A single field that differs between the stored row and the rebuild. */
export interface UserStatsFieldDrift {
    field: UserStatsField;
    /** Rebuilt value, or `null` when the user has no stored row at all. */
    expected: string | number | null;
    /** Stored value, or `null` when the user has no stored row at all. */
    actual: string | number | null;
}

/** Drift for one user. */
export interface UserStatsUserDrift {
    userId: string;
    fields: UserStatsFieldDrift[];
}

/**
 * Platform-wide drift for one field of the projection (Issue #1032).
 *
 * Per-user drift answers "which rows are wrong?"; the aggregate answers "how
 * wrong is the projection as a whole?" — e.g. the leaderboard is over-counting
 * 42 predictions and 310.5 XLM of earnings in total. Totals are summed over
 * every examined user (not only the drifted ones), so `expectedTotal` is what
 * the projection should add up to and `storedTotal` what it does add up to.
 */
export interface UserStatsFieldAggregate {
    field: UserStatsField;
    /** Users whose value of this field drifted. */
    usersDrifted: number;
    /** Sum of the rebuilt values (8-dp string for money fields). */
    expectedTotal: string | number;
    /** Sum of the stored values; a missing row counts as 0. */
    storedTotal: string | number;
    /** `storedTotal - expectedTotal`: positive = over-counted, negative = under-counted. */
    delta: string | number;
}

/** Aggregate view of the drift across all examined users (Issue #1032). */
export interface UserStatsAggregateDrift {
    /** Users with settled predictions but no stored row. */
    missingRows: number;
    /** Stored rows whose user has no settled prediction yet a non-zero projection. */
    orphanRows: number;
    /** One entry per projection field, in {@link USER_STATS_FIELDS} order. */
    fields: UserStatsFieldAggregate[];
}

/** Outcome of a rebuild run (dry-run or applied). */
export interface UserStatsRebuildReport {
    /** true = nothing was written; false = the drifted rows were rewritten. */
    dryRun: boolean;
    /** ISO-8601 timestamp of the run. */
    generatedAt: string;
    /** Users considered (stored rows plus users with settled predictions). */
    usersExamined: number;
    /** Users whose stored row differs from the rebuild. */
    usersWithDrift: number;
    /** Total number of drifted fields across all users. */
    driftFieldCount: number;
    /** Per-user drift detail. */
    drift: UserStatsUserDrift[];
    /** Platform-wide totals of the drift, field by field. */
    aggregate: UserStatsAggregateDrift;
    /** Users rewritten (always 0 in dry-run mode). */
    usersRepaired: number;
}

/** Options accepted by {@link rebuildUserStats}. */
export interface RebuildUserStatsOptions {
    /**
     * When true (the default) nothing is written and the report only
     * describes the drift.
     */
    dryRun?: boolean;
    /** Restrict the rebuild to these user ids. */
    userIds?: string[];
    /**
     * Number of predictions read per query while scanning the history
     * (default {@link DEFAULT_REBUILD_BATCH_SIZE}). The scan is cursor-paginated
     * so a rebuild never loads the whole prediction table into memory at once.
     */
    batchSize?: number;
}

/** Default page size of the prediction-history scan. */
export const DEFAULT_REBUILD_BATCH_SIZE = 1000;

/** Mutable accumulator used while aggregating the prediction history. */
interface MutableTotals {
    totalPredictions: number;
    correctPredictions: number;
    totalEarnings: Decimal;
    upDownWins: number;
    upDownLosses: number;
    upDownEarnings: Decimal;
    legendsWins: number;
    legendsLosses: number;
    legendsEarnings: Decimal;
}

function emptyTotals(): MutableTotals {
    return {
        totalPredictions: 0,
        correctPredictions: 0,
        totalEarnings: toDecimal(0),
        upDownWins: 0,
        upDownLosses: 0,
        upDownEarnings: toDecimal(0),
        legendsWins: 0,
        legendsLosses: 0,
        legendsEarnings: toDecimal(0),
    };
}

function toSnapshot(totals: MutableTotals): UserStatsTotals {
    return {
        totalPredictions: totals.totalPredictions,
        correctPredictions: totals.correctPredictions,
        totalEarnings: serializeMoney(totals.totalEarnings),
        upDownWins: totals.upDownWins,
        upDownLosses: totals.upDownLosses,
        upDownEarnings: serializeMoney(totals.upDownEarnings),
        legendsWins: totals.legendsWins,
        legendsLosses: totals.legendsLosses,
        legendsEarnings: serializeMoney(totals.legendsEarnings),
    };
}

function normalizeBatchSize(batchSize: number | undefined): number {
    if (batchSize === undefined) return DEFAULT_REBUILD_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
        throw new Error(`batchSize must be a positive integer, got ${batchSize}`);
    }
    return batchSize;
}

type HistoryPrediction = PredictionOutcomePrediction & {
    userId: string;
    amount: Decimal | number | string;
    round: (PredictionOutcomeRound & { mode: string }) | null;
};

/** Folds one prediction of the history into the per-user accumulator. */
function accumulatePrediction(
    totals: Map<string, MutableTotals>,
    prediction: HistoryPrediction,
): void {
    const round = prediction.round;
    // A round without an end price was never settled, so the incremental
    // writer never counted it either.
    if (!round || !isRoundSettled(round)) return;

    const isCorrect = isPredictionCorrect(prediction, round);
    const amount = toDecimal(prediction.amount);
    const earnings = isCorrect ? amount : amount.negated();

    const entry = totals.get(prediction.userId) ?? emptyTotals();
    entry.totalPredictions += 1;
    if (isCorrect) entry.correctPredictions += 1;
    entry.totalEarnings = entry.totalEarnings.add(earnings);

    if (round.mode === "UP_DOWN") {
        if (isCorrect) entry.upDownWins += 1;
        else entry.upDownLosses += 1;
        entry.upDownEarnings = entry.upDownEarnings.add(earnings);
    } else if (round.mode === "LEGENDS") {
        if (isCorrect) entry.legendsWins += 1;
        else entry.legendsLosses += 1;
        entry.legendsEarnings = entry.legendsEarnings.add(earnings);
    }

    totals.set(prediction.userId, entry);
}

/**
 * Aggregates the prediction history into the per-user stats projection.
 *
 * The rules mirror `updateUserStatsForRound` exactly:
 *   - only predictions whose chain status is CONFIRMED / NOT_REQUIRED count;
 *   - only *settled* rounds count (a round without an end price was never
 *     applied by the incremental writer, which refuses to run on it);
 *   - a correct prediction earns `+amount`, a wrong one earns `-amount`;
 *   - the mode counters only move for the mode of the round.
 */
export async function computeUserStatsTotals(
    userIds?: string[],
    options: { batchSize?: number } = {},
): Promise<Map<string, UserStatsTotals>> {
    const batchSize = normalizeBatchSize(options.batchSize);
    const where: Prisma.PredictionWhereInput = {
        chainStatus: { in: [...SETTLED_CHAIN_STATUSES] },
    };
    if (userIds && userIds.length > 0) {
        where.userId = { in: userIds };
    }

    const totals = new Map<string, MutableTotals>();
    let cursor: string | undefined;

    // Keyset pagination on the primary key: stable under concurrent inserts
    // and bounded in memory regardless of the size of the history.
    for (;;) {
        const predictions = await prisma.prediction.findMany({
            where,
            orderBy: { id: "asc" },
            take: batchSize,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: {
                id: true,
                userId: true,
                amount: true,
                side: true,
                priceRange: true,
                round: {
                    select: { mode: true, startPrice: true, endPrice: true },
                },
            },
        });

        for (const prediction of predictions) {
            accumulatePrediction(totals, prediction);
        }

        if (predictions.length < batchSize) break;
        const last = predictions[predictions.length - 1];
        if (!last?.id || last.id === cursor) break;
        cursor = last.id;
    }

    const snapshots = new Map<string, UserStatsTotals>();
    for (const [userId, entry] of totals) {
        snapshots.set(userId, toSnapshot(entry));
    }
    return snapshots;
}

/** Compares a rebuilt snapshot with a stored row, field by field. */
function diffUserStats(
    userId: string,
    expected: UserStatsTotals,
    actual: {
        totalPredictions: number;
        correctPredictions: number;
        totalEarnings: Decimal | number | string;
        upDownWins: number;
        upDownLosses: number;
        upDownEarnings: Decimal | number | string;
        legendsWins: number;
        legendsLosses: number;
        legendsEarnings: Decimal | number | string;
    } | null,
): UserStatsUserDrift | null {
    const fields: UserStatsFieldDrift[] = [];

    for (const field of USER_STATS_FIELDS) {
        if (!actual) {
            fields.push({ field, expected: expected[field], actual: null });
            continue;
        }

        if (USER_STATS_MONEY_FIELDS.has(field)) {
            const expectedValue = expected[field] as string;
            const actualValue = serializeMoney(actual[field]);
            if (!toDecimal(expectedValue).eq(toDecimal(actualValue))) {
                fields.push({ field, expected: expectedValue, actual: actualValue });
            }
            continue;
        }

        const expectedValue = expected[field] as number;
        const actualValue = actual[field] as number;
        if (expectedValue !== actualValue) {
            fields.push({ field, expected: expectedValue, actual: actualValue });
        }
    }

    if (fields.length === 0) return null;
    return { userId, fields };
}

type StoredUserStats = NonNullable<Parameters<typeof diffUserStats>[2]>;

/**
 * Sums expected vs stored values across users to produce the platform-wide
 * view of the drift (Issue #1032). Money is summed with Decimal, never floats.
 */
class AggregateDriftAccumulator {
    private missingRows = 0;
    private orphanRows = 0;
    private readonly expected = new Map<UserStatsField, Decimal>();
    private readonly stored = new Map<UserStatsField, Decimal>();
    private readonly drifted = new Map<UserStatsField, number>();

    constructor() {
        for (const field of USER_STATS_FIELDS) {
            this.expected.set(field, toDecimal(0));
            this.stored.set(field, toDecimal(0));
            this.drifted.set(field, 0);
        }
    }

    add(
        expected: UserStatsTotals,
        stored: StoredUserStats | null,
        drift: UserStatsUserDrift | null,
        hasHistory: boolean,
    ): void {
        if (!stored && hasHistory) this.missingRows += 1;
        if (stored && !hasHistory && drift) this.orphanRows += 1;

        for (const field of USER_STATS_FIELDS) {
            this.expected.set(field, this.expected.get(field)!.add(toDecimal(expected[field])));
            if (stored) {
                this.stored.set(field, this.stored.get(field)!.add(toDecimal(stored[field])));
            }
        }
        for (const fieldDrift of drift?.fields ?? []) {
            this.drifted.set(fieldDrift.field, this.drifted.get(fieldDrift.field)! + 1);
        }
    }

    toReport(): UserStatsAggregateDrift {
        const format = (field: UserStatsField, value: Decimal): string | number =>
            USER_STATS_MONEY_FIELDS.has(field) ? serializeMoney(value) : value.toNumber();

        return {
            missingRows: this.missingRows,
            orphanRows: this.orphanRows,
            fields: USER_STATS_FIELDS.map((field) => {
                const expectedTotal = this.expected.get(field)!;
                const storedTotal = this.stored.get(field)!;
                return {
                    field,
                    usersDrifted: this.drifted.get(field)!,
                    expectedTotal: format(field, expectedTotal),
                    storedTotal: format(field, storedTotal),
                    delta: format(field, storedTotal.sub(expectedTotal)),
                };
            }),
        };
    }
}

/**
 * Recomputes the `UserStats` projection from the prediction history and
 * reports (or repairs) the drift.
 *
 * Dry-run by default: pass `{ dryRun: false }` to write the rebuilt rows.
 */
export async function rebuildUserStats(
    options: RebuildUserStatsOptions = {},
): Promise<UserStatsRebuildReport> {
    const dryRun = options.dryRun !== false;
    const userIds = options.userIds;

    const rebuilt = await computeUserStatsTotals(userIds, {
        batchSize: options.batchSize,
    });

    const storedWhere: Prisma.UserStatsWhereInput = {};
    if (userIds && userIds.length > 0) {
        storedWhere.userId = { in: userIds };
    }
    const storedRows = await prisma.userStats.findMany({ where: storedWhere });

    // The DB filter already restricts the rows, but the scope is enforced
    // here as well so a rebuild scoped to a user can never touch (or report
    // on) anybody else.
    const scopedRows =
        userIds && userIds.length > 0
            ? storedRows.filter((row) => userIds.includes(row.userId))
            : storedRows;
    const storedByUser = new Map(scopedRows.map((row) => [row.userId, row]));

    // Users with predictions but without a stored row are drift too, and so are
    // stored rows whose user no longer has any settled prediction.
    const userIdSet = new Set<string>([
        ...rebuilt.keys(),
        ...storedByUser.keys(),
    ]);

    const drift: UserStatsUserDrift[] = [];
    const aggregate = new AggregateDriftAccumulator();
    for (const userId of userIdSet) {
        const expected = rebuilt.get(userId) ?? toSnapshot(emptyTotals());
        const stored = storedByUser.get(userId) ?? null;
        const entry = diffUserStats(userId, expected, stored);
        aggregate.add(expected, stored, entry, rebuilt.has(userId));
        if (entry) drift.push(entry);
    }

    let usersRepaired = 0;
    if (!dryRun) {
        for (const entry of drift) {
            const expected = rebuilt.get(entry.userId) ?? toSnapshot(emptyTotals());
            await prisma.userStats.upsert({
                where: { userId: entry.userId },
                create: {
                    userId: entry.userId,
                    totalPredictions: expected.totalPredictions,
                    correctPredictions: expected.correctPredictions,
                    totalEarnings: toDecimal(expected.totalEarnings),
                    upDownWins: expected.upDownWins,
                    upDownLosses: expected.upDownLosses,
                    upDownEarnings: toDecimal(expected.upDownEarnings),
                    legendsWins: expected.legendsWins,
                    legendsLosses: expected.legendsLosses,
                    legendsEarnings: toDecimal(expected.legendsEarnings),
                },
                update: {
                    totalPredictions: expected.totalPredictions,
                    correctPredictions: expected.correctPredictions,
                    totalEarnings: toDecimal(expected.totalEarnings),
                    upDownWins: expected.upDownWins,
                    upDownLosses: expected.upDownLosses,
                    upDownEarnings: toDecimal(expected.upDownEarnings),
                    legendsWins: expected.legendsWins,
                    legendsLosses: expected.legendsLosses,
                    legendsEarnings: toDecimal(expected.legendsEarnings),
                },
            });
            usersRepaired += 1;
        }
    }

    const driftFieldCount = drift.reduce((sum, entry) => sum + entry.fields.length, 0);

    return {
        dryRun,
        generatedAt: new Date().toISOString(),
        usersExamined: userIdSet.size,
        usersWithDrift: drift.length,
        driftFieldCount,
        drift,
        aggregate: aggregate.toReport(),
        usersRepaired,
    };
}
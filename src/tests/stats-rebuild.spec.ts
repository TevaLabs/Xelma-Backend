/**
 * Tests for the UserStats rebuild / drift detection (Issue #877).
 *
 * Run:  npx jest src/tests/stats-rebuild.spec.ts
 */

// ---------------------------------------------------------------------------
// Mock Prisma so these tests never touch a real database
// ---------------------------------------------------------------------------

const mockPredictionFindMany = jest.fn();
const mockUserStatsFindMany = jest.fn();
const mockUserStatsUpsert = jest.fn();

jest.mock("@prisma/client", () => ({
    PrismaClient: jest.fn().mockImplementation(() => ({
        prediction: { findMany: mockPredictionFindMany },
        userStats: {
            findMany: mockUserStatsFindMany,
            upsert: mockUserStatsUpsert,
        },
    })),
}));

import {
    rebuildUserStats,
    computeUserStatsTotals,
} from "../services/stats.service";
import { toDecimal } from "../utils/decimal.util";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A settled UP_DOWN round. */
function upDownRound(startPrice: string, endPrice: string | null) {
    return { mode: "UP_DOWN", startPrice: toDecimal(startPrice), endPrice: endPrice === null ? null : toDecimal(endPrice) };
}

/** A settled LEGENDS round. */
function legendsRound(startPrice: string, endPrice: string | null) {
    return { mode: "LEGENDS", startPrice: toDecimal(startPrice), endPrice: endPrice === null ? null : toDecimal(endPrice) };
}

function prediction(overrides: Record<string, unknown> = {}) {
    return {
        userId: "user-1",
        amount: toDecimal("10"),
        side: "UP",
        priceRange: null,
        round: upDownRound("1", "2"),
        ...overrides,
    };
}

function storedRow(overrides: Record<string, unknown> = {}) {
    return {
        userId: "user-1",
        totalPredictions: 1,
        correctPredictions: 1,
        totalEarnings: toDecimal("10"),
        upDownWins: 1,
        upDownLosses: 0,
        upDownEarnings: toDecimal("10"),
        legendsWins: 0,
        legendsLosses: 0,
        legendsEarnings: toDecimal("0"),
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockPredictionFindMany.mockResolvedValue([]);
    mockUserStatsFindMany.mockResolvedValue([]);
    mockUserStatsUpsert.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

describe("computeUserStatsTotals", () => {
    it("counts a correct UP_DOWN prediction as a win and positive earnings", async () => {
        mockPredictionFindMany.mockResolvedValue([prediction()]);

        const totals = await computeUserStatsTotals();

        expect(totals.get("user-1")).toEqual({
            totalPredictions: 1,
            correctPredictions: 1,
            totalEarnings: "10.00000000",
            upDownWins: 1,
            upDownLosses: 0,
            upDownEarnings: "10.00000000",
            legendsWins: 0,
            legendsLosses: 0,
            legendsEarnings: "0.00000000",
        });
    });

    it("counts a wrong UP_DOWN prediction as a loss and negative earnings", async () => {
        mockPredictionFindMany.mockResolvedValue([
            prediction({ side: "DOWN", round: upDownRound("1", "2") }),
        ]);

        const totals = await computeUserStatsTotals();

        expect(totals.get("user-1")).toMatchObject({
            totalPredictions: 1,
            correctPredictions: 0,
            totalEarnings: "-10.00000000",
            upDownWins: 0,
            upDownLosses: 1,
            upDownEarnings: "-10.00000000",
        });
    });

    it("ignores predictions whose round was never settled", async () => {
        mockPredictionFindMany.mockResolvedValue([
            prediction({ round: upDownRound("1", null) }),
        ]);

        const totals = await computeUserStatsTotals();

        expect(totals.size).toBe(0);
    });

    it("keeps UP_DOWN and LEGENDS counters in their own buckets", async () => {
        mockPredictionFindMany.mockResolvedValue([
            prediction({ round: upDownRound("1", "2") }),
            prediction({
                amount: toDecimal("5"),
                side: null,
                priceRange: { min: 1, max: 3 },
                round: legendsRound("1", "2"),
            }),
        ]);

        const totals = await computeUserStatsTotals();

        expect(totals.get("user-1")).toMatchObject({
            totalPredictions: 2,
            correctPredictions: 2,
            totalEarnings: "15.00000000",
            upDownWins: 1,
            upDownEarnings: "10.00000000",
            legendsWins: 1,
            legendsEarnings: "5.00000000",
        });
    });

    it("treats a LEGENDS prediction outside its price range as a loss", async () => {
        mockPredictionFindMany.mockResolvedValue([
            prediction({
                side: null,
                priceRange: { min: 5, max: 6 },
                round: legendsRound("1", "2"),
            }),
        ]);

        const totals = await computeUserStatsTotals();

        expect(totals.get("user-1")).toMatchObject({
            correctPredictions: 0,
            legendsWins: 0,
            legendsLosses: 1,
            legendsEarnings: "-10.00000000",
        });
    });

    it("only reads predictions that already reached a settled chain status", async () => {
        await computeUserStatsTotals();

        expect(mockPredictionFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    chainStatus: { in: ["CONFIRMED", "NOT_REQUIRED"] },
                }),
            }),
        );
    });

    it("scopes the query to the requested users", async () => {
        await computeUserStatsTotals(["user-1"]);

        expect(mockPredictionFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ userId: { in: ["user-1"] } }),
            }),
        );
    });
});

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

describe("rebuildUserStats — dry run", () => {
    it("is a dry run by default and writes nothing", async () => {
        mockPredictionFindMany.mockResolvedValue([prediction()]);
        mockUserStatsFindMany.mockResolvedValue([storedRow()]);

        const report = await rebuildUserStats();

        expect(report.dryRun).toBe(true);
        expect(report.usersRepaired).toBe(0);
        expect(mockUserStatsUpsert).not.toHaveBeenCalled();
    });

    it("reports no drift when the stored row matches the history", async () => {
        mockPredictionFindMany.mockResolvedValue([prediction()]);
        mockUserStatsFindMany.mockResolvedValue([storedRow()]);

        const report = await rebuildUserStats();

        expect(report.usersWithDrift).toBe(0);
        expect(report.driftFieldCount).toBe(0);
        expect(report.drift).toHaveLength(0);
        expect(report.usersExamined).toBe(1);
    });

    it("reports the drifted fields of a stale row", async () => {
        mockPredictionFindMany.mockResolvedValue([
            prediction(),
            prediction({ amount: toDecimal("5"), side: "DOWN", round: upDownRound("1", "2") }),
        ]);
        mockUserStatsFindMany.mockResolvedValue([storedRow()]);

        const report = await rebuildUserStats();

        expect(report.usersWithDrift).toBe(1);
        expect(report.driftFieldCount).toBeGreaterThan(0);

        const driftedFields = report.drift[0].fields.map((field) => field.field);
        expect(driftedFields).toContain("totalPredictions");
        expect(driftedFields).toContain("totalEarnings");
        expect(driftedFields).toContain("upDownLosses");
        expect(driftedFields).toContain("upDownEarnings");
        // The correct-prediction count is unchanged: one win, one loss.
        expect(driftedFields).not.toContain("correctPredictions");

        const earnings = report.drift[0].fields.find(
            (field) => field.field === "totalEarnings",
        );
        expect(earnings?.expected).toBe("5.00000000");
        expect(earnings?.actual).toBe("10.00000000");
    });

    it("flags a user that has predictions but no stored row at all", async () => {
        mockPredictionFindMany.mockResolvedValue([prediction()]);
        mockUserStatsFindMany.mockResolvedValue([]);

        const report = await rebuildUserStats();

        expect(report.usersWithDrift).toBe(1);
        expect(report.drift[0].userId).toBe("user-1");
        expect(report.drift[0].fields.every((field) => field.actual === null)).toBe(true);
    });

    it("flags a stored row whose user no longer has any settled prediction", async () => {
        mockPredictionFindMany.mockResolvedValue([]);
        mockUserStatsFindMany.mockResolvedValue([storedRow()]);

        const report = await rebuildUserStats();

        expect(report.usersWithDrift).toBe(1);
        expect(report.drift[0].fields.length).toBeGreaterThan(0);
    });

    it("ignores rows that are not in the requested scope", async () => {
        mockPredictionFindMany.mockResolvedValue([]);
        mockUserStatsFindMany.mockResolvedValue([storedRow({ userId: "other-user" })]);

        const report = await rebuildUserStats({ userIds: ["user-1"] });

        expect(report.usersWithDrift).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Applying the rebuild
// ---------------------------------------------------------------------------

describe("rebuildUserStats — apply", () => {
    it("rewrites the drifted row with the rebuilt values", async () => {
        mockPredictionFindMany.mockResolvedValue([prediction()]);
        mockUserStatsFindMany.mockResolvedValue([
            storedRow({ totalPredictions: 4, totalEarnings: toDecimal("0") }),
        ]);

        const report = await rebuildUserStats({ dryRun: false });

        expect(report.dryRun).toBe(false);
        expect(report.usersRepaired).toBe(1);
        expect(mockUserStatsUpsert).toHaveBeenCalledTimes(1);

        const call = mockUserStatsUpsert.mock.calls[0][0];
        expect(call.where).toEqual({ userId: "user-1" });
        expect(call.update).toMatchObject({
            totalPredictions: 1,
            correctPredictions: 1,
            upDownWins: 1,
            upDownLosses: 0,
        });
        expect(toDecimal(call.update.totalEarnings).toString()).toBe("10");
    });

    it("does not write anything when there is no drift", async () => {
        mockPredictionFindMany.mockResolvedValue([prediction()]);
        mockUserStatsFindMany.mockResolvedValue([storedRow()]);

        const report = await rebuildUserStats({ dryRun: false });

        expect(report.usersRepaired).toBe(0);
        expect(mockUserStatsUpsert).not.toHaveBeenCalled();
    });
});

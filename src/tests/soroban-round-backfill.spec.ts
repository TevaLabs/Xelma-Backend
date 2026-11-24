/**
 * Tests for the Soroban round-ID backfill (Issue #979).
 *
 * Run:  npx jest src/tests/soroban-round-backfill.spec.ts
 *
 * The backfill can only ever observe the on-chain ACTIVE round (the
 * contract exposes no history and no lookup by id), so these tests drive
 * the service with a mocked chain reader and a mocked Prisma client:
 *   - a live DB round whose mode + scaled start price match the active
 *     on-chain round is filled;
 *   - everything else is reported and skipped, never filled — including
 *     ambiguous matches, where two rounds share the active round's price.
 */

// ---------------------------------------------------------------------------
// Mock Prisma so these tests never touch a real database
// ---------------------------------------------------------------------------

const mockRoundFindMany = jest.fn();
const mockRoundFindUnique = jest.fn();
const mockRoundUpdate = jest.fn();

jest.mock("@prisma/client", () => ({
    PrismaClient: jest.fn().mockImplementation(() => ({
        round: {
            findMany: mockRoundFindMany,
            findUnique: mockRoundFindUnique,
            update: mockRoundUpdate,
        },
    })),
}));

// ---------------------------------------------------------------------------
// Mock the Soroban chain reader
// ---------------------------------------------------------------------------

const mockGetActiveRound = jest.fn();
const mockGetLastRoundId = jest.fn();

jest.mock("../services/soroban.service", () => ({
    __esModule: true,
    default: {
        getActiveRound: mockGetActiveRound,
        getLastRoundId: mockGetLastRoundId,
    },
}));

import {
    backfillSorobanRoundIds,
    scaledStartPrice,
} from "../services/soroban-round-backfill.service";
import { toDecimal } from "../utils/decimal.util";
import { RoundMode } from "@tevalabs/xelma-bindings";
import { createActiveUpDownRound } from "./fixtures/soroban-rounds";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A DB round missing its Soroban id. Price $1.2345 matches the fixture chain round. */
function dbRound(overrides: Record<string, unknown> = {}) {
    return {
        id: "round-1",
        mode: "UP_DOWN",
        status: "ACTIVE",
        startPrice: toDecimal("1.2345"),
        isSoroban: true,
        createdAt: new Date("2026-11-20T00:00:00.000Z"),
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockRoundFindMany.mockResolvedValue([]);
    mockRoundFindUnique.mockResolvedValue(null);
    mockRoundUpdate.mockResolvedValue({});
    mockGetActiveRound.mockResolvedValue(null);
    mockGetLastRoundId.mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// Price scaling (shared with createRound)
// ---------------------------------------------------------------------------

describe("scaledStartPrice", () => {
    it("scales a start price exactly like createRound does", () => {
        expect(scaledStartPrice(toDecimal("1.2345"))).toBe("12345");
        expect(scaledStartPrice("1.2345")).toBe("12345");
        expect(scaledStartPrice(toDecimal("0.2297"))).toBe("2297");
    });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe("backfillSorobanRoundIds — dry run", () => {
    it("is a dry run by default and writes nothing", async () => {
        mockRoundFindMany.mockResolvedValue([dbRound()]);
        mockGetActiveRound.mockResolvedValue(createActiveUpDownRound());

        const report = await backfillSorobanRoundIds();

        expect(report.dryRun).toBe(true);
        expect(report.roundsMatched).toBe(1);
        expect(report.roundsRepaired).toBe(0);
        expect(mockRoundUpdate).not.toHaveBeenCalled();
    });

    it("matches the live round by mode and scaled start price", async () => {
        mockRoundFindMany.mockResolvedValue([dbRound()]);
        mockGetActiveRound.mockResolvedValue(createActiveUpDownRound());
        mockGetLastRoundId.mockResolvedValue(42);

        const report = await backfillSorobanRoundIds();

        expect(report.chainLastRoundId).toBe(42);
        expect(report.chainActiveRoundId).toBe("42");
        expect(report.roundsExamined).toBe(1);
        expect(report.entries).toHaveLength(1);
        expect(report.entries[0]).toEqual({
            roundId: "round-1",
            sorobanRoundId: "42",
            outcome: "matched",
        });
        expect(mockRoundFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ sorobanRoundId: null }),
            }),
        );
    });

    it("does not match a round whose start price differs", async () => {
        mockRoundFindMany.mockResolvedValue([
            dbRound({ startPrice: toDecimal("1.2346") }),
        ]);
        mockGetActiveRound.mockResolvedValue(createActiveUpDownRound());

        const report = await backfillSorobanRoundIds();

        expect(report.roundsMatched).toBe(0);
        expect(report.entries[0].outcome).toBe("skipped");
        expect(report.entries[0].reason).toBe("no_match");
        expect(mockRoundUpdate).not.toHaveBeenCalled();
    });

    it("does not match a round of the other mode", async () => {
        mockRoundFindMany.mockResolvedValue([dbRound()]);
        mockGetActiveRound.mockResolvedValue(
            createActiveUpDownRound({ mode: RoundMode.Precision, price_start: BigInt(12345) }),
        );

        const report = await backfillSorobanRoundIds();

        expect(report.roundsMatched).toBe(0);
        expect(report.entries[0].reason).toBe("no_match");
    });

    it("skips non-Soroban rounds even when the price matches", async () => {
        mockRoundFindMany.mockResolvedValue([dbRound({ isSoroban: false })]);
        mockGetActiveRound.mockResolvedValue(createActiveUpDownRound());

        const report = await backfillSorobanRoundIds();

        expect(report.roundsMatched).toBe(0);
        expect(report.entries[0].reason).toBe("not_soroban");
        expect(mockRoundUpdate).not.toHaveBeenCalled();
    });

    it("skips LEGENDS rounds: they are never created on chain", async () => {
        mockRoundFindMany.mockResolvedValue([
            dbRound({ mode: "LEGENDS", isSoroban: false }),
        ]);
        mockGetActiveRound.mockResolvedValue(createActiveUpDownRound());

        const report = await backfillSorobanRoundIds();

        expect(report.roundsMatched).toBe(0);
        expect(report.entries[0].reason).toBe("legends");
    });

    it("skips finished rounds: the contract keeps no history", async () => {
        mockRoundFindMany.mockResolvedValue([
            dbRound({ status: "RESOLVED" }),
            dbRound({ id: "round-2", status: "CANCELLED" }),
            dbRound({ id: "round-3", status: "PENDING" }),
        ]);
        mockGetActiveRound.mockResolvedValue(createActiveUpDownRound());

        const report = await backfillSorobanRoundIds();

        expect(report.roundsMatched).toBe(0);
        expect(report.roundsSkipped).toBe(3);
        expect(report.entries.every((entry) => entry.reason === "not_live")).toBe(true);
    });

    it("skips everything when the chain has no active round", async () => {
        mockRoundFindMany.mockResolvedValue([dbRound()]);
        mockGetActiveRound.mockResolvedValue(null);
        mockGetLastRoundId.mockResolvedValue(7);

        const report = await backfillSorobanRoundIds();

        expect(report.chainReachable).toBe(true);
        expect(report.chainActiveRoundId).toBeNull();
        expect(report.roundsMatched).toBe(0);
        expect(report.entries[0].reason).toBe("no_active_round");
    });

    it("skips everything when the chain cannot be read at all", async () => {
        mockRoundFindMany.mockResolvedValue([dbRound()]);
        mockGetActiveRound.mockResolvedValue(null);
        mockGetLastRoundId.mockResolvedValue(null);

        const report = await backfillSorobanRoundIds();

        expect(report.chainReachable).toBe(false);
        expect(report.roundsMatched).toBe(0);
        expect(report.entries[0].reason).toBe("chain_unavailable");
    });

    it("refuses an ambiguous match instead of guessing", async () => {
        mockRoundFindMany.mockResolvedValue([
            dbRound({ id: "round-1" }),
            dbRound({ id: "round-2" }),
        ]);
        mockGetActiveRound.mockResolvedValue(createActiveUpDownRound());

        const report = await backfillSorobanRoundIds();

        expect(report.roundsMatched).toBe(0);
        expect(report.roundsSkipped).toBe(2);
        expect(
            report.entries.every((entry) => entry.reason === "ambiguous"),
        ).toBe(true);
        expect(mockRoundUpdate).not.toHaveBeenCalled();
    });

    it("skips when the active round is already linked to another row", async () => {
        mockRoundFindMany.mockResolvedValue([dbRound()]);
        mockRoundFindUnique.mockResolvedValue({ id: "round-other" });
        mockGetActiveRound.mockResolvedValue(createActiveUpDownRound());

        const report = await backfillSorobanRoundIds();

        expect(report.roundsMatched).toBe(0);
        expect(report.entries[0].reason).toBe("already_linked");
        expect(mockRoundUpdate).not.toHaveBeenCalled();
    });

    it("scopes the query to the requested rounds", async () => {
        mockRoundFindMany.mockResolvedValue([dbRound()]);
        mockGetActiveRound.mockResolvedValue(createActiveUpDownRound());

        await backfillSorobanRoundIds({ roundIds: ["round-1"] });

        expect(mockRoundFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    sorobanRoundId: null,
                    id: { in: ["round-1"] },
                }),
            }),
        );
    });

    it("still matches a LOCKED round: it is still the live on-chain round", async () => {
        mockRoundFindMany.mockResolvedValue([dbRound({ status: "LOCKED" })]);
        mockGetActiveRound.mockResolvedValue(createActiveUpDownRound());

        const report = await backfillSorobanRoundIds();

        expect(report.roundsMatched).toBe(1);
        expect(report.entries[0].sorobanRoundId).toBe("42");
    });
});

// ---------------------------------------------------------------------------
// Applying the backfill
// ---------------------------------------------------------------------------

describe("backfillSorobanRoundIds — apply", () => {
    it("writes the matched id", async () => {
        mockRoundFindMany.mockResolvedValue([dbRound()]);
        mockGetActiveRound.mockResolvedValue(createActiveUpDownRound());

        const report = await backfillSorobanRoundIds({ dryRun: false });

        expect(report.dryRun).toBe(false);
        expect(report.roundsRepaired).toBe(1);
        expect(mockRoundUpdate).toHaveBeenCalledTimes(1);
        expect(mockRoundUpdate).toHaveBeenCalledWith({
            where: { id: "round-1" },
            data: { sorobanRoundId: "42" },
        });
    });

    it("does not write anything when there is no match", async () => {
        mockRoundFindMany.mockResolvedValue([
            dbRound({ startPrice: toDecimal("9.9999") }),
        ]);
        mockGetActiveRound.mockResolvedValue(createActiveUpDownRound());

        const report = await backfillSorobanRoundIds({ dryRun: false });

        expect(report.roundsRepaired).toBe(0);
        expect(mockRoundUpdate).not.toHaveBeenCalled();
    });

    it("is idempotent: a second run finds nothing to fill", async () => {
        mockRoundFindMany.mockResolvedValue([dbRound()]);
        mockGetActiveRound.mockResolvedValue(createActiveUpDownRound());

        const first = await backfillSorobanRoundIds({ dryRun: false });
        expect(first.roundsRepaired).toBe(1);

        // After the apply the round has its id, so the scan finds nothing.
        mockRoundFindMany.mockResolvedValue([]);
        const second = await backfillSorobanRoundIds({ dryRun: false });

        expect(second.roundsMatched).toBe(0);
        expect(second.roundsRepaired).toBe(0);
        expect(mockRoundUpdate).toHaveBeenCalledTimes(1);
    });

    it("marks the entry skipped when the write fails", async () => {
        mockRoundFindMany.mockResolvedValue([dbRound()]);
        mockGetActiveRound.mockResolvedValue(createActiveUpDownRound());
        mockRoundUpdate.mockRejectedValue(new Error("unique constraint"));

        const report = await backfillSorobanRoundIds({ dryRun: false });

        expect(report.roundsRepaired).toBe(0);
        expect(report.roundsMatched).toBe(0);
        expect(report.entries[0].outcome).toBe("skipped");
        expect(report.entries[0].reason).toBe("write_failed");
    });
});

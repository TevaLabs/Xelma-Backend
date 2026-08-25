/**
 * Tests for src/services/stats.service.ts
 *
 * Run:  npx jest src/tests/stats.service.spec.ts
 */

// ---------------------------------------------------------------------------
// Mock Prisma so these tests never touch a real database
// ---------------------------------------------------------------------------

const mockCount = jest.fn();

jest.mock("../lib/prisma", () => ({
    prisma: {
        round: { count: mockCount },
        user: { count: mockCount },
        prediction: { count: mockCount },
    },
}));

// ---------------------------------------------------------------------------
// The module under test must be imported *after* the mocks are set up
// ---------------------------------------------------------------------------

import {
    getPlatformStats,
    invalidateStatsCache,
} from "../services/stats.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
    jest.clearAllMocks();
    invalidateStatsCache();
    // Ensure we start in live mode (DATA_MODE unset → live)
    delete process.env.DATA_MODE;
});

// ---------------------------------------------------------------------------
// Tests — live mode (DATA_MODE unset or live)
// ---------------------------------------------------------------------------

describe("getPlatformStats — live mode", () => {
    it("returns live DB values when data exists", async () => {
        mockCount
            .mockResolvedValueOnce(10) // rounds
            .mockResolvedValueOnce(5) // users
            .mockResolvedValueOnce(30); // predictions/bets

        const stats = await getPlatformStats();

        expect(stats.isFallback).toBe(false);
        expect(stats.totalRounds).toBe(10);
        expect(stats.totalUsers).toBe(5);
        expect(stats.totalBets).toBe(30);
        expect(stats.cachedAt).toBeTruthy();
    });

    it("returns zero counts with isFallback=false when DB is empty", async () => {
        mockCount.mockResolvedValue(0);

        const stats = await getPlatformStats();

        expect(stats.isFallback).toBe(false);
        expect(stats.totalRounds).toBe(0);
        expect(stats.totalUsers).toBe(0);
        expect(stats.totalBets).toBe(0);
    });

    it("returns mock fallback with isFallback=true when DB throws", async () => {
        mockCount.mockRejectedValue(new Error("connection refused"));

        const stats = await getPlatformStats();

        expect(stats.isFallback).toBe(true);
    });

    it("serves cached value on second call within TTL", async () => {
        mockCount
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(9);

        const first = await getPlatformStats();
        const second = await getPlatformStats();

        expect(mockCount).toHaveBeenCalledTimes(3);
        expect(second.totalRounds).toBe(first.totalRounds);
    });

    it("re-queries after cache is manually invalidated", async () => {
        mockCount
            .mockResolvedValueOnce(5)
            .mockResolvedValueOnce(2)
            .mockResolvedValueOnce(12)
            .mockResolvedValueOnce(6)
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(15);

        await getPlatformStats();
        invalidateStatsCache();
        const fresh = await getPlatformStats();

        expect(mockCount).toHaveBeenCalledTimes(6);
        expect(fresh.totalRounds).toBe(6);
    });
});

// ---------------------------------------------------------------------------
// Tests — mock mode (DATA_MODE=mock)
// ---------------------------------------------------------------------------

describe("getPlatformStats — mock mode", () => {
    it("returns MOCK_PLATFORM_STATS with isFallback=true when DATA_MODE=mock", async () => {
        process.env.DATA_MODE = "mock";

        const stats = await getPlatformStats();

        expect(stats.isFallback).toBe(true);
        expect(mockCount).not.toHaveBeenCalled(); // DB should not be touched
    });

    it("returns mock data regardless of DB state", async () => {
        process.env.DATA_MODE = "mock";
        // Even if DB would return data, mock mode skips it
        mockCount
            .mockResolvedValueOnce(100)
            .mockResolvedValueOnce(50)
            .mockResolvedValueOnce(200);

        const stats = await getPlatformStats();

        expect(stats.isFallback).toBe(true);
        expect(mockCount).not.toHaveBeenCalled();
    });

    it("serves cached mock value on second call within TTL", async () => {
        process.env.DATA_MODE = "mock";

        const first = await getPlatformStats();
        const second = await getPlatformStats();

        expect(mockCount).toHaveBeenCalledTimes(0);
        expect(second.isFallback).toBe(true);
        expect(second.totalRounds).toBe(first.totalRounds);
    });

    it("re-queries mock data after cache invalidation", async () => {
        process.env.DATA_MODE = "mock";

        const first = await getPlatformStats();
        invalidateStatsCache();
        const fresh = await getPlatformStats();

        expect(fresh.isFallback).toBe(true);
    });
});
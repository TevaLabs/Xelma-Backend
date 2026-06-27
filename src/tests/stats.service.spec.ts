/**
 * Tests for src/services/stats.service.ts
 *
 * Run:  npx jest src/tests/stats.service.spec.ts
 */

// ---------------------------------------------------------------------------
// Mock Prisma so these tests never touch a real database
// ---------------------------------------------------------------------------

const mockCount = jest.fn();

jest.mock("@prisma/client", () => ({
    PrismaClient: jest.fn().mockImplementation(() => ({
        round: { count: mockCount },
        user: { count: mockCount },
        prediction: { count: mockCount },
    })),
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
    invalidateStatsCache(); // start every test with a cold cache
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getPlatformStats", () => {
    it("returns live DB values when data exists", async () => {
        // Each call to count() returns a different value via sequential mocking
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

    it("returns mock fallback when all counts are zero (empty DB)", async () => {
        mockCount.mockResolvedValue(0); // every count() returns 0

        const stats = await getPlatformStats();

        expect(stats.isFallback).toBe(true);
        // Fallback values should equal the mock constants (all 0 in this project)
        expect(stats.totalRounds).toBeGreaterThanOrEqual(0);
        expect(stats.totalUsers).toBeGreaterThanOrEqual(0);
        expect(stats.totalBets).toBeGreaterThanOrEqual(0);
    });

    it("returns mock fallback when DB throws", async () => {
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
        const second = await getPlatformStats(); // should hit cache

        // Prisma should only have been called once (3 counts for the first call)
        expect(mockCount).toHaveBeenCalledTimes(3);
        expect(second.totalRounds).toBe(first.totalRounds);
    });

    it("re-queries after cache is manually invalidated", async () => {
        mockCount
            .mockResolvedValueOnce(5)
            .mockResolvedValueOnce(2)
            .mockResolvedValueOnce(12)
            // second batch after invalidation
            .mockResolvedValueOnce(6)
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(15);

        await getPlatformStats(); // prime cache
        invalidateStatsCache();
        const fresh = await getPlatformStats(); // should re-query

        expect(mockCount).toHaveBeenCalledTimes(6); // 3 + 3
        expect(fresh.totalRounds).toBe(6);
    });
});
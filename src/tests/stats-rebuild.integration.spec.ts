/**
 * UserStats rebuild integration tests (Issue #877).
 *
 * These tests drive the rebuild against a real database, proving that:
 *   - the rebuild recomputes the projection from the prediction history;
 *   - a drifted row is reported field by field and can be repaired;
 *   - a projection that still matches the history is left alone;
 *   - predictions of rounds that were never settled are ignored.
 *
 * They follow the same describeIfDb pattern as the other integration suites so
 * they run only when a database is available.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from "@jest/globals";
import { prisma } from "../lib/prisma";
import { rebuildUserStats } from "../services/stats.service";

const shouldRunDbTests =
    process.env.RUN_DB_TESTS === "true" ||
    process.env.CI === "true" ||
    (global as any).hasDb;

const describeDb = shouldRunDbTests ? describe : describe.skip;

describeDb("UserStats rebuild (Issue #877)", () => {
    beforeAll(async () => {
        if (shouldRunDbTests) {
            try {
                await prisma.$queryRaw`SELECT 1`;
            } catch (error) {
                throw new Error(
                    "Database unavailable for the UserStats rebuild tests. Ensure DATABASE_URL is configured.",
                );
            }
        }
    });

    afterEach(async () => {
        await prisma.userStats.deleteMany({});
        await prisma.prediction.deleteMany({});
        await prisma.round.deleteMany({});
        await prisma.user.deleteMany({});
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    async function createUser() {
        return prisma.user.create({
            data: {
                walletAddress: `G_REBUILD_${Date.now()}_${Math.random().toString(36).substring(7)}`,
                virtualBalance: 1000,
            },
        });
    }

    async function createResolvedRound(startPrice: string, endPrice: string | null) {
        return prisma.round.create({
            data: {
                mode: "UP_DOWN",
                status: endPrice === null ? "PENDING" : "RESOLVED",
                startPrice,
                endPrice,
                startTime: new Date(),
                endTime: new Date(),
            },
        });
    }

    it("reports drift and repairs the stored row", async () => {
        const user = await createUser();
        const round = await createResolvedRound("1", "2");

        await prisma.prediction.create({
            data: {
                userId: user.id,
                roundId: round.id,
                side: "UP",
                amount: 10,
                chainStatus: "CONFIRMED",
            },
        });

        // A stale projection: the counters were never updated.
        await prisma.userStats.create({
            data: { userId: user.id, totalPredictions: 3, totalEarnings: 0 },
        });

        const dryRun = await rebuildUserStats();

        expect(dryRun.dryRun).toBe(true);
        expect(dryRun.usersWithDrift).toBe(1);
        expect(dryRun.usersRepaired).toBe(0);

        const entry = dryRun.drift.find((item) => item.userId === user.id);
        expect(entry).toBeDefined();

        const driftedFields = entry!.fields.map((field) => field.field);
        expect(driftedFields).toContain("totalPredictions");
        expect(driftedFields).toContain("totalEarnings");

        const earnings = entry!.fields.find((field) => field.field === "totalEarnings");
        expect(earnings?.expected).toBe("10.00000000");

        // The dry run must not have touched the row.
        const untouched = await prisma.userStats.findUnique({ where: { userId: user.id } });
        expect(untouched?.totalPredictions).toBe(3);

        const applied = await rebuildUserStats({ dryRun: false });

        expect(applied.dryRun).toBe(false);
        expect(applied.usersRepaired).toBe(1);

        const repaired = await prisma.userStats.findUnique({ where: { userId: user.id } });
        expect(repaired?.totalPredictions).toBe(1);
        expect(repaired?.correctPredictions).toBe(1);
        expect(repaired?.upDownWins).toBe(1);
        expect(repaired?.upDownLosses).toBe(0);
        expect(repaired?.totalEarnings.toString()).toBe("10");

        // A second dry run must now be clean.
        const after = await rebuildUserStats();
        expect(after.usersWithDrift).toBe(0);
    });

    it("ignores predictions whose round was never settled", async () => {
        const user = await createUser();
        const round = await createResolvedRound("1", null);

        await prisma.prediction.create({
            data: {
                userId: user.id,
                roundId: round.id,
                side: "UP",
                amount: 10,
                chainStatus: "CONFIRMED",
            },
        });

        // A projection that already counts the unsettled round — the rebuild
        // must consider it drift, because the incremental writer never counts
        // a round without an end price.
        await prisma.userStats.create({
            data: {
                userId: user.id,
                totalPredictions: 1,
                correctPredictions: 1,
                totalEarnings: 10,
                upDownWins: 1,
                upDownEarnings: 10,
            },
        });

        const report = await rebuildUserStats();

        expect(report.usersExamined).toBe(1);
        expect(report.usersWithDrift).toBe(1);

        const entry = report.drift.find((item) => item.userId === user.id);
        expect(entry).toBeDefined();

        const totalPredictions = entry!.fields.find(
            (field) => field.field === "totalPredictions",
        );
        expect(totalPredictions?.expected).toBe(0);
        expect(totalPredictions?.actual).toBe(1);

        const earnings = entry!.fields.find((field) => field.field === "totalEarnings");
        expect(earnings?.expected).toBe("0.00000000");

        // Repairing brings the row back to the "nothing counted" state.
        await rebuildUserStats({ dryRun: false });
        const repaired = await prisma.userStats.findUnique({ where: { userId: user.id } });
        expect(repaired?.totalPredictions).toBe(0);
        expect(repaired?.totalEarnings.toString()).toBe("0");
    });

    it("only rebuilds the users it is scoped to", async () => {
        const user = await createUser();
        const otherUser = await createUser();
        const round = await createResolvedRound("1", "2");

        await prisma.prediction.create({
            data: {
                userId: user.id,
                roundId: round.id,
                side: "UP",
                amount: 10,
                chainStatus: "CONFIRMED",
            },
        });

        await prisma.userStats.create({
            data: { userId: otherUser.id, totalPredictions: 7 },
        });

        const report = await rebuildUserStats({ userIds: [user.id] });

        expect(report.usersExamined).toBe(1);
        expect(report.drift.every((item) => item.userId === user.id)).toBe(true);
    });
});

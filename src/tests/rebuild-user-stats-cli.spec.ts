/**
 * Tests for the UserStats recompute CLI helpers (Issue #1032).
 *
 * Run:  npx jest src/tests/rebuild-user-stats-cli.spec.ts
 */
import {
    parseRebuildArgs,
    formatRebuildReport,
    rebuildExitCode,
} from "../utils/rebuild-user-stats-cli";
import {
    USER_STATS_FIELDS,
    type UserStatsRebuildReport,
} from "../services/stats.service";

function cleanReport(overrides: Partial<UserStatsRebuildReport> = {}): UserStatsRebuildReport {
    return {
        dryRun: true,
        generatedAt: "2026-11-24T00:00:00.000Z",
        usersExamined: 2,
        usersWithDrift: 0,
        driftFieldCount: 0,
        drift: [],
        aggregate: {
            missingRows: 0,
            orphanRows: 0,
            fields: USER_STATS_FIELDS.map((field) => ({
                field,
                usersDrifted: 0,
                expectedTotal: 0,
                storedTotal: 0,
                delta: 0,
            })),
        },
        usersRepaired: 0,
        ...overrides,
    };
}

function driftedReport(users: number, overrides: Partial<UserStatsRebuildReport> = {}) {
    const base = cleanReport();
    return cleanReport({
        usersExamined: users,
        usersWithDrift: users,
        driftFieldCount: users,
        drift: Array.from({ length: users }, (_, index) => ({
            userId: `user-${index + 1}`,
            fields: [{ field: "totalPredictions" as const, expected: 1, actual: 3 }],
        })),
        aggregate: {
            missingRows: 0,
            orphanRows: 0,
            fields: base.aggregate.fields.map((entry) =>
                entry.field === "totalPredictions"
                    ? { ...entry, usersDrifted: users, expectedTotal: users, storedTotal: 3 * users, delta: 2 * users }
                    : entry,
            ),
        },
        ...overrides,
    });
}

describe("parseRebuildArgs", () => {
    it("defaults to a dry run over every user", () => {
        expect(parseRebuildArgs([])).toEqual({
            apply: false,
            json: false,
            userIds: [],
            summaryOnly: false,
            help: false,
        });
    });

    it("parses every flag", () => {
        const options = parseRebuildArgs([
            "--apply",
            "--json",
            "--summary",
            "--user",
            "a",
            "--user=b",
            "--batch-size",
            "500",
            "--max-details=10",
        ]);

        expect(options).toEqual({
            apply: true,
            json: true,
            userIds: ["a", "b"],
            summaryOnly: true,
            help: false,
            batchSize: 500,
            maxDetails: 10,
        });
    });

    it("lets a later --dry-run override --apply", () => {
        expect(parseRebuildArgs(["--apply", "--dry-run"]).apply).toBe(false);
    });

    it("recognises -h / --help", () => {
        expect(parseRebuildArgs(["-h"]).help).toBe(true);
        expect(parseRebuildArgs(["--help"]).help).toBe(true);
    });

    it.each([
        [["--user"], "--user requires a user id"],
        [["--user", "--apply"], "--user requires a user id"],
        [["--batch-size"], "--batch-size requires a value"],
        [["--batch-size", "0"], "--batch-size must be a positive integer"],
        [["--batch-size", "1.5"], "--batch-size must be a positive integer"],
        [["--max-details=abc"], "--max-details must be a positive integer"],
        [["--wat"], "Unknown argument: --wat"],
    ])("rejects %j", (argv, message) => {
        expect(() => parseRebuildArgs(argv)).toThrow(message);
    });
});

describe("rebuildExitCode", () => {
    it("is 0 for a clean dry run", () => {
        expect(rebuildExitCode(cleanReport())).toBe(0);
    });

    it("is 1 for a dry run that found drift", () => {
        expect(rebuildExitCode(driftedReport(1))).toBe(1);
    });

    it("is 0 once the drift was applied", () => {
        expect(rebuildExitCode(driftedReport(1, { dryRun: false, usersRepaired: 1 }))).toBe(0);
    });
});

describe("formatRebuildReport", () => {
    it("reports a clean projection", () => {
        const text = formatRebuildReport(cleanReport());

        expect(text).toContain("UserStats rebuild (dry run): 2 user(s) examined, 0 with drift");
        expect(text).toContain("No drift detected.");
        expect(text).not.toContain("Aggregate drift");
    });

    it("prints the aggregate summary for drifted fields only", () => {
        const text = formatRebuildReport(driftedReport(2));

        expect(text).toContain("Aggregate drift (stored - expected): 0 missing row(s), 0 orphan row(s)");
        expect(text).toMatch(/totalPredictions\s+expected\s+2\s+stored\s+6\s+delta\s+\+4\s+\(2 user\(s\)\)/);
        expect(text).not.toMatch(/correctPredictions\s+expected/);
        expect(text).toContain("Drift detected. Re-run with --apply");
    });

    it("prints per-user detail by default", () => {
        const text = formatRebuildReport(driftedReport(2));

        expect(text).toContain("user-1");
        expect(text).toContain("user-2");
        expect(text).toContain("totalPredictions: expected 1, stored 3");
    });

    it("truncates per-user detail with maxDetails", () => {
        const text = formatRebuildReport(driftedReport(3), { maxDetails: 1, summaryOnly: false });

        expect(text).toContain("user-1");
        expect(text).not.toContain("user-2");
        expect(text).toContain("… 2 more user(s) with drift");
    });

    it("omits per-user detail in summary mode", () => {
        const text = formatRebuildReport(driftedReport(2), { summaryOnly: true });

        expect(text).toContain("Aggregate drift");
        expect(text).not.toContain("user-1");
    });

    it("renders a missing row as (no row)", () => {
        const text = formatRebuildReport(
            driftedReport(1, {
                drift: [{ userId: "user-1", fields: [{ field: "totalPredictions", expected: 1, actual: null }] }],
            }),
        );

        expect(text).toContain("totalPredictions: expected 1, stored (no row)");
    });

    it("reports the repaired count for an applied run", () => {
        const text = formatRebuildReport(driftedReport(2, { dryRun: false, usersRepaired: 2 }));

        expect(text).toContain("UserStats rebuild (applied)");
        expect(text).toContain("Repaired 2 user row(s).");
    });
});

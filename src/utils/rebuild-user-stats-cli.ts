/**
 * Pure helpers behind `scripts/rebuild-user-stats.ts` (Issues #877, #1032).
 *
 * The script itself only wires these to `process.argv`, the database and
 * `process.exit`. Keeping argument parsing, report rendering and the exit-code
 * policy here makes the CLI behaviour unit-testable without a database or a
 * child process.
 */
import type {
    UserStatsRebuildReport,
    UserStatsFieldAggregate,
} from "../services/stats.service";

export interface RebuildCliOptions {
    /** Write the rebuilt rows. false (the default) = dry run. */
    apply: boolean;
    /** Print the report as JSON instead of text. */
    json: boolean;
    /** Restrict the run to these user ids (empty = every user). */
    userIds: string[];
    /** Page size of the prediction-history scan (undefined = service default). */
    batchSize?: number;
    /** Max number of per-user drift entries printed in text mode (undefined = all). */
    maxDetails?: number;
    /** Text mode: print only the aggregate summary, no per-user detail. */
    summaryOnly: boolean;
    /** `--help` was requested; the caller prints {@link REBUILD_CLI_USAGE} and exits 0. */
    help: boolean;
}

export const REBUILD_CLI_USAGE = [
    "Usage: ts-node scripts/rebuild-user-stats.ts [options]",
    "",
    "Recomputes the UserStats projection from the prediction history and",
    "reports the drift against the stored rows. Dry run unless --apply is given.",
    "",
    "  --dry-run            report drift without writing (default)",
    "  --apply              rewrite the drifted UserStats rows",
    "  --user <id>          only inspect this user (repeatable)",
    "  --batch-size <n>     predictions read per query (default 1000)",
    "  --max-details <n>    print at most n per-user drift entries (text mode)",
    "  --summary            print only the aggregate drift summary (text mode)",
    "  --json               print the full report as JSON",
    "  -h, --help           show this help",
    "",
    "Exit codes: 0 = no drift (or drift repaired with --apply), 1 = drift found",
    "in a dry run, or the run failed.",
].join("\n");

function parsePositiveInt(flag: string, raw: string | undefined): number {
    if (raw === undefined || raw === "" || raw.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        throw new Error(`${flag} must be a positive integer, got "${raw}"`);
    }
    return Number(raw);
}

/** Parses the CLI arguments (without the `node script` prefix). Throws on bad input. */
export function parseRebuildArgs(argv: string[]): RebuildCliOptions {
    const options: RebuildCliOptions = {
        apply: false,
        json: false,
        userIds: [],
        summaryOnly: false,
        help: false,
    };

    // Supports both `--flag value` and `--flag=value`.
    const valueOf = (index: number, arg: string, flag: string) => {
        if (arg.startsWith(`${flag}=`)) return { value: arg.slice(flag.length + 1), consumed: 0 };
        return { value: argv[index + 1], consumed: 1 };
    };
    const is = (arg: string, flag: string) => arg === flag || arg.startsWith(`${flag}=`);

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === "--apply") {
            options.apply = true;
        } else if (arg === "--dry-run") {
            options.apply = false;
        } else if (arg === "--json") {
            options.json = true;
        } else if (arg === "--summary") {
            options.summaryOnly = true;
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else if (is(arg, "--user")) {
            const { value, consumed } = valueOf(index, arg, "--user");
            if (!value || value.startsWith("--")) throw new Error("--user requires a user id");
            options.userIds.push(value);
            index += consumed;
        } else if (is(arg, "--batch-size")) {
            const { value, consumed } = valueOf(index, arg, "--batch-size");
            options.batchSize = parsePositiveInt("--batch-size", value);
            index += consumed;
        } else if (is(arg, "--max-details")) {
            const { value, consumed } = valueOf(index, arg, "--max-details");
            options.maxDetails = parsePositiveInt("--max-details", value);
            index += consumed;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return options;
}

/**
 * Exit-code policy: a dry run that finds drift is a failed check, which is
 * what makes the command usable as a CI / cron gate. An applied run succeeds
 * once the rows are rewritten.
 */
export function rebuildExitCode(report: UserStatsRebuildReport): number {
    return report.dryRun && report.usersWithDrift > 0 ? 1 : 0;
}

function signed(value: string | number): string {
    const text = String(value);
    return text.startsWith("-") || /^0(\.0+)?$/.test(text) ? text : `+${text}`;
}

function formatAggregateLine(entry: UserStatsFieldAggregate): string {
    return (
        `    ${entry.field.padEnd(20)} ` +
        `expected ${String(entry.expectedTotal).padStart(16)}  ` +
        `stored ${String(entry.storedTotal).padStart(16)}  ` +
        `delta ${signed(entry.delta).padStart(16)}  ` +
        `(${entry.usersDrifted} user(s))`
    );
}

/** Renders the human-readable report printed in text mode. */
export function formatRebuildReport(
    report: UserStatsRebuildReport,
    options: Pick<RebuildCliOptions, "maxDetails" | "summaryOnly"> = { summaryOnly: false },
): string {
    const lines: string[] = [];

    lines.push(
        `UserStats rebuild (${report.dryRun ? "dry run" : "applied"}): ` +
            `${report.usersExamined} user(s) examined, ` +
            `${report.usersWithDrift} with drift, ` +
            `${report.driftFieldCount} drifted field(s)`,
    );

    if (report.usersWithDrift > 0) {
        const { aggregate } = report;
        lines.push("");
        lines.push(
            `  Aggregate drift (stored - expected): ` +
                `${aggregate.missingRows} missing row(s), ${aggregate.orphanRows} orphan row(s)`,
        );
        for (const entry of aggregate.fields) {
            if (entry.usersDrifted > 0) lines.push(formatAggregateLine(entry));
        }
    }

    if (!options.summaryOnly && report.drift.length > 0) {
        const limit = options.maxDetails ?? report.drift.length;
        const shown = report.drift.slice(0, limit);

        for (const entry of shown) {
            lines.push("");
            lines.push(`  ${entry.userId}`);
            for (const field of entry.fields) {
                lines.push(
                    `    ${field.field}: expected ${field.expected ?? "(none)"}, ` +
                        `stored ${field.actual ?? "(no row)"}`,
                );
            }
        }

        const hidden = report.drift.length - shown.length;
        if (hidden > 0) {
            lines.push("");
            lines.push(`  … ${hidden} more user(s) with drift (use --json or raise --max-details)`);
        }
    }

    lines.push("");
    if (report.dryRun) {
        lines.push(
            report.usersWithDrift > 0
                ? "Drift detected. Re-run with --apply to repair the stored rows."
                : "No drift detected.",
        );
    } else {
        lines.push(`Repaired ${report.usersRepaired} user row(s).`);
    }

    return lines.join("\n");
}

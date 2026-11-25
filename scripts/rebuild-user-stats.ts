#!/usr/bin/env ts-node
/**
 * Rebuild the `UserStats` projection from the prediction history (Issue #877).
 *
 * WHY THIS EXISTS
 * ---------------
 * `UserStats` is a materialized projection of the prediction history: every
 * settled prediction bumps its counters by one. That incremental maintenance
 * drifts — a retried round resolution counts twice, a crash between the
 * prediction write and the stats write loses a count, a backfill never reaches
 * the projection. The counters still *look* plausible, so nothing in the
 * request path can detect it.
 *
 * This script recomputes the projection from the source of truth and compares
 * it with the stored rows. The rebuild logic lives in
 * `src/services/stats.service.ts` (`rebuildUserStats`); this file is only the
 * command-line wrapper.
 *
 * USAGE
 *   npm run db:rebuild:user-stats                  # dry run (default): report drift, write nothing
 *   npm run db:rebuild:user-stats -- --apply       # repair the drifted rows
 *   npm run db:rebuild:user-stats -- --user <id>   # scope the run to one user (repeatable)
 *   npm run db:rebuild:user-stats -- --json        # machine-readable report
 *
 * EXIT CODES
 *   0  no drift found (or the drift was repaired with --apply)
 *   1  drift was detected in dry-run mode, or the run failed
 *
 * The dry run is the CI-friendly mode: it exits 1 as soon as the stored rows
 * no longer match the prediction history.
 *
 * Requires DATABASE_URL to point at the database you want to inspect.
 */
import dotenv from "dotenv";

dotenv.config({ override: false });

interface CliOptions {
  apply: boolean;
  json: boolean;
  userIds: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, json: false, userIds: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--user") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--user requires a user id");
      }
      options.userIds.push(value);
      index += 1;
    } else if (arg.startsWith("--user=")) {
      options.userIds.push(arg.slice("--user=".length));
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: ts-node scripts/rebuild-user-stats.ts [options]",
          "",
          "  --dry-run        report drift without writing (default)",
          "  --apply         rewrite the drifted UserStats rows",
          "  --user <id>     only inspect this user (repeatable)",
          "  --json          print the report as JSON",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  // The service pulls in the app configuration, which insists on a JWT secret.
  // The rebuild never touches authentication, so a placeholder is enough to
  // boot the module graph.
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || "xelma-rebuild-user-stats-placeholder-secret";

  const { rebuildUserStats } = await import("../src/services/stats.service");
  const { prisma } = await import("../src/lib/prisma");

  try {
    const report = await rebuildUserStats({
      dryRun: !options.apply,
      userIds: options.userIds.length > 0 ? options.userIds : undefined,
    });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        `UserStats rebuild (${report.dryRun ? "dry run" : "applied"}): ` +
          `${report.usersExamined} user(s) examined, ` +
          `${report.usersWithDrift} with drift, ` +
          `${report.driftFieldCount} drifted field(s)`,
      );

      for (const entry of report.drift) {
        console.log(`\n  ${entry.userId}`);
        for (const field of entry.fields) {
          console.log(
            `    ${field.field}: expected ${field.expected ?? "(none)"}, ` +
              `stored ${field.actual ?? "(no row)"}`,
          );
        }
      }

      if (report.dryRun) {
        console.log(
          report.usersWithDrift > 0
            ? "\nDrift detected. Re-run with --apply to repair the stored rows."
            : "\nNo drift detected.",
        );
      } else {
        console.log(`\nRepaired ${report.usersRepaired} user row(s).`);
      }
    }

    // A dry run that finds drift is a failed check — this is what makes the
    // command usable as a CI gate.
    return report.dryRun && report.usersWithDrift > 0 ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

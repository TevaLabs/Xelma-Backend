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
 * `src/services/stats.service.ts` (`rebuildUserStats`) and the argument
 * parsing / report rendering in `src/utils/rebuild-user-stats-cli.ts`; this
 * file is only the wiring to argv, the database and the process exit code.
 *
 * USAGE
 *   npm run db:rebuild:user-stats                  # dry run (default): report drift, write nothing
 *   npm run db:rebuild:user-stats -- --apply       # repair the drifted rows
 *   npm run db:rebuild:user-stats -- --user <id>   # scope the run to one user (repeatable)
 *   npm run db:rebuild:user-stats -- --json        # machine-readable report
 *   npm run db:rebuild:user-stats -- --summary     # aggregate drift only (Issue #1032)
 *   npm run db:rebuild:user-stats -- --max-details 20 --batch-size 5000
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

async function main(): Promise<number> {
  const {
    parseRebuildArgs,
    formatRebuildReport,
    rebuildExitCode,
    REBUILD_CLI_USAGE,
  } = await import("../src/utils/rebuild-user-stats-cli");

  const options = parseRebuildArgs(process.argv.slice(2));
  if (options.help) {
    console.log(REBUILD_CLI_USAGE);
    return 0;
  }

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
      batchSize: options.batchSize,
    });

    console.log(
      options.json ? JSON.stringify(report, null, 2) : formatRebuildReport(report, options),
    );

    return rebuildExitCode(report);
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

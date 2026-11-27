#!/usr/bin/env ts-node
/**
 * Backfill the missing `sorobanRoundId` on rounds (Issue #979).
 *
 * WHY THIS EXISTS
 * ---------------
 * `Round.sorobanRoundId` is set at creation from the Soroban contract, but
 * `RoundService.startRound` never captures it: `sorobanService.createRound`
 * returns `void`, so the local `sorobanRoundId` stays `null` and every
 * UP_DOWN round is stored without its on-chain id. This script fills in
 * the ids that can be proven from the chain. The backfill logic lives in
 * `src/services/soroban-round-backfill.service.ts` (`backfillSorobanRoundIds`);
 * this file is only the command-line wrapper.
 *
 * WHAT IT CAN MATCH
 * -----------------
 * The contract exposes only the active round (`get_active_round`) and the
 * creation counter (`get_last_round_id`) — no history, no lookup by id. So
 * only the currently live round can be matched, and only when exactly one
 * DB round (UP_DOWN, `isSoroban: true`, ACTIVE or LOCKED) shares its mode
 * and start price. Everything else is reported and skipped, never filled:
 * LEGENDS rounds (never created on chain), non-Soroban rounds, finished
 * rounds, and ambiguous matches. See the service for the full rules.
 *
 * USAGE
 *   npm run db:backfill:soroban-round-ids                  # dry run (default): report what would be filled, write nothing
 *   npm run db:backfill:soroban-round-ids -- --apply       # write the matched ids
 *   npm run db:backfill:soroban-round-ids -- --round <id>  # scope the run to one round (repeatable)
 *   npm run db:backfill:soroban-round-ids -- --json        # machine-readable report
 *
 * EXIT CODES
 *   0  nothing to backfill (or the matched ids were written with --apply)
 *   1  dry-run found rounds to backfill, or the run failed (e.g. the
 *      Soroban contract could not be read at all)
 *
 * The dry run is the CI-friendly mode: it exits 1 as soon as a round is
 * found whose id can be backfilled.
 *
 * Requires DATABASE_URL to point at the database you want to inspect, and
 * the Soroban contract to be reachable (SOROBAN_CONTRACT_ID / SOROBAN_RPC_URL).
 */
import dotenv from "dotenv";

dotenv.config({ override: false });

interface CliOptions {
  apply: boolean;
  json: boolean;
  roundIds: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, json: false, roundIds: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--round") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--round requires a round id");
      }
      options.roundIds.push(value);
      index += 1;
    } else if (arg.startsWith("--round=")) {
      options.roundIds.push(arg.slice("--round=".length));
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: ts-node scripts/backfill-soroban-round-ids.ts [options]",
          "",
          "  --dry-run        report what would be filled without writing (default)",
          "  --apply         write the matched Soroban round ids",
          "  --round <id>    only inspect this round (repeatable)",
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
  // The backfill never touches authentication, so a placeholder is enough to
  // boot the module graph.
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || "xelma-backfill-soroban-rounds-placeholder-secret";

  const { backfillSorobanRoundIds } = await import(
    "../src/services/soroban-round-backfill.service"
  );
  const { prisma } = await import("../src/lib/prisma");

  try {
    const report = await backfillSorobanRoundIds({
      dryRun: !options.apply,
      roundIds: options.roundIds.length > 0 ? options.roundIds : undefined,
    });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        `Soroban round ID backfill (${report.dryRun ? "dry run" : "applied"}): ` +
          `${report.roundsExamined} round(s) missing an id, ` +
          `${report.roundsMatched} matched, ` +
          `${report.roundsSkipped} skipped`,
      );
      console.log(
        `  chain last round id: ${report.chainLastRoundId ?? "(unreachable)"}, ` +
          `active round: ${report.chainActiveRoundId ?? "(none)"}`,
      );

      for (const entry of report.entries) {
        if (entry.outcome === "matched") {
          console.log(
            `  ${entry.roundId} -> soroban ${entry.sorobanRoundId}`,
          );
        } else {
          console.log(
            `  ${entry.roundId} skipped (${entry.reason})` +
              (entry.detail ? `: ${entry.detail}` : ""),
          );
        }
      }

      for (const warning of report.warnings) {
        console.log(`  warning: ${warning}`);
      }

      if (!report.chainReachable) {
        console.log("\nSoroban contract could not be read; nothing was matched.");
      } else if (report.dryRun) {
        console.log(
          report.roundsMatched > 0
            ? "\nRounds found to backfill. Re-run with --apply to write the ids."
            : "\nNothing to backfill.",
        );
      } else {
        console.log(`\nBackfilled ${report.roundsRepaired} round(s).`);
      }
    }

    // A dry run that finds rounds to backfill is a failed check — this is
    // what makes the command usable as a CI gate. A run that could not read
    // the chain at all also fails.
    if (!report.chainReachable) return 1;
    return report.dryRun && report.roundsMatched > 0 ? 1 : 0;
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

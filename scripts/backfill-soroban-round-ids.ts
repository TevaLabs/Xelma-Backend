#!/usr/bin/env ts-node
/**
 * Backfill historical `Round.sorobanRoundId` values (Issue #824).
 *
 * The contract exposes no `get_round` getter, so ids for rounds created before
 * the mapper started persisting them cannot be recovered on-chain. Operators
 * export the `roundId -> sorobanRoundId` pairs from their deployment records
 * and replay them here.
 *
 * Usage:
 *   npx ts-node scripts/backfill-soroban-round-ids.ts --file mapping.json          # dry run
 *   npx ts-node scripts/backfill-soroban-round-ids.ts --file mapping.json --apply  # writes
 *
 * Mapping file: `{ "<roundId>": "<sorobanRoundId>" }` or
 * `[{ "roundId": "...", "sorobanRoundId": "42" }]`.
 */
import fs from 'fs';
import path from 'path';
import { prisma } from '../src/lib/prisma';
import {
  parseSorobanRoundIdMapping,
  planSorobanRoundBackfill,
} from '../src/utils/soroban-round.mapper';

interface CliOptions {
  file?: string;
  apply: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, json: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--file':
      case '-f':
        options.file = argv[++i];
        break;
      case '--apply':
        options.apply = true;
        break;
      case '--dry-run':
        options.apply = false;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage(): string {
  return [
    'Usage: ts-node scripts/backfill-soroban-round-ids.ts --file <mapping.json> [--apply] [--json]',
    '',
    '  --file, -f  JSON mapping of roundId -> sorobanRoundId (required)',
    '  --apply     Persist the plan (default is a dry run)',
    '  --json      Print the plan as JSON',
    '  --help, -h  Show this help',
  ].join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.file) {
    throw new Error(`--file is required\n\n${usage()}`);
  }

  const mappingPath = path.resolve(process.cwd(), options.file);
  const raw = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
  const entries = parseSorobanRoundIdMapping(raw);

  const rounds = await prisma.round.findMany({
    select: { id: true, sorobanRoundId: true },
  });
  const plan = planSorobanRoundBackfill(rounds, entries);

  const summary = {
    mode: options.apply ? 'apply' : 'dry-run',
    mappingPath,
    entries: entries.length,
    updates: plan.updates.length,
    skipped: plan.skipped.length,
    plan,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Mode: ${summary.mode}`);
    console.log(`Mapping: ${mappingPath} (${entries.length} entries)`);
    console.log(`Would update: ${plan.updates.length}`);
    for (const update of plan.updates) {
      console.log(`  ${update.roundId} -> ${update.sorobanRoundId}`);
    }
    console.log(`Skipped: ${plan.skipped.length}`);
    for (const skip of plan.skipped) {
      console.log(`  ${skip.roundId} (${skip.reason})`);
    }
  }

  if (!options.apply) {
    console.log('\nDry run only — re-run with --apply to persist.');
    return;
  }

  const applied = await prisma.$transaction(
    plan.updates.map((update) =>
      prisma.round.updateMany({
        // Guard on `null` so a concurrent writer cannot be overwritten.
        where: { id: update.roundId, sorobanRoundId: null },
        data: { sorobanRoundId: update.sorobanRoundId, isSoroban: true },
      }),
    ),
  );

  const appliedCount = applied.reduce((sum, result) => sum + result.count, 0);
  console.log(`\nApplied ${appliedCount}/${plan.updates.length} updates.`);

  if (appliedCount !== plan.updates.length) {
    throw new Error(
      `Only ${appliedCount} of ${plan.updates.length} rounds were updated; ` +
        'another process may have written sorobanRoundId. Re-run the dry run to inspect.',
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

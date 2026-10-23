# Backfilling `Round.sorobanRoundId` (Issue #824)

Rounds created while the Soroban mapper was not persisting the on-chain id have
`Round.sorobanRoundId = NULL`, so retries, reconciliation, and the frontend
`predictionMetadata.sorobanRoundId` field cannot address them.

The contract exposes no `get_round` getter, so historical ids cannot be
enumerated on-chain. Export the authoritative `roundId -> sorobanRoundId` pairs
from your deployment records and replay them with
`scripts/backfill-soroban-round-ids.ts`.

## Mapping file

Either shape works:

```json
{ "8f1c…": "42", "2b9d…": "43" }
```

```json
[
  { "roundId": "8f1c…", "sorobanRoundId": "42" },
  { "roundId": "2b9d…", "sorobanRoundId": "43" }
]
```

Ids must be positive u64 integers; malformed mappings fail the whole run
instead of silently skipping a round.

## Dry run (default)

```bash
npx ts-node scripts/backfill-soroban-round-ids.ts --file soroban-rounds.json
# or machine-readable:
npx ts-node scripts/backfill-soroban-round-ids.ts --file soroban-rounds.json --json
```

The plan reports every intended update plus skipped entries with a reason:

| Reason | Meaning |
| --- | --- |
| `unknown_round` | `roundId` is not in the database. |
| `already_applied` | The round already has that id — replaying is a no-op. |
| `already_assigned` | The round has a different id; resolved manually. |
| `soroban_id_taken` | Another round (or an earlier entry) owns that id. |

## Apply

```bash
npx ts-node scripts/backfill-soroban-round-ids.ts --file soroban-rounds.json --apply
```

Updates run in a single transaction, each guarded on `sorobanRoundId IS NULL`
so a concurrent writer is never overwritten, and set `isSoroban = true`. If the
guarded count differs from the plan the script exits non-zero and leaves the
rows untouched.

The planner lives in `src/utils/soroban-round.mapper.ts`
(`parseSorobanRoundIdMapping`, `planSorobanRoundBackfill`) and is covered by
`src/tests/soroban-round-backfill.spec.ts`.

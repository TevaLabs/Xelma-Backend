# Migration Safety Guide

This directory contains all Prisma database migrations for Xelma Backend.

Every new migration folder holds the forward `migration.sql` that Prisma
applies, plus a hand-written `down.sql` rollback script that Prisma never runs.
See [Rollback Guidance](#rollback-guidance).

---

## Safety Checklist

Complete every item before merging a migration PR into `main` or deploying
to a production database.

### Pre-Migration

- [ ] **Read the migration SQL** — open the migration folder and review every
      statement in `migration.sql`.
- [ ] **Check for destructive operations** — `DROP COLUMN`, `DROP TABLE`,
      column renames, type changes.  Each requires a multi-step deployment
      (see [Deployment Sequencing](#deployment-sequencing)).
- [ ] **Verify backward compatibility** — the application code must tolerate
      the schema in *both* the current and post-migration state until all
      instances have restarted.
- [ ] **Estimate table size** — tables > 1 M rows need special handling
      (see [Large Table Guidance](#large-table-guidance)).
- [ ] **Test on staging** — run `prisma migrate deploy` against a staging
      database that mirrors production data volume before touching production.
- [ ] **Check for long-running locks** — `ALTER TABLE … ADD COLUMN NOT NULL`
      without a `DEFAULT` locks the entire table in Postgres.  Use a nullable
      column or provide a `DEFAULT`.
- [ ] **Prepare rollback SQL** — write a `down.sql` next to `migration.sql`
      using the [rollback template](#rollback-sql-template), and test it
      locally (see [Rollback Guidance](#rollback-guidance)).
- [ ] **Verify readiness endpoint** before and after deploy:
      `GET /metrics/readiness` → `{ "ready": true }`

---

## Deployment Sequencing

Prisma `migrate deploy` applies pending migrations one at a time, in order —
not as one transaction. If a later migration fails, the earlier ones stay
applied. For breaking schema changes use a **two-phase** deploy:

### Phase 1 — Widen
Deploy application code that tolerates both old and new schema, *then* apply
the migration:
```
deploy code (reads both old + new column) → prisma migrate deploy
```

### Phase 2 — Narrow
Once all instances run the new code, remove the compatibility shim:
```
remove old compatibility code → deploy code
```

**Example — rename `users.name` → `users.display_name`:**
1. Add `display_name` (nullable) via `prisma migrate deploy`
2. Backfill: `UPDATE users SET display_name = name WHERE display_name IS NULL`
3. Deploy code that writes to **both** `name` and `display_name`
4. Migrate: make `display_name NOT NULL`, then drop `name`
5. Deploy code that only uses `display_name`

---

## Rollback Guidance

Every migration PR ships a reviewed, tested rollback script. This section
covers why, where the script lives, how to write it, how to generate a draft
with Prisma, and how to test it.

### Why rollbacks need planning

Prisma Migrate is **forward-only**. It has no "down" migrations:

- `prisma migrate deploy` only ever applies migrations — it never reverts one.
- `prisma migrate reset` drops the **entire** database. Never run it outside
  a disposable local database.
- `prisma migrate resolve --rolled-back` only edits the `_prisma_migrations`
  history table for a migration that **failed**. It does not undo any SQL, and
  it refuses to touch a migration that succeeded.

So when a migration succeeds but turns out to be wrong (a bad release, a slow
query, the wrong column type), undoing it means hand-written SQL. Writing that
SQL during an incident is where mistakes happen. Write it alongside the
migration instead, while the forward SQL is fresh, and get it reviewed in the
same PR.

### Where rollback scripts live: `down.sql`

Put the rollback script in a file named exactly `down.sql`, in the same folder
as the `migration.sql` it reverses:

```text
prisma/migrations/
├── migration_lock.toml
├── README.md                       ← this guide
└── 20260903000000_add_payout_claim/
    ├── migration.sql               ← applied by `prisma migrate deploy`
    └── down.sql                    ← rollback; only ever run by a human
```

Why this location:

- **Reviewed together** — the forward and rollback SQL appear in the same diff.
- **Easy to find during an incident** — the rollback for migration `X` is
  always `prisma/migrations/X/down.sql`, on every branch and release tag.
- **Versioned with the code** — unlike a PR description, it can't get lost.

**Prisma ignores it.** Prisma only reads `migration.sql` in each migration
folder, plus `migration_lock.toml`. Checked against this repo with Prisma
5.22.0 and PostgreSQL:

- `prisma migrate deploy` and `prisma migrate status` ignore `down.sql` and
  this `README.md`.
- The shadow-database replay used by `prisma migrate dev` / `migrate diff
  --from-migrations` ignores them too.
- The checksum stored in `_prisma_migrations` covers `migration.sql` only, so
  you can add or edit `down.sql` for a migration that is already applied
  without a checksum mismatch. (Never edit an applied `migration.sql`.)

Migrations created before this convention have no `down.sql`. Adding one is
welcome but optional. New migrations must include one.

### Rollback SQL template

Copy this into `prisma/migrations/<migration_name>/down.sql`:

```sql
-- ============================================================
-- Rollback  : <timestamp>_<name>
-- Reverses  : prisma/migrations/<timestamp>_<name>/migration.sql
-- Author    : <name or GitHub handle>
-- Date      : <YYYY-MM-DD>
-- Data loss : <NONE | YES — what is lost, and how to recover it>
-- Tested    : <yes/no — apply → rollback → re-apply on a disposable DB>
--
-- Run with:
--   npx prisma db execute --schema prisma/schema.prisma \
--     --file prisma/migrations/<timestamp>_<name>/down.sql
-- ============================================================

BEGIN;

-- Reverse every statement of migration.sql in the OPPOSITE order:
-- the last object created is the first one dropped.

-- <undo step N>
-- ...
-- <undo step 1>

-- Forget the migration so `prisma migrate status` shows it as pending
-- again and `prisma migrate deploy` can re-apply it later.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '<timestamp>_<name>';

COMMIT;
```

Notes on the template:

- **Transactions.** PostgreSQL has transactional DDL. With `BEGIN; … COMMIT;`,
  any failing statement aborts the whole script and leaves the database
  untouched. You can fix the script and run it again.
- **Statements that can't run in a transaction.** `CREATE INDEX CONCURRENTLY`
  and `DROP INDEX CONCURRENTLY` must go **after** `COMMIT`, as separate
  statements. On PostgreSQL 12+, `ALTER TYPE … ADD VALUE` works inside a
  transaction, but the new value can't be used until the transaction commits.
- **Opposite order.** Objects depend on each other: a foreign key depends on
  its table, and a column depends on its enum type. Undo the last step first.
- **No `IF EXISTS`.** Inside a transaction, leave it off. If an object the
  script expects is missing, the database is not in the state you think. The
  error stops the rollback before it does damage.
- **The `DELETE` row.** Removing the history row lets the migration be
  re-applied after a fix. It also avoids a "migration applied in the database
  but missing locally" mismatch if the code is reverted to a release without
  the migration folder.

### Reversal cheat sheet

| Forward (`migration.sql`)                     | Rollback (`down.sql`)                                    | Loses data? |
| --------------------------------------------- | -------------------------------------------------------- | ----------- |
| `CREATE TABLE "T"`                            | `DROP TABLE "T"`                                         | **Yes** — every row in `T` |
| `ALTER TABLE "T" ADD COLUMN "c"`              | `ALTER TABLE "T" DROP COLUMN "c"`                        | **Yes** — values in `c` |
| `CREATE [UNIQUE] INDEX "i"`                   | `DROP INDEX "i"`                                         | No |
| `ADD CONSTRAINT "k"` (FK / unique / check)    | `ALTER TABLE "T" DROP CONSTRAINT "k"`                    | No |
| `CREATE TYPE "E" AS ENUM (…)`                 | `DROP TYPE "E"` (after the columns that use it)          | No |
| `ALTER TYPE "E" ADD VALUE 'v'`                | Recreate the type without `'v'` — see below              | Rows using `'v'` must be remapped |
| `RENAME COLUMN "a" TO "b"`                    | `RENAME COLUMN "b" TO "a"`                               | No |
| `ALTER TABLE "A" RENAME TO "B"`               | `ALTER TABLE "B" RENAME TO "A"` (plus renamed `_pkey` / `_fkey` / `_idx`) | No |
| `ALTER COLUMN "c" SET NOT NULL`               | `ALTER COLUMN "c" DROP NOT NULL`                         | No |
| `ALTER COLUMN "c" SET DEFAULT x`              | `ALTER COLUMN "c" SET DEFAULT <old>` / `DROP DEFAULT`    | No |
| `ALTER COLUMN "c" TYPE <new>`                 | `ALTER COLUMN "c" TYPE <old> USING "c"::<old>`           | Maybe — narrowing can fail or truncate |
| Data backfill (`UPDATE …`)                    | Usually nothing; reverse `UPDATE` only if old values are derivable | Depends |
| `DROP COLUMN` / `DROP TABLE`                  | Re-create the structure only                             | ⚠️ **Data is gone** — see below |

Common reversals, written in this repo's style (quoted PascalCase names,
matching Prisma's generated names for indexes and constraints):

```sql
-- CREATE TABLE → DROP TABLE
-- (also drops the table's own indexes, constraints and foreign keys)
DROP TABLE "Claim";

-- ADD COLUMN → DROP COLUMN
ALTER TABLE "Round" DROP COLUMN "isSoroban";

-- CREATE INDEX → DROP INDEX
DROP INDEX "Notification_userId_createdAt_idx";

-- ADD CONSTRAINT → DROP CONSTRAINT
ALTER TABLE "Claim" DROP CONSTRAINT "Claim_userId_fkey";

-- CREATE TYPE → DROP TYPE (only after every column using it is gone)
DROP TYPE "ClaimStatus";

-- Renames: swap the names back. Never DROP + ADD, which loses the data.
ALTER TABLE "Round" RENAME COLUMN "onChain" TO "isSoroban";
ALTER TABLE "Payout" RENAME TO "Claim";
ALTER INDEX "Payout_walletAddress_idx" RENAME TO "Claim_walletAddress_idx";
```

#### Removing an enum value (PostgreSQL limitation)

PostgreSQL can add a value to an enum (`ALTER TYPE … ADD VALUE`), but it
**cannot remove one**. To undo an `ADD VALUE`, recreate the type without the
value. Any rows that use it must be remapped first, or the cast fails.
Example: undo adding `'EXPIRED'` to `"ClaimStatus"`:

```sql
-- 1. Remap rows that use the value being removed (pick a sensible target).
UPDATE "Claim" SET "status" = 'FAILED' WHERE "status" = 'EXPIRED';

-- 2. Swap in a new type with the original value list.
ALTER TYPE "ClaimStatus" RENAME TO "ClaimStatus_old";
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'NEEDS_MANUAL_REVIEW');

-- 3. Move every column that uses the type. Drop and restore any default,
--    because the old default is typed as the old enum.
ALTER TABLE "Claim" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Claim" ALTER COLUMN "status" TYPE "ClaimStatus" USING ("status"::text::"ClaimStatus");
ALTER TABLE "Claim" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- 4. Drop the old type.
DROP TYPE "ClaimStatus_old";
```

Repeat step 3 for **every** table and column that uses the enum
(`grep -n '"ClaimStatus"' prisma/migrations/*/migration.sql` finds them).

#### ⚠️ Destructive changes cannot be undone with SQL alone

If `migration.sql` drops a column or table, or narrows a type, the rollback
can recreate the **structure** but not the **data**. For these migrations:

- Mark the header `Data loss : YES` and say so in the PR description.
- Copy the data aside **in the forward migration**, before the drop, so the
  rollback can restore it. For example, with
  `CREATE TABLE "_backup_Round_legacyField" AS SELECT "id", "legacyField" FROM "Round";`
  the rollback can re-add the column and `UPDATE … FROM` the backup table.
- Otherwise, the only way back is a database backup. Confirm that a recent one
  exists before deploying.

The reverse is also true: rolling back a `CREATE TABLE` or `ADD COLUMN` throws
away anything written to it after the deploy. Say so in the header.

### Generating a draft rollback with Prisma

This repo uses **Prisma 5.22** (`npx prisma --version`). In this version,
`prisma migrate diff` can generate rollback SQL by diffing **from** your new
schema **to** the schema before your change:

```bash
# 1. Save the schema as it was on your base branch (rebase onto it first).
git show main:prisma/schema.prisma > /tmp/schema.before.prisma
#    (fork contributors: git show upstream/main:prisma/schema.prisma)

# 2. Diff FROM where the migration leaves you TO where you want to return.
npx prisma migrate diff \
  --from-schema-datamodel prisma/schema.prisma \
  --to-schema-datamodel /tmp/schema.before.prisma \
  --script > /tmp/rollback.draft.sql
```

Treat the output as a **draft**. Paste it between `BEGIN;` and the `DELETE`
line of the template, then review it:

- **Renames become `DROP` + `ADD`.** Prisma can't tell a rename from a new
  column, so it drops the column (losing its data). Replace that with
  `RENAME COLUMN` / `RENAME TO`.
- **Enum value removals come with their own `BEGIN; … COMMIT;`.** Delete
  those inner lines; nested inside the template's transaction, the inner
  `COMMIT` commits early. Prisma also doesn't remap rows that use the removed
  value — add the `UPDATE` from the enum section above.
- **No data steps.** Backfills, data copies and restores from backup tables
  are never generated. Add them by hand.
- **Everything that differs is included.** If your branch is behind the base
  branch, or the base schema is wrong, unrelated statements show up. Make sure
  every statement belongs to your migration.

Prefer the schema-to-schema diff above. The variants that read a database or
the migrations folder, such as `--from-url "$DATABASE_URL"` or
`--from-migrations prisma/migrations --shadow-database-url …`, also pick up
any existing drift between `schema.prisma` and the committed migrations, which
makes the output noisy.

### Running a rollback

```bash
npx prisma db execute --schema prisma/schema.prisma \
  --file prisma/migrations/<migration_name>/down.sql
```

This uses `DATABASE_URL` from the datasource in `prisma/schema.prisma`.
`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <path>/down.sql` works too.

In production:

1. **Do NOT run `prisma migrate reset`** — it drops all data.
2. Deploy application code that doesn't need the migration
   (see [Deployment Sequencing](#deployment-sequencing)), then run `down.sql`.
3. Check `npx prisma migrate status` — the migration should be listed as not
   yet applied.
4. Alert the on-call engineer and open a post-mortem issue.

### When `migrate deploy` fails partway: `migrate resolve`

If a migration fails during `prisma migrate deploy` (error `P3018`), Prisma
records it as failed. Every later deploy is then blocked with `P3009` until
you resolve it:

1. Check what the failed migration left behind. On PostgreSQL, a failing
   `migration.sql` is normally rolled back as a whole: in testing, a failed
   migration left no partial changes. That doesn't hold if the file has its
   own `COMMIT` or non-transactional statements, so inspect the schema
   (`\d "Table"` in `psql`). If anything is left over, run the matching
   statements from `down.sql`.
2. Mark the migration as rolled back:

   ```bash
   npx prisma migrate resolve --rolled-back <migration_name>
   ```

3. Fix `migration.sql` (it was never applied, so editing it is safe), then
   run `prisma migrate deploy` again.

`migrate resolve --rolled-back` only works on **failed** migrations. On one
that succeeded, Prisma answers *"cannot be rolled back because it is not in a
failed state"* — use `down.sql` instead. Its `DELETE` from `_prisma_migrations`
updates the history.

### Testing a rollback locally

Test every `down.sql` against a **disposable** database before review:
apply → roll back → re-apply. **Never test against production, staging, or
any database whose data you want to keep.**

```bash
# Throwaway databases in the docker-compose Postgres
# (any local Postgres works; just use new, empty databases)
docker compose up -d postgres
docker compose exec postgres createdb -U xelma xelma_rollback_test
docker compose exec postgres createdb -U xelma xelma_rollback_shadow

export DATABASE_URL=postgresql://xelma:xelma@localhost:5432/xelma_rollback_test
SHADOW_URL=postgresql://xelma:xelma@localhost:5432/xelma_rollback_shadow
MIGRATION=20260903000000_add_payout_claim   # your migration

# 1. Apply every migration, including yours.
npm run db:migrate

# 2. Optional but recommended: insert a few rows that use your new
#    tables / columns / enum values, so the rollback runs against real data.

# 3. Roll back.
npx prisma db execute --schema prisma/schema.prisma \
  --file prisma/migrations/$MIGRATION/down.sql
npx prisma migrate status   # expect: "Following migration have not yet been applied: <MIGRATION>"

# 4. Re-apply.
npm run db:migrate
npx prisma migrate status   # expect: "Database schema is up to date!"

# 5. Check that the round trip left nothing behind: the database must match
#    the committed migrations exactly. Exit code 0 = identical, 2 = differences.
npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-migrations prisma/migrations \
  --shadow-database-url "$SHADOW_URL" \
  --exit-code

# 6. Clean up.
docker compose exec postgres dropdb -U xelma xelma_rollback_test
docker compose exec postgres dropdb -U xelma xelma_rollback_shadow
```

If step 3 fails, the template's transaction leaves the database unchanged.
Fix `down.sql` and run step 3 again. If step 5 shows differences, the
rollback missed something (or re-created it differently) — fix `down.sql`
and repeat from step 1 on fresh databases.

### Worked example: `20260903000000_add_payout_claim`

The forward migration ([`migration.sql`](20260903000000_add_payout_claim/migration.sql))
does four things, in this order:

1. `CREATE TYPE "ClaimStatus"`
2. `CREATE TABLE "Claim"`
3. `CREATE UNIQUE INDEX "Claim_txHash_key"`, then three more indexes:
   `Claim_walletAddress_idx`, `Claim_status_createdAt_idx`, `Claim_userId_idx`
4. `ALTER TABLE "Claim" ADD CONSTRAINT "Claim_userId_fkey"` (FK to `"User"`)

Its rollback, `prisma/migrations/20260903000000_add_payout_claim/down.sql`,
undoes those steps in reverse:

```sql
-- ============================================================
-- Rollback  : 20260903000000_add_payout_claim
-- Reverses  : prisma/migrations/20260903000000_add_payout_claim/migration.sql
-- Author    : <GitHub handle>
-- Date      : <YYYY-MM-DD>
-- Data loss : YES — every row in "Claim" (payout claim records). Export the
--             table first if the rows are needed for reconciliation:
--             \copy "Claim" TO 'claim_backup.csv' CSV HEADER
-- Tested    : yes — apply → rollback → re-apply on a disposable DB
--
-- Run with:
--   npx prisma db execute --schema prisma/schema.prisma \
--     --file prisma/migrations/20260903000000_add_payout_claim/down.sql
-- ============================================================

BEGIN;

-- 4. AddForeignKey
ALTER TABLE "Claim" DROP CONSTRAINT "Claim_userId_fkey";

-- 3. CreateIndex (reverse order)
DROP INDEX "Claim_userId_idx";
DROP INDEX "Claim_status_createdAt_idx";
DROP INDEX "Claim_walletAddress_idx";
DROP INDEX "Claim_txHash_key";

-- 2. CreateTable
DROP TABLE "Claim";

-- 1. CreateEnum (only after the column using it is gone)
DROP TYPE "ClaimStatus";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260903000000_add_payout_claim';

COMMIT;
```

`DROP TABLE "Claim"` alone would also remove the indexes and the foreign key.
Spelling each one out mirrors the forward migration line by line, which makes
review easy. Running this through the test steps above gives a clean round
trip: `migrate status` shows the migration as pending after step 3, and step 5
reports an empty diff after re-applying.

---

## Data Backfill Guidance

Backfills that touch millions of rows must be batched to avoid long locks and
memory pressure.

```sql
-- Batch backfill: update 1 000 rows at a time, yield between batches
DO $$
DECLARE
  affected INT := 1;
BEGIN
  WHILE affected > 0 LOOP
    UPDATE users
    SET    display_name = name
    WHERE  display_name IS NULL
    LIMIT  1000;

    GET DIAGNOSTICS affected = ROW_COUNT;
    PERFORM pg_sleep(0.05);
  END LOOP;
END $$;
```

- Never run an unbatched `UPDATE … WHERE …` on a table > 100 k rows during
  production hours.
- Monitor replication lag and statement timeouts during backfills.

---

## Large Table Guidance

| Row count | Concern                              | Mitigation |
|-----------|--------------------------------------|------------|
| > 1 M     | `ADD COLUMN NOT NULL` locks table    | Add as nullable, backfill, then add NOT NULL |
| > 5 M     | Full-table backfill is too slow      | Use batched update script above |
| > 10 M    | `CREATE INDEX` blocks writes         | Use `CREATE INDEX CONCURRENTLY` |
| Any       | `DROP TABLE` is irreversible         | Export data first; run in off-peak window |

---

## Migration Templates

### Safe — Add Nullable Column

```sql
ALTER TABLE "users" ADD COLUMN "bio" TEXT;
```

### Safe — Add Column with Default

```sql
ALTER TABLE "predictions"
  ADD COLUMN "confidence" INTEGER NOT NULL DEFAULT 50;
```

### Safe — Add Index (Concurrent)

```sql
-- Use CONCURRENTLY so writes are not blocked (cannot run inside a transaction)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_predictions_user_id"
  ON "predictions" ("userId");
```

### Multi-step — Add NOT NULL Column (without downtime)

```sql
-- Step A: add as nullable, deploy app code that writes the value
ALTER TABLE "users" ADD COLUMN "display_name" TEXT;

-- Step B: backfill (use batched script for large tables)
UPDATE "users" SET "display_name" = "name" WHERE "display_name" IS NULL;

-- Step C: tighten constraint after all rows are filled
ALTER TABLE "users" ALTER COLUMN "display_name" SET NOT NULL;
```

### Destructive — Drop Column

```sql
-- ⚠️  Irreversible — ensure no application code references the column
ALTER TABLE "users" DROP COLUMN IF EXISTS "legacy_field";
```

**Rollback SQL (document in PR):**
```sql
ALTER TABLE "users" ADD COLUMN "legacy_field" TEXT;
-- Restore from backup if needed
```

### Destructive — Drop Table

```sql
-- ⚠️  All data permanently lost — archive before dropping
CREATE TABLE "archived_rounds_2026" AS SELECT * FROM "rounds";
DROP TABLE IF EXISTS "rounds";
```

### Add Enum Value (safe)

```sql
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'MODERATOR';
```

> Removing an enum value is not supported by Postgres directly — treat it as
> a multi-step column-type migration.

---

## Reversible Migration Template

Use this header in `migration.sql`. The rollback SQL itself goes in the
sibling `down.sql` (see [Rollback SQL template](#rollback-sql-template)), not
in comments here:

```sql
-- ============================================================
-- Migration: <timestamp>_<name>
-- Description: <one-line summary>
--
-- Apply    : prisma migrate deploy
-- Rollback : prisma/migrations/<timestamp>_<name>/down.sql
-- ============================================================

-- Forward migration
ALTER TABLE "example" ADD COLUMN "new_field" TEXT;
```

---

## PR Description Template

Paste this block into every PR that includes a migration:

~~~markdown
## Migration: `<migration_name>`

**Type:** [Add column | Drop column | Rename | Index | Enum | Other]
**Risk:** [Low | Medium | High]
**Rollback loses data:** [No | Yes — <what, and how to recover it>]

### What this migration does
<one paragraph>

### Backward compatibility
Application code is compatible with both old and new schema: [Yes / No]

### Rollback
`prisma/migrations/<migration_name>/down.sql`

### Checklist
- [ ] Tested on staging
- [ ] Backfill plan documented (if applicable)
- [ ] `GET /metrics/readiness` returns `ready: true` post-deploy
- [ ] Rollback tested locally (apply → rollback → re-apply)
~~~

---

## Review Checklist (for PR reviewers)

- [ ] Migration file name is timestamped and descriptive.
- [ ] No `DROP TABLE` or `DROP COLUMN` without an explicit data-export step.
- [ ] `NOT NULL` columns without a default include a backfill step.
- [ ] `CREATE INDEX` uses `CONCURRENTLY` for tables > 100 k rows.
- [ ] Migration folder contains a `down.sql` that follows the
      [rollback template](#rollback-sql-template), reverses the statements in
      the opposite order, and states its data-loss risk.
- [ ] `GET /metrics/readiness` returns `ready: true` post-deploy.
- [ ] Staging deploy confirmed green before merging.

## 🔌 Socket.IO Client Contract Documentation

This section defines the real-time event contract, lifecycle events, and type structures for the Xelma Backend gateway (`src/socket.ts`). Any frontend engineer can use this to integrate real-time tracking without needing to read the source code.

---

### 🧭 Connection Lifecycle & Authentication

#### 1. Connection Requirements
Connections are established against the root namespace (`/`). Authentication requires a valid JSON Web Token (JWT) provided in the initial handshake payload.

```typescript
import { io } from "socket.io-client";

const socket = io("[https://api.tevalabs.com](https://api.tevalabs.com)", {
  auth: {
    token: "YOUR_JWT_ACCESS_TOKEN"
  },
  autoConnect: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000
});

socket.on("connect_error", async (error) => {
  if (error.message === "Authentication failed" || error.message === "jwt expired") {
    // 1. Refresh token via HTTP route (src/routes/auth.routes.ts)
    const freshToken = await fetchNewToken();
    
    // 2. Re-assign credentials
    socket.auth = { token: freshToken };
    
    // 3. Retry connection lifecycle
    socket.connect();
  }
});

{
  "status": "authenticated",
  "sessionId": "sess_883af10x9",
  "connectedAt": "2026-06-28T05:30:00.000Z",
  "version": "1.0.0"
}

{
  "asset": "XLM",
  "priceUsd": 0.124500,
  "timestamp": 1782624600000,
  "change24h": 1.85
}

{
  "roundId": "rnd_9921045a",
  "status": "active",
  "txCount": 14,
  "terminalStateFinality": false,
  "updatedAt": "2026-06-28T05:31:12.402Z"
}

{
  "id": "ntf_7712a",
  "type": "success",
  "message": "Transaction batch execution finalized successfully.",
  "read": false
}

{
  "channelId": "chan_stellar_general",
  "senderAddress": "GBC...21ENG",
  "text": "Decimal normalization logic tests are executing green."
}

---

### 📝 TypeScript Definition Compilation
Drop this file cleanly into your web frontend dashboard type directory (`src/types/socket.ts`) to ensure end-to-end interface parity:

```typescript
export interface ServerToClientEvents {
  "server:hello": (data: { status: string; sessionId: string; connectedAt: string; version: string; }) => void;
  "price_update": (data: { asset: string; priceUsd: number; timestamp: number; change24h: number; }) => void;
  "round_update": (data: { roundId: string; status: "pending" | "active" | "settled" | "defaulted"; txCount: number; terminalStateFinality: boolean; updatedAt: string; }) => void;
  "notifications": (data: { id: string; type: "info" | "warning" | "success"; message: string; read: boolean; }) => void;
  "chat": (data: { channelId: string; messageId: string; senderAddress: string; text: string; timestamp: string; }) => void;
}

export interface ClientToServerEvents {
  "chat": (data: { channelId: string; senderAddress: string; text: string; }) => void;
}
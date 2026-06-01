# Migration Safety Guide

This directory contains all Prisma database migrations for Xelma Backend.

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
- [ ] **Prepare rollback SQL** — document the SQL to undo the migration in
      the PR description (see [Rollback Guidance](#rollback-guidance)).
- [ ] **Verify readiness endpoint** before and after deploy:
      `GET /metrics/readiness` → `{ "ready": true }`

---

## Deployment Sequencing

Prisma `migrate deploy` applies all pending migrations in one transaction.
For breaking schema changes use a **two-phase** deploy:

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

Prisma does **not** support automatic rollback.  After a failed or undesired
migration:

1. **Do NOT run `prisma migrate reset`** in production — it drops all data.
2. Apply the inverse SQL manually:

```sql
-- Example: rolling back an ADD COLUMN
ALTER TABLE "users" DROP COLUMN IF EXISTS "display_name";

-- Remove the migration record so Prisma will re-apply it on next deploy
DELETE FROM _prisma_migrations
WHERE migration_name = '20260601000000_add_display_name';
```

3. Either delete the migration folder or mark it failed and commit that change.
4. Test the rollback on staging before applying to production.
5. Alert the on-call engineer and open a post-mortem issue.

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

Use this header when writing a migration that must support rollback:

```sql
-- ============================================================
-- Migration: <timestamp>_<name>
-- Description: <one-line summary>
--
-- Apply  : prisma migrate deploy
-- Rollback:
--   <exact SQL to undo this migration>
--   DELETE FROM _prisma_migrations WHERE migration_name = '<timestamp>_<name>';
-- ============================================================

-- Forward migration
ALTER TABLE "example" ADD COLUMN "new_field" TEXT;
```

---

## PR Description Template

Paste this block into every PR that includes a migration:

```markdown
## Migration: `<migration_name>`

**Type:** [Add column | Drop column | Rename | Index | Enum | Other]
**Risk:** [Low | Medium | High]

### What this migration does
<one paragraph>

### Backward compatibility
Application code is compatible with both old and new schema: [Yes / No]

### Rollback SQL
```sql
-- paste rollback SQL here
DELETE FROM _prisma_migrations WHERE migration_name = '<name>';
```

### Checklist
- [ ] Tested on staging
- [ ] Backfill plan documented (if applicable)
- [ ] `GET /metrics/readiness` returns `ready: true` post-deploy
- [ ] Rollback SQL tested on staging
```

---

## Review Checklist (for PR reviewers)

- [ ] Migration file name is timestamped and descriptive.
- [ ] No `DROP TABLE` or `DROP COLUMN` without an explicit data-export step.
- [ ] `NOT NULL` columns without a default include a backfill step.
- [ ] `CREATE INDEX` uses `CONCURRENTLY` for tables > 100 k rows.
- [ ] PR description includes the rollback SQL.
- [ ] `GET /metrics/readiness` returns `ready: true` post-deploy.
- [ ] Staging deploy confirmed green before merging.
